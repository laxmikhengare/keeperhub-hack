/**
 * Bundle-level deterministic pre-pass.
 *
 * Turns an EvidenceBundle into (a) a keccak-verified resolution table the model
 * can trust, and (b) the deterministic call-history joins the model must never
 * be asked to compute. keccak.ts holds the primitives; this file applies them
 * to a bundle.
 */

import {
  ZERO_HASH,
  STANDARD_ROLES,
  extractSourceConstants,
  normalizeHash,
  type ResolvedRole,
  type SourceConstant,
} from './keccak.js';
import type { EvidenceBundle } from './types.js';

export interface ContractSource {
  address: string;
  name: string | null;
  source: string;
  /** True when this source came from the implementation behind a proxy. */
  viaProxy: boolean;
  /** The proxy address, when viaProxy. */
  proxyAddress?: string;
}

const lc = (s: string): string => s.trim().toLowerCase();

/**
 * The sources whose logic actually governs `contractAddress`.
 *
 * §5: "When isProxy is true, the logic lives in implementationAddress's source,
 * not the proxy's." We return both — the proxy's own source can still carry
 * admin roles (OssifiableProxy has its own admin slot) — but the implementation
 * is marked so the prompt can tell the model which one holds the business logic.
 */
export function effectiveSourcesFor(
  bundle: EvidenceBundle,
  contractAddress: string,
): ContractSource[] {
  const out: ContractSource[] = [];
  const seen = new Set<string>();

  const visit = (addr: string, viaProxy: boolean, proxyAddress?: string, depth = 0): void => {
    const key = lc(addr);
    if (seen.has(key) || depth > 4) return;
    seen.add(key);

    const entry = bundle.contracts[key];
    if (!entry) return;

    if (entry.verifiedSource) {
      out.push({
        address: entry.address,
        name: entry.name,
        source: entry.verifiedSource,
        viaProxy,
        ...(proxyAddress ? { proxyAddress } : {}),
      });
    }

    if (entry.isProxy && entry.implementationAddress) {
      visit(entry.implementationAddress, true, entry.address, depth + 1);
    }
  };

  visit(contractAddress, false, undefined, 0);
  return out;
}

/**
 * Every keccak-verified role constant declared anywhere in the bundle.
 *
 * Gathering across all contracts rather than only the permission's own contract
 * is deliberate and safe: a hash either matches or it does not, so a constant
 * found in an implementation, a library, or an inherited file resolves the
 * proxy's role correctly. This is what makes the proxy case work without any
 * special-casing at the call site.
 */
export function collectSourceConstants(
  bundle: EvidenceBundle,
): Map<string, SourceConstant & { contract: string; contractName: string | null }> {
  const all = new Map<string, SourceConstant & { contract: string; contractName: string | null }>();

  for (const entry of Object.values(bundle.contracts)) {
    if (!entry.verifiedSource) continue;
    for (const [roleHash, constant] of extractSourceConstants(entry.verifiedSource)) {
      if (!all.has(roleHash)) {
        all.set(roleHash, { ...constant, contract: entry.address, contractName: entry.name });
      }
    }
  }

  return all;
}

/** Stable key for a (contract, roleHash) pair. */
export const permissionKey = (contract: string, roleHash: string): string =>
  `${lc(contract)}:${normalizeHash(roleHash)}`;

/**
 * Resolve every permission's role hash to a verified name, or explicitly to
 * unresolved. Order matters: standards table first (DEFAULT_ADMIN_ROLE's zero
 * bytes are not a hash of anything and must never be brute-forced), then source
 * constants, then nothing. We never guess.
 */
