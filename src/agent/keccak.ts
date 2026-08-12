/**
 * Deterministic role-hash resolution. Runs BEFORE the model.
 *
 * §5 rule: do the hashing in code, do the judgment in the model. Never the
 * other way round. Nothing in this file calls an LLM, and nothing in this file
 * guesses — every name it returns has been confirmed by keccak256.
 *
 * ── The subtlety that breaks naive implementations ────────────────────────
 *
 * A role's *identifier* and its *preimage* are not the same string. Lido's
 * bridge declares:
 *
 *     bytes32 public constant DEPOSITS_ENABLER_ROLE =
 *         keccak256("BridgingManager.DEPOSITS_ENABLER_ROLE");
 *
 * The name is `DEPOSITS_ENABLER_ROLE`; the preimage is
 * `BridgingManager.DEPOSITS_ENABLER_ROLE`. So the §5 sketch of
 * `verifyRoleName(name, hash) => hash(name) === expected` returns FALSE for a
 * perfectly correct resolution. Brute-forcing the identifier never matches
 * either — you have to read the source and hash the *string literal*.
 *
 * Everything here therefore tracks (name, preimage) as a pair and verifies the
 * preimage. `verifyRoleName` is kept with its §5 signature because it is the
 * right check for standards-table roles (where name === preimage), but
 * `isVerifiedResolution` is the guard the Analyst actually enforces.
 */

// js-sha3 is CommonJS. A named import resolves under vitest's transform but
// throws under plain Node ESM ("does not provide an export named 'keccak256'"),
// so go through the default export and destructure.
import sha3 from 'js-sha3';

const { keccak256 } = sha3;

/** keccak256 of a UTF-8 string, 0x-prefixed and lowercased. */
export const hash = (s: string): string => '0x' + keccak256(s);

/** DEFAULT_ADMIN_ROLE is literally 32 zero bytes — it is NOT a hash of anything. */
export const ZERO_HASH = '0x' + '00'.repeat(32);

/** Normalise a hex hash for comparison. Hashes arrive in mixed case from chain data. */
export const normalizeHash = (h: string): string => h.trim().toLowerCase();

export type ResolutionMethod =
  | 'source_constant'
  | 'known_standard'
  | 'brute_force'
  | 'unresolved';

