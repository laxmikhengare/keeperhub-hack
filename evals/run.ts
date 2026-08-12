/**
 * Eval harness.
 *
 *   npm run eval                        both suites
 *   npm run eval -- --suite=roles       role classification only
 *   npm run eval -- --suite=adjudication
 *   npm run eval -- --effort=medium     sweep effort
 *   npm run eval -- --no-cache          force fresh model calls
 *   npm run eval -- --json              machine-readable summary
 *
 * Model responses are cached under .cache/ keyed by a hash of everything that
 * can change the answer (component, model, effort, and the exact input bundle),
 * so re-runs while tuning the scoring or the label set are free. Delete .cache/
 * or pass --no-cache after editing a prompt.
 */

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { analyze } from '../src/agent/analyst.js';
import { adjudicate, computeAgreementRate } from '../src/agent/adjudicator.js';
import { PRIMARY_MODEL, type Effort } from '../src/agent/client.js';
import type { EvidenceBundle, PermissionAnalysis, ReadinessVerdict, ShadowReport } from '../src/agent/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');
const cacheDir = join(here, '../.cache');

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const has = (name: string): boolean => args.includes(`--${name}`);

const effort = (flag('effort') as Effort | undefined) ?? 'high';
const suite = flag('suite') ?? 'all';
const useCache = !has('no-cache');
const asJson = has('json');
const CONCURRENCY = Number(flag('concurrency') ?? 5);

/* ── plumbing ─────────────────────────────────────────────────────────────── */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * Prompt text is part of the cache key.
 *
 * Without this, editing a prompt and re-running the evals silently replays the
 * old cached answers — you tune against a stale score and conclude the change
 * did nothing. The prompts are the thing being tuned, so they must invalidate.
 */
const PROMPT_FINGERPRINT = createHash('sha256')
  .update(readFileSync(join(here, '../src/agent/prompts/analyst.md'), 'utf8'))
  .update(readFileSync(join(here, '../src/agent/prompts/adjudicator.md'), 'utf8'))
  .digest('hex')
  .slice(0, 12);

function cacheKey(component: string, payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify({ component, model: PRIMARY_MODEL, effort, prompts: PROMPT_FINGERPRINT, payload }))
    .digest('hex')
    .slice(0, 32);
}

