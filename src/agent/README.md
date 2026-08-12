# `@understudy/agent` — the AI layer

Two functions. Both frozen per §4 of `AI-LAYER-SPEC.md`.

```ts
import { analyze, adjudicate } from './src/agent/index.js';

const analysis: PermissionAnalysis = await analyze(bundle);   // stage 2
const verdict:  ReadinessVerdict   = await adjudicate(report); // stage 5
```

Both return a schema-valid typed object or throw a typed error — never a partial
result. The only credential required is `ANTHROPIC_API_KEY`.

---

## Setup

```sh
npm install
cp .env.example .env        # then paste your key into .env
npm test                    # 72 unit tests, no API calls, ~0.4s
npm run typecheck
```

`.env` is gitignored. `import 'dotenv/config'` is the first line of
`client.ts`, so `tsx`, `vitest` and the eval runner all pick it up with no
per-script flags.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests. Deterministic, no API calls. |
| `npm run typecheck` | Includes the §4 interface drift guard. |
| `npm run eval` | Both eval suites. |
| `npm run eval -- --suite=roles` | Role classification only. |
| `npm run eval -- --effort=medium` | Effort sweep. |
| `npm run eval -- --no-cache` | Force fresh model calls. |
| `npm run analyze -- evals/fixtures/lido-l1-bridge.json` | Run the Analyst on one bundle. |
| `npx tsx scripts/adjudicate-fixture.ts --twins` | Run both twin scenarios side by side. |

Regenerating inputs: `scripts/make-edge-fixtures.ts`, `scripts/make-shadow-fixtures.ts`,
`scripts/make-labels.ts`.

---

## Current scores

`claude-opus-5`, `effort=high`, measured 2026-08-13.

```
role classification    27/29  (93.1%)   target ≥85% · majority-class baseline 72.4%
  ✗ edge-no-source-01        expected unknown, got load_bearing  (contested label)
  ✗ edge-proxy-no-impl-02    expected unknown, got load_bearing  (contested label)
  ✓ no unverified role names returned (hard requirement)

adjudication            8/8  (100.0%)   target 100%
  ✓ twin-a-benign               ready      agreement  97%
  ✓ twin-b-regression           not_ready  agreement  97%
  ✓ perfect-run                 ready      agreement 100%
  ✓ low-agreement-benign        ready      agreement  80%
  ✓ single-miss-high-agreement  not_ready  agreement  99%
  ✓ null-tolerance-window       not_ready  agreement  98%
  ✓ new-workflow-acted-wrongly  not_ready  agreement  98%
  ✓ no-observations             not_ready  agreement 100%
```

**Read the baseline next to the accuracy.** The label set is 21 `load_bearing`,
3 `vestigial`, 5 `unknown`, because real governance-held roles genuinely skew
that way — so a model that answered `load_bearing` every time would score
72.4%. The number that matters is the 20.7-point gap over that, and the fact
that both `vestigial` rows and 3 of 5 `unknown` rows are classified correctly.

Both remaining failures are on rows marked `contested` in the label set *before*
the run — genuine judgment disagreements, not regressions. Tuning further would
be fitting the prompt to disputed labels.

### The adjudication suite is the argument

| Scenario | Agreement | Verdict |
|---|---|---|
| `twin-a-benign` | **97%** | `ready` |
| `twin-b-regression` | **97%** | `not_ready` |
| `single-miss-high-agreement` | 99% | `not_ready` |
| `low-agreement-benign` | 80% | `ready` |
| `no-observations` | 100% | `not_ready` |

Identical rates with opposite verdicts; a *higher* rate blocked than one that
passed; a *lower* rate cleared than one that failed; and a vacuous 100%
rejected outright. The agreement rate carries no signal about the verdict, which
is the whole reason this is an agent and not a threshold.

---

## How it works

**Hashing in code, judgment in the model.** Never the other way round.

Before the model runs, `keccak.ts` + `resolve.ts` do everything deterministic:

- Strip Solidity comments with a string-literal-aware scanner, then extract
  `bytes32 ... = keccak256("LITERAL")` declarations and hash the **literal**,
  not the identifier. Lido's preimages are namespaced
  (`keccak256("BridgingManager.DEPOSITS_ENABLER_ROLE")`), so hashing the
  constant's name matches nothing.
