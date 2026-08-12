/**
 * Deterministic guarantees across the whole fixture set.
 *
 * These assert what the pre-pass does WITHOUT a model call, so they run in
 * milliseconds and gate every commit. The model-dependent scores live in the
 * eval suite (`npm run eval`).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { hash, ZERO_HASH, isVerifiedResolution } from './keccak.js';
import { resolveRoles, permissionKey } from './resolve.js';
import { EvidenceBundleSchema } from './schemas.js';
import type { EvidenceBundle } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '../../evals/fixtures');
const load = (name: string): EvidenceBundle =>
  JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as EvidenceBundle;

const bundleFiles = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json') && !f.startsWith('shadow-'))
  .sort();

describe('every EvidenceBundle fixture is schema-valid', () => {
  for (const file of bundleFiles) {
    it(file, () => {
      const parsed = EvidenceBundleSchema.safeParse(load(file));
      if (!parsed.success) console.error(file, parsed.error.issues.slice(0, 4));
      expect(parsed.success).toBe(true);
    });
  }
});

describe('resolution never guesses', () => {
  for (const file of bundleFiles) {
    it(`${file}: every resolved name is keccak-verified`, () => {
      const bundle = load(file);
      for (const [, r] of resolveRoles(bundle)) {
        if (r.resolutionMethod === 'unresolved') {
          expect(r.roleName).toBeNull();
        } else {
          expect(isVerifiedResolution(r.roleName, r.preimage, r.roleHash)).toBe(true);
        }
      }
    });
  }
});

describe('§5 failure-mode coverage', () => {
  it('the failure-mode table is represented in the fixture set', () => {
    for (const required of [
      'edge-no-source.json',
      'edge-unresolvable.json',
      'edge-empty.json',
      'edge-inherited-base.json',
      'edge-active-keeper.json',
    ]) {
      expect(bundleFiles).toContain(required);
    }
  });

  it('edge-no-source: verifiedSource is null and nothing is invented', () => {
    const bundle = load('edge-no-source.json');
    const contract = Object.values(bundle.contracts)[0]!;
    expect(contract.verifiedSource).toBeNull();

    const resolved = resolveRoles(bundle);
    // OPERATOR_ROLE is in the standards table, so it resolves even with no source.
    const operator = resolved.get(permissionKey(contract.address, hash('OPERATOR_ROLE')))!;
    expect(operator.roleName).toBe('OPERATOR_ROLE');
    expect(operator.resolutionMethod).toBe('known_standard');

    // The other one cannot be resolved by any means and must stay null.
    const unresolvable = [...resolved.values()].filter((r) => r.resolutionMethod === 'unresolved');
    expect(unresolvable).toHaveLength(1);
    expect(unresolvable[0]!.roleName).toBeNull();
  });

  it('edge-unresolvable: a hash matching no constant stays unresolved despite good source', () => {
    const bundle = load('edge-unresolvable.json');
    const resolved = [...resolveRoles(bundle).values()];
    expect(resolved.filter((r) => r.resolutionMethod === 'source_constant')).toHaveLength(1);
    const unresolved = resolved.filter((r) => r.resolutionMethod === 'unresolved');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.roleName).toBeNull();
  });

  it('edge-empty: an empty bundle resolves to nothing without throwing', () => {
    const bundle = load('edge-empty.json');
    expect(bundle.permissions).toHaveLength(0);
    expect(() => resolveRoles(bundle)).not.toThrow();
    expect(resolveRoles(bundle).size).toBe(0);
  });

  it('edge-inherited-base: the absent base leaves the role for the model to hypothesise', () => {
    const bundle = load('edge-inherited-base.json');
    const resolved = resolveRoles(bundle);
    const contract = Object.values(bundle.contracts)[0]!;

    // SETTLEMENT_ROLE is USED in the source but DECLARED in an absent import,
    // so the deterministic pass cannot see it. That is the point of this case:
    // it is the only route to resolutionMethod 'brute_force'.
    const settlement = resolved.get(permissionKey(contract.address, hash('SETTLEMENT_ROLE')))!;
    expect(settlement.resolutionMethod).toBe('unresolved');
    expect(contract.verifiedSource).toContain('onlyRole(SETTLEMENT_ROLE)');
    expect(contract.verifiedSource).not.toContain('constant SETTLEMENT_ROLE');

    // ...and if the model proposes the obvious name, brute force confirms it.
    expect(isVerifiedResolution('SETTLEMENT_ROLE', 'SETTLEMENT_ROLE', hash('SETTLEMENT_ROLE'))).toBe(true);
  });

  it('edge-active-keeper: gives the eval set a clear-cut load_bearing/vestigial pair', () => {
    const bundle = load('edge-active-keeper.json');
    expect(bundle.callHistory.length).toBeGreaterThan(0);

    const called = bundle.callHistory.map((c) => c.functionName);
    expect(called).toContain('performUpkeep');
    // setFeeRecipient exists in source but was never called — the vestigial half.
    expect(called).not.toContain('setFeeRecipient');
    expect(Object.values(bundle.contracts)[0]!.verifiedSource).toContain('setFeeRecipient');

    const resolved = resolveRoles(bundle);
    expect(resolved.get(permissionKey(bundle.permissions[0]!.contract, ZERO_HASH))?.roleName).toBe(
      'DEFAULT_ADMIN_ROLE',
    );
  });
});