async function cached<T>(component: string, payload: unknown, run: () => Promise<T>): Promise<T> {
  if (!useCache) return run();
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `${component}-${cacheKey(component, payload)}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as T;
  const value = await run();
  writeFileSync(file, JSON.stringify(value, null, 2));
  return value;
}

/** Bounded-concurrency map that preserves input order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

const readJsonl = <T>(name: string): T[] =>
  readFileSync(join(here, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

/* ── role classification ──────────────────────────────────────────────────── */

interface RoleRow {
  id: string;
  fixture: string;
  contract: string;
  roleHash: string;
  expected: { roleName: string | null; resolutionMethod: string; classification: string };
  contested?: boolean;
  note: string;
}

interface RoleResult {
  row: RoleRow;
  ok: boolean;
  got?: { roleName: string | null; resolutionMethod: string; classification: string };
  hallucinated: boolean;
  error?: string;
}

async function runRoles(): Promise<{ results: RoleResult[]; baseline: number }> {
  const rows = readJsonl<RoleRow>('role-classification.jsonl');
  const fixtures = [...new Set(rows.map((r) => r.fixture))].sort();

  const analyses = new Map<string, PermissionAnalysis | { error: string }>();
  await pool(fixtures, CONCURRENCY, async (fixture) => {
    const bundle = JSON.parse(readFileSync(join(fixturesDir, fixture), 'utf8')) as EvidenceBundle;
    try {
      const analysis = await cached('analyst', { fixture, bundle }, () => analyze(bundle, { effort }));
      analyses.set(fixture, analysis);
    } catch (err) {
      analyses.set(fixture, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const results: RoleResult[] = rows.map((row) => {
    const analysis = analyses.get(row.fixture)!;
    if ('error' in analysis) {
      return { row, ok: false, hallucinated: false, error: analysis.error };
    }
    const got = analysis.permissions.find(
      (p) =>
        p.contract.toLowerCase() === row.contract.toLowerCase() &&
        p.roleHash.toLowerCase() === row.roleHash.toLowerCase(),
    );
    if (!got) return { row, ok: false, hallucinated: false, error: 'no matching permission returned' };

    // A hallucination is the unforgivable failure: a confident name that is
    // simply not what that hash is. Tracked separately from accuracy.
    const hallucinated = got.roleName !== null && got.roleName !== row.expected.roleName;

    return {
      row,
      ok: got.classification === row.expected.classification,
      got: {
        roleName: got.roleName,
        resolutionMethod: got.resolutionMethod,
        classification: got.classification,
      },
      hallucinated,
    };
  });

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.expected.classification, (counts.get(r.expected.classification) ?? 0) + 1);
  const baseline = Math.max(...counts.values()) / rows.length;

  return { results, baseline };
}

/* ── adjudication ─────────────────────────────────────────────────────────── */

interface AdjRow {
  id: string;
  reportPath: string;
  expected: { verdict: string };
  note: string;
}

interface AdjResult {
  row: AdjRow;
  ok: boolean;
  got?: ReadinessVerdict;
  error?: string;
}

async function runAdjudication(): Promise<AdjResult[]> {
  const rows = readJsonl<AdjRow>('adjudication.jsonl');
  return pool(rows, CONCURRENCY, async (row) => {
    const report = JSON.parse(readFileSync(join(fixturesDir, row.reportPath), 'utf8')) as ShadowReport;
    try {
      const verdict = await cached('adjudicator', { path: row.reportPath, report }, () =>
        adjudicate(report, { effort }),
      );
      return { row, ok: verdict.verdict === row.expected.verdict, got: verdict };
    } catch (err) {
      return { row, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/* ── report ───────────────────────────────────────────────────────────────── */

const pct = (n: number, d: number): string => `${((n / d) * 100).toFixed(1)}%`;

const summary: Record<string, unknown> = { model: PRIMARY_MODEL, effort };
let failed = false;

console.log(`\n${BOLD}understudy evals${RESET}  ${DIM}model=${PRIMARY_MODEL} effort=${effort} cache=${useCache ? 'on' : 'off'}${RESET}\n`);

if (suite === 'all' || suite === 'roles') {
  const { results, baseline } = await runRoles();
  const passed = results.filter((r) => r.ok).length;
  const hallucinations = results.filter((r) => r.hallucinated).length;
  const target = 0.85;
  const rate = passed / results.length;
  if (rate < target || hallucinations > 0) failed = true;

  console.log(
    `${BOLD}role classification${RESET}    ${passed}/${results.length}  (${pct(passed, results.length)})` +
      `   ${DIM}target ≥85% · majority-class baseline ${(baseline * 100).toFixed(1)}%${RESET}`,
  );
  for (const r of results) {
    if (r.ok) continue;
    const detail = r.error
      ? r.error
      : `expected ${r.row.expected.classification}, got ${r.got!.classification}`;
    console.log(`  ${RED}✗${RESET} ${r.row.id.padEnd(28)} ${detail}${r.row.contested ? `  ${DIM}(contested label)${RESET}` : ''}`);
  }
  // The hallucination guard is a hard gate, not a score.
  const hallucinationLine =
    hallucinations === 0
      ? `  ${GREEN}✓${RESET} no unverified role names returned ${DIM}(hard requirement)${RESET}`
      : `  ${RED}✗ ${hallucinations} HALLUCINATED ROLE NAME(S) — this must be zero${RESET}`;
  console.log(hallucinationLine);
  for (const r of results.filter((x) => x.hallucinated)) {
    console.log(`      ${RED}${r.row.id}: returned "${r.got!.roleName}", expected ${r.row.expected.roleName ?? 'null'}${RESET}`);
  }

  summary['roles'] = { passed, total: results.length, rate, baseline, hallucinations };
  console.log();
}

if (suite === 'all' || suite === 'adjudication') {
  const results = await runAdjudication();
  const passed = results.filter((r) => r.ok).length;
  if (passed !== results.length) failed = true;

  console.log(
    `${BOLD}adjudication${RESET}           ${passed}/${results.length}  (${pct(passed, results.length)})` +
      `   ${DIM}target 100% — it gates an irreversible action${RESET}`,
  );
  for (const r of results) {
    const mark = r.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const report = JSON.parse(readFileSync(join(fixturesDir, r.row.reportPath), 'utf8')) as ShadowReport;
    const rate = (computeAgreementRate(report) * 100).toFixed(0);
    const got = r.error ? `ERROR: ${r.error}` : r.got!.verdict;
    const expectation = r.ok ? '' : ` ${DIM}(expected ${r.row.expected.verdict})${RESET}`;
    console.log(`  ${mark} ${r.row.id.padEnd(28)} ${String(got).padEnd(10)} ${DIM}agreement ${rate.padStart(3)}%${RESET}${expectation}`);
  }

  summary['adjudication'] = { passed, total: results.length, rate: passed / results.length };
  console.log();
}

if (asJson) console.log(JSON.stringify(summary, null, 2));

process.exit(failed ? 1 : 0);