- Walk proxy → implementation so roles held on a proxy resolve against the
  logic contract's source.
- Build a keccak-verified resolution table that the prompt tells the model to
  trust and not re-derive.

After the model returns, post-processing enforces what code can prove:

- **No role name survives unless keccak confirmed it.** Code's verified
  resolution always wins; an unconfirmed name from the model is discarded, the
  permission is reported `unresolved`, and the discard is recorded in
  `declaredUnknowns`.
- `observedCalls` and `lastCalledBlock` are a deterministic join of
  `callHistory` against the model's `gatedFunctions`. They are **omitted from
  the model's response schema entirely**, so the model cannot emit them.
- Same for `agreementRate` in the Adjudicator — computed in code, spliced in,
  never a branch condition.
- Any `regression` forces `not_ready`; `not_ready` ⟺ `blockingIssues.length > 0`,
  else `AgentSchemaError`.

`types.ts` holds the §4 interfaces verbatim plus compile-time assertions that
the Zod schemas match them, so drift fails `npm run typecheck` rather than
surfacing at integration.

---

## Known limitations

**1. `DEFAULT_ADMIN_ROLE` is undecidable from an `EvidenceBundle`.** This is the
most substantive finding. Whether revoking an admin role is safe depends on
whether *any other address* holds it — and the bundle only lists this keeper's
grants. AccessControl is non-enumerable, so it cannot be derived from source
either. The agent handles this by classifying on the consequence of being wrong
(`load_bearing`, confidence ≤0.6) and naming the exact on-chain check in
`declaredUnknowns`, but that is a mitigation, not a fix. See "For Kaustubh".

**2. Two contested labels.** `edge-no-source-01` (is `OPERATOR_ROLE` what gates
`settleEpoch` when there is no source to confirm it?) and `edge-proxy-no-impl-02`
(does a granted `DEFAULT_ADMIN_ROLE` prove the absent implementation uses
AccessControl?). Both are 50/50 judgment calls awaiting a second opinion.

**3. `brute_force` has exactly one row.** Only `edge-inherited-base` exercises
it, and it is synthetic. Real bundles either resolve from source or not at all.

**4. Multi-argument `abi.encodePacked` preimages are skipped, not guessed.**
`keccak256(abi.encodePacked(a, b))` is not statically resolvable, so the
extractor ignores it rather than emitting a wrong hash.

**5. The effort sweep is incomplete.** `high` is measured. `medium` was blocked
by API credit exhaustion; `npm run eval -- --effort=medium` will complete it.

**6. Truncation is untested in anger.** Source is capped at 600k chars with
deterministic ordering (sorted by lowercased address, for prompt-cache
stability). No fixture reaches the cap — `single-role.json` is the largest at
177 KB of Solidity.

**7. Adjudicator scale.** Every disagreement is sent in full. A shadow run with
thousands of disagreements would need summarisation; the current fixtures top
out at 20.

---

## For Kaustubh

Nothing in §4 has been changed. Two things worth a conversation:

**Proposed Scout enhancement (would need a §4 change — not made).** Adding a
per-permission `otherHolders: number` (or `isSoleHolder: boolean`) would convert
the entire `DEFAULT_ADMIN_ROLE` class from a hedged judgment into a decidable
one, and it is cheap to obtain: `RoleGranted`/`RoleRevoked` logs for that
`(contract, role)` pair. This is the single highest-value addition to the
bundle. Flagging rather than implementing, per §1.

**`scripts/make_fixture.py` is referenced by `evals/fixtures/README.md` but is
not in the repo**, so I could not generate additional real bundles from the
126 contracts the keeper holds roles on. All four real fixtures were used as-is;
the six edge-case bundles are synthetic and generated by
`scripts/make-edge-fixtures.ts`.

**Interoperability note.** `js-sha3` is CommonJS; `import { keccak256 } from
'js-sha3'` resolves under vitest but throws under plain Node ESM. It is imported
via the default export here. Worth knowing if any of that code moves.
