/**
 * Build the ShadowReport fixture set for the adjudication evals.
 *
 *   npx tsx scripts/make-shadow-fixtures.ts
 *
 * These two are the demo. Both carry exactly 100 observations with exactly 3
 * disagreements, so both land on an agreement rate of precisely 0.97 — the
 * number is asserted in the eval suite, not eyeballed. The correct verdicts are
 * opposite. No threshold can produce both, which is the whole argument for the
 * Adjudicator being an agent rather than an `if`.
 *
 * The discriminator is entirely in jobSemantics:
 *
 *   benign      tolerance 3600s  — a missed beat is recoverable on the next tick
 *   regression  tolerance   24s  — two blocks, then the position is gone
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { PermissionAnalysis, ShadowReport } from '../src/agent/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '../evals/fixtures');

const BLOCK_TIME = 12;
const START_BLOCK = 21_400_000;
const START_TS = 1_735_689_600;
const TOTAL = 100;

/** Both reports quote the same upstream analysis shape; only semantics differ. */
function analysisFor(contract: string, roleName: string, fn: string): PermissionAnalysis {
  return {
    permissions: [
      {
        contract,
        roleHash: '0x4b43b36766bde12c5e9cbbc37d15f8d1f769f08f54720ab370faeb4ce893753a',
        roleName,
        resolutionMethod: 'source_constant',
        gatedFunctions: [fn],
        observedCalls: 412,
        lastCalledBlock: START_BLOCK - 40,
        classification: 'load_bearing',
        confidence: 0.94,
        reasoning: `role gates ${fn}; 412 observed calls by this keeper, most recently 40 blocks before the shadow window → load_bearing`,
      },
    ],
    automationIntent: {
      triggerKind: 'block',
      conditionSummary: 'Checks every block whether the guarded action is currently required.',
      conditionCall: { contract, fn: 'checkUpkeep', args: ['0x'] },
      action: { contract, fn, args: ['0x'] },
      confidence: 0.9,
      reasoning: 'Upkeep registration exposes checkUpkeep/performUpkeep and the call history is dense and regular.',
    },
    declaredUnknowns: [],
  };
}

interface Disagreement {
  /** Index into the observation series. */
  at: number;
  groundTruthReason: string;
  newWorkflowReason: string;
  chainState: Record<string, string>;
}

function build(opts: {
  contract: string;
  jobSemantics: ShadowReport['jobSemantics'];
  analysis: PermissionAnalysis;
  disagreements: Disagreement[];
  agreeState: (i: number) => Record<string, string>;
  agreeGroundTruthReason: string;
  agreeNewWorkflowReason: string;
}): ShadowReport {
  const byIndex = new Map(opts.disagreements.map((d) => [d.at, d]));
  const observations: ShadowReport['observations'] = [];

  for (let i = 0; i < TOTAL; i++) {
    const block = START_BLOCK + i * 5;
    const timestamp = START_TS + i * 5 * BLOCK_TIME;
    const d = byIndex.get(i);

    if (d) {
      // Every disagreement in both twins has the same surface shape:
      // ground truth acted, the new workflow did not. Only the semantics and
      // the chain state distinguish harmless from fatal.
      observations.push({
        block,
        timestamp,
        groundTruth: { shouldAct: true, reason: d.groundTruthReason },
        newWorkflow: { wouldAct: false, reason: d.newWorkflowReason },
        chainState: d.chainState,
      });
    } else {
      const act = i % 7 === 0;
      observations.push({
        block,
        timestamp,
        groundTruth: { shouldAct: act, reason: act ? opts.agreeGroundTruthReason : 'Condition not met; no action required.' },
        newWorkflow: { wouldAct: act, reason: act ? opts.agreeNewWorkflowReason : 'Condition not met; no action required.' },
        chainState: opts.agreeState(i),
      });
    }
  }

  return {
    analysis: opts.analysis,
    jobSemantics: opts.jobSemantics,
    observations,
    windowBlocks: TOTAL * 5,
    averageBlockTimeSeconds: BLOCK_TIME,
  };
}

