# Understudy

**The agent that takes over from a dead keeper without dropping a block.**

```
Transactions mined           16 on Ethereum Sepolia, all through KeeperHub
Uncovered samples             0   ← moments with no keeper at all
Tests passing                76
Role classification        89.7%  (26/29 · majority-class baseline 72.4%)
Adjudication               100%   (8/8 · incl. both twin scenarios)
Contracts migrated            1 of 5 deployed, live end to end
Surfaces exercised            MCP · simulation · audit trail · gas sponsorship ·
                              idempotency · Web3 plugin · Blockscout
```

**Full migration, on chain:**

| Step | Transaction |
|---|---|
| grant | [`0x0f3eee2d…`](https://sepolia.etherscan.io/tx/0x0f3eee2d9ced9c22bb3566389024b1276808fd274ca952dab71d8f58343a410c) |
| verify ×3 | three real settlements — epochs 8→9→10→11, each confirmed by re-reading the contract. Sponsored **internal** transactions relayed by KeeperHub, so they are not top-level entries on the wallet; see [`runs/`](./runs) |
| revoke | [`0x3e9d7ffd…`](https://sepolia.etherscan.io/tx/0x3e9d7ffdafeabcd5eeaaf0ca21654e747ea39c74e623ec02e00bf87bbd975eb8) **← the gated one** |

**Read it without cloning** — [understudy front door](https://laxmikhengare.github.io/keeperhub-hack/) ·
[migration report](https://laxmikhengare.github.io/keeperhub-hack/report.html) — every run, every
transaction, the agent's reasoning ·
[pitch deck](https://laxmikhengare.github.io/keeperhub-hack/deck.html) — five plates ·
[`LIMITS.md`](./LIMITS.md) — what's real, what's staged

---

## Contents

- [The problem](#the-problem)
- [What it does](#what-it-does)
- [Where the agent is](#where-the-agent-is)
- [Setup](#setup)
- [Running it](#running-it)
- [Deploying your own demo protocol](#deploying-your-own-demo-protocol)
- [Repository layout](#repository-layout)
- [Architecture notes](#architecture-notes)
- [KeeperHub surfaces used](#keeperhub-surfaces-used)
- [Friction we hit](#friction-we-hit-and-would-fix)
- [Honest limits](#honest-limits)

---

## The problem

Onchain protocols cannot wake themselves up. There is no cron inside a smart
contract. Something external has to poke them — settle the epoch, top up the
position, harvest the yield. Almost nobody builds that themselves; they rent it.

Four of those services closed in four months.

| Platform | Dead since |
|---|---|
| Gelato Web3 Functions | **31 March 2026** — *"fully decommissioned"* |
| Chainlink Automation v1.x | **30 June 2026** |
| OpenZeppelin Defender | **1 July 2026** |
| Chainlink Automation v2.1 | **31 July 2026** |

Migrating is not repointing a config. The dead keeper's **address** is written
into your contracts — roles, allowlists, `onlyKeeper`. The replacement has a
different address, and the old key cannot be exported.

So every contract that still trusts the dead one has to be found and rewritten.
And the ordering is a trap:

- **Revoke too early** → the protocol sits unattended. That is the window where
  a liquidation is missed and real money leaves.
- **Revoke too late** → a dead credential keeps production write access.

Every provider's official answer begins *"do this by hand."*

> **OpenZeppelin:** *"Private keys cannot be exported from Defender's AWS KMS.
> Every migration requires generating new signer addresses and updating all
> on-chain permissions."*
>
> **Chainlink, CRE migration guide:** *"No automated discovery or enumeration of
> existing upkeeps. All work is manual."*
>
> **KeeperHub's own guide:** *"Nothing maps automatically."* Step one is
> *"export and document your setup by hand."*

---

## What it does

```
1. SCOUT        code   Read public data: which contracts still trust the dead
                       keeper, what it was allowed to do, what it actually did.
2. ANALYST     AGENT   Read the contracts' source. Which permissions matter?
                       What was this job really doing?
3. REBUILD      code   Reconstruct the job. Validate and simulate it.
4. SHADOW       code   Run it observe-only against live chain state.
5. ADJUDICATOR AGENT   Are the disagreements harmless or a regression?
                       Is this replacement ready?
6. CUTOVER      code   grant → verify N real executions → revoke → attest.
```

Stage 5's verdict is the **only** thing that unlocks stage 6's revoke.

---

## Where the agent is

Two components, both structurally load-bearing. Delete either and the product
stops working.

### The Analyst — comprehension

The Scout hands it `(contract, roleHash)`. That role is a **keccak hash with no
global registry**, because every protocol invents its own names. Our demo
contract makes it deliberately hard, mirroring production practice:

```solidity
bytes32 public constant KEEPER_ROLE = keccak256("LegacyProtocol.KEEPER_ROLE");
```

The preimage is **namespaced**, exactly as Lido does it
(`keccak256("BridgingManager.DEPOSITS_ENABLER_ROLE")`). Hashing the identifier
`KEEPER_ROLE` yields `0xfc8737ab…`, which matches nothing. You have to read the
source and hash the *string literal*.

On a live Sepolia bundle:

> **KEEPER_ROLE · load_bearing · 0.95** — *"guards `performUpkeep()`
> (LegacyProtocol.sol:68), the essential settlement function; keeper called it 5
> times in blocks 11475578–11475601, and the contract's design explicitly warns
> that losing this capability leaves the protocol unattended and degraded."*

Given four contracts where the keeper held the **same role on all four** but had
only exercised it on **one**, it marked the exercised one `load_bearing` (0.95),
the rest `unknown` (0.50), and wrote its own blocking note:

> *"…must verify before revoking KEEPER_ROLE to avoid freezing any active
> settlement vaults."*

**Hallucination guard:** no role name is returned unless `keccak256` of the
model's answer reproduces the observed hash. Unverified names are discarded and
recorded in `declaredUnknowns`.

### The Adjudicator — judgment

**Two runs at the same agreement rate can require opposite verdicts.** Four live
runs, same chain, same contract, same pipeline:

| Run | Agreement | Verdict | Why |
|---|---|---|---|
| unverified source | **100%** | `NOT_READY` | role unresolvable — won't revoke on evidence it can't read |
| quiet window | **100%** | `READY` | no state transitions observed — agreement was vacuous, see `LIMITS.md` |
| faithful | **100%** | `READY` | → cutover complete, 5 transactions |
| stale-threshold | 67% | `NOT_READY` | genuine regressions, blocked |

Three runs at an identical 100%, and they do not share a verdict.

On the regression run it diagnosed the planted bug from behaviour alone, never
having been told it existed:

> *"New workflow compares `timestamp > deadline` instead of `>= deadline`,
> systematically missing settlements that arrive exactly at the deadline. With a
> 12-second tolerance window (one block), there is no margin to recover."*

It then separated six disagreements into **three regressions** and **three
benign cascades** caused by the earlier misses.

### The interlock

```ts
if (verdict.verdict !== 'ready') {
  this.record('ABORTED', why);
  return;                      // ← the revoke below is never reached
}
// …grant, then verify N live executions, and only then:
await this.write('revokeRole', this.plan.oldKeeper, 'revoke');
```

Not a disabled button. Not a confirmation dialog. On `not_ready` the code path
that constructs revoke calldata is **never entered** — nothing to sign, nothing
to send.

---

## Setup

### Prerequisites

| | |
|---|---|
| **Node.js ≥ 22** | `node -v` |
| **Foundry** | only to build or deploy contracts — [`getfoundry.sh`](https://getfoundry.sh) |
| **Anthropic API key** | required for the agents |
| **KeeperHub API key** | required only to execute onchain |

### Install

```sh
git clone https://github.com/laxmikhengare/keeperhub-hack.git
cd keeperhub-hack
npm install
cp .env.example .env      # then fill in ANTHROPIC_API_KEY
```

### Verify it works — no network, no keys

```sh
npm run typecheck         # includes the interface drift guard
npm test                  # 76 tests, deterministic, no API calls
```

Both pass on a clean checkout with an empty `.env`.

### Run the agents

Add `ANTHROPIC_API_KEY` to `.env`, then:

```sh
npm run eval              # both eval suites — ~2 min, a few cents
npm run analyze -- evals/fixtures/lido-l1-bridge.json
```

`lido-l1-bridge.json` is a **real Ethereum mainnet bundle**: a proxy whose logic
is only reachable through the EIP-1967 slot, with namespaced role preimages and
a decoy `MY_ROLE` constant sitting inside an OpenZeppelin doc comment. See
[`evals/fixtures/README.md`](./evals/fixtures/README.md) for why each fixture is
there.

### Execute onchain

Add `KEEPERHUB_API_KEY` and `SEPOLIA_RPC_URL`. Get the key from
app.keeperhub.com → Settings → API Keys → Organisation. Then read your wallet
address:

```sh
curl -s -H "Authorization: Bearer $KEEPERHUB_API_KEY" \
  https://app.keeperhub.com/api/integrations
```

Put that `address` in `.env` as `KH_WALLET`.

---

## Running it

### Scout — chain to evidence bundle

Public reads only. No wallet, no key, no archive node.

```sh
npm run scout -- --keeper 0x57e7… --chain 11155111 \
  --contracts 0x34d6…,0x7150… --out bundle.json

# omit --contracts for a full reverse lookup across the chain (slow on mainnet)
npm run scout -- --keeper 0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c --chain 1
```

The bundle is validated against the frozen schema inside the Scout, so a
malformed one fails there rather than inside the Analyst.

### The full migration

```sh
# the refusal — adjudicator blocks, no revoke is constructed
npm run migrate -- --contract $CYCLER --variant stale-threshold --blocks 30

# the cutover — grant, three real settlements, revoke, attest
npm run migrate -- --contract $CYCLER --variant faithful --blocks 30
```

Both write `runs/<variant>-<ts>.jsonl` (the journal) and `.summary.json`.

**Between runs**, the dead keeper needs its role back:

```sh
cast send $CYCLER "grantRole(bytes32,address)" \
  $(cast keccak "LegacyProtocol.KEEPER_ROLE") $DEAD_KEEPER \
  --private-key $DEPLOYER_PRIVATE_KEY --rpc-url $SEPOLIA_RPC_URL
```

> The `stale-threshold` defect only diverges when the deadline actually moves.
> If nothing has settled the contract recently, both variants agree 100% and the
> run passes. Drive some settlements first — and see `LIMITS.md`, because that
> false pass is a real limitation, not a demo quirk.

### Report

```sh
npm run report -- --all --out docs/report.html
npm run report -- runs/faithful-1786570516604
```

Self-contained HTML. Refused runs sort first.

### Blast radius, standalone

```sh
./spike/blast-radius.sh 0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c
```

Bash and curl, no dependencies. Every contract on mainnet that granted that
address a role, each confirmed live with `hasRole()`. The Lido DAO Agent returns
**126 contracts**.

### Regenerate fixtures

```sh
python3 scripts/make_fixture.py <keeper> <contract> evals/fixtures/name.json
```

---

## Deploying your own demo protocol

Only needed to run the full migration against contracts you control.

```sh
npm run build:contracts

# a throwaway key with ~0.05 Sepolia ETH
export DEPLOYER_PRIVATE_KEY=0x…
export OLD_KEEPER=$(cast wallet new | grep Address | awk '{print $2}')
export GUARDIAN=$(cast wallet new  | grep Address | awk '{print $2}')

npm run deploy:contracts
```

Three instances with different epoch/window pairs, so the blast-radius scan
returns a multi-contract result:

| | epoch / window | why |
|---|---|---|
| vault | 1h / 10m | time-critical settlement |
| treasury | 6h / 1h | generous window — late is tolerable |
| oracle | 15m / 2m | tight window — a missed beat matters |

For the shadow demo you also want a fast cycler, so state actually moves:

```sh
cd contracts && forge create src/LegacyProtocol.sol:LegacyProtocol --broadcast \
  --private-key $DEPLOYER_PRIVATE_KEY --rpc-url $SEPOLIA_RPC_URL \
  --constructor-args $ADMIN $DEAD_KEEPER $GUARDIAN 48 12
```

> `--constructor-args` is variadic and swallows every flag after it. It must
> come last, or `forge` silently falls back to `localhost:8545`.

Then verify, so the Analyst can read source, and grant KeeperHub's wallet admin
so it can perform the migration:

```sh
forge verify-contract $CYCLER src/LegacyProtocol.sol:LegacyProtocol \
  --chain-id 11155111 --verifier blockscout \
  --verifier-url https://eth-sepolia.blockscout.com/api \
  --constructor-args $(cast abi-encode "c(address,address,address,uint256,uint256)" \
    $ADMIN $DEAD_KEEPER $GUARDIAN 48 12)

cast send $CYCLER "grantRole(bytes32,address)" \
  0x0000000000000000000000000000000000000000000000000000000000000000 $KH_WALLET \
  --private-key $DEPLOYER_PRIVATE_KEY --rpc-url $SEPOLIA_RPC_URL
```

That admin grant is done out of band, by a human. Understudy cannot grant itself
admin and should not be able to.

### Live on Sepolia, all verified

| | |
|---|---|
| cycler (48s / 12s) | [`0x34d6B905…`](https://eth-sepolia.blockscout.com/address/0x34d6B90581EB625eEd64532d5056C5BdA3a99cE3) |
| vault / treasury / oracle | [`0xbcdFC978…`](https://eth-sepolia.blockscout.com/address/0xbcdFC978Aa7F49E84C50549D05Bd76eF214562Dd) · [`0x7150c2fC…`](https://eth-sepolia.blockscout.com/address/0x7150c2fC9Ebb7054049A0CA90e17F0D7888BdB8D) · [`0xaD4b48B7…`](https://eth-sepolia.blockscout.com/address/0xaD4b48B738B837b33FDC2F8812293c96E317008f) |
| dead keeper | `0x57e7e59fB71c100A235842Ed69eaF46A9567B1DD` |
| new keeper (KeeperHub) | `0x6e1a4201172f81a06E70cA176076B94e42e371f3` |

---

## Repository layout

```
src/agent/          the two agents — analyze() and adjudicate()
  types.ts          frozen interfaces, with a compile-time drift guard
  keccak.ts         deterministic role resolution (hashing in code)
  client.ts         model calls, per-family request shaping, typed errors
  prompts/          system prompts for both components
src/scout/          chain → EvidenceBundle (Blockscout + viem)
src/shadow/         observe-only runner, two rebuilt-keeper variants
src/keeperhub/      MCP client — the execution layer
src/cutover/        the state machine and the interlock
contracts/          LegacyProtocol.sol + deploy script (Foundry)
evals/              label sets, fixtures, and the eval runner
runs/               journals from every migration — committed as evidence
scripts/            CLIs: scout, migrate, report, analyze, fixtures
spike/              standalone blast-radius scan (bash + curl)
docs/               report, deck, explainer, brand
```

### npm scripts

| Command | What it does |
|---|---|
| `npm test` | 76 unit tests, no network |
| `npm run typecheck` | includes the interface drift guard |
| `npm run eval` | both eval suites (`--suite=roles` / `=adjudication`) |
| `npm run analyze -- <bundle>` | run the Analyst on one bundle |
| `npm run scout -- --keeper 0x…` | build an EvidenceBundle from chain |
| `npm run migrate -- --contract 0x…` | the full six-stage migration |
| `npm run report -- --all` | regenerate `docs/report.html` |
| `npm run build:contracts` | `forge build` |
| `npm run deploy:contracts` | deploy the three demo instances |

---

## Architecture notes

**Hashing in code, judgment in the model.** Never the other way round. Before
the model runs, `keccak.ts` and `resolve.ts` strip Solidity comments with a
string-literal-aware scanner, extract `bytes32 … = keccak256("LITERAL")`
declarations, hash the *literal*, walk proxy → implementation, and build a
keccak-verified resolution table the prompt is told to trust.

**A log is history; only state is current.** Every `RoleGranted` pair is
re-confirmed with a live `hasRole()` call before it is reported. Acting on a
grant that was since revoked is the failure this product exists to prevent.

**Reads go through an explorer, not the node.** Free RPC tiers reject archive
`eth_getLogs`, so historical discovery routes through Blockscout — which is also
what KeeperHub's own read-layer/execute-layer architecture post recommends.

**Idempotency keys are scoped per run *and* per attempt.** KeeperHub caches
failures under a reused key and replays them, so an action-scoped key means a
transient failure can never recover. We shipped that exact bug, found it, and
fixed it — see `src/cutover/index.ts`.

**Proof by doing.** A successful grant proves a role was written, not that the
replacement works. The new keeper settles three real epochs before the old one
is revoked, each confirmed by re-reading `epoch()` rather than trusting the
execution report.

---

## KeeperHub surfaces used

| Surface | Where |
|---|---|
| **MCP** `execute_contract_call` | every grant, revoke and live settlement |
| **Simulation** (`simulate: true`) | before every broadcast; `wouldRevert` aborts |
| **Audit trail** | `get_direct_execution_status` — receipts KeeperHub re-reads from chain |
| **Gas sponsorship** | `sponsored: true` on every transaction |
| **Idempotency keys** | scoped per run and attempt, with retry |
| **Web3 plugin** | verified-ABI handling, EIP-1967/1822 proxy resolution |
| **Blockscout** | the read layer |

Not used: CLI, workflow builder, x402, MPP. Nothing here is a paid agent
service, so there was no honest reason to reach for x402 or MPP.

---

## Friction we hit, and would fix

1. **`execute_contract_call` argument encoding** (upstream #1841). `chain_id`
   and `function_args` must be **strings**, and `function_args` a *stringified*
   JSON array. Nothing in the tool description says so; a number and a real
   array both 400. Reproduced exactly as reported.
2. **Idempotency keys cache failures** (upstream #1840). An action-scoped key
   means a transient failure is replayed forever. We scope per attempt — after
   shipping the bug ourselves first.
3. **Unverified contracts fail ABI auto-fetch** with a 400 that never mentions
   the `abi` field exists as a fallback.
4. **MCP handshake is unforgiving.** `tools/call` before
   `notifications/initialized` returns *"Session not initialized"*. A headless
   quickstart showing the three-call sequence would save the hour.
5. **A default User-Agent gets a 403** from the MCP endpoint. Silent and
   confusing from a fresh client.

---

## Honest limits

Full detail in [`LIMITS.md`](./LIMITS.md). In short:

Sepolia, not mainnet. One contract migrated end to end out of five deployed. The
protocol is ours — really deployed, really verified, really settling, but we
wrote it. The dead keeper is a keypair we created and abandoned. The
`stale-threshold` defect is planted, though the Adjudicator was never told it
existed. A shadow window with no state transitions returns a false `READY`; the
fix is designed, not built.

Headline scores are `claude-haiku-4-5`, the model the live runs used, so they
reproduce from a clean checkout. On `claude-opus-5` the same suites score 93.1%
and 100%.

---

Apache-2.0.
