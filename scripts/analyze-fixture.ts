/**
 * Run the Analyst against a fixture and print the result.
 *
 *   npm run analyze -- evals/fixtures/lido-l1-bridge.json [--effort=medium]
 */

import { readFileSync } from 'node:fs';
import { analyze } from '../src/agent/index.js';
import type { EvidenceBundle } from '../src/agent/index.js';
import type { Effort } from '../src/agent/client.js';

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--')) ?? 'evals/fixtures/lido-l1-bridge.json';
const effortArg = args.find((a) => a.startsWith('--effort='))?.split('=')[1] as Effort | undefined;

const bundle = JSON.parse(readFileSync(path, 'utf8')) as EvidenceBundle;

console.log(`\n▶  analyze("${path}")`);
console.log(
  `   ${bundle.permissions.length} permissions · ${Object.keys(bundle.contracts).length} contracts · ` +
    `${bundle.callHistory.length} call-history entries · effort=${effortArg ?? 'high'}\n`,
);

const started = Date.now();
const analysis = await analyze(bundle, effortArg ? { effort: effortArg } : {});
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

for (const p of analysis.permissions) {
  const name = p.roleName ?? '(unresolved)';
  console.log(`  ${p.roleHash.slice(0, 12)}…  ${name}`);
  console.log(`     classification : ${p.classification}   confidence: ${p.confidence.toFixed(2)}`);
  console.log(`     resolution     : ${p.resolutionMethod}`);
  console.log(`     gates          : ${p.gatedFunctions.join(', ') || '(none identified)'}`);
  console.log(`     observed calls : ${p.observedCalls}${p.lastCalledBlock !== null ? ` (last block ${p.lastCalledBlock})` : ''}`);
  console.log(`     reasoning      : ${p.reasoning}`);
  console.log();
}

const ai = analysis.automationIntent;
console.log(`  automationIntent: ${ai.triggerKind}  (confidence ${ai.confidence.toFixed(2)})`);
console.log(`     ${ai.conditionSummary}`);
console.log(`     ${ai.reasoning}\n`);

if (analysis.declaredUnknowns.length > 0) {
  console.log('  declaredUnknowns:');
  for (const u of analysis.declaredUnknowns) console.log(`     - ${u}`);
} else {
  console.log('  declaredUnknowns: (none)');
}

console.log(`\n✓ schema-valid PermissionAnalysis in ${elapsed}s\n`);
