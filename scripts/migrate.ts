/**
 * UNDERSTUDY — the full migration.
 *
 *   scout → analyst → builder → shadow → adjudicator → cutover
 *
 *   npx tsx scripts/migrate.ts --contract 0x… --variant faithful
 *   npx tsx scripts/migrate.ts --contract 0x… --variant stale-threshold
 *
 * The two variants are the argument. Both run the identical pipeline against
 * the identical chain; the only difference is whether the rebuilt keeper is
 * faithful or carries a stale-read off-by-one. One cuts over. The other is
 * refused — and no revoke transaction is ever constructed.
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { Address } from 'viem';

import { buildEvidenceBundle } from '../src/scout/index.js';
import { analyze, adjudicate } from '../src/agent/index.js';
import { runShadow, type RebuiltVariant } from '../src/shadow/index.js';
import { KeeperHub } from '../src/keeperhub/client.js';
import { Cutover } from '../src/cutover/index.js';
import { client } from '../src/scout/chain.js';
import LEGACY_ARTIFACT from '../contracts/out/LegacyProtocol.sol/LegacyProtocol.json' with { type: 'json' };

const argv = process.argv;
const arg = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  if (i !== -1 && argv[i + 1]) return argv[i + 1]!;
  return argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? d;
};

const CHAIN_ID = Number(arg('chain', '11155111'));
const CONTRACT = arg('contract') ?? process.env['CYCLER']!;
const VARIANT = (arg('variant', 'faithful') as RebuiltVariant);
const BLOCKS = Number(arg('blocks', '25'));
const OLD_KEEPER = process.env['DEAD_KEEPER']!;
const NEW_KEEPER = process.env['KH_WALLET']!;
const ABI = (LEGACY_ARTIFACT as { abi: unknown[] }).abi;
const RUN = `${VARIANT}-${Date.now()}`;

const rule = (t: string) => console.log(`\n${'─'.repeat(66)}\n${t}\n${'─'.repeat(66)}`);

// ── 1. SCOUT ───────────────────────────────────────────────────────────────
rule('1 · SCOUT — what does the dead keeper still control?');
const bundle = await buildEvidenceBundle({
  deadKeeper: OLD_KEEPER,
  chainId: CHAIN_ID,
  contracts: [CONTRACT],
  onProgress: (m) => console.log(`  ${m}`),
});

// ── 2. ANALYST ─────────────────────────────────────────────────────────────
rule('2 · ANALYST — which permissions matter, and what was this job doing?');
const analysis = await analyze(bundle);
for (const p of analysis.permissions) {
  console.log(`  ${p.roleName ?? p.roleHash.slice(0, 14)}  ${p.classification}  (${p.confidence.toFixed(2)})`);
  console.log(`    gates: ${p.gatedFunctions.join(', ') || '—'} · observed calls: ${p.observedCalls}`);
  console.log(`    ${p.reasoning}`);
}
const target = analysis.permissions.find((p) => p.gatedFunctions.includes('performUpkeep'))
  ?? analysis.permissions[0]!;

// ── 3+4. BUILDER + SHADOW ──────────────────────────────────────────────────
rule(`3·4 · REBUILD + SHADOW — run the replacement observe-only (${VARIANT})`);
const report = await runShadow({
  chainId: CHAIN_ID,
  contract: CONTRACT,
  analysis,
  variant: VARIANT,
  blocks: BLOCKS,
  jobDescription:
    'Settle each epoch by calling performUpkeep once the deadline passes. ' +
    'The protocol cannot settle itself; a missed settlement degrades it.',
  consequenceOfMissedAction:
    'The epoch is recorded as missed, missedSettlements increments, and the ' +
    'protocol is degraded until the next successful settlement.',
  onProgress: (m) => console.log(`  ${m}`),
});
const disagreements = report.observations.filter(
  (o) => o.groundTruth.shouldAct !== o.newWorkflow.wouldAct,
);
const agreementRate =
  report.observations.length
    ? (report.observations.length - disagreements.length) / report.observations.length
    : 0;
console.log(`  agreement ${(agreementRate * 100).toFixed(0)}% · ${disagreements.length} disagreement(s)`);

// ── 5. ADJUDICATOR ─────────────────────────────────────────────────────────
rule('5 · ADJUDICATOR — is this replacement ready?');
const verdict = await adjudicate(report);
console.log(`  verdict        ${verdict.verdict.toUpperCase()}`);
console.log(`  agreement      ${(verdict.agreementRate * 100).toFixed(0)}%`);
for (const d of verdict.disagreements) {
  console.log(`  · block ${d.block}  ${d.classification}`);
  console.log(`      ${d.reasoning}`);
}
if (verdict.blockingIssues.length) {
  console.log('  blocking:');
  for (const b of verdict.blockingIssues) console.log(`      - ${b}`);
}
console.log(`\n  ${verdict.reasoning}`);

// ── 6. CUTOVER ─────────────────────────────────────────────────────────────
rule('6 · CUTOVER — grant · verify live · revoke');
const kh = new KeeperHub();
await kh.connect();

/**
 * Proof by doing: the new keeper performs the real job on chain. A successful
 * grant proves only that a role was written — not that the replacement works.
 */
