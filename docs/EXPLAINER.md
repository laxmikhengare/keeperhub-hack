# Understudy — plain-language explainer

---

## The 60-second version

Four "cron job as a service" providers shut down in the last four months. Thousands of financial applications relied on them to run scheduled tasks. Those tasks are now dead, and the only official migration path every provider offers is a document that starts with *"do this by hand."*

The hard part isn't rebuilding the cron job. It's that the old job ran under a **service account**, and that account ID is hardcoded into the permission lists of every application it touched. The replacement has a different account ID. So somebody has to find every place the old one was trusted, grant the same trust to the new one, verify the new one actually works, and then revoke the old one — without ever leaving the application unattended, and with every single step being **irreversible and publicly visible**.

**Understudy is an agent that does that migration.** It reads the dead job's footprint, figures out which permissions actually mattered, rebuilds the job, runs the new one in shadow mode against live production traffic, decides whether it's genuinely ready, and only then performs the handover.

The name is the point: an understudy learns the part, shadows every performance, and only goes on when they're ready.

---

## Blockchain, in five minutes, only the parts you need

Forget the crypto/trading connotations. Mechanically:

**A blockchain is a shared, append-only, publicly readable database.** Anyone can read all of it, for free. Writing costs a small fee and is permanent.

**A smart contract is a program deployed into that database.** Once deployed, its code can't be changed. It holds state (balances, config, permissions) and exposes functions anyone can call.

**An address is an account ID** — effectively a public key, like `0x89057c7e4c5cd283aff5907b816f61e326047c29`. Both users and programs have them.

**A transaction is a write.** Costs money, takes a few seconds, and is irreversible.

Four things that are unusual coming from normal backend work:

1. **Contracts cannot wake themselves up.** There is no `setInterval`, no cron inside the database. If a program needs something to happen every hour, an *external* process must call it. That external process is called a **keeper**. This is the whole reason our project exists.
2. **Permissions live inside each contract, as data.** A typical contract has something like `KEEPER_ROLE`, and a mapping of which addresses hold it. Functions are guarded with `onlyRole(KEEPER_ROLE)`. It's IAM, except each service manages its own allowlist, and updating one is a paid, irreversible database write.
3. **Everything is public.** Every permission grant, every call, every failure — all queryable, all the way back to 2015. This is what makes our discovery step possible without any credentials.
4. **There's a prod and a staging network.** "Mainnet" is prod (real money). "Sepolia" and "Base Sepolia" are testnets (free fake money). Same code, same tooling.

---

## The actual problem, in terms you'll recognise

Imagine this:

> Your company's scheduled-jobs provider announces end-of-life. You move to a new provider. But the new provider's jobs run under a **different service account**, and — critically — **you cannot export the old account's credentials.** They're gone.
>
> Meanwhile, forty of your microservices have the old service account hardcoded into their IAM allowlists. Each allowlist update is a separate, paid, irreversible API call. You can't script it blindly, because getting one wrong either breaks a service or leaves a stale credential with production access.
>
> And the ordering is a trap:
> - **Revoke too early** → your service sits unmonitored. If it's a lending protocol, that's the window where someone gets liquidated wrong and real money is lost.
> - **Revoke too late** → a dead account still has write access to production.
>
> Now do it across 40 services and 3 regions, at 2am, by hand.

That's the migration. That's what everyone is doing manually right now.

The provider quotes are real:

- OpenZeppelin: *"Private keys cannot be exported… every migration requires generating new signer addresses and updating all on-chain permissions."*
- Chainlink's own migration doc: *"No automated discovery or enumeration of existing upkeeps. All work is manual."*
- Our sponsor's own guide: *"Nothing maps automatically."* Step one is *"export and document your setup by hand."*

**Nobody automates this.** We checked 376 projects in the hackathon — two or three false positives, zero real ones.

---

## What we're building

Six stages. Two of them are the agent.

```
1. SCOUT       (plain code)  Read public data: which jobs existed, which
                             contracts still trust the dead account, and
                             what the old job actually did.

2. ANALYST     ★ AGENT       Read the contracts' source code and decide:
                             which of these permissions actually matter?
                             What was this job really doing?

3. BUILDER     (plain code)  Generate the replacement job. Dry-run it.

4. SHADOW      (plain code)  Run the new job in observe-only mode against
                             live production state. It decides what it
                             *would* do, executes nothing. Log the diff.

5. ADJUDICATOR ★ AGENT       Look at the disagreements. Are they harmless
                             or a real regression? Is this thing ready?

6. CUTOVER     (plain code)  grant new → wait for it to do the job for real
                             N times → revoke old. Every step dry-run first,
                             every step reversible until the revoke.
```

The verdict from stage 5 is the **only** thing that unlocks stage 6's final step. Not a threshold — the agent's judgment.

---

## Where the AI is (this is probably your part)

Two components. Both use Claude Opus 5 with **structured outputs** (Zod schema → guaranteed-valid JSON), so downstream code consumes typed objects, not parsed prose.

### Component 1 — The Analyst

**The problem.** Stage 1 hands us pairs like `(contract: 0x89057c7e…, role: 0x4b43b367…)`. That second value is a **keccak hash** — think `sha256("KEEPER_ROLE")`. It's an opaque 32-byte ID with no lookup table anywhere, because every project invents its own role names.

To decide whether that permission matters, you have to:

