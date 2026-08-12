/**
 * CUTOVER — stage 6.
 *
 *   PLAN → SIMULATE_ALL → GRANT(new) → VERIFY_LIVE(n) → REVOKE(old) → ATTEST
 *                              │              │
 *                              └── ABORT ─────┘
 *
 * The ordering is the entire product. Revoke before the replacement has proven
 * itself and the protocol sits unattended; revoke too late and a dead
 * credential keeps production access. So the old permission is removed only
 * after the new keeper has done the real job on chain, N times, verifiably.
 *
 * THE INTERLOCK
 *
 * `buildRevoke()` is unreachable unless the Adjudicator returned `ready`. The
 * gate is not a confirmation dialog or a disabled button — on a `not_ready`
 * verdict the code path that constructs revoke calldata is never entered, so
 * there is nothing to sign and nothing to send. That is the property being
 * demonstrated, and it is why the verdict comes from a model rather than a
 * threshold: two runs at identical agreement rates can require opposite
 * answers.
 *
 * Every transition is journalled to disk before the next begins, so a crash
 * mid-migration is resumable. A migration you cannot resume is a migration you
 * cannot trust.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address } from 'viem';
import type { ReadinessVerdict } from '../agent/types.js';
import { KeeperHub, type ExecutionResult } from '../keeperhub/client.js';
import { client } from '../scout/chain.js';

export type Phase =
  | 'PLAN'
  | 'SIMULATE_ALL'
  | 'GRANT'
  | 'VERIFY_LIVE'
  | 'REVOKE'
  | 'ATTEST'
  | 'ABORTED'
  | 'DONE';

export interface CutoverPlan {
  chainId: number;
  contract: string;
  roleHash: string;
  roleName: string | null;
  oldKeeper: string;
  newKeeper: string;
  abi: unknown[];
  /** Live executions the new keeper must land before the old one is revoked. */
  requiredLiveExecutions: number;
}

export interface JournalEntry {
  at: string;
  phase: Phase;
  detail: string;
  txHash?: string;
  txLink?: string;
  gasUsed?: string;
  blockNumber?: number;
  sponsored?: boolean;
  unprotectedBlocks?: number;
}

export interface CutoverResult {
  phase: Phase;
  journal: JournalEntry[];
  /** Blocks during which the protocol had no live keeper. Must be 0. */
  unprotectedBlocks: number;
  grantTx?: string;
  revokeTx?: string;
  abortReason?: string;
}

