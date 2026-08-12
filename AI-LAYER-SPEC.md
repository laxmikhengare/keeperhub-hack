# Understudy — AI Layer Specification

**Owner:** Laxmi
**Package:** `@understudy/agent`
**Depends on:** nothing from the web3 side. You build against fixtures.
**Deadline:** working + evaluated by **Aug 10**. Integration Aug 11.

> **If you are a coding agent reading this:** this document is your complete brief. Build the package described in §3 against the interfaces in §4. Everything you need is here — do not ask for blockchain access, RPC endpoints, wallets, or API keys beyond `ANTHROPIC_API_KEY`. Start with §11 (Definition of Done) so you know what you're aiming at, then work §5 → §6 → §7.

---

## 1. Read this first — the boundary

The project splits cleanly in two. **You own the entire left column. Do not write anything in the right column.**

| Laxmi (this doc) | Kaustubh |
|---|---|
| `src/agent/analyst.ts` | `src/scout/**` — reading blockchain data |
| `src/agent/adjudicator.ts` | `src/builder/**` — generating jobs |
| `src/agent/prompts/**` | `src/shadow/**` — running the observe-only pass |
| `src/agent/schemas.ts` | `src/cutover/**` — the transaction state machine |
| `src/agent/keccak.ts` | `src/evidence/**`, `web/**`, `contracts/**` |
| `evals/**` | everything blockchain |

The two halves meet at exactly **two function signatures** (§4). Those are frozen. If you need them changed, message Kaustubh — do not change them unilaterally, because he is coding against them at the same time.

**You will never need:** a wallet, a private key, an RPC URL, testnet funds, Solidity, or any blockchain library. Your inputs are JSON. Your outputs are JSON.

---

## 2. What the product is, in three minutes

Skip the crypto connotations. Mechanically:

**A blockchain is a shared, append-only, publicly readable database.** A **smart contract** is an immutable program deployed into it, holding state and exposing functions. An **address** (`0x89057c7e…`) is an account ID. A **transaction** is a write — costs a fee, takes seconds, **irreversible**.

Three facts that matter for your work:

1. **Contracts cannot wake themselves up.** No `setInterval`, no internal cron. If a program needs something done hourly, an external process must call it. That process is a **keeper** — a cron job with an account.
2. **Permissions are per-contract IAM stored as data.** A contract has something like `KEEPER_ROLE` and a mapping of which addresses hold it. Functions are guarded with `onlyRole(KEEPER_ROLE)`. Updating an allowlist is a paid, irreversible write.
3. **Everything is public** — every grant, every call, back to 2015. That's how we discover things with no credentials.

### The problem

Four keeper providers shut down in four months. The replacement keeper runs under a **different account**, and the old account's credentials cannot be exported. So for every protocol:

