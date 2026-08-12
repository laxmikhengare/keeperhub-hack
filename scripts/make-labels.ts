/**
 * Emit the eval label sets.
 *
 *   npx tsx scripts/make-labels.ts
 *
 * Role hashes are read out of the fixtures rather than typed by hand, so a
 * label can never drift from the permission it is labelling.
 *
 * CLASSIFICATION LABELS ARE PROPOSALS. They are judgment calls, and the ones
 * marked `contested` are the ones I'd most want a second opinion on before
 * they are treated as ground truth. Everything else follows directly from the
 * §5 rule that the discriminator is the consequence of revoking, not the call
 * count.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveRoles, permissionKey } from '../src/agent/resolve.js';
import { normalizeHash } from '../src/agent/keccak.js';
import type { EvidenceBundle } from '../src/agent/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '../evals/fixtures');
const evalsDir = join(here, '../evals');

type Classification = 'load_bearing' | 'vestigial' | 'unknown';

interface Label {
  classification: Classification;
  note: string;
  contested?: boolean;
  /**
   * Override the expectation when the deterministic pre-pass cannot resolve the
   * role but the full pipeline should. Only SETTLEMENT_ROLE needs this: its
   * constant lives in an absent import, so resolveRoles() reports unresolved,
   * while analyze() should have the model propose the name and code confirm it
   * by brute force.
   */
  expectRoleName?: string;
  expectResolutionMethod?: 'source_constant' | 'known_standard' | 'brute_force' | 'unresolved';
}

/** Keyed by resolved role name, or by raw hash when the role does not resolve. */
type FixtureLabels = Record<string, Label>;

const EMERGENCY_PAIR = (what: string): Label => ({
  classification: 'load_bearing',
  note: `Emergency control on a live contract with zero call history. Never firing is what a working kill switch looks like — revoking removes a holder of ${what}, so the discriminator is the consequence of revoking, not the call count.`,
});

const bridgeLabels: FixtureLabels = {
  DEPOSITS_ENABLER_ROLE: EMERGENCY_PAIR('the only path to re-enable deposits after a pause'),
  DEPOSITS_DISABLER_ROLE: EMERGENCY_PAIR('the ability to halt deposits into the bridge'),
  WITHDRAWALS_ENABLER_ROLE: EMERGENCY_PAIR('the only path to restore withdrawal finalization'),
  WITHDRAWALS_DISABLER_ROLE: EMERGENCY_PAIR('the ability to stop withdrawal finalization if L2 is compromised'),
  DEFAULT_ADMIN_ROLE: {
    classification: 'load_bearing',
    note: 'Admin of every role on this AccessControl instance; gates grantRole/revokeRole for all four bridging roles. Revoking blindly risks leaving role administration unreachable.',
  },
};

