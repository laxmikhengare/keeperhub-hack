/**
 * Component 1 — THE ANALYST.
 *
 * Hybrid by design (§5): keccak resolution happens in code before the model is
 * called, and every role name the model proposes is re-verified in code after.
 * The model does the part that needs a model — reading control flow across
 * inheritance and judging load_bearing vs vestigial under incomplete evidence.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { callModel, type Effort } from './client.js';
import { AgentSchemaError } from './errors.js';
import { isVerifiedResolution, normalizeHash, resolveByBruteForce, type ResolvedRole } from './keccak.js';
import {
  computeCallStats,
  effectiveSourcesFor,
  permissionKey,
  renderResolutionTable,
  resolveRoles,
} from './resolve.js';
import {
  EvidenceBundleSchema,
  PermissionAnalysisModelOutputSchema,
  PermissionAnalysisSchema,
} from './schemas.js';
import type { EvidenceBundle, PermissionAnalysis } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const ANALYST_SYSTEM = readFileSync(join(here, 'prompts/analyst.md'), 'utf8');

/** Char budget for Solidity in one prompt. Opus 5 has a 1M window; this is a guard rail. */
const SOURCE_BUDGET_CHARS = 600_000;

const lc = (s: string): string => s.trim().toLowerCase();
const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export interface AnalyzeOptions {
  effort?: Effort;
  maxTokens?: number;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Evidence rendering                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Which contracts get full source.
 *
 * Contracts carrying a permission (and the implementations behind them) are
 * sent in full; everything else is summarised. Ordering is by lowercased
 * address throughout so the rendered prefix is byte-stable across eval rows —
 * a non-deterministic order would silently defeat prompt caching.
 */
function selectSources(bundle: EvidenceBundle): {
  full: Array<{ address: string; name: string | null; source: string; label: string }>;
  summarized: Array<{ address: string; name: string | null }>;
  truncated: string[];
} {
  const needed = new Map<string, { label: string }>();

  const permissionContracts = [...new Set(bundle.permissions.map((p) => lc(p.contract)))].sort();
  for (const addr of permissionContracts) {
    for (const src of effectiveSourcesFor(bundle, addr)) {
      const key = lc(src.address);
      if (needed.has(key)) continue;
      needed.set(key, {
        label: src.viaProxy
          ? `IMPLEMENTATION behind proxy ${lc(src.proxyAddress ?? addr)} — the logic lives here`
          : 'directly holds permissions',
      });
    }
  }

  const full: Array<{ address: string; name: string | null; source: string; label: string }> = [];
  const summarized: Array<{ address: string; name: string | null }> = [];
  const truncated: string[] = [];

  let spent = 0;
  for (const key of [...needed.keys()].sort()) {
    const entry = bundle.contracts[key];
    if (!entry?.verifiedSource) continue;
    let source = entry.verifiedSource;
    if (spent + source.length > SOURCE_BUDGET_CHARS) {
      const remaining = Math.max(0, SOURCE_BUDGET_CHARS - spent);
      source = source.slice(0, remaining) + '\n\n/* … source truncated for length … */\n';
      truncated.push(entry.address);
    }
    spent += source.length;
    full.push({
      address: entry.address,
      name: entry.name,
      source,
      label: needed.get(key)!.label,
    });
  }

  for (const key of Object.keys(bundle.contracts).sort()) {
    if (needed.has(lc(key))) continue;
    const entry = bundle.contracts[key]!;
    summarized.push({ address: entry.address, name: entry.name });
  }

  return { full, summarized, truncated };
}

function abiFunctionNames(abi: unknown[] | null): string[] {
  if (!abi) return [];
  const names: string[] = [];
  for (const item of abi) {
    if (item && typeof item === 'object' && 'type' in item && 'name' in item) {
      const entry = item as { type?: unknown; name?: unknown };
      if (entry.type === 'function' && typeof entry.name === 'string') names.push(entry.name);
    }
  }
  return [...new Set(names)].sort();
}

function renderEvidence(bundle: EvidenceBundle, resolved: Map<string, ResolvedRole>): string {
  const parts: string[] = [];

  parts.push('# DEAD KEEPER');
  parts.push(
    `address:  ${lc(bundle.deadKeeper.address)}\n` +
      `provider: ${bundle.deadKeeper.provider}\n` +
      `chain:    ${bundle.chainContext.chainName} (chainId ${bundle.chainContext.chainId})\n` +
      `current block: ${bundle.chainContext.currentBlock}`,
  );

  if (bundle.upkeep) {
    const u = bundle.upkeep;
    parts.push('\n# UPKEEP REGISTRATION');
    parts.push(
      `id: ${u.id}\ntarget: ${lc(u.targetContract)}\n` +
        `check:  ${u.checkFunctionSig ?? '(unknown)'}\n` +
        `perform: ${u.performFunctionSig ?? '(unknown)'}\n` +
        `admin: ${lc(u.adminAddress)}\nbalance: ${u.balance}`,
    );
  } else {
    parts.push('\n# UPKEEP REGISTRATION\nNone. This keeper was discovered as a bare address, not via a keeper registry.');
  }

  parts.push('\n# ' + renderResolutionTable(bundle, resolved));

  parts.push('\n# PERMISSIONS TO CLASSIFY');
  parts.push(
    'Return exactly one entry per row below, in this order, copying contract and roleHash verbatim.',
  );
  bundle.permissions.forEach((p, i) => {
    const r = resolved.get(permissionKey(p.contract, p.roleHash));
    parts.push(
      `${i + 1}. contract=${lc(p.contract)}\n` +
        `   roleHash=${normalizeHash(p.roleHash)}\n` +
        `   resolvedName=${r?.roleName ?? 'UNRESOLVED'}  grantedAtBlock=${p.grantedAtBlock}  stillActive=${p.stillActive}`,
    );
  });

  parts.push('\n# CALL HISTORY (what this keeper actually did)');
  if (bundle.callHistory.length === 0) {
    const span = bundle.chainContext.currentBlock - Math.min(...bundle.permissions.map((p) => p.grantedAtBlock));
    parts.push(
      'EMPTY — no decoded calls from this keeper to these contracts were found.\n' +
        `The roles were granted roughly ${span.toLocaleString()} blocks ago and no use has been observed since.\n` +
        'Treat this as real evidence of non-use, but read the "zero call history" guidance in your instructions before concluding vestigial.',
    );
  } else {
    for (const c of bundle.callHistory) {
      parts.push(
        `- ${lc(c.contract)} ${c.functionName ?? c.selector}  calls=${c.count}  blocks ${c.firstBlock}..${c.lastBlock}`,
      );
    }
  }

  const { full, summarized, truncated } = selectSources(bundle);

  parts.push('\n# CONTRACT SOURCE');
  if (full.length === 0) {
    parts.push('No verified source is available for any contract holding these permissions.');
  }
  for (const c of full) {
    parts.push(
      `\n## ${c.address}${c.name ? ` (${c.name})` : ''} — ${c.label}\n` +
        '```solidity\n' +
        c.source +
        '\n```',
    );
  }

  if (summarized.length > 0) {
    parts.push('\n## Other contracts in the bundle (not carrying permissions)');
    for (const c of summarized) {
      const abi = abiFunctionNames(bundle.contracts[lc(c.address)]?.abi ?? null);
      parts.push(`- ${c.address}${c.name ? ` (${c.name})` : ''}${abi.length ? ` — functions: ${abi.join(', ')}` : ''}`);
    }
  }

  if (truncated.length > 0) {
    parts.push(
      `\nNOTE: source for ${truncated.join(', ')} was truncated for length. ` +
        'If a judgment depends on the missing portion, say so in declaredUnknowns.',
    );
  }

  return parts.join('\n');
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The seam                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function emptyAnalysis(reason: string): PermissionAnalysis {
  return {
    permissions: [],
    automationIntent: {
      triggerKind: 'unknown',
      conditionSummary: 'No automation could be reconstructed — the bundle contains no permissions, no upkeep registration and no call history.',
      conditionCall: null,
      action: null,
      confidence: 0,
      reasoning: reason,
    },
    declaredUnknowns: [reason],
  };
}

export async function analyze(
  bundle: EvidenceBundle,
  options: AnalyzeOptions = {},
): Promise<PermissionAnalysis> {
  const validated = EvidenceBundleSchema.safeParse(bundle);
  if (!validated.success) {
    throw new AgentSchemaError('EvidenceBundle failed schema validation', validated.error.issues.slice(0, 10));
  }

  // §5 failure-mode table: empty permissions returns cleanly, never throws.
  if (bundle.permissions.length === 0 && !bundle.upkeep && bundle.callHistory.length === 0) {
    return emptyAnalysis('EvidenceBundle contained no permissions, no upkeep and no call history — nothing to analyse.');
  }

  const resolved = resolveRoles(bundle);
  const evidence = renderEvidence(bundle, resolved);

  const { value } = await callModel({
    schema: PermissionAnalysisModelOutputSchema,
    system: ANALYST_SYSTEM,
    user: evidence,
    label: 'analyst',
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
  });

  return postProcess(bundle, resolved, value);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Post-processing — the hallucination guard                                  */
/* ────────────────────────────────────────────────────────────────────────── */

type ModelOutput = ReturnType<typeof PermissionAnalysisModelOutputSchema.parse>;

/**
 * Reconcile the model's output with what code proved.
 *
 * §5's single most important rule: if the model states a role name that
 * verification does not confirm, the name is discarded. Code's resolution wins
 * every time it exists — the model cannot overwrite a keccak-verified name, and
 * it cannot introduce an unverified one.
 */
export function postProcess(
  bundle: EvidenceBundle,
  resolved: Map<string, ResolvedRole>,
  model: ModelOutput,
): PermissionAnalysis {
  const byKey = new Map<string, ModelOutput['permissions'][number]>();
  for (const p of model.permissions) {
    byKey.set(permissionKey(p.contract, p.roleHash), p);
  }

  const declaredUnknowns = [...model.declaredUnknowns];
  const permissions: PermissionAnalysis['permissions'] = [];

  for (const perm of bundle.permissions) {
    const key = permissionKey(perm.contract, perm.roleHash);
    const roleHash = normalizeHash(perm.roleHash);
    const code = resolved.get(key);
    const proposed = byKey.get(key);

    if (!proposed) {
      declaredUnknowns.push(
        `Model returned no entry for role ${roleHash} on ${lc(perm.contract)}; recorded as unknown.`,
      );
    }

    // 1. Name + method. Code's verified resolution is authoritative.
    let roleName: string | null = null;
    let resolutionMethod: PermissionAnalysis['permissions'][number]['resolutionMethod'] = 'unresolved';

    if (code && code.roleName && isVerifiedResolution(code.roleName, code.preimage, roleHash)) {
      roleName = code.roleName;
      resolutionMethod = code.resolutionMethod;
    } else if (proposed?.roleName) {
      // Code could not resolve it. The model guessed — confirm or discard.
      const brute = resolveByBruteForce(proposed.roleName, roleHash);
      if (brute) {
        roleName = brute.name;
        resolutionMethod = 'brute_force';
      } else {
        declaredUnknowns.push(
          `Model proposed role name "${proposed.roleName}" for ${roleHash}, but keccak256 verification ` +
            `did not confirm it. Name discarded and reported as unresolved.`,
        );
      }
    }

    // 2. Deterministic joins — never the model's arithmetic.
    const gatedFunctions = [...new Set((proposed?.gatedFunctions ?? []).map((f) => f.trim()).filter(Boolean))];
    const { observedCalls, lastCalledBlock } = computeCallStats(bundle, perm.contract, gatedFunctions);

    permissions.push({
      contract: perm.contract,
      roleHash,
      roleName,
      resolutionMethod,
      gatedFunctions,
      observedCalls,
      lastCalledBlock,
      classification: proposed?.classification ?? 'unknown',
      confidence: clamp01(proposed?.confidence ?? 0),
      reasoning:
        proposed?.reasoning?.trim() ||
        'No reasoning was produced for this permission; treat as undetermined.',
    });
  }

  const result: PermissionAnalysis = {
    permissions,
    automationIntent: {
      ...model.automationIntent,
      confidence: clamp01(model.automationIntent.confidence),
    },
    declaredUnknowns: [...new Set(declaredUnknowns)],
  };

  const check = PermissionAnalysisSchema.safeParse(result);
  if (!check.success) {
    throw new AgentSchemaError('post-processed analysis failed schema validation', check.error.issues.slice(0, 10));
  }
  return check.data as PermissionAnalysis;
}
