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
  unprotectedSamples?: number;
  degradedSamples?: number;
}

export interface CutoverResult {
  phase: Phase;
  journal: JournalEntry[];
  /** Samples where NO keeper held the role. Attributable to us. Must be 0. */
  unprotectedSamples: number;
  /** Samples where the protocol was past its settlement window. Context only. */
  degradedSamples: number;
  totalSamples: number;
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
  /** Samples where NO keeper held the role. Attributable to the migration. */
  private unprotected = 0;
  /** Samples where the protocol was past its window. Usually pre-existing. */
  private degraded = 0;
  private samples = 0;
  /**
   * Unique per process run. A resumed migration must not reuse the previous
   * run's idempotency keys, or KeeperHub replays that run's cached outcome
   * instead of executing.
   */
  private readonly runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

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
      unprotectedSamples: this.unprotected,
      degradedSamples: this.degraded,
      ...extra,
    };
    this.journal.push(entry);
    appendFileSync(this.journalPath, JSON.stringify(entry) + '\n');
    const tx = extra.txHash ? `  ${extra.txHash.slice(0, 18)}…` : '';
    this.log(`  [${phase}] ${detail}${tx}`);
  }

  /**
   * Sample coverage around every state transition.
   *
   * Two distinct things get measured, because conflating them overstates the
   * claim and a reviewer would rightly call it out:
   *
   *   uncoveredSamples — no keeper at all holds the role. This is the number
   *     the migration is responsible for, and the one that must be zero. It can
   *     only become non-zero by revoking before granting.
   *
   *   degradedSamples — the protocol is past its settlement window. Usually
   *     already true on arrival, because the dead keeper stopped settling long
   *     before we showed up. That gap belongs to the abandoned keeper, not to
   *     us, so it is reported separately rather than folded into the headline.
   */
  private async sampleCoverage(): Promise<void> {
    const c = client(this.plan.chainId);
    try {
      const [oldHas, newHas, degraded] = await Promise.all([
        this.hasRole(this.plan.oldKeeper),
        this.hasRole(this.plan.newKeeper),
        c.readContract({
          address: this.plan.contract as Address,
          abi: IS_UNPROTECTED_ABI,
          functionName: 'isUnprotected',
        }) as Promise<boolean>,
      ]);
      this.samples += 1;
      if (!oldHas && !newHas) this.unprotected += 1;
      if (degraded) this.degraded += 1;
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
   * One KeeperHub write: simulate, broadcast, wait for the receipt — retried
   * under a fresh idempotency key each attempt. A simulated revert is not
   * retried, because the chain is telling us the call itself is wrong.
   */
  private async write(
    fn: 'grantRole' | 'revokeRole',
    account: string,
    label: string,
    maxAttempts = 3,
  ): Promise<ExecutionResult> {
    const common = {
      contract: this.plan.contract,
      chainId: this.plan.chainId,
      functionName: fn,
      args: [this.plan.roleHash, account],
      abi: this.plan.abi,
    };

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // The key is namespaced by run AND by attempt. Both halves matter:
      //
      //   runId    — a resumed run must not reuse the previous run's keys, or
      //              KeeperHub replays that run's cached outcome instead of
      //              executing.
      //   attempt  — KeeperHub caches *failures* too. A key scoped to the
      //              logical action means the first failure is replayed
      //              forever and the retry can never recover (issue #1840).
      //
      // Transport-level duplicates of a single attempt are still deduplicated,
      // which is the protection the parameter is actually for. Double-execution
      // is guarded by the contract's own role state, which is where that
      // guarantee belongs.
      const key = `${this.runId}-${label}-a${attempt}`;

      try {
        const sim = await this.kh.executeContractCall({
          ...common,
          simulate: true,
          idempotencyKey: `${key}-sim`,
        });
        if (sim.wouldRevert) {
          // Not retryable: the chain is telling us this call is wrong.
          throw new Error(`${label}: simulation says it would revert — refusing to broadcast`);
        }
        this.record(
          'SIMULATE_ALL',
          `${fn}(${account}) simulated ok · gas≈${sim.gasEstimate ?? '?'}${attempt > 1 ? ` · attempt ${attempt}` : ''}`,
        );

        const exec = await this.kh.executeContractCall({ ...common, idempotencyKey: key });
        if (!exec.executionId) throw new Error(`${label}: no executionId returned`);
        return await this.kh.waitForReceipt(exec.executionId);
      } catch (e) {
        lastError = e as Error;
        if (lastError.message.includes('would revert')) throw lastError;
        if (attempt === maxAttempts) break;
        this.record('SIMULATE_ALL', `${label} attempt ${attempt} failed (${lastError.message.slice(0, 90)}) — retrying under a fresh key`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }

    throw new Error(`${label}: failed after ${maxAttempts} attempts — ${lastError?.message}`);
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
        unprotectedSamples: this.unprotected,
        degradedSamples: this.degraded,
        totalSamples: this.samples,
        abortReason: why,
      };
    }

    // ── GRANT ────────────────────────────────────────────────────────────
    if (await this.hasRole(this.plan.newKeeper)) {
      this.record('GRANT', 'new keeper already holds the role — skipping grant');
    } else {
      const r = await this.write('grantRole', this.plan.newKeeper, 'grant');
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
          unprotectedSamples: this.unprotected,
        degradedSamples: this.degraded,
        totalSamples: this.samples,
          grantTx,
          abortReason: detail,
        };
      }
      this.record('VERIFY_LIVE', `${i}/${this.plan.requiredLiveExecutions} — ${detail}`);
    }

    // ── REVOKE ───────────────────────────────────────────────────────────
    // Only now, and only ever here.
    const rev = await this.write('revokeRole', this.plan.oldKeeper, 'revoke');
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
        unprotectedSamples: this.unprotected,
        degradedSamples: this.degraded,
        totalSamples: this.samples,
        abortReason: 'post-migration state verification failed',
      };
    }
    this.record('ATTEST', `verified on chain — old=false new=true · uncovered samples=${this.unprotected}/${this.samples}`);

    return {
      phase: 'DONE',
      journal: this.journal,
      unprotectedSamples: this.unprotected,
      degradedSamples: this.degraded,
      totalSamples: this.samples,
      grantTx,
      revokeTx: rev.transactionHash,
    };
  }
}