let liveAttempt = 0;
async function verifyLive() {
  liveAttempt++;
  const before = (await client(CHAIN_ID).readContract({
    address: CONTRACT as Address,
    abi: ABI as never,
    functionName: 'epoch',
  })) as bigint;

  try {
    // Wait until the job is genuinely due. A keeper that fires early reverts;
    // waiting is the correct behaviour, not a workaround.
    const waitUntil = Date.now() + 180_000;
    for (;;) {
      const [due] = (await client(CHAIN_ID).readContract({
        address: CONTRACT as Address,
        abi: ABI as never,
        functionName: 'checkUpkeep',
        args: ['0x'],
      })) as readonly [boolean, string];
      if (due) break;
      if (Date.now() > waitUntil) return { ok: false, detail: 'job never became due within 180s' };
      await new Promise((r) => setTimeout(r, 6000));
    }

    const exec = await kh.executeContractCall({
      contract: CONTRACT,
      chainId: CHAIN_ID,
      functionName: 'performUpkeep',
      args: ['0x'],
      abi: ABI,
      idempotencyKey: `${RUN}-live-${liveAttempt}-a1`,
    });
    if (!exec.executionId) return { ok: false, detail: 'no executionId returned' };
    const r = await kh.waitForReceipt(exec.executionId);
    const after = (await client(CHAIN_ID).readContract({
      address: CONTRACT as Address,
      abi: ABI as never,
      functionName: 'epoch',
    })) as bigint;

    // Independently confirm the job advanced. KeeperHub reporting success is
    // not the same as the protocol having settled.
    if (after <= before) {
      return { ok: false, detail: `tx landed but epoch did not advance (${before}→${after})` };
    }
    return {
      ok: true,
      detail: `epoch ${before}→${after} · ${r.transactionHash?.slice(0, 18)}… · gas ${r.gasUsed}`,
    };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.slice(0, 160) };
  }
}

mkdirSync('runs', { recursive: true });
const cutover = new Cutover(
  {
    chainId: CHAIN_ID,
    contract: CONTRACT,
    roleHash: target.roleHash,
    roleName: target.roleName,
    oldKeeper: OLD_KEEPER,
    newKeeper: NEW_KEEPER,
    abi: ABI,
    requiredLiveExecutions: 3,
  },
  kh,
  `runs/${RUN}.jsonl`,
  (m) => console.log(m),
);

const result = await cutover.run(verdict, verifyLive);

// ── receipt ────────────────────────────────────────────────────────────────
rule('RESULT');
console.log(`  phase              ${result.phase}`);
console.log(`  BLOCKS UNPROTECTED ${result.unprotectedBlocks}`);
if (result.grantTx) console.log(`  grant              https://sepolia.etherscan.io/tx/${result.grantTx}`);
if (result.revokeTx) console.log(`  revoke             https://sepolia.etherscan.io/tx/${result.revokeTx}`);
if (result.abortReason) console.log(`  abort reason       ${result.abortReason}`);
console.log(`  journal            runs/${RUN}.jsonl`);

writeFileSync(
  `runs/${RUN}.summary.json`,
  JSON.stringify({ variant: VARIANT, contract: CONTRACT, agreementRate, verdict, result }, null, 2),
);

process.exit(result.phase === 'DONE' || result.phase === 'ABORTED' ? 0 : 1);
