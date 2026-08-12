import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { computeAgreementRate, findDisagreements, postProcess } from './adjudicator.js';
import { AgentSchemaError } from './errors.js';
import { stripComments } from './keccak.js';
import type { ShadowReport } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): ShadowReport =>
  JSON.parse(readFileSync(join(here, '../../evals/fixtures', name), 'utf8')) as ShadowReport;

const benign = fixture('shadow-benign.json');
const regression = fixture('shadow-regression.json');

const disagreement = (classification: 'benign_timing' | 'benign_old_keeper_wasteful' | 'regression', block = 100) => ({
  block,
  oldDecision: 'act',
  newDecision: 'skip',
  classification,
  reasoning: 'test',
});

describe('the twin scenarios', () => {
  it('have IDENTICAL agreement rates — this is the whole demo', () => {
    expect(computeAgreementRate(benign)).toBe(computeAgreementRate(regression));
    expect(computeAgreementRate(benign)).toBe(0.97);
  });

  it('differ only in what the job means', () => {
    expect(benign.jobSemantics.toleranceWindowSeconds).toBe(3600);
    expect(regression.jobSemantics.toleranceWindowSeconds).toBe(24);
  });

  it('present the same surface shape — 3 disagreements, all "old acted, new did not"', () => {
    for (const report of [benign, regression]) {
      const rows = findDisagreements(report);
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.groundTruth.shouldAct).toBe(true);
        expect(r.newWorkflow.wouldAct).toBe(false);
      }
    }
  });

  it('carry a genuinely liquidatable position inside the window in the regression twin', () => {
    const rows = findDisagreements(regression);
    const fatal = rows.find((r) => Number(r.chainState['healthFactor']) < 1);
    expect(fatal, 'regression twin must contain a real missed obligation').toBeDefined();
    expect(Number(fatal!.chainState['blocksUntilBadDebt'])).toBe(2);
  });
});

describe('computeAgreementRate', () => {
  it('returns 1 for an empty observation set rather than dividing by zero', () => {
    expect(computeAgreementRate({ ...benign, observations: [] })).toBe(1);
  });
});

describe('§6 post-processing assertions', () => {
  it('passes through the code-computed agreementRate, not anything from the model', () => {
    const out = postProcess(
      { verdict: 'ready', disagreements: [], blockingIssues: [], reasoning: 'ok' },
      0.8123,
    );
    expect(out.agreementRate).toBe(0.8123);
  });

  it('forces not_ready when a regression is present, and says why', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = postProcess(
      {
        verdict: 'ready',
        disagreements: [disagreement('regression', 4242)],
        blockingIssues: [],
        reasoning: 'model wrongly cleared this',
      },
      0.97,
    );
    expect(out.verdict).toBe('not_ready');
    expect(out.blockingIssues.length).toBeGreaterThan(0);
    expect(out.blockingIssues[0]).toContain('4242');
    // The safety net firing is a prompt bug — it must be loud.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not fire the safety net when only benign disagreements are present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = postProcess(
      {
        verdict: 'ready',
        disagreements: [disagreement('benign_timing'), disagreement('benign_old_keeper_wasteful')],
        blockingIssues: [],
        reasoning: 'all jitter',
      },
      0.97,
    );
    expect(out.verdict).toBe('ready');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws on not_ready with no blocking issues', () => {
    expect(() =>
      postProcess({ verdict: 'not_ready', disagreements: [], blockingIssues: [], reasoning: 'x' }, 0.5),
    ).toThrow(AgentSchemaError);
  });

  it('throws on ready with blocking issues', () => {
    expect(() =>
      postProcess(
        { verdict: 'ready', disagreements: [], blockingIssues: ['something is wrong'], reasoning: 'x' },
        0.99,
      ),
    ).toThrow(AgentSchemaError);
  });

  it('holds the biconditional in both directions for valid pairs', () => {
    expect(
      postProcess({ verdict: 'ready', disagreements: [], blockingIssues: [], reasoning: 'x' }, 1).verdict,
    ).toBe('ready');
    expect(
      postProcess(
        { verdict: 'not_ready', disagreements: [], blockingIssues: ['blocked'], reasoning: 'x' }, 0.4,
      ).verdict,
    ).toBe('not_ready');
  });
});

describe('no threshold anywhere in the adjudicator', () => {
  // The behavioural guarantee. This is the one that matters: whatever the
  // agreement rate is, it cannot move the verdict. A source grep proves the
  // absence of one spelling; this proves the absence of the behaviour.
  it('verdict is invariant across the entire range of agreement rates', () => {
    const rates = [0, 0.5, 0.9, 0.949, 0.95, 0.951, 0.97, 0.99, 1];

    const cleared = rates.map(
      (r) =>
        postProcess(
          { verdict: 'ready', disagreements: [disagreement('benign_timing')], blockingIssues: [], reasoning: 'x' },
          r,
        ).verdict,
    );
    expect(new Set(cleared)).toEqual(new Set(['ready']));

    const blocked = rates.map(
      (r) =>
        postProcess(
          {
            verdict: 'not_ready',
            disagreements: [disagreement('regression')],
            blockingIssues: ['missed obligation'],
            reasoning: 'x',
          },
          r,
        ).verdict,
    );
    expect(new Set(blocked)).toEqual(new Set(['not_ready']));

    // And a 100%-agreement run with a regression still cannot pass.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      postProcess(
        { verdict: 'ready', disagreements: [disagreement('regression')], blockingIssues: [], reasoning: 'x' },
        1,
      ).verdict,
    ).toBe('not_ready');
    warn.mockRestore();
  });

  it('contains no numeric comparison against agreementRate in executable code', () => {
    // Reuses the Solidity comment stripper — TS and Solidity share comment and
    // string-literal syntax, and the prose above legitimately quotes the banned
    // line `if (agreementRate > 0.95)`, which a naive grep would flag.
    const code = stripComments(readFileSync(join(here, 'adjudicator.ts'), 'utf8'));
    expect(code).not.toMatch(/agreementRate\s*[<>]=?/);
    expect(code).not.toMatch(/[<>]=?\s*0\.\d+/);
  });
});
