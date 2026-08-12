/**
 * Scout CLI — produce an EvidenceBundle from live chain data.
 *
 *   npx tsx scripts/scout.ts --keeper 0x… --chain 11155111 --out bundle.json
 *   npx tsx scripts/scout.ts --keeper 0x… --chain 1 --contracts 0xa,0xb
 *
 * Public reads only: no wallet, no key, no archive node.
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildEvidenceBundle } from '../src/scout/index.js';
import { EvidenceBundleSchema } from '../src/agent/schemas.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.split('=').slice(1).join('=');
}

const keeper = arg('keeper');
const chainId = Number(arg('chain') ?? 11155111);
const out = arg('out');
const contracts = arg('contracts')?.split(',').map((s) => s.trim()).filter(Boolean);

if (!keeper) {
  console.error('usage: tsx scripts/scout.ts --keeper 0x… [--chain 11155111] [--contracts 0xa,0xb] [--out file.json]');
  process.exit(1);
}

const bundle = await buildEvidenceBundle({
  deadKeeper: keeper,
  chainId,
  contracts,
  provider: (arg('provider') as any) ?? 'manual',
  onProgress: (m) => console.error(m),
});

// Validate against the frozen §4 schema before anyone downstream sees it.
// A malformed bundle should fail here, in the Scout, not inside the Analyst.
const parsed = EvidenceBundleSchema.safeParse(bundle);
if (!parsed.success) {
  console.error('\n✗ bundle failed §4 schema validation:');
  console.error(JSON.stringify(parsed.error.issues.slice(0, 10), null, 2));
  process.exit(1);
}

const live = bundle.permissions.filter((p) => p.stillActive);
const sourced = Object.values(bundle.contracts).filter((c) => c.verifiedSource).length;

console.error('');
console.error('── bundle ─────────────────────────────');
console.error(`  keeper       ${bundle.deadKeeper.address}`);
console.error(`  chain        ${bundle.chainContext.chainName} @ ${bundle.chainContext.currentBlock}`);
console.error(`  permissions  ${bundle.permissions.length} (${live.length} still active)`);
console.error(`  contracts    ${Object.keys(bundle.contracts).length} (${sourced} with verified source)`);
console.error(`  callHistory  ${bundle.callHistory.length} distinct selectors`);
console.error(`  schema       ✓ valid`);

if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(bundle, null, 2));
  console.error(`  written      ${out}`);
} else {
  process.stdout.write(JSON.stringify(bundle, null, 2));
}
