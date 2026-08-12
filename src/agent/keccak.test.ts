import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  hash,
  ZERO_HASH,
  STANDARD_ROLES,
  stripComments,
  extractSourceConstants,
  verifyRoleName,
  isVerifiedResolution,
  bruteForceCandidates,
  resolveByBruteForce,
} from './keccak.js';
import {
  resolveRoles,
  permissionKey,
  effectiveSourcesFor,
  computeCallStats,
  renderResolutionTable,
} from './resolve.js';
import type { EvidenceBundle } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): EvidenceBundle =>
  JSON.parse(readFileSync(join(here, '../../evals/fixtures', name), 'utf8')) as EvidenceBundle;

const PRIMARY = 'lido-l1-bridge.json';
const PROXY = '0x89057c7e4c5cd283aff5907b816f61e326047c29';
const IMPL = '0x7e1dbd017973871abcfac9e4b830018812056c17';

/** Ground truth from evals/role-classification.jsonl — verified against mainnet. */
const GROUND_TRUTH = [
  {
    roleHash: '0x4b43b36766bde12c5e9cbbc37d15f8d1f769f08f54720ab370faeb4ce893753a',
    roleName: 'DEPOSITS_ENABLER_ROLE',
    preimage: 'BridgingManager.DEPOSITS_ENABLER_ROLE',
  },
  {
    roleHash: '0x63f736f21cb2943826cd50b191eb054ebbea670e4e962d0527611f830cd399d6',
    roleName: 'DEPOSITS_DISABLER_ROLE',
    preimage: 'BridgingManager.DEPOSITS_DISABLER_ROLE',
  },
  {
    roleHash: '0x9ab8816a3dc0b3849ec1ac00483f6ec815b07eee2fd766a353311c823ad59d0d',
    roleName: 'WITHDRAWALS_ENABLER_ROLE',
    preimage: 'BridgingManager.WITHDRAWALS_ENABLER_ROLE',
  },
  {
    roleHash: '0x94a954c0bc99227eddbc0715a62a7e1056ed8784cd719c2303b685683908857c',
    roleName: 'WITHDRAWALS_DISABLER_ROLE',
    preimage: 'BridgingManager.WITHDRAWALS_DISABLER_ROLE',
  },
] as const;