export interface ResolvedRole {
  /** The 32-byte role identifier, lowercased. */
  roleHash: string;
  /** The Solidity identifier, e.g. DEPOSITS_ENABLER_ROLE. Null when unresolved. */
  roleName: string | null;
  /** The exact string that was hashed. Differs from roleName when namespaced. */
  preimage: string | null;
  resolutionMethod: ResolutionMethod;
  /** Where the constant was found — address of the contract whose source declared it. */
  sourceContract?: string;
  /** 1-indexed line number in that contract's verifiedSource. For reasoning citations. */
  sourceLine?: number;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 1. Well-known standards                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const STANDARD_ROLE_NAMES = [
  'MINTER_ROLE',
  'BURNER_ROLE',
  'PAUSER_ROLE',
  'UNPAUSER_ROLE',
  'KEEPER_ROLE',
  'UPGRADER_ROLE',
  'OPERATOR_ROLE',
  'MANAGER_ROLE',
  'EXECUTOR_ROLE',
  'PROPOSER_ROLE',
  'CANCELLER_ROLE',
  'GUARDIAN_ROLE',
  'EMERGENCY_ADMIN_ROLE',
  'EMERGENCY_ROLE',
  'ADMIN_ROLE',
  'GOVERNOR_ROLE',
  'TIMELOCK_ADMIN_ROLE',
  'RESUME_ROLE',
  'PAUSE_ROLE',
  'ORACLE_ROLE',
  'REPORTER_ROLE',
  'SLASHER_ROLE',
  'REBALANCER_ROLE',
  'TREASURY_ROLE',
  'WITHDRAWAL_ROLE',
  'DEPOSIT_ROLE',
  'RELAYER_ROLE',
  'VALIDATOR_ROLE',
  'STAKING_ROLE',
  'FEE_SETTER_ROLE',
  'DEFAULT_ADMIN_ROLE',
] as const;

/** hash -> canonical name. DEFAULT_ADMIN_ROLE is special-cased to 32 zero bytes. */
export const STANDARD_ROLES: Record<string, string> = (() => {
  const table: Record<string, string> = { [ZERO_HASH]: 'DEFAULT_ADMIN_ROLE' };
  for (const name of STANDARD_ROLE_NAMES) {
    // DEFAULT_ADMIN_ROLE's on-chain value is zero bytes, not keccak("DEFAULT_ADMIN_ROLE").
    // Register the hashed form too — some non-OZ contracts genuinely do hash it.
    table[hash(name)] = name;
  }
  return table;
})();

/* ────────────────────────────────────────────────────────────────────────── */
/* 2. Comment stripping                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Remove Solidity comments while preserving byte offsets and line numbers.
 *
 * This is what defuses the decoy. OpenZeppelin's AccessControl.sol carries
 *
 *     /** ... bytes32 public constant MY_ROLE = keccak256("MY_ROLE"); ... *\/
 *
 * inside a documentation comment. A regex run over raw source happily extracts
 * MY_ROLE as a real role of the contract. Stripping comments first removes the
 * entire class of false positive, rather than trying to pattern-match "is this
 * line inside a docblock?" after the fact.
 *
 * The scanner is string-literal aware, so a `//` or `/*` inside a string (URLs
 * in revert messages, for instance) is not mistaken for a comment. Comment
 * characters are replaced with spaces and newlines are kept, so every surviving
 * index and line number still maps onto the original source.
 */
export function stripComments(source: string): string {
  const out: string[] = new Array(source.length);
  let i = 0;
  const n = source.length;

  type Mode = 'code' | 'line' | 'block' | 'dquote' | 'squote';
  let mode: Mode = 'code';

  while (i < n) {
    const c = source[i]!;
    const next = i + 1 < n ? source[i + 1]! : '';

    switch (mode) {
      case 'code':
        if (c === '/' && next === '/') {
          mode = 'line';
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (c === '/' && next === '*') {
          mode = 'block';
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (c === '"') mode = 'dquote';
        else if (c === "'") mode = 'squote';
        out[i] = c;
        i += 1;
        continue;

      case 'line':
        if (c === '\n') {
          mode = 'code';
          out[i] = '\n';
        } else {
          out[i] = ' ';
        }
        i += 1;
        continue;

      case 'block':
        if (c === '*' && next === '/') {
          mode = 'code';
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        out[i] = c === '\n' ? '\n' : ' ';
        i += 1;
        continue;

      case 'dquote':
      case 'squote': {
        const quote = mode === 'dquote' ? '"' : "'";
        if (c === '\\') {
          out[i] = c;
          if (i + 1 < n) out[i + 1] = next;
          i += 2;
          continue;
        }
        if (c === quote) mode = 'code';
        out[i] = c;
        i += 1;
        continue;
      }
    }
  }

  return out.join('');
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 3. Source constant extraction                                              */
/* ────────────────────────────────────────────────────────────────────────── */

export interface SourceConstant {
  /** Solidity identifier. */
  name: string;
  /** The literal that was actually hashed. */
  preimage: string;
  /** keccak256(preimage), lowercased. */
  roleHash: string;
  /** 1-indexed line in the ORIGINAL source. */
  line: number;
}

/**
 * Matches, across newlines:
 *   bytes32 [public|private|internal|constant|immutable ...] NAME = keccak256("LITERAL")
 * including the `bytes(...)` and `abi.encodePacked(...)` wrappers that appear in
 * the wild. Only single-string-literal forms are extracted — a multi-argument
 * `abi.encodePacked(a, b)` is not statically resolvable, so we skip it rather
 * than guess (and the caller records it as an unknown).
 */
const CONSTANT_RE =
  /bytes32\s+(?:(?:public|private|internal|external|constant|immutable|override)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*keccak256\s*\(\s*(?:bytes\s*\(\s*|abi\s*\.\s*encodePacked\s*\(\s*)?(["'])((?:[^"'\\]|\\.)*)\2\s*\)/g;

/**
 * Pull `bytes32 ... = keccak256("NAME")` declarations out of Solidity source.
 *
 * Returns a map keyed by role hash so the caller can look up by the hash Scout
 * observed on-chain. Comments are stripped first (see stripComments).
 */
export function extractSourceConstants(source: string): Map<string, SourceConstant> {
  const found = new Map<string, SourceConstant>();
  if (!source) return found;

  const stripped = stripComments(source);

  // Precompute line starts once so line lookup is O(log n) per match, not O(n).
  const lineStarts: number[] = [0];
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  CONSTANT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONSTANT_RE.exec(stripped)) !== null) {
    const name = m[1]!;
    const rawLiteral = m[3]!;
    // Solidity string escapes we care about for hashing fidelity.
    const preimage = rawLiteral
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');

    const roleHash = hash(preimage);
    if (!found.has(roleHash)) {
      found.set(roleHash, { name, preimage, roleHash, line: lineOf(m.index) });
    }
  }

  return found;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 4. Verification                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * §5 signature: given a name the model hypothesised, confirm or deny it.
 *
 * NOTE this is only correct when name === preimage (standards-table roles and
 * un-namespaced source constants). For namespaced roles use
 * `isVerifiedResolution`, which checks the preimage. Never trust an unverified
 * guess from either path.
 */
export function verifyRoleName(name: string, expectedHash: string): boolean {
  return hash(name).toLowerCase() === normalizeHash(expectedHash);
}

/**
 * The guard the Analyst actually enforces.
 *
 * A (name, preimage) pair is verified iff keccak256(preimage) equals the hash
 * Scout observed on-chain. When no preimage is known we fall back to hashing
 * the name, which is the §5 behaviour.
 */
export function isVerifiedResolution(
  name: string | null,
  preimage: string | null,
  expectedHash: string,
): boolean {
  if (!name) return false;
  const target = normalizeHash(expectedHash);
  if (preimage !== null) return hash(preimage).toLowerCase() === target;
  if (target === ZERO_HASH && name === 'DEFAULT_ADMIN_ROLE') return true;
  return verifyRoleName(name, expectedHash);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 5. Brute force                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Try every plausible casing/suffix permutation of a candidate.
 *
 * Used to confirm a name the model hypothesised when the source is unavailable.
 * Deliberately does NOT attempt to guess namespace prefixes — that space is
 * unbounded and a wrong guess that happened to collide would be exactly the
 * hallucinated-name failure this module exists to prevent.
 */
export function bruteForceCandidates(base: string): Array<{ name: string; hash: string }> {
  const cleaned = base.trim().replace(/\s+/g, '_');
  if (!cleaned) return [];

  const stem = cleaned.replace(/_ROLE$/i, '');
  const variants = new Set<string>();

  for (const form of [stem, stem.toUpperCase(), stem.toLowerCase()]) {
    variants.add(form);
    variants.add(`${form}_ROLE`);
    variants.add(`${form}_role`);
  }
  variants.add(cleaned);
  variants.add(cleaned.toUpperCase());
  variants.add(cleaned.toLowerCase());

  return [...variants].map((name) => ({ name, hash: hash(name) }));
}

/** Confirm a hypothesised name by permutation. Returns the matching variant, or null. */
export function resolveByBruteForce(
  base: string,
  expectedHash: string,
): { name: string; hash: string } | null {
  const target = normalizeHash(expectedHash);
  return bruteForceCandidates(base).find((c) => c.hash === target) ?? null;
}