export function resolveRoles(bundle: EvidenceBundle): Map<string, ResolvedRole> {
  const sourceConstants = collectSourceConstants(bundle);
  const resolved = new Map<string, ResolvedRole>();

  for (const perm of bundle.permissions) {
    const roleHash = normalizeHash(perm.roleHash);
    const key = permissionKey(perm.contract, perm.roleHash);

    const standard = STANDARD_ROLES[roleHash];
    if (standard) {
      resolved.set(key, {
        roleHash,
        roleName: standard,
        // Zero bytes are a sentinel value, not a preimage — record that honestly.
        preimage: roleHash === ZERO_HASH ? null : standard,
        resolutionMethod: 'known_standard',
      });
      continue;
    }

    const constant = sourceConstants.get(roleHash);
    if (constant) {
      resolved.set(key, {
        roleHash,
        roleName: constant.name,
        preimage: constant.preimage,
        resolutionMethod: 'source_constant',
        sourceContract: constant.contract,
        sourceLine: constant.line,
      });
      continue;
    }

    resolved.set(key, {
      roleHash,
      roleName: null,
      preimage: null,
      resolutionMethod: 'unresolved',
    });
  }

  return resolved;
}

/**
 * The RESOLVED ROLE HASHES block handed to the model as evidence.
 *
 * The model is told to trust these and not to re-derive them. Anything marked
 * UNRESOLVED is the model's job to reason about — and to declare as unknown if
 * it genuinely cannot tell.
 */
export function renderResolutionTable(
  bundle: EvidenceBundle,
  resolved: Map<string, ResolvedRole>,
): string {
  const lines: string[] = [
    'RESOLVED ROLE HASHES (verified by keccak256 in code — trust these, do not re-derive):',
  ];

  for (const perm of bundle.permissions) {
    const r = resolved.get(permissionKey(perm.contract, perm.roleHash));
    const short = `${normalizeHash(perm.roleHash).slice(0, 12)}…`;

    if (!r || r.resolutionMethod === 'unresolved') {
      lines.push(`  ${short}  on ${lc(perm.contract)}  ->  UNRESOLVED`);
      continue;
    }

    let provenance: string;
    if (r.resolutionMethod === 'known_standard') {
      provenance =
        r.roleHash === ZERO_HASH
          ? 'standard: 32 zero bytes, not a hash'
          : 'standard role table';
    } else {
      const where = r.sourceContract ? ` in ${lc(r.sourceContract)}` : '';
      provenance = `source constant${where}, line ${r.sourceLine}; preimage "${r.preimage}"`;
    }

    lines.push(`  ${short}  on ${lc(perm.contract)}  ->  ${r.roleName}   (${provenance})`);
  }

  const namespaced = [...resolved.values()].filter(
    (r) => r.preimage && r.roleName && r.preimage !== r.roleName,
  );
  if (namespaced.length > 0) {
    lines.push('');
    lines.push(
      'NOTE: some preimages are namespaced (e.g. keccak256("Contract.ROLE_NAME")), so the',
      'hash is NOT keccak256 of the identifier. The names above are already verified.',
    );
  }

  return lines.join('\n');
}

/**
 * Deterministic join of callHistory against the model's gatedFunctions.
 *
 * §12 forbids an LLM doing arithmetic or counting, so the model returns which
 * functions a role guards and code does the counting. Matching is by decoded
 * function name, case-insensitive, tolerating a trailing signature such as
 * `performUpkeep(bytes)`.
 */
export function computeCallStats(
  bundle: EvidenceBundle,
  contract: string,
  gatedFunctions: string[],
): { observedCalls: number; lastCalledBlock: number | null } {
  const wanted = new Set(
    gatedFunctions.map((f) => f.trim().split('(')[0]!.toLowerCase()).filter(Boolean),
  );

  let observedCalls = 0;
  let lastCalledBlock: number | null = null;

  for (const call of bundle.callHistory) {
    if (lc(call.contract) !== lc(contract)) continue;
    if (!call.functionName) continue;
    const name = call.functionName.trim().split('(')[0]!.toLowerCase();
    if (!wanted.has(name)) continue;

    observedCalls += call.count;
    lastCalledBlock = lastCalledBlock === null ? call.lastBlock : Math.max(lastCalledBlock, call.lastBlock);
  }

  return { observedCalls, lastCalledBlock };
}
