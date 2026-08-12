/**
 * Component 2 — THE ADJUDICATOR.
 *
 * The most important code in the project (§6). Its verdict is the only thing
 * that unlocks the irreversible revoke.
 *
 * There is deliberately no threshold anywhere in this file. `agreementRate` is
 * computed here, in code, and passed straight through to the caller — it is
 * context for the model and a field on the output, and it never appears in a
 * comparison that influences the verdict. §12 names `if (agreementRate > 0.95)`
 * as the single worst line that could be written here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { callModel, type Effort } from './client.js';
import { AgentSchemaError } from './errors.js';
import { ReadinessVerdictModelOutputSchema, ReadinessVerdictSchema, ShadowReportSchema } from './schemas.js';
import type { ReadinessVerdict, ShadowReport } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const ADJUDICATOR_SYSTEM = readFileSync(join(here, 'prompts/adjudicator.md'), 'utf8');

export interface AdjudicateOptions {
  effort?: Effort;
  maxTokens?: number;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Deterministic pre-pass                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Agreement rate, computed in code.
 *
 * Passed through to the verdict verbatim. This is a reported statistic, not an
 * input to any branch.
 */
export function computeAgreementRate(report: ShadowReport): number {
  const total = report.observations.length;
  if (total === 0) return 1;
  const agree = report.observations.filter(
    (o) => o.groundTruth.shouldAct === o.newWorkflow.wouldAct,
  ).length;
  return agree / total;
}

export interface DisagreementRow {
  block: number;
  timestamp: number;
  index: number;
  groundTruth: ShadowReport['observations'][number]['groundTruth'];
  newWorkflow: ShadowReport['observations'][number]['newWorkflow'];
  chainState: Record<string, string>;
}

export function findDisagreements(report: ShadowReport): DisagreementRow[] {
  return report.observations
    .map((o, index) => ({ ...o, index }))
    .filter((o) => o.groundTruth.shouldAct !== o.newWorkflow.wouldAct);
}

/**
 * §6: "Compute the delay in seconds using averageBlockTimeSeconds; don't eyeball
 * block numbers." So code does the arithmetic and hands the model figures.
 */
function toleranceMath(report: ShadowReport): string {
  const t = report.jobSemantics.toleranceWindowSeconds;
  const blockTime = report.averageBlockTimeSeconds;

  if (t === null) {
    return (
      `tolerance window: NOT SPECIFIED (null)\n` +
      `  The deadline is unknown. A delay cannot be shown to be safe.`
    );
  }

  const blocks = t / blockTime;
  return (
    `tolerance window: ${t}s  ==  ${blocks.toFixed(1)} blocks at ${blockTime}s/block\n` +
    `  one block  = ${blockTime}s  (${((blockTime / t) * 100).toFixed(3)}% of the window)\n` +
    `  two blocks = ${blockTime * 2}s  (${(((blockTime * 2) / t) * 100).toFixed(3)}% of the window)`
  );
}

