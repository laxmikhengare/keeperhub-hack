/**
 * Run the Adjudicator against a ShadowReport fixture.
 *
 *   npx tsx scripts/adjudicate-fixture.ts evals/fixtures/shadow-benign.json
 *   npx tsx scripts/adjudicate-fixture.ts --twins        # run both, side by side
 */

import { readFileSync } from 'node:fs';
import { adjudicate } from '../src/agent/index.js';
import { computeAgreementRate } from '../src/agent/adjudicator.js';
import type { ShadowReport } from '../src/agent/index.js';
import type { Effort } from '../src/agent/client.js';

const args = process.argv.slice(2);
const effort = args.find((a) => a.startsWith('--effort='))?.split('=')[1] as Effort | undefined;
const twins = args.includes('--twins');

const paths = twins
  ? ['evals/fixtures/shadow-benign.json', 'evals/fixtures/shadow-regression.json']
  : [args.find((a) => !a.startsWith('--')) ?? 'evals/fixtures/shadow-benign.json'];

for (const path of paths) {
  const report = JSON.parse(readFileSync(path, 'utf8')) as ShadowReport;
  const rate = computeAgreementRate(report);

  console.log(`\n${'━'.repeat(78)}`);
  console.log(`▶  adjudicate("${path}")`);
  console.log(
    `   agreement ${(rate * 100).toFixed(1)}%  ·  tolerance ` +
      `${report.jobSemantics.toleranceWindowSeconds ?? 'null'}s  ·  ` +
      `${report.observations.length} observations`,
  );
  console.log(`   consequence: ${report.jobSemantics.consequenceOfMissedAction.slice(0, 90)}…\n`);

  const started = Date.now();
  const verdict = await adjudicate(report, effort ? { effort } : {});
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const badge = verdict.verdict === 'ready' ? '✅ READY' : '⛔ NOT READY';
  console.log(`   ${badge}      (agreementRate passed through: ${verdict.agreementRate})`);
  console.log(`\n   ${verdict.reasoning}\n`);

  for (const d of verdict.disagreements) {
    console.log(`   · block ${d.block.toLocaleString()} — ${d.classification}`);
    console.log(`     ${d.reasoning}`);
  }

  if (verdict.blockingIssues.length > 0) {
    console.log('\n   blockingIssues:');
    for (const b of verdict.blockingIssues) console.log(`     - ${b}`);
  }

  console.log(`\n   (${elapsed}s)`);
}

console.log(`\n${'━'.repeat(78)}\n`);