/* ── TWIN A — benign. 97% agreement, correct verdict: ready ───────────────── */

const BENIGN_CONTRACT = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';

const benign = build({
  contract: BENIGN_CONTRACT,
  analysis: analysisFor(BENIGN_CONTRACT, 'KEEPER_ROLE', 'compoundRewards'),
  jobSemantics: {
    description:
      'Compounds accrued staking rewards back into the vault. Runs opportunistically whenever pending rewards exceed the gas cost of compounding.',
    targetContract: BENIGN_CONTRACT,
    // One hour. The action is economically motivated, not deadline-bound.
    toleranceWindowSeconds: 3600,
    consequenceOfMissedAction:
      'Rewards continue accruing and are compounded on the next run. A delayed compound costs a negligible amount of foregone yield; nothing is lost and no position is at risk.',
  },
  agreeGroundTruthReason: 'Pending rewards exceed the compounding threshold; compound.',
  agreeNewWorkflowReason: 'Pending rewards exceed the compounding threshold; compound.',
  agreeState: (i) => ({
    pendingRewardsWei: `${1_200_000_000_000_000_000n + BigInt(i) * 40_000_000_000_000_000n}`,
    thresholdWei: '1000000000000000000',
    secondsSinceLastCompound: `${600 + i * 3}`,
  }),
  disagreements: [
    {
      at: 18,
      groundTruthReason: 'Pending rewards just crossed the threshold; old keeper compounds immediately.',
      newWorkflowReason:
        'Pending rewards are 0.4% above threshold but gas price is elevated; waits for the next block window to compound more efficiently. Would act within ~2 blocks.',
      chainState: {
        pendingRewardsWei: '1004000000000000000',
        thresholdWei: '1000000000000000000',
        secondsSinceLastCompound: '655',
        gasPriceGwei: '84',
      },
    },
    {
      at: 51,
      groundTruthReason: 'Threshold crossed; old keeper compounds on the same block.',
      newWorkflowReason:
        'Threshold crossed by 0.2%; defers one block to batch with the pending harvest. Would act at the next observation.',
      chainState: {
        pendingRewardsWei: '1002000000000000000',
        thresholdWei: '1000000000000000000',
        secondsSinceLastCompound: '712',
        gasPriceGwei: '61',
      },
    },
    {
      at: 77,
      groundTruthReason: 'Threshold crossed; old keeper compounds.',
      newWorkflowReason:
        'Threshold crossed by 0.1%; waits one block for a cheaper slot. Would act at the next observation.',
      chainState: {
        pendingRewardsWei: '1001000000000000000',
        thresholdWei: '1000000000000000000',
        secondsSinceLastCompound: '688',
        gasPriceGwei: '77',
      },
    },
  ],
});

/* ── TWIN B — regression. 97% agreement, correct verdict: not_ready ───────── */

const RISK_CONTRACT = '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9';