> Find every contract that still trusts the dead account → grant the same trust to the new one → prove the new one works → revoke the old one. Across dozens of contracts and several chains. **Revoke too early and the protocol sits unattended** (that's where real money gets lost). **Revoke too late and a dead credential still has production access.**

Think: your scheduled-jobs provider died, the new one uses a different service account, forty microservices have the old one hardcoded in their IAM allowlists, each update is an irreversible paid API call, and you're doing it at 2am.

Every provider's official migration path is a document beginning *"do this by hand."*

### The pipeline

```
1. SCOUT        (Kaustubh)  Read public data → EvidenceBundle
2. ANALYST      ★ YOU       Which permissions matter? What was this job doing?
3. BUILDER      (Kaustubh)  Generate the replacement job, dry-run it
4. SHADOW       (Kaustubh)  Run it observe-only against live state → ShadowReport
5. ADJUDICATOR  ★ YOU       Are the disagreements harmless or a regression? Ready?
6. CUTOVER      (Kaustubh)  grant → verify N real executions → revoke
```

**Your Adjudicator's verdict is the only thing that unlocks the irreversible revoke.** Not a threshold. Your judgment. That is the centrepiece of the whole project and the reason it's an agent rather than a script.

---

## 3. Your deliverable

```
src/agent/
├── index.ts            # exports analyze() and adjudicate() — the seam
├── schemas.ts          # Zod schemas for both inputs and both outputs
├── analyst.ts          # Component 1
├── adjudicator.ts      # Component 2
├── keccak.ts           # deterministic role-hash resolution pre-pass
├── client.ts           # shared Anthropic client + error handling
└── prompts/
    ├── analyst.md
    └── adjudicator.md

evals/
├── role-classification.jsonl   # 25–30 hand-labeled rows
├── adjudication.jsonl          # 8–12 scenario rows
├── run.ts                      # prints accuracy
└── fixtures/                   # EvidenceBundle + ShadowReport JSON files
```

**Dependencies you need, and nothing more:**

```bash
npm i @anthropic-ai/sdk zod js-sha3
npm i -D tsx vitest @types/node
```

`js-sha3` is a pure hash function — it is not a blockchain library and pulls in no web3 tooling.

---

## 4. THE CONTRACT — frozen interfaces

This is the most important section. Everything else can move; this cannot.

```ts
// ============ INPUT to Analyst — produced by Scout ============

export interface EvidenceBundle {
  deadKeeper: {
    address: string                 // "0x89057c7e4c5cd283aff5907b816f61e326047c29"
    chainId: number                 // 1 = Ethereum mainnet, 8453 = Base, 11155111 = Sepolia
    provider: 'chainlink' | 'gelato' | 'defender' | 'manual'
  }

  /** Present when discovered from a keeper registry; absent for a bare address. */
  upkeep?: {
    id: string
    targetContract: string
    checkFunctionSig: string | null    // e.g. "checkUpkeep(bytes) returns (bool,bytes)"
    performFunctionSig: string | null  // e.g. "performUpkeep(bytes)"
    adminAddress: string
    balance: string                    // decimal string
  }

  /** Every (contract, role) pair the dead keeper was granted. */
  permissions: Array<{
    contract: string
    roleHash: string                // 32-byte hex — an OPAQUE ID, see §5
    grantedAtBlock: number
    stillActive: boolean            // confirmed live on-chain right now
  }>

  /** Source + ABI for every contract above. Keyed by lowercased address. */
  contracts: Record<string, {
    address: string
    name: string | null
    isProxy: boolean
    implementationAddress: string | null
    verifiedSource: string | null   // full Solidity source, may be large or null
    abi: unknown[] | null           // JSON ABI
  }>

  /** What the dead keeper actually did, decoded. Empty array = no history found. */
  callHistory: Array<{
    contract: string
    selector: string                // "0x4585e33b" — first 4 bytes of the call
    functionName: string | null     // decoded from ABI when possible
    count: number
    firstBlock: number
    lastBlock: number
  }>

  chainContext: {
    chainId: number
    chainName: string
    currentBlock: number
  }
}

// ============ OUTPUT of Analyst ============

export interface PermissionAnalysis {
  permissions: Array<{
    contract: string
    roleHash: string
    roleName: string | null           // resolved & VERIFIED, or null if unresolvable
    resolutionMethod: 'source_constant' | 'known_standard' | 'brute_force' | 'unresolved'
    gatedFunctions: string[]          // functions this role actually guards
    observedCalls: number             // carried through from callHistory
    lastCalledBlock: number | null
    classification: 'load_bearing' | 'vestigial' | 'unknown'
    confidence: number                // 0..1
    reasoning: string                 // 1–3 sentences. RENDERED IN THE UI.
  }>

  automationIntent: {
    triggerKind: 'block' | 'event' | 'schedule' | 'unknown'
    conditionSummary: string          // plain English
    conditionCall: { contract: string; fn: string; args: string[] } | null
    action:        { contract: string; fn: string; args: string[] } | null
    confidence: number
    reasoning: string
  }

  /** Anything the agent could not determine. Surfaced to the user, never silently dropped. */
  declaredUnknowns: string[]
}

// ============ INPUT to Adjudicator — produced by Shadow ============

export interface ShadowReport {
  analysis: PermissionAnalysis        // context from stage 2

  jobSemantics: {
    description: string               // what this job is supposed to do
    targetContract: string
    /** How long the job has to act before something bad happens. THE KEY FIELD. */
    toleranceWindowSeconds: number | null
    consequenceOfMissedAction: string // e.g. "position becomes liquidatable"
  }

  observations: Array<{
    block: number
    timestamp: number
    groundTruth:  { shouldAct: boolean; reason: string }
    newWorkflow:  { wouldAct:  boolean; reason: string }
    chainState: Record<string, string>   // named readings at that block
  }>

  windowBlocks: number
  averageBlockTimeSeconds: number
}

// ============ OUTPUT of Adjudicator ============

export interface ReadinessVerdict {
  verdict: 'ready' | 'not_ready'
  agreementRate: number               // computed in code, passed through — NOT the decision
  disagreements: Array<{
    block: number
    oldDecision: string
    newDecision: string
    classification: 'benign_timing' | 'benign_old_keeper_wasteful' | 'regression'
    reasoning: string
  }>
  blockingIssues: string[]            // non-empty ⟺ verdict === 'not_ready'
  reasoning: string                   // the headline justification. RENDERED IN THE UI.
}

// ============ THE SEAM — the only two functions Kaustubh calls ============

export function analyze(bundle: EvidenceBundle): Promise<PermissionAnalysis>
export function adjudicate(report: ShadowReport): Promise<ReadinessVerdict>
```

Both functions must **throw typed errors**, never return partial garbage:

```ts
export class AgentRefusalError extends Error { constructor(public stopDetails: unknown) { super(...) } }
export class AgentSchemaError  extends Error {}
export class AgentTimeoutError extends Error {}
```

---

## 5. Component 1 — THE ANALYST

### The problem

Scout hands you pairs like `(contract: 0x89057c7e…, roleHash: 0x4b43b367…)`.

That role hash is **keccak256 of a string** — think `sha256("KEEPER_ROLE")`. There is **no global registry**, because every protocol invents its own role names. To decide whether a permission matters you have to:

1. **Resolve the hash to a name.** Read the contract's Solidity for `bytes32 public constant SOMETHING_ROLE = keccak256("SOMETHING")` and match by hashing.
2. **Find what it guards.** Which functions carry `onlyRole(SOMETHING_ROLE)` or an inline `hasRole(SOMETHING_ROLE, msg.sender)` check.
3. **Check reality.** Did the dead keeper ever call those functions? `callHistory` tells you.
4. **Judge:** `load_bearing`, `vestigial`, or `unknown`.

Step 1 is string-matching over Solidity you've never seen. Step 2 is reading control flow across inheritance. Step 4 is a call under incomplete evidence. **This is why it's an agent and not a rule** — and a judge will ask, so the reasoning has to be visible.

### Hybrid design — deterministic fast path, agentic fallback

**Do the hashing in code. Do the judgment in the model.** Never the other way round.

**`src/agent/keccak.ts`** — a deterministic pre-pass that runs before the model:

```ts
import { keccak256 } from 'js-sha3'

const hash = (s: string) => '0x' + keccak256(s)

// 1. Well-known standards. DEFAULT_ADMIN_ROLE is literally 32 zero bytes.
const STANDARD_ROLES: Record<string, string> = {
  [ '0x' + '00'.repeat(32) ]: 'DEFAULT_ADMIN_ROLE',
  [ hash('MINTER_ROLE')     ]: 'MINTER_ROLE',
  [ hash('PAUSER_ROLE')     ]: 'PAUSER_ROLE',
  [ hash('KEEPER_ROLE')     ]: 'KEEPER_ROLE',
  // …extend generously: BURNER, UPGRADER, OPERATOR, MANAGER, EXECUTOR,
  //   GUARDIAN, EMERGENCY_ADMIN, RESUME_ROLE, PAUSE_ROLE, ORACLE_ROLE, …
}

/** Pull `bytes32 ... = keccak256("NAME")` declarations out of Solidity source. */
export function extractSourceConstants(source: string): Map<string, string> { /* regex */ }

/** Given a name the model hypothesised, confirm or deny it. Never trust an unverified guess. */
export function verifyRoleName(name: string, expectedHash: string): boolean {
  return hash(name).toLowerCase() === expectedHash.toLowerCase()
}

/** Try every plausible casing/suffix permutation of a candidate. */
export function bruteForceCandidates(base: string): Array<{ name: string; hash: string }> { /* … */ }
```

Then build a **resolution table** and hand it to the model as part of the evidence:

```
RESOLVED ROLE HASHES (verified by keccak256, trust these):
  0x0000…0000  → DEFAULT_ADMIN_ROLE   (standard)
  0x4b43b367…  → KEEPER_ROLE          (source constant, line 88)
  0x9ab8816a…  → UNRESOLVED
```

The model's job is then the part that actually needs a model: what does an unresolved role guard, and does any of this matter?

**The rule to hold on to: if the model ever states a role name that `verifyRoleName()` doesn't confirm, set `roleName: null` and `resolutionMethod: 'unresolved'` in post-processing.** Hallucinated role names are the single biggest correctness risk in this component, and this check eliminates the entire class.

### Prompt design notes

- **Lead with the judgment task, not the definitions.** The model knows Solidity; it doesn't know what you want decided.
- **Define the three classifications sharply** with an example of each. `vestigial` = the role exists but the keeper never used the functions it guards. `unknown` = you genuinely can't tell — and saying so is a correct answer, not a failure.
- **Force evidence into the reasoning.** Require each `reasoning` string to cite either a source line or a call count. This is what shows on screen at the decision point, so it has to read like an engineer wrote it: *"role 0x4b43… = EMERGENCY_ADMIN, gates pause(), never called by this keeper in 12,000 blocks → vestigial."*
- **Reward `declaredUnknowns`.** Silently dropping something we couldn't parse is a correctness bug and a credibility bug. Surfacing it is more convincing than false completeness.
- **Handle proxies.** When `isProxy` is true, the logic lives in `implementationAddress`'s source, not the proxy's. Say so explicitly in the prompt.
- **Truncation strategy.** Solidity source can exceed context. Prefer sending contracts that appear in `permissions` at full length and summarising the rest. Opus 5 has a 1M context window, so this is rarely a problem — but handle it deterministically rather than letting it fail at runtime.

### Failure modes to test

| Case | Correct behaviour |
|---|---|
| `verifiedSource` is `null` | Fall back to ABI + call history. `resolutionMethod: 'unresolved'`, low confidence. Don't invent a name. |
| Role held but zero call history | Strong `vestigial` signal — but check whether it guards an emergency function that *should* rarely fire. |
| Role hash resolves to nothing anywhere | `unknown`, and add to `declaredUnknowns`. Never guess. |
| Contract is a proxy | Analyse the implementation's source. |
| Inherited roles from a base contract not in the bundle | `declaredUnknowns`. |
| Empty `permissions` array | Return an empty analysis cleanly, don't throw. |

---

## 6. Component 2 — THE ADJUDICATOR

### This is the most important 200 lines in the project

The Shadow stage produces N observations of *"here's what the old keeper did, here's what the new one would have done, here's the chain state."* Some disagree.

**The insight the whole demo rests on:**

| Run | Agreement | Correct verdict | Why |
|---|---|---|---|
| A | **97%** | `ready` | 3 disagreements, all timing jitter — the new job fires 1–2 blocks later on a task with a 3600-second tolerance window. Nothing was missed. |
| B | **97%** | `not_ready` | 3 disagreements — but one skipped an action while ground truth said act, inside a two-block liquidation window. Real money at risk. |

**Same number. Opposite answers.** A threshold provably cannot produce both. The difference lives in `jobSemantics.toleranceWindowSeconds` and `consequenceOfMissedAction` — what the job *means*.

You must build **both scenarios as fixtures** and make them pass. They are the demo.

### Classification rules to encode in the prompt

- `benign_timing` — the new workflow acted, just later, **and the delay is comfortably inside `toleranceWindowSeconds`**. Compute the delay in seconds using `averageBlockTimeSeconds`; don't eyeball block numbers.
- `benign_old_keeper_wasteful` — the old keeper acted when ground truth said it didn't need to. The new one being more conservative is an improvement, not a regression.
- `regression` — the new workflow **failed to act when ground truth said act**, or acted when it clearly shouldn't have. Any single instance inside the tolerance-critical path blocks the cutover.

### Hard requirements

1. **`verdict: 'not_ready'` ⟺ `blockingIssues.length > 0`.** Enforce this in post-processing; if the model returns an inconsistent pair, throw `AgentSchemaError`.
2. **Any `regression` forces `not_ready`.** Assert it in code after the call. The model should reach the conclusion on its own — the assertion is a safety net, and if it ever fires, that's a prompt bug worth fixing.
3. **`agreementRate` is computed by Kaustubh's code and passed through.** It is context for the model, never the decision. Do not let the prompt treat it as a threshold.
4. **`reasoning` must be quotable on stage.** It appears on screen during the pitch. Aim for two sentences a senior engineer would write.

### Prompt design notes

- Give the model the **tolerance window and the consequence** prominently — they are the discriminator between the two scenarios.
- Tell it explicitly: *"A high agreement rate is not sufficient. A single missed obligation inside the tolerance window blocks the cutover regardless of the rate."*
- Ask it to reason about **each disagreement independently** before the overall verdict. Independent classification first, aggregate second.
- **Being conservative is correct.** The cost of a false `not_ready` is a human looks again. The cost of a false `ready` is an unmonitored protocol. Say that in the prompt.

---

## 7. The eval harness

**This is a headline deliverable, not a nice-to-have.** Nobody in a hackathon ships evals for their agent. It simultaneously proves the agent works, proves it *is* an agent (you don't write evals for an `if` statement), and reads as rigor to the judges — who are infrastructure engineers.

The accuracy number goes in the project README.

### `evals/role-classification.jsonl`

25–30 rows, one JSON object per line:

```jsonl
{"id":"lido-accounting-01","bundlePath":"fixtures/lido-accounting.json","contract":"0x89057c7e…","roleHash":"0x4b43b367…","expected":{"classification":"load_bearing","roleName":"KEEPER_ROLE"},"note":"gates performUpkeep, 412 observed calls"}
```

**How to build the label set without blockchain access:** Kaustubh will drop **3–5 real `EvidenceBundle` JSON files** into `evals/fixtures/` on **Day 3**. Until then, have your agent generate synthetic bundles from the §4 schema — realistic Solidity, realistic role constants, realistic call histories. Synthetic bundles are fine for building; swap in the real ones when they land and re-measure.

**Cover these cases deliberately:** an obvious load-bearing role · an obvious vestigial role · an emergency role never called (the hard one — vestigial or load-bearing?) · an unresolvable hash · a proxy contract · a contract with `verifiedSource: null` · `DEFAULT_ADMIN_ROLE` · a role inherited from an absent base contract.

### `evals/adjudication.jsonl`

8–12 rows. **The two twin scenarios at identical agreement rates are mandatory** — everything else is supporting coverage.

```jsonl
{"id":"twin-a-benign","reportPath":"fixtures/shadow-benign.json","expected":{"verdict":"ready"},"note":"97% agreement, timing jitter inside 3600s window"}
{"id":"twin-b-regression","reportPath":"fixtures/shadow-regression.json","expected":{"verdict":"not_ready"},"note":"97% agreement, one missed action inside 2-block window"}
```

### `evals/run.ts`

```
$ npm run eval

role classification    27/30  (90.0%)
  ✗ lido-oracle-04   expected load_bearing, got vestigial
  ✗ aave-acl-11      expected unresolved, got MANAGER_ROLE  ← hallucinated name
  ✗ synthetic-07     expected unknown, got vestigial

adjudication           12/12  (100.0%)
  ✓ twin-a-benign     ready
  ✓ twin-b-regression not_ready
```

**Targets: ≥85% role classification, 100% adjudication.** Adjudication must be perfect — it gates an irreversible action, and there are only a dozen cases.

Run evals concurrently with a small pool (4–6) and cache responses by input hash so re-runs are cheap.

---

## 8. Claude API reference — Opus 5 specifics

Model: **`claude-opus-5`**. These are current and several differ from older Claude models — do not write from memory.

```ts
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'

const client = new Anthropic()   // reads ANTHROPIC_API_KEY

const res = await client.messages.parse({
  model: 'claude-opus-5',
  max_tokens: 16000,
  thinking: { type: 'adaptive' },
  output_config: {
    effort: 'high',                          // low | medium | high | xhigh | max
    format: zodOutputFormat(PermissionAnalysisSchema),
  },
  system: ANALYST_SYSTEM,
  messages: [{ role: 'user', content: evidenceText }],
})

if (res.stop_reason === 'refusal') throw new AgentRefusalError(res.stop_details)
const analysis = res.parsed_output           // nullable — guard it
if (!analysis) throw new AgentSchemaError('parse returned null')
```

**Gotchas that will cost you an hour each:**

| Gotcha | Detail |
|---|---|
| `temperature` / `top_p` / `top_k` | **Rejected with a 400** on Opus 5. Steer with prompting instead. |
| `effort` placement | Inside `output_config`, **not** top-level. |
| Thinking | **On by default** on Opus 5. `{type:'adaptive'}` is equivalent to omitting it; set it explicitly for documentation. `max_tokens` caps thinking *plus* output — give it room. |
| `parsed_output` | Nullable. Always guard. |
| `stop_reason: 'refusal'` | Returns **HTTP 200**, not an error. Permission analysis is security-adjacent enough that a classifier could conceivably fire; check it before reading content or you'll crash mid-demo. |
| Prefill | Last-assistant-turn prefills return a 400. Use structured outputs (you already are). |
| Schema limits | No recursive schemas, no `minLength`/`maximum` constraints. Keep schemas flat-ish. |
| Effort tuning | Start at `high`. Sweep `medium` and `xhigh` against the eval set — `low`/`medium` are unusually strong on Opus 5 and may match `high` at a fraction of the cost. |

Prompt caching is worth wiring for the eval loop: put the stable system prompt in a cached block so 30 eval rows don't re-pay for it.

---

## 9. Fixtures — real data to build against

Real values pulled from live Ethereum mainnet, so your synthetic fixtures look like the real thing:

```
Dead-keeper-shaped account (real, holds roles on 126 contracts):
  0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c        (Lido DAO Agent)

Real contracts it holds roles on:
  0x89057c7e4c5cd283aff5907b816f61e326047c29        (5 roles)
  0x7d498dc44a0dc8f0f0a7acd053a00f97cb15e0f9        (5 roles)
  0x0f25c1dc2a9922304f2eac71dca9b07e310e8e5a        (5 roles)
  0x7e1dbd017973871abcfac9e4b830018812056c17        (1 role — DEFAULT_ADMIN)

Real role-hash prefixes observed on those contracts:
  0x0000000000…   ← DEFAULT_ADMIN_ROLE (32 zero bytes)
  0x4b43b367…
  0x63f736f21c…
  0x9ab8816a3d…
  0x94a954c0bc…

A real dead Chainlink upkeep (registry sunset July 31, still funded):
  target contract  0x13596380b9a91f1f3a1bd30e63d89f9c9185e84e
  gas limit        700000
  balance          0.785 LINK
```

Full hashes and complete bundles arrive from Kaustubh on **Day 3**. Generate synthetic ones in the meantime — do not block.

---

## 10. Suggested build order

| Day | Work |
|---|---|
| **1** | `schemas.ts` (all four §4 types as Zod) · `keccak.ts` with the standards table and source-constant regex, unit-tested · one synthetic `EvidenceBundle` fixture |
| **2** | `analyst.ts` end to end on the synthetic fixture. Get *something* returning valid typed output before tuning quality. |
| **3** | Real bundles land. Expand fixtures. Write the 25–30 label rows. `evals/run.ts`. Measure. |
| **4** | Tune the analyst prompt to ≥85%. Add the hallucination guard. Sweep `effort`. |
| **5** | `adjudicator.ts` + **the two twin fixtures**. This is the demo — get it right. |
| **6** | Adjudication evals at 100%. Post-processing assertions. Error types. Integration handoff. |

**Ship a working-but-mediocre analyst on Day 2.** Kaustubh is blocked on the *shape* of your output, not its quality. An analyst returning valid typed objects unblocks his entire pipeline; a perfect one on Day 5 does not.

---

## 11. Definition of Done

- [ ] `analyze(bundle)` and `adjudicate(report)` exported from `src/agent/index.ts`, matching §4 exactly
- [ ] Both return schema-valid typed objects or throw a typed error — never partial garbage
- [ ] **No role name is ever returned unless `verifyRoleName()` confirmed it**
- [ ] `verdict: 'not_ready'` ⟺ `blockingIssues.length > 0`, asserted in code
- [ ] Any `regression` classification forces `not_ready`, asserted in code
- [ ] `npm run eval` prints both scores. Role classification **≥85%**, adjudication **100%**
- [ ] **The two twin scenarios pass** — identical agreement rate, opposite verdicts
- [ ] `evals/fixtures/` contains ≥6 bundles covering the §5 failure-mode table
- [ ] Unit tests for `keccak.ts` — standards table, source-constant regex, verification
- [ ] Every `reasoning` string cites concrete evidence (a source line or a call count)
- [ ] Runs from a clean checkout with only `ANTHROPIC_API_KEY` set
- [ ] `src/agent/README.md`: how to run, current eval scores, known limitations

---

## 12. Anti-requirements — things that will sink the project

The hackathon is called **Agents Onchain**. Judges will ask where the agent is. These are the ways to fail that question:

- ❌ **A threshold anywhere in the Adjudicator.** `if (agreementRate > 0.95) return 'ready'` is the single worst line you could write. The twin scenarios exist to prove that's impossible.
- ❌ **An LLM summarising a decision code already made.** That's decoration and judges spot it instantly.
- ❌ **An LLM doing something deterministic** — hashing, filtering, counting, formatting. Those go in `keccak.ts` and plain code.
- ❌ **Reasoning that isn't surfaced.** If the judgment doesn't render on screen at the decision point, it doesn't exist to a judge.
- ❌ **Unverified role names.** One hallucinated `KEEPER_ROLE` in the demo destroys credibility on the spot.
- ❌ **Silent unknowns.** Dropping something you couldn't parse is worse than declaring it.

**The test to keep applying: could a bash script do this?** If yes, anywhere on the critical path, that part is not the agent.

---

## 13. Questions → Kaustubh

Anything about blockchains, the Scout's output, the Shadow stage, or KeeperHub. Do not spend time researching web3 — that's the other half of the team, and the boundary in §1 is deliberate.

**One thing to flag immediately if it comes up:** if you need a change to the §4 interfaces, message before changing them. He is coding against them in parallel.
