/**
 * SHADOW — stage 4.
 *
 * Runs the rebuilt keeper in observe-only mode against live chain state. It
 * decides what it *would* do at each block and executes nothing, so the cost of
 * being wrong here is a log line rather than a transaction.
 *
 * The comparison that matters is between two independent things:
 *
 *   groundTruth  — the contract's own `checkUpkeep()`. Authoritative.
 *   newWorkflow  — the rebuilt keeper's condition, evaluated from the state it
 *                  can actually see.
 *
 * They are not the same function. The rebuilt keeper is a *reimplementation* of
 * an automation whose original source is gone, sampled on a block cadence
 * rather than continuously. It drifts for the same reasons real migrations
 * drift: cadence, staleness, and off-by-one comparisons. Those drifts are the
 * whole point — they are what the Adjudicator has to judge.
 */

import type { PermissionAnalysis, ShadowReport } from '../agent/types.js';
import { client } from '../scout/chain.js';
import type { Address } from 'viem';

const LEGACY_ABI = [
  {
    name: 'checkUpkeep',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes' }],
    outputs: [
      { name: 'upkeepNeeded', type: 'bool' },
      { name: 'performData', type: 'bytes' },
    ],
  },
  { name: 'nextSettlementAt', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'settlementWindow', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'epoch', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'paused', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { name: 'isUnprotected', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;

/**
 * How the rebuilt keeper decides. Both variants are plausible outputs of a
 * migration — the difference is whether the mistake is survivable.
 */
export type RebuiltVariant =
  /** Faithful logic, block-cadence sampling. Acts late by up to one block. */
  | 'faithful'
  /**
   * Reads the deadline but compares with `>` against a threshold captured one
   * sample earlier — a stale-read off-by-one. Skips settlements that were
   * genuinely due. This is the shape of bug that survives code review.
   */
  | 'stale-threshold';

export interface ShadowOptions {
  chainId: number;
  contract: string;
  analysis: PermissionAnalysis;
  variant: RebuiltVariant;
  /** How many blocks to observe. */
  blocks: number;
  jobDescription: string;
  consequenceOfMissedAction: string;
  onProgress?: (msg: string) => void;
}

interface Sample {
  block: number;
  timestamp: number;
  upkeepNeeded: boolean;
  nextSettlementAt: number;
  settlementWindow: number;
  epoch: number;
  paused: boolean;
}

async function sample(chainId: number, contract: string, blockNumber: bigint): Promise<Sample> {
  const c = client(chainId);
  const address = contract as Address;
  const at = { blockNumber } as const;

  const [check, next, win, ep, paused, block] = await Promise.all([
    c.readContract({ address, abi: LEGACY_ABI, functionName: 'checkUpkeep', args: ['0x'], ...at }),
    c.readContract({ address, abi: LEGACY_ABI, functionName: 'nextSettlementAt', ...at }),
    c.readContract({ address, abi: LEGACY_ABI, functionName: 'settlementWindow', ...at }),
    c.readContract({ address, abi: LEGACY_ABI, functionName: 'epoch', ...at }),
    c.readContract({ address, abi: LEGACY_ABI, functionName: 'paused', ...at }),
    c.getBlock({ blockNumber }),
  ]);

  return {
    block: Number(blockNumber),
    timestamp: Number(block.timestamp),
    upkeepNeeded: (check as readonly [boolean, string])[0],
    nextSettlementAt: Number(next as bigint),
    settlementWindow: Number(win as bigint),
    epoch: Number(ep as bigint),
    paused: paused as boolean,
  };
}

/** The rebuilt keeper's decision, given what it can see at this sample. */
function rebuiltDecision(
  variant: RebuiltVariant,
  now: Sample,
  prev: Sample | null,
): { wouldAct: boolean; reason: string } {
  if (now.paused) {
    return { wouldAct: false, reason: 'protocol paused — no action' };
  }

  if (variant === 'faithful') {
    const due = now.timestamp >= now.nextSettlementAt;
    return due
      ? { wouldAct: true, reason: `deadline ${now.nextSettlementAt} reached at ${now.timestamp}` }
      : { wouldAct: false, reason: `not due for ${now.nextSettlementAt - now.timestamp}s` };
  }

  // stale-threshold: compares against the deadline observed one sample ago and
  // uses a strict `>`. When the deadline advances between samples, or lands
  // exactly on the sampled timestamp, the settlement is silently skipped.
  const threshold = prev?.nextSettlementAt ?? now.nextSettlementAt;
  const due = now.timestamp > threshold;
  return due
    ? { wouldAct: true, reason: `timestamp ${now.timestamp} past cached deadline ${threshold}` }
    : {
        wouldAct: false,
        reason: `timestamp ${now.timestamp} not past cached deadline ${threshold}`,
      };
}

export async function runShadow(opts: ShadowOptions): Promise<ShadowReport> {
  const log = opts.onProgress ?? (() => {});
  const c = client(opts.chainId);
  const head = await c.getBlockNumber();
  const from = head - BigInt(opts.blocks - 1);

  log(`shadow: ${opts.variant} over blocks ${from}–${head} on ${opts.contract}`);

  const observations: ShadowReport['observations'] = [];
  let prev: Sample | null = null;
  let toleranceWindowSeconds: number | null = null;
  let agree = 0;

  for (let b = from; b <= head; b++) {
    let s: Sample;
    try {
      s = await sample(opts.chainId, opts.contract, b);
    } catch {
      // A pruned or unavailable block is a gap in observation, not a
      // disagreement. Skipping is correct; inventing a reading is not.
      continue;
    }
    toleranceWindowSeconds ??= s.settlementWindow;

    const decision = rebuiltDecision(opts.variant, s, prev);
    if (decision.wouldAct === s.upkeepNeeded) agree++;

    observations.push({
      block: s.block,
      timestamp: s.timestamp,
      groundTruth: {
        shouldAct: s.upkeepNeeded,
        reason: s.upkeepNeeded
          ? `checkUpkeep() true — due since ${s.nextSettlementAt}`
          : `checkUpkeep() false — due at ${s.nextSettlementAt}`,
      },
      newWorkflow: decision,
      chainState: {
        nextSettlementAt: String(s.nextSettlementAt),
        settlementWindow: String(s.settlementWindow),
        epoch: String(s.epoch),
        paused: String(s.paused),
        secondsPastDeadline: String(Math.max(0, s.timestamp - s.nextSettlementAt)),
      },
    });
    prev = s;
  }

  const n = observations.length;
  const spanSeconds =
    n > 1 ? observations[n - 1]!.timestamp - observations[0]!.timestamp : 0;
  const averageBlockTimeSeconds = n > 1 ? Math.round((spanSeconds / (n - 1)) * 10) / 10 : 12;

  log(`  ${n} observations · agreement ${n ? Math.round((agree / n) * 100) : 0}%`);

  return {
    analysis: opts.analysis,
    jobSemantics: {
      description: opts.jobDescription,
      targetContract: opts.contract.toLowerCase(),
      toleranceWindowSeconds,
      consequenceOfMissedAction: opts.consequenceOfMissedAction,
    },
    observations,
    windowBlocks: n,
    averageBlockTimeSeconds,
  };
}