const regression = build({
  contract: RISK_CONTRACT,
  analysis: analysisFor(RISK_CONTRACT, 'LIQUIDATOR_ROLE', 'liquidatePosition'),
  jobSemantics: {
    description:
      'Liquidates undercollateralized borrow positions. Must fire while the position is still liquidatable — the protocol only tolerates a two-block grace period before bad debt is socialised.',
    targetContract: RISK_CONTRACT,
    // Two blocks. This single number is the entire difference from the twin.
    toleranceWindowSeconds: 24,
    consequenceOfMissedAction:
      'The position falls below the liquidation floor and becomes bad debt absorbed by the protocol reserve. Depositors take the loss; the action cannot be retried after the window closes.',
  },
  agreeGroundTruthReason: 'Health factor below 1.0; liquidate.',
  agreeNewWorkflowReason: 'Health factor below 1.0; liquidate.',
  agreeState: (i) => ({
    healthFactor: i % 7 === 0 ? '0.981' : '1.264',
    positionSizeUsd: `${250_000 + i * 1_500}`,
    blocksUntilBadDebt: i % 7 === 0 ? '2' : 'n/a',
  }),
  disagreements: [
    {
      // Benign: old keeper fired on a position that was actually still healthy.
      at: 23,
      groundTruthReason: 'Old keeper submitted a liquidation for this position.',
      newWorkflowReason:
        'Health factor is 1.031 — above the liquidation floor. Position is not liquidatable; declines to act.',
      chainState: {
        healthFactor: '1.031',
        positionSizeUsd: '284000',
        blocksUntilBadDebt: 'n/a',
        oracleStalenessSeconds: '4',
      },
    },
    {
      // Benign: same wasteful pattern.
      at: 60,
      groundTruthReason: 'Old keeper submitted a liquidation for this position.',
      newWorkflowReason:
        'Health factor is 1.007 — marginally above the floor. Liquidating would revert; declines to act.',
      chainState: {
        healthFactor: '1.007',
        positionSizeUsd: '312500',
        blocksUntilBadDebt: 'n/a',
        oracleStalenessSeconds: '6',
      },
    },
    {
      // THE REGRESSION. Genuinely liquidatable, inside the two-block window,
      // and the new workflow sits it out on a stale-oracle guard.
      at: 84,
      groundTruthReason:
        'Health factor 0.972, position is liquidatable and inside the two-block grace period; old keeper liquidates.',
      newWorkflowReason:
        'Oracle price is 19 seconds old and the freshness guard requires <15s; skips this position rather than acting on data it considers stale.',
      chainState: {
        healthFactor: '0.972',
        positionSizeUsd: '1180000',
        blocksUntilBadDebt: '2',
        oracleStalenessSeconds: '19',
      },
    },
  ],
});

/* ── Supporting scenarios ─────────────────────────────────────────────────── */
/* The twins carry the argument; these stop the eval set from being a two-row  */
/* demo and cover the shapes the Adjudicator must not get wrong.               */

/** No disagreements at all. Trivially ready. */
const perfect = build({
  contract: BENIGN_CONTRACT,
  analysis: analysisFor(BENIGN_CONTRACT, 'KEEPER_ROLE', 'compoundRewards'),
  jobSemantics: benign.jobSemantics,
  agreeGroundTruthReason: 'Pending rewards exceed the compounding threshold; compound.',
  agreeNewWorkflowReason: 'Pending rewards exceed the compounding threshold; compound.',
  agreeState: (i) => ({ pendingRewardsWei: `${1_200_000_000_000_000_000n + BigInt(i) * 40_000_000_000_000_000n}`, thresholdWei: '1000000000000000000' }),
  disagreements: [],
});

/**
 * THE MIRROR OF THE TWINS. Agreement is only 80% — far below any threshold
 * anyone would pick — yet every single disagreement is the old keeper firing
 * needlessly. The new workflow is strictly better. Correct verdict: ready.
 *
 * The twins prove a high rate cannot clear a cutover. This proves a low rate
 * cannot block one. Together they close the argument from both sides.
 */
const lowAgreementBenign = build({
  contract: RISK_CONTRACT,
  analysis: analysisFor(RISK_CONTRACT, 'LIQUIDATOR_ROLE', 'liquidatePosition'),
  jobSemantics: {
    description: 'Liquidates undercollateralized borrow positions. The old keeper submitted speculatively on every candidate; most attempts reverted.',
    targetContract: RISK_CONTRACT,
    toleranceWindowSeconds: 24,
    consequenceOfMissedAction: 'The position falls below the liquidation floor and becomes bad debt absorbed by the protocol reserve.',
  },
  agreeGroundTruthReason: 'Health factor below 1.0; liquidate.',
  agreeNewWorkflowReason: 'Health factor below 1.0; liquidate.',
  agreeState: (i) => ({ healthFactor: i % 7 === 0 ? '0.978' : '1.301', blocksUntilBadDebt: i % 7 === 0 ? '2' : 'n/a' }),
  disagreements: Array.from({ length: 20 }, (_, k) => ({
    at: 2 + k * 5,
    groundTruthReason: 'Old keeper submitted a liquidation for this position.',
    newWorkflowReason: 'Health factor is above the liquidation floor; the call would revert. Declines to act.',
    chainState: { healthFactor: (1.02 + k * 0.004).toFixed(3), blocksUntilBadDebt: 'n/a', oracleStalenessSeconds: '3' },
  })),
});