const IS_UNPROTECTED_ABI = [
  { name: 'isUnprotected', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  {
    name: 'hasRole',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }, { type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

export class Cutover {
  private journal: JournalEntry[] = [];
  private unprotected = 0;

  constructor(
    private readonly plan: CutoverPlan,
    private readonly kh: KeeperHub,
    private readonly journalPath: string,
    private readonly log: (m: string) => void = () => {},
  ) {
    mkdirSync(dirname(journalPath), { recursive: true });
    if (existsSync(journalPath)) {
      this.journal = readFileSync(journalPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as JournalEntry);
    }
  }

  private record(phase: Phase, detail: string, extra: Partial<JournalEntry> = {}): void {
    const entry: JournalEntry = {
      at: new Date().toISOString(),
      phase,
      detail,
      unprotectedBlocks: this.unprotected,
      ...extra,
    };
    this.journal.push(entry);
    appendFileSync(this.journalPath, JSON.stringify(entry) + '\n');
    const tx = extra.txHash ? `  ${extra.txHash.slice(0, 18)}…` : '';
    this.log(`  [${phase}] ${detail}${tx}`);
  }

  /**
   * Sample whether the protocol is currently unattended. Called around every
   * state transition — this is the number the whole design exists to keep at
   * zero, so it is measured rather than asserted.
   */
  private async sampleCoverage(): Promise<void> {
    try {
      const bad = (await client(this.plan.chainId).readContract({
        address: this.plan.contract as Address,
        abi: IS_UNPROTECTED_ABI,
        functionName: 'isUnprotected',
      })) as boolean;
      if (bad) this.unprotected += 1;
    } catch {
      /* a failed probe is not evidence of coverage loss; don't inflate the count */
    }
  }

  private async hasRole(account: string): Promise<boolean> {
    return (await client(this.plan.chainId).readContract({
      address: this.plan.contract as Address,
      abi: IS_UNPROTECTED_ABI,
      functionName: 'hasRole',
      args: [this.plan.roleHash as `0x${string}`, account as Address],
    })) as boolean;
  }

  /**
   * One KeeperHub write, simulated first.
   *
   * The idempotency key is scoped per attempt, not per action. KeeperHub caches
   * failures under a reused key and replays them, so a per-action key means a
   * transient failure can never be retried successfully (upstream issue #1840).
   */
  private async write(
    fn: 'grantRole' | 'revokeRole',
    account: string,
    label: string,
    attempt: number,
  ): Promise<ExecutionResult> {
    const args = [this.plan.roleHash, account];
    const common = {
      contract: this.plan.contract,
      chainId: this.plan.chainId,
      functionName: fn,
      args,
      abi: this.plan.abi,
    };

    const sim = await this.kh.executeContractCall({
      ...common,
      simulate: true,
      idempotencyKey: `${label}-sim-a${attempt}`,
    });
    if (sim.wouldRevert) {
      throw new Error(`${label}: simulation says it would revert — refusing to broadcast`);
    }
    this.record('SIMULATE_ALL', `${fn}(${account}) simulated ok · gas≈${sim.gasEstimate ?? '?'}`);

    const exec = await this.kh.executeContractCall({
      ...common,
      idempotencyKey: `${label}-real-a${attempt}`,
    });
    if (!exec.executionId) throw new Error(`${label}: no executionId returned`);
    return this.kh.waitForReceipt(exec.executionId);
  }

  /**
   * Run the migration.
   *
   * `verdict` is the only thing that unlocks the revoke. It is taken as an
   * argument rather than computed here so this module cannot be tempted to
   * derive readiness from a number.
   */
  async run(
    verdict: ReadinessVerdict,
    verifyLive: () => Promise<{ ok: boolean; detail: string }>,
  ): Promise<CutoverResult> {
    this.record('PLAN', `${this.plan.roleName ?? this.plan.roleHash} on ${this.plan.contract}`);
    await this.sampleCoverage();

    // ── THE INTERLOCK ────────────────────────────────────────────────────
    // Before any calldata exists. On `not_ready` we return here, and
    // buildRevoke/write('revokeRole') is never reached.
    if (verdict.verdict !== 'ready') {
      const why = verdict.blockingIssues.join('; ') || verdict.reasoning;
      this.record('ABORTED', `adjudicator returned not_ready — ${why}`);
      this.log('');
      this.log('  ✋ CUTOVER BLOCKED. No revoke transaction was constructed.');
      this.log(`     ${verdict.reasoning}`);
      return {
        phase: 'ABORTED',
        journal: this.journal,
        unprotectedBlocks: this.unprotected,
        abortReason: why,
      };
    }

    // ── GRANT ────────────────────────────────────────────────────────────
    if (await this.hasRole(this.plan.newKeeper)) {
      this.record('GRANT', 'new keeper already holds the role — skipping grant');
    } else {
      const r = await this.write('grantRole', this.plan.newKeeper, 'grant', 1);
      this.record('GRANT', `new keeper granted ${this.plan.roleName ?? 'role'}`, {
        txHash: r.transactionHash,
        txLink: r.transactionLink,
        gasUsed: r.gasUsed,
        blockNumber: r.blockNumber,
        sponsored: r.sponsored,
      });
    }
    await this.sampleCoverage();
    const grantTx = this.journal.findLast((e) => e.phase === 'GRANT')?.txHash;

    // ── VERIFY_LIVE ──────────────────────────────────────────────────────
    // Proof by doing. The replacement performs the actual job on chain; a
    // successful grant is not evidence that the new keeper works.
    for (let i = 1; i <= this.plan.requiredLiveExecutions; i++) {
      const { ok, detail } = await verifyLive();
      await this.sampleCoverage();
      if (!ok) {
        this.record('ABORTED', `live verification ${i}/${this.plan.requiredLiveExecutions} failed — ${detail}`);
        this.log('');
        this.log('  ✋ CUTOVER BLOCKED. Old keeper retains its role.');
        return {
          phase: 'ABORTED',
          journal: this.journal,
          unprotectedBlocks: this.unprotected,
          grantTx,
          abortReason: detail,
        };
      }
      this.record('VERIFY_LIVE', `${i}/${this.plan.requiredLiveExecutions} — ${detail}`);
    }

    // ── REVOKE ───────────────────────────────────────────────────────────
    // Only now, and only ever here.
    const rev = await this.write('revokeRole', this.plan.oldKeeper, 'revoke', 1);
    this.record('REVOKE', `old keeper revoked`, {
      txHash: rev.transactionHash,
      txLink: rev.transactionLink,
      gasUsed: rev.gasUsed,
      blockNumber: rev.blockNumber,
      sponsored: rev.sponsored,
    });
    await this.sampleCoverage();

    // ── ATTEST ───────────────────────────────────────────────────────────
    // Re-read both sides from chain rather than trusting our own journal.
    const oldStill = await this.hasRole(this.plan.oldKeeper);
    const newHas = await this.hasRole(this.plan.newKeeper);
    if (oldStill || !newHas) {
      this.record('ABORTED', `post-state wrong: old=${oldStill} new=${newHas}`);
      return {
        phase: 'ABORTED',
        journal: this.journal,
        unprotectedBlocks: this.unprotected,
        abortReason: 'post-migration state verification failed',
      };
    }
    this.record('ATTEST', `verified on chain — old=false new=true · unprotected blocks=${this.unprotected}`);

    return {
      phase: 'DONE',
      journal: this.journal,
      unprotectedBlocks: this.unprotected,
      grantTx,
      revokeTx: rev.transactionHash,
    };
  }
}