1. **Resolve the hash to a name** — read the contract's source for `bytes32 constant SOMETHING_ROLE = keccak256("SOMETHING")` and match. Source is public and usually verified, but the naming is arbitrary.
2. **Find what it guards** — which functions carry `onlyRole(SOMETHING_ROLE)`.
3. **Check reality** — pull the dead account's transaction history to that contract, decode which functions it actually called, count them.
4. **Judge** — load-bearing, vestigial, or unknown?

Step 1 is string-matching over Solidity you've never seen. Step 2 is reading control flow. Step 4 is a call under incomplete evidence. **You cannot write a rule for this on an arbitrary contract**, which is exactly why it's a good agent task.

Output schema (abridged):

```ts
{
  permissions: [{
    contract, roleHash,
    roleName: string | null,        // resolved from source, or null
    gatedFunctions: string[],
    observedCalls: number,          // from decoded history
    classification: 'load_bearing' | 'vestigial' | 'unknown',
    confidence: number,
    reasoning: string               // shown in the UI
  }],
  automationIntent: { trigger, condition, action }
}
```

### Component 2 — The Adjudicator

**The problem, and the best thing in the project.** The shadow run produces N blocks of `(what the old job did, what the new job would have done, the state at that moment)`. Some of them disagree.

Here's the key insight:

| Run | Agreement | Correct verdict | Why |
|---|---|---|---|
| A | **97%** | ✅ go ahead | 3 disagreements, all timing jitter — new job fires 1–2 blocks later on a task with a one-hour window. Nothing missed. |
| B | **97%** | ❌ block it | 3 disagreements — but one skipped a required action inside a two-block safety window. Real money at risk. |

**Same number. Opposite answers.** A threshold provably cannot produce both. The difference is what the job *means*, which lives in the contract's source and the job's intent — not in the diff.

This verdict is the **only** gate on the irreversible revoke:

```ts
const verdict = await adjudicate(shadowLog, analysis)
if (verdict.verdict !== 'ready') {
  emit('CUTOVER_BLOCKED', verdict)
  return          // ← the revoke transaction is never even constructed
}
await buildAndSubmitRevoke(...)
```

Note it's not a disabled button or a confirm dialog. On the `not_ready` branch, **the code that builds a transaction is not entered.** Nothing exists to sign.

### The eval harness

We hand-label 25–30 `(contract, role, expected classification)` rows from real production contracts and run the Analyst against them. `npm run eval` prints accuracy; the number goes in the README.

This is unusual for a hackathon and it does three jobs at once: proves the agent works, proves it *is* an agent (nobody writes evals for an `if` statement), and signals rigor to the judges — who are infrastructure engineers, not demo watchers.

---

## What you could own

The whole AI layer is cleanly separable and needs zero blockchain knowledge — the Scout hands you JSON, you hand back typed objects.

- **`src/agent/analyst.ts`** + prompts + schema
- **`src/agent/adjudicator.ts`** + prompts + schema
- **`evals/`** — the label set and the runner
- The **reasoning panel** in the UI (rendering the agent's justification at the decision point)

Concretely useful things to bring: prompt design for reading source code, structured-output schema design, building the eval set, and tuning `effort` (Opus 5's reasoning-depth dial). Two API gotchas worth knowing up front: `temperature`/`top_p`/`top_k` are **rejected with a 400** on Opus 5, and `effort` goes inside `output_config`, not at the top level.

---

## Why this wins

Judging is two stages: the sponsor's engineering team screens **every** submission down to 10 finalists, then those 10 pitch a panel. Almost all the expected value is in surviving that first screen, and it's read by engineers.

- **Zero competitors.** Across 376 hackathon projects: ~20 are the same DeFi-monitoring bot, ~12 are the same permission firewall, ~9 are the same self-attestation tool. Migration: nobody.
- **The judges have personally lived this pain.** The sponsor was built by the ops team of one of the largest DeFi protocols. "Your keeper's account changed and now every service's IAM is wrong" is the defining nightmare of that job.
- **It's their live commercial need.** They maintain comparison pages against all four dead competitors and offer discounts to teams switching over. Migration is their growth channel — and their own guide admits it's manual.
- **The demo has a moment.** Break the new job, force the cutover, and watch the agent *refuse to build the transaction*. Then show the same 97% agreement producing the opposite decision. That's the slide people remember.

---

## Glossary

| Term | Plain meaning |
|---|---|
| **Contract** | A program deployed to the shared database. Immutable once live. |
| **Address** | An account ID (public key). Users and programs both have one. |
| **Transaction** | A write. Costs a fee, takes seconds, irreversible. |
| **Keeper / upkeep** | A cron job that pokes a contract, because contracts can't self-trigger. |
| **Role** | An entry in a contract's internal IAM allowlist, e.g. `KEEPER_ROLE`. |
| **Executor / signer address** | The service account the keeper runs as. |
| **Grant / revoke** | Add to / remove from that allowlist. Each is a transaction. |
| **Mainnet / testnet** | Prod / staging. |
| **Gas** | The per-write fee. |
| **keccak hash** | Their SHA-256. Used as opaque IDs — including role names. |
| **Blockscout** | The public database browser + API. No auth needed. |
| **KeeperHub** | The hackathon sponsor. Runs the transactions reliably (retries, fee handling, dry-runs, audit log) so we don't have to. |
| **MCP** | Model Context Protocol — how our agent calls KeeperHub's tools. |