/**
 * 99% agreement — higher than the benign twin — with exactly one dropped
 * liquidation. Correct verdict: not_ready. A threshold tuned to pass the
 * benign twin at 97% would wave this through.
 */
const singleMiss = build({
  contract: RISK_CONTRACT,
  analysis: analysisFor(RISK_CONTRACT, 'LIQUIDATOR_ROLE', 'liquidatePosition'),
  jobSemantics: regression.jobSemantics,
  agreeGroundTruthReason: 'Health factor below 1.0; liquidate.',
  agreeNewWorkflowReason: 'Health factor below 1.0; liquidate.',
  agreeState: (i) => ({ healthFactor: i % 7 === 0 ? '0.983' : '1.288', blocksUntilBadDebt: i % 7 === 0 ? '2' : 'n/a' }),
  disagreements: [
    {
      at: 44,
      groundTruthReason: 'Health factor 0.964 with two blocks before bad debt; old keeper liquidates.',
      newWorkflowReason: 'Position size exceeds the per-transaction cap configured in the new job; skips rather than partially liquidating.',
      chainState: { healthFactor: '0.964', positionSizeUsd: '4200000', blocksUntilBadDebt: '2', perTxCapUsd: '2000000' },
    },
  ],
});

/**
 * toleranceWindowSeconds is null. The delay may well be harmless, but nothing
 * in the evidence proves it. Correct verdict: not_ready — unproven, not safe.
 */
const nullTolerance = build({
  contract: BENIGN_CONTRACT,
  analysis: analysisFor(BENIGN_CONTRACT, 'KEEPER_ROLE', 'rebalance'),
  jobSemantics: {
    description: 'Rebalances the vault between strategies when allocation drifts past its band.',
    targetContract: BENIGN_CONTRACT,
    toleranceWindowSeconds: null,
    consequenceOfMissedAction: 'Unknown. The protocol documentation does not state a deadline for rebalancing, and the drift penalty has not been characterised.',
  },
  agreeGroundTruthReason: 'Allocation drift exceeds the band; rebalance.',
  agreeNewWorkflowReason: 'Allocation drift exceeds the band; rebalance.',
  agreeState: (i) => ({ driftBps: `${40 + (i % 9) * 12}`, bandBps: '100' }),
  disagreements: [
    {
      at: 30,
      groundTruthReason: 'Drift crossed the band; old keeper rebalances immediately.',
      newWorkflowReason: 'Drift crossed the band by 3 bps; defers ~4 blocks to await a deeper liquidity window.',
      chainState: { driftBps: '103', bandBps: '100', poolDepthUsd: '840000' },
    },
    {
      at: 71,
      groundTruthReason: 'Drift crossed the band; old keeper rebalances.',
      newWorkflowReason: 'Drift crossed by 2 bps; defers ~4 blocks for the same reason.',
      chainState: { driftBps: '102', bandBps: '100', poolDepthUsd: '910000' },
    },
  ],
});

/**
 * The inverse regression: the new workflow ACTS when ground truth says it must
 * not, in a context where acting is destructive. Correct verdict: not_ready.
 * Everything else in the set has the shape "old acted, new did not".
 */