function renderEvidence(report: ShadowReport, agreementRate: number, rows: DisagreementRow[]): string {
  const parts: string[] = [];
  const js = report.jobSemantics;

  parts.push('# JOB SEMANTICS — read this before the observations');
  parts.push(
    `description: ${js.description}\n` +
      `target contract: ${js.targetContract.toLowerCase()}\n\n` +
      `consequence of a missed action:\n  ${js.consequenceOfMissedAction}\n\n` +
      toleranceMath(report),
  );

  parts.push('\n# SHADOW RUN');
  parts.push(
    `observations: ${report.observations.length} over ${report.windowBlocks} blocks ` +
      `(avg ${report.averageBlockTimeSeconds}s/block)\n` +
      `disagreements: ${rows.length}\n` +
      `agreement rate: ${(agreementRate * 100).toFixed(1)}%  ` +
      `— CONTEXT ONLY. This number is computed in code and is not a criterion. ` +
      `Do not reason from it toward a verdict.`,
  );

  parts.push('\n# DISAGREEMENTS — classify each one independently');
  if (rows.length === 0) {
    parts.push('None. The new workflow matched ground truth on every observation.');
  }
  for (const r of rows) {
    const state = Object.entries(r.chainState)
      .map(([k, v]) => `    ${k}: ${v}`)
      .join('\n');
    parts.push(
      `\n## observation ${r.index + 1} of ${report.observations.length} — block ${r.block.toLocaleString()} (ts ${r.timestamp})\n` +
        `  ground truth : shouldAct=${r.groundTruth.shouldAct}\n` +
        `                 ${r.groundTruth.reason}\n` +
        `  new workflow : wouldAct=${r.newWorkflow.wouldAct}\n` +
        `                 ${r.newWorkflow.reason}\n` +
        `  chain state at this block:\n${state}`,
    );
  }

  parts.push('\n# UPSTREAM PERMISSION ANALYSIS (stage 2 context)');
  for (const p of report.analysis.permissions) {
    parts.push(
      `- ${p.roleName ?? '(unresolved)'} on ${p.contract.toLowerCase()} — ${p.classification} ` +
        `(confidence ${p.confidence}); gates ${p.gatedFunctions.join(', ') || '(unknown)'}; ` +
        `${p.observedCalls} observed calls`,
    );
  }
  if (report.analysis.declaredUnknowns.length > 0) {
    parts.push('\nUnknowns declared upstream:');
    for (const u of report.analysis.declaredUnknowns) parts.push(`  - ${u}`);
  }

  return parts.join('\n');
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The seam                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export async function adjudicate(
  report: ShadowReport,
  options: AdjudicateOptions = {},
): Promise<ReadinessVerdict> {
  const validated = ShadowReportSchema.safeParse(report);
  if (!validated.success) {
    throw new AgentSchemaError('ShadowReport failed schema validation', validated.error.issues.slice(0, 10));
  }

  const agreementRate = computeAgreementRate(report);
  const rows = findDisagreements(report);
  const evidence = renderEvidence(report, agreementRate, rows);

  const { value } = await callModel({
    schema: ReadinessVerdictModelOutputSchema,
    system: ADJUDICATOR_SYSTEM,
    user: evidence,
    label: 'adjudicator',
    // The judgment is short; the reasoning is what costs tokens.
    maxTokens: options.maxTokens ?? 16_000,
    ...(options.effort ? { effort: options.effort } : {}),
  });

  return postProcess(value, agreementRate);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Post-processing assertions (§6 hard requirements)                          */
/* ────────────────────────────────────────────────────────────────────────── */

type ModelVerdict = ReturnType<typeof ReadinessVerdictModelOutputSchema.parse>;

export function postProcess(model: ModelVerdict, agreementRate: number): ReadinessVerdict {
  let verdict = model.verdict;
  const blockingIssues = [...model.blockingIssues];

  // Requirement 2: any regression forces not_ready.
  //
  // The model is expected to reach this on its own — the prompt says so
  // explicitly. This is a safety net. If it ever fires, that is a prompt bug
  // worth fixing, so it is loud rather than silent.
  const regressions = model.disagreements.filter((d) => d.classification === 'regression');
  if (regressions.length > 0 && verdict === 'ready') {
    const blocks = regressions.map((r) => r.block).join(', ');
    console.warn(
      `[adjudicator] SAFETY NET FIRED: model returned 'ready' with ${regressions.length} ` +
        `regression(s) at block(s) ${blocks}. Forcing not_ready. This is a prompt bug — fix the prompt.`,
    );
    verdict = 'not_ready';
    blockingIssues.push(
      `${regressions.length} disagreement(s) classified as regression at block(s) ${blocks}; ` +
        `a regression blocks cutover regardless of the agreement rate.`,
    );
  }

  // Requirement 1: verdict === 'not_ready'  <=>  blockingIssues.length > 0.
  if (verdict === 'not_ready' && blockingIssues.length === 0) {
    throw new AgentSchemaError(
      "inconsistent verdict: 'not_ready' with an empty blockingIssues array",
      { verdict, blockingIssues },
    );
  }
  if (verdict === 'ready' && blockingIssues.length > 0) {
    throw new AgentSchemaError(
      "inconsistent verdict: 'ready' with a non-empty blockingIssues array",
      { verdict, blockingIssues },
    );
  }

  const result: ReadinessVerdict = {
    verdict,
    // Computed in code above and passed straight through — never the model's number.
    agreementRate,
    disagreements: model.disagreements,
    blockingIssues,
    reasoning: model.reasoning,
  };

  const check = ReadinessVerdictSchema.safeParse(result);
  if (!check.success) {
    throw new AgentSchemaError('post-processed verdict failed schema validation', check.error.issues.slice(0, 10));
  }
  return check.data as ReadinessVerdict;
}