const LABELS: Record<string, FixtureLabels> = {
  'lido-l1-bridge.json': bridgeLabels,
  'lido-bridge-2.json': bridgeLabels,

  'lido-voting-target.json': {
    PAUSE_ROLE: {
      classification: 'load_bearing',
      note: 'Gates pause() on EasyTrack, halting motion creation and enactment. Emergency control, never exercised.',
    },
    UNPAUSE_ROLE: {
      classification: 'load_bearing',
      note: 'Gates unpause(). The recovery half of the pause pair — without a holder, a paused EasyTrack cannot be restarted.',
    },
    CANCEL_ROLE: {
      classification: 'load_bearing',
      note: 'Gates cancelMotions() and cancelAllMotions(). The control that stops an erroneous or malicious governance motion from enacting.',
    },
    DEFAULT_ADMIN_ROLE: {
      classification: 'load_bearing',
      note: 'Administers the three EasyTrack roles above.',
    },
  },

  'single-role.json': {
    DEFAULT_ADMIN_ROLE: {
      classification: 'load_bearing',
      note: 'The only permission in the bundle, and it is role administration for the whole contract.',
    },
  },

  'edge-no-source.json': {
    OPERATOR_ROLE: {
      classification: 'unknown',
      note: 'verifiedSource is null. The keeper made 1,284 settleEpoch calls, but nothing in the bundle proves OPERATOR_ROLE is what gates settleEpoch — the ABI shows the function, not its modifier. §5 says fall back to ABI + call history with low confidence and do not invent the link.',
      contested: true,
    },
    '0x7c1e9b4a08f3d25e6a0b93cc47182fd05e6a3b91c8d472fa15e0937b62c48ad3': {
      classification: 'unknown',
      note: 'No source and no standards match. Nothing can be said about it. Must appear in declaredUnknowns.',
    },
  },

  'edge-unresolvable.json': {
    HARVESTER_ROLE: {
      classification: 'load_bearing',
      note: 'Resolves from source; gates harvest(); 806 calls ending 400 blocks ago. Active production automation.',
    },
    '0x3d9f0c71a2e845bb61c0f38d94a7e2150b6c48fa3e97d215806b4cf39e1a7d62': {
      classification: 'unknown',
      note: 'Source parses cleanly and declares exactly one role constant, which is not this hash. The role is real on-chain but unexplained by this bundle. Never guess a name.',
    },
  },

  'edge-inherited-base.json': {
    // Keyed by hash: the deterministic pass cannot resolve this one by design.
    '0x300f9ae985dc711960f7a4d1dd013f9c19ecf40bff149522ab7523b2187a3846': {
      expectRoleName: 'SETTLEMENT_ROLE',
      expectResolutionMethod: 'brute_force',
      classification: 'load_bearing',
      note: 'Gates settle(); 2,451 calls ending 60 blocks ago. The constant is declared in an absent import, so the name must come from the model and be confirmed by brute force — the only row that exercises resolutionMethod "brute_force".',
    },
    PAUSER_ROLE: {
      classification: 'load_bearing',
      note: 'Standards-table role gating pause() on a contract with live settlement traffic. Emergency control, never called.',
    },
  },

  'edge-active-keeper.json': {
    KEEPER_ROLE: {
      classification: 'load_bearing',
      note: '8,642 performUpkeep calls ending 240 blocks ago, and the upkeep registration names performUpkeep explicitly. The unambiguous positive case.',
    },
    FEE_SETTER_ROLE: {
      classification: 'vestigial',
      note: 'Gates setFeeRecipient(), which the source documents as an operational convenience held by several admins. Zero calls across 1.2M blocks. Not an emergency control — nothing is lost by revoking.',
    },
    DEFAULT_ADMIN_ROLE: {
      classification: 'load_bearing',
      note: 'Role administration for the automation roles above.',
    },
  },

  'edge-proxy-no-impl.json': {
    MINTER_ROLE: {
      classification: 'unknown',
      note: 'The name resolves from the standards table, but implementationAddress points at a contract absent from the bundle, so what it guards is invisible. Resolvable name, unknowable function.',
    },
    DEFAULT_ADMIN_ROLE: {
      classification: 'unknown',
      note: 'Same: the proxy source is a bare EIP-1967 forwarder with no access-control logic. Whether this contract even uses AccessControl cannot be determined without the implementation.',
      contested: true,
    },
  },

  'edge-vestigial.json': {
    KEEPER_ROLE: {
      classification: 'load_bearing',
      note: '5,204 performUpkeep calls ending 120 blocks ago. Anchors the fixture so it is not uniformly negative.',
    },
    METADATA_ROLE: {
      classification: 'vestigial',
      note: 'Gates setBaseURI(); cosmetic, zero calls, and the source records three other operators holding the role. Revoking costs nothing.',
    },
    ALLOWLIST_ROLE: {
      classification: 'vestigial',
      note: 'Gates addToAllowlist(), which reverts unconditionally because allowlistActive has been false since deployment. The function has no reachable effect.',
    },
  },
};

/* ── Emit ─────────────────────────────────────────────────────────────────── */

const rows: string[] = [];
const tally: Record<Classification, number> = { load_bearing: 0, vestigial: 0, unknown: 0 };