const actedWrongly = build({
  contract: RISK_CONTRACT,
  analysis: analysisFor(RISK_CONTRACT, 'LIQUIDATOR_ROLE', 'liquidatePosition'),
  jobSemantics: {
    description: 'Liquidates undercollateralized positions. Liquidation is irreversible and seizes collateral from the borrower.',
    targetContract: RISK_CONTRACT,
    toleranceWindowSeconds: 24,
    consequenceOfMissedAction: 'A missed liquidation becomes bad debt. A WRONGFUL liquidation seizes a solvent borrower\'s collateral and cannot be reversed.',
  },
  agreeGroundTruthReason: 'Health factor below 1.0; liquidate.',
  agreeNewWorkflowReason: 'Health factor below 1.0; liquidate.',
  agreeState: (i) => ({ healthFactor: i % 7 === 0 ? '0.979' : '1.277', blocksUntilBadDebt: i % 7 === 0 ? '2' : 'n/a' }),
  disagreements: [],
});
// Hand-build the inverted disagreements: ground truth says DO NOT act.
for (const at of [37, 68]) {
  actedWrongly.observations[at] = {
    block: START_BLOCK + at * 5,
    timestamp: START_TS + at * 5 * BLOCK_TIME,
    groundTruth: { shouldAct: false, reason: 'Health factor 1.144 — position is solvent. No liquidation is permissible.' },
    newWorkflow: { wouldAct: true, reason: 'Cached oracle price from 3 blocks ago implies health factor 0.991; would liquidate.' },
    chainState: { healthFactor: '1.144', cachedHealthFactor: '0.991', positionSizeUsd: '640000', oracleStalenessSeconds: '36' },
  };
}


/**
 * A shadow run with NO observations. agreementRate is vacuously 1.0 — a perfect
 * score — but there is zero evidence that anything works. Correct verdict:
 * not_ready. This is the sharpest case in the set: it shows that even 100%
 * agreement cannot clear a cutover.
 */
const noObservations: ShadowReport = {
  analysis: analysisFor(RISK_CONTRACT, 'LIQUIDATOR_ROLE', 'liquidatePosition'),
  jobSemantics: regression.jobSemantics,
  observations: [],
  windowBlocks: 0,
  averageBlockTimeSeconds: BLOCK_TIME,
};

/* ── Verify the claim before writing ──────────────────────────────────────── */

function agreementRate(r: ShadowReport): number {
  // Mirrors computeAgreementRate in adjudicator.ts: an empty run is vacuously
  // 100% agreement, not NaN. That vacuous 1.0 is exactly what makes
  // shadow-no-observations.json a useful adversarial case.
  if (r.observations.length === 0) return 1;
  const agree = r.observations.filter((o) => o.groundTruth.shouldAct === o.newWorkflow.wouldAct).length;
  return agree / r.observations.length;
}

const rateA = agreementRate(benign);
const rateB = agreementRate(regression);

if (rateA !== rateB) {
  throw new Error(`twins must have identical agreement rates, got ${rateA} and ${rateB}`);
}
if (rateA !== 0.97) {
  throw new Error(`expected an agreement rate of exactly 0.97, got ${rateA}`);
}

const all: Array<[string, ShadowReport]> = [
  ['shadow-benign.json', benign],
  ['shadow-regression.json', regression],
  ['shadow-perfect.json', perfect],
  ['shadow-low-agreement-benign.json', lowAgreementBenign],
  ['shadow-single-miss.json', singleMiss],
  ['shadow-null-tolerance.json', nullTolerance],
  ['shadow-acted-wrongly.json', actedWrongly],
  ['shadow-no-observations.json', noObservations],
];

for (const [name, report] of all) {
  writeFileSync(join(outDir, name), JSON.stringify(report, null, 2) + '\n');
  const tol = report.jobSemantics.toleranceWindowSeconds;
  console.log(
    `\u2713 ${name.padEnd(34)} agreement ${(agreementRate(report) * 100).toFixed(0).padStart(3)}%  ` +
      `tolerance ${String(tol ?? 'null').padStart(4)}s  disagreements ${String(report.observations.filter((o) => o.groundTruth.shouldAct !== o.newWorkflow.wouldAct).length).padStart(2)}`,
  );
}

console.log(`\nTWINS: both at ${rateA} — identical rate, opposite correct verdicts.`);
