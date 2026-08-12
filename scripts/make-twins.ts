/**
 * Build the twin ShadowReport fixtures.
 *
 *   npx tsx scripts/make-twins.ts
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

/* ── Verify the claim before writing ──────────────────────────────────────── */

function agreementRate(r: ShadowReport): number {
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

writeFileSync(join(outDir, 'shadow-benign.json'), JSON.stringify(benign, null, 2) + '\n');
writeFileSync(join(outDir, 'shadow-regression.json'), JSON.stringify(regression, null, 2) + '\n');

console.log(`✓ shadow-benign.json      ${benign.observations.length} observations, agreement ${rateA}`);
console.log(`✓ shadow-regression.json  ${regression.observations.length} observations, agreement ${rateB}`);
console.log(`  tolerance windows: ${benign.jobSemantics.toleranceWindowSeconds}s vs ${regression.jobSemantics.toleranceWindowSeconds}s`);