describe('hash primitive', () => {
  it('is keccak256, NOT NIST SHA3-256', () => {
    // These differ for every input. Getting this wrong silently resolves nothing,
    // so anchor on the universally published empty-string digest.
    expect(hash('')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    expect(hash('')).not.toBe(
      '0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a', // sha3-256("")
    );
  });

  it('reproduces every ground-truth role hash from its preimage', () => {
    for (const { preimage, roleHash } of GROUND_TRUTH) {
      expect(hash(preimage)).toBe(roleHash);
    }
  });
});

describe('standards table', () => {
  it('maps 32 zero bytes to DEFAULT_ADMIN_ROLE', () => {
    expect(ZERO_HASH).toBe(`0x${'0'.repeat(64)}`);
    expect(STANDARD_ROLES[ZERO_HASH]).toBe('DEFAULT_ADMIN_ROLE');
  });

  it('never resolves DEFAULT_ADMIN_ROLE by hashing its name', () => {
    // keccak256("DEFAULT_ADMIN_ROLE") is a real hash and is NOT the zero-bytes
    // value the contract actually uses. Conflating them is a classic bug.
    expect(hash('DEFAULT_ADMIN_ROLE')).not.toBe(ZERO_HASH);
  });

  it('covers the common OZ roles', () => {
    for (const name of ['MINTER_ROLE', 'PAUSER_ROLE', 'KEEPER_ROLE', 'UPGRADER_ROLE']) {
      expect(STANDARD_ROLES[hash(name)]).toBe(name);
    }
  });
});

describe('stripComments', () => {
  it('removes line and block comments', () => {
    expect(stripComments('a // gone\nb').trim().split('\n')[0]!.trim()).toBe('a');
    expect(stripComments('x /* gone */ y')).toMatch(/x\s+y/);
  });

  it('preserves line numbers so source citations stay accurate', () => {
    const src = 'line1\n/* two\nthree */\nline4';
    expect(stripComments(src).split('\n')).toHaveLength(4);
  });

  it('does not treat // inside a string literal as a comment', () => {
    const src = 'string url = "https://example.com/x"; bytes32 a;';
    const out = stripComments(src);
    expect(out).toContain('https://example.com/x');
    expect(out).toContain('bytes32 a;');
  });

  it('does not treat /* inside a string literal as a comment opener', () => {
    const src = 'string s = "/* not a comment"; bytes32 kept;';
    expect(stripComments(src)).toContain('bytes32 kept;');
  });
});

describe('extractSourceConstants — real mainnet source', () => {
  const bundle = fixture(PRIMARY);
  const implSource = bundle.contracts[IMPL]!.verifiedSource!;
  const constants = extractSourceConstants(implSource);

  it('extracts the namespaced role constants by hashing the LITERAL, not the identifier', () => {
    for (const { roleHash, roleName, preimage } of GROUND_TRUTH) {
      const found = constants.get(roleHash);
      expect(found, `expected to resolve ${roleName}`).toBeDefined();
      expect(found!.name).toBe(roleName);
      expect(found!.preimage).toBe(preimage);
    }
  });

  it('reports a usable source line for reasoning citations', () => {
    const found = constants.get(GROUND_TRUTH[0].roleHash)!;
    expect(found.line).toBeGreaterThan(0);
    const line = implSource.split('\n')[found.line - 1] ?? '';
    expect(line).toContain('DEPOSITS_ENABLER_ROLE');
  });

  it('does NOT surface the MY_ROLE decoy hiding in an OpenZeppelin doc comment', () => {
    expect(implSource).toContain('MY_ROLE'); // the decoy really is in the source
    const names = [...constants.values()].map((c) => c.name);
    expect(names).not.toContain('MY_ROLE');
    expect(constants.has(hash('MY_ROLE'))).toBe(false);
  });

  it('handles the bytes() and abi.encodePacked() wrapper forms', () => {
    const src = `
      bytes32 public constant A = keccak256(bytes("AAA"));
      bytes32 internal constant B = keccak256(abi.encodePacked("BBB"));
      bytes32 private constant C = keccak256('CCC');
    `;
    const found = extractSourceConstants(src);
    expect(found.get(hash('AAA'))?.name).toBe('A');
    expect(found.get(hash('BBB'))?.name).toBe('B');
    expect(found.get(hash('CCC'))?.name).toBe('C');
  });
});

describe('verification guards', () => {
  it('the naive §5 check FAILS on namespaced roles — which is why preimages are tracked', () => {
    const { roleName, roleHash, preimage } = GROUND_TRUTH[0];
    // Hashing the identifier matches nothing. This is the documented trap.
    expect(verifyRoleName(roleName, roleHash)).toBe(false);
    // Verifying the preimage is what actually confirms the resolution.
    expect(isVerifiedResolution(roleName, preimage, roleHash)).toBe(true);
  });

  it('rejects a plausible but wrong name', () => {
    const { roleHash, preimage } = GROUND_TRUTH[0];
    expect(isVerifiedResolution('KEEPER_ROLE', 'KEEPER_ROLE', roleHash)).toBe(false);
    expect(isVerifiedResolution('DEPOSITS_ENABLER_ROLE', `WRONG.${preimage}`, roleHash)).toBe(false);
  });

  it('rejects a null name outright', () => {
    expect(isVerifiedResolution(null, null, ZERO_HASH)).toBe(false);
  });

  it('accepts DEFAULT_ADMIN_ROLE against zero bytes with no preimage', () => {
    expect(isVerifiedResolution('DEFAULT_ADMIN_ROLE', null, ZERO_HASH)).toBe(true);
  });
});

describe('bruteForceCandidates', () => {
  it('recovers a standard role from a bare stem', () => {
    expect(resolveByBruteForce('keeper', hash('KEEPER_ROLE'))?.name).toBe('KEEPER_ROLE');
    expect(resolveByBruteForce('MINTER', hash('MINTER_ROLE'))?.name).toBe('MINTER_ROLE');
  });

  it('returns null rather than guessing when nothing matches', () => {
    expect(resolveByBruteForce('keeper', GROUND_TRUTH[0].roleHash)).toBeNull();
  });

  it('does not attempt namespace prefixes', () => {
    const names = bruteForceCandidates('DEPOSITS_ENABLER_ROLE').map((c) => c.name);
    expect(names.some((n) => n.includes('.'))).toBe(false);
  });
});

describe('proxy traversal', () => {
  const bundle = fixture(PRIMARY);

  it('reaches the implementation source from the proxy address', () => {
    const sources = effectiveSourcesFor(bundle, PROXY);
    const impl = sources.find((s) => s.address.toLowerCase() === IMPL);
    expect(impl, 'implementation source must be reachable from the proxy').toBeDefined();
    expect(impl!.viaProxy).toBe(true);
    expect(impl!.proxyAddress?.toLowerCase()).toBe(PROXY);
    expect(impl!.source).toContain('BridgingManager.DEPOSITS_ENABLER_ROLE');
  });
});

describe('resolveRoles — end to end on the primary fixture', () => {
  const bundle = fixture(PRIMARY);
  const resolved = resolveRoles(bundle);

  it('resolves all five permissions with zero unresolved', () => {
    expect(bundle.permissions).toHaveLength(5);
    const methods = [...resolved.values()].map((r) => r.resolutionMethod);
    expect(methods).not.toContain('unresolved');
  });

  it('matches the hand-verified ground truth exactly', () => {
    for (const { roleHash, roleName, preimage } of GROUND_TRUTH) {
      const r = resolved.get(permissionKey(PROXY, roleHash))!;
      expect(r.roleName).toBe(roleName);
      expect(r.preimage).toBe(preimage);
      expect(r.resolutionMethod).toBe('source_constant');
      expect(isVerifiedResolution(r.roleName, r.preimage, roleHash)).toBe(true);
    }
  });

  it('resolves DEFAULT_ADMIN_ROLE from the standards table, not by hashing', () => {
    const r = resolved.get(permissionKey(PROXY, ZERO_HASH))!;
    expect(r.roleName).toBe('DEFAULT_ADMIN_ROLE');
    expect(r.resolutionMethod).toBe('known_standard');
    expect(r.preimage).toBeNull();
  });

  it('renders a resolution table that flags the namespacing', () => {
    const table = renderResolutionTable(bundle, resolved);
    expect(table).toContain('DEPOSITS_ENABLER_ROLE');
    expect(table).toContain('BridgingManager.DEPOSITS_ENABLER_ROLE');
    expect(table).toContain('namespaced');
    expect(table).not.toContain('UNRESOLVED');
  });
});

describe('resolveRoles — the other three real fixtures', () => {
  for (const name of ['lido-bridge-2.json', 'lido-voting-target.json', 'single-role.json']) {
    it(`resolves every permission in ${name}`, () => {
      const bundle = fixture(name);
      const resolved = resolveRoles(bundle);
      expect(resolved.size).toBe(bundle.permissions.length);
      for (const [, r] of resolved) {
        if (r.resolutionMethod !== 'unresolved') {
          expect(isVerifiedResolution(r.roleName, r.preimage, r.roleHash)).toBe(true);
        }
      }
    });
  }
});

describe('computeCallStats', () => {
  const bundle = fixture(PRIMARY);

  it('returns zero for the empty callHistory these fixtures carry', () => {
    expect(bundle.callHistory).toHaveLength(0);
    expect(computeCallStats(bundle, PROXY, ['enableDeposits'])).toEqual({
      observedCalls: 0,
      lastCalledBlock: null,
    });
  });

  it('sums counts and takes the max block, matching by name and tolerating signatures', () => {
    const withHistory: EvidenceBundle = {
      ...bundle,
      callHistory: [
        { contract: PROXY, selector: '0x1', functionName: 'performUpkeep', count: 400, firstBlock: 10, lastBlock: 900 },
        { contract: PROXY, selector: '0x2', functionName: 'performUpkeep', count: 12, firstBlock: 20, lastBlock: 950 },
        { contract: PROXY, selector: '0x3', functionName: 'unrelated', count: 99, firstBlock: 1, lastBlock: 9999 },
      ],
    };
    expect(computeCallStats(withHistory, PROXY, ['performUpkeep(bytes)'])).toEqual({
      observedCalls: 412,
      lastCalledBlock: 950,
    });
  });

  it('ignores calls to a different contract', () => {
    const withHistory: EvidenceBundle = {
      ...bundle,
      callHistory: [
        { contract: IMPL, selector: '0x1', functionName: 'enableDeposits', count: 5, firstBlock: 1, lastBlock: 2 },
      ],
    };
    expect(computeCallStats(withHistory, PROXY, ['enableDeposits']).observedCalls).toBe(0);
  });
});