for (const fixture of Object.keys(LABELS).sort()) {
  const bundle = JSON.parse(readFileSync(join(fixturesDir, fixture), 'utf8')) as EvidenceBundle;
  const resolved = resolveRoles(bundle);
  const labels = LABELS[fixture]!;
  const used = new Set<string>();

  bundle.permissions.forEach((perm, i) => {
    const r = resolved.get(permissionKey(perm.contract, perm.roleHash))!;
    const hashKey = normalizeHash(perm.roleHash);
    const key = r.roleName && labels[r.roleName] ? r.roleName : hashKey;
    const label = labels[key];

    if (!label) {
      throw new Error(`no label for ${fixture} ${hashKey} (${r.roleName ?? 'unresolved'})`);
    }
    used.add(key);
    tally[label.classification] += 1;

    rows.push(
      JSON.stringify({
        id: `${fixture.replace(/\.json$/, '')}-${String(i + 1).padStart(2, '0')}`,
        fixture,
        contract: perm.contract.toLowerCase(),
        roleHash: hashKey,
        expected: {
          roleName: label.expectRoleName ?? r.roleName,
          resolutionMethod: label.expectResolutionMethod ?? r.resolutionMethod,
          classification: label.classification,
        },
        ...(label.contested ? { contested: true } : {}),
        note: label.note,
      }),
    );
  });

  for (const k of Object.keys(labels)) {
    if (!used.has(k)) throw new Error(`unused label ${fixture} -> ${k}`);
  }
}

writeFileSync(join(evalsDir, 'role-classification.jsonl'), rows.join('\n') + '\n');

const total = rows.length;
const majority = Math.max(...Object.values(tally));
console.log(`role-classification.jsonl  ${total} rows`);
console.log(`  load_bearing ${tally.load_bearing}  vestigial ${tally.vestigial}  unknown ${tally.unknown}`);
console.log(`  majority-class baseline: ${((majority / total) * 100).toFixed(1)}%  <- a constant guess scores this`);

/* ── Adjudication ─────────────────────────────────────────────────────────── */

const adjudication = [
  ['twin-a-benign', 'shadow-benign.json', 'ready', 'MANDATORY TWIN. 97% agreement, 3 disagreements, all timing jitter inside a 3600s window.'],
  ['twin-b-regression', 'shadow-regression.json', 'not_ready', 'MANDATORY TWIN. 97% agreement — identical to twin A — but one missed liquidation inside a 24s window.'],
  ['perfect-run', 'shadow-perfect.json', 'ready', '100% agreement, zero disagreements. The trivial pass.'],
  ['low-agreement-benign', 'shadow-low-agreement-benign.json', 'ready', 'Only 80% agreement, yet every disagreement is the old keeper firing needlessly. Proves a LOW rate must not block a cutover — the mirror of the twins.'],
  ['single-miss-high-agreement', 'shadow-single-miss.json', 'not_ready', '99% agreement — higher than the benign twin — with exactly one dropped liquidation. Any threshold that passes twin A passes this too.'],
  ['null-tolerance-window', 'shadow-null-tolerance.json', 'not_ready', 'toleranceWindowSeconds is null. The delay may be harmless but nothing proves it; unproven is not safe.'],
  ['new-workflow-acted-wrongly', 'shadow-acted-wrongly.json', 'not_ready', 'The inverse regression: the new workflow would liquidate a solvent position on a stale cached price. Acting wrongly is as disqualifying as failing to act.'],
  ['no-observations', 'shadow-no-observations.json', 'not_ready', 'Zero observations, so agreementRate is vacuously 1.0. Perfect agreement with no evidence must not clear a cutover.'],
] as const;

writeFileSync(
  join(evalsDir, 'adjudication.jsonl'),
  adjudication
    .map(([id, reportPath, verdict, note]) =>
      JSON.stringify({ id, reportPath, expected: { verdict }, note }),
    )
    .join('\n') + '\n',
);

console.log(`\nadjudication.jsonl         ${adjudication.length} rows`);
console.log(`  ready ${adjudication.filter((a) => a[2] === 'ready').length}  not_ready ${adjudication.filter((a) => a[2] === 'not_ready').length}`);
