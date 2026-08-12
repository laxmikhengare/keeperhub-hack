# Understudy

**The agent that takes over from a dead keeper without dropping a block.**

```
Transactions mined            9 on Ethereum Sepolia, all through KeeperHub
Tests passing                76
Role classification        89.7%  (26/29 · majority-class baseline 72.4%)
Adjudication               100%   (8/8 · incl. both twin scenarios)
Contracts migrated            1 of 5 deployed, live end to end
Uncovered samples             0   ← moments with no keeper at all
Surfaces exercised            MCP · Web3 · Blockscout · simulation ·
                              gas sponsorship · audit trail · idempotency
```

**Full migration, on chain:**

| Step | Transaction |
|---|---|
| grant | [`0xe0c6447d…`](https://sepolia.etherscan.io/tx/0xe0c6447db793a5f1bc5131315b0ba42fcd9894a96dfc17a5f484d206bcd52e7b) |
| verify ×3 | `0x478bf65e…` · `0x948d47da…` · `0x053a0f38…` — epochs 5→6→7→8, gas 71,451 / 66,352 / 66,352. Sponsored **internal** transactions relayed by KeeperHub, so they do not appear as top-level entries on the wallet; see [`runs/`](./runs) for the journal. |
| revoke | [`0x08ee2954…`](https://sepolia.etherscan.io/tx/0x08ee29549347d355c2422c62b43349ac4d1844d61d9b911fcb237348894fdb6a) |

---

## The problem

Four keeper networks shut down in four months.

| Platform | Dead since |
|---|---|
| Gelato Web3 Functions | **March 31, 2026** — *"fully decommissioned"* |
| Chainlink Automation v1.x | **June 30, 2026** |
| OpenZeppelin Defender | **July 1, 2026** |
| Chainlink Automation v2.1 | **July 31, 2026** |

Thousands of protocols rented their autopilot from those four. Migrating is not
repointing a config: your keeper's **address** is written into your contracts —
roles, allowlists, `onlyKeeper`. The replacement has a different address.

So somebody has to find every contract on every chain that still trusts the dead
one, hand that trust over, prove the replacement works, and take the old key
away. And the ordering is a trap:

- **Revoke too early** → the protocol sits unattended. That is the window where
  a liquidation is missed and real money is lost.
- **Revoke too late** → a dead credential still has production write access.

Every provider's official answer is a document that begins *"do this by hand."*

> **OpenZeppelin:** *"Private keys cannot be exported from Defender's AWS KMS.
> Every migration requires generating new signer addresses and updating all
> on-chain permissions."*
>
> **Chainlink's own CRE migration guide:** *"No automated discovery or
> enumeration of existing upkeeps. All work is manual."*
>
> **KeeperHub's own guide:** *"Nothing maps automatically."* Step one is
> *"export and document your setup by hand."*

Nobody automates this. Understudy does.

---

## What it does

```
1. SCOUT        code   Read public data: which contracts still trust the dead
                       keeper, what it was allowed to do, what it actually did.
2. ANALYST     AGENT   Read the contracts' source. Which permissions matter?
                       What was this job really doing?
3. BUILDER      code   Rebuild the job as a KeeperHub workflow. Simulate it.
4. SHADOW       code   Run it observe-only against live chain state. Log the diff.
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

The Scout hands it `(contract: 0x34d6b905…, role: 0x0e8d2f4f…)`. That role is a
**keccak hash with no global registry**, because every protocol invents its own
names. Resolving it means reading Solidity you have never seen, finding which
functions the role guards, correlating against what the keeper actually called,
and judging.

Our own contract makes that deliberately hard, mirroring production practice:

```solidity
bytes32 public constant KEEPER_ROLE = keccak256("LegacyProtocol.KEEPER_ROLE");
```

The preimage is **namespaced**, exactly as Lido does it
(`keccak256("BridgingManager.DEPOSITS_ENABLER_ROLE")`). Hashing the identifier
`KEEPER_ROLE` yields `0xfc8737ab…`, which matches nothing. You have to read the
source and hash the *string literal*.

On a live Sepolia bundle it returned:

> **KEEPER_ROLE · load_bearing · 0.95** — *"guards `performUpkeep()`
> (LegacyProtocol.sol:68), the essential settlement function; keeper called it 5
> times in blocks 11475578–11475601, and the contract's design explicitly warns
> that losing this capability leaves the protocol unattended and degraded."*

On a four-contract bundle where the keeper held the **same role on all four** but
had only ever exercised it on **one**, it marked the exercised one `load_bearing`
(0.95) and the other three `unknown` (0.50) — then wrote its own blocking note:

> *"…must verify before revoking KEEPER_ROLE to avoid freezing any active
> settlement vaults."*

**Hallucination guard:** no role name is ever returned unless `keccak256` of the
model's answer reproduces the observed hash. Unverified names are discarded and
recorded in `declaredUnknowns`.

### The Adjudicator — judgment

The Shadow run produces N observations of *what ground truth said* vs *what the
rebuilt keeper would have done*. Some disagree. The insight the whole design
rests on:

**Two runs at the same agreement rate can require opposite verdicts.**

Three live runs against the same chain, same contract:

| Run | Agreement | Verdict | Why |
|---|---|---|---|
| unverified source | **100%** | `NOT_READY` | role unresolvable — cannot revoke on unresolved evidence |
| faithful | **100%** | `READY` | → 5 transactions, cutover complete |
| stale-threshold | 80% | `NOT_READY` | 3 genuine regressions |

Two runs at an identical 100% with opposite outcomes. The rate carries no signal.

On the regression run it diagnosed the planted bug from behaviour alone:

> *"New workflow compares `timestamp > deadline` instead of `>= deadline`,
> systematically missing settlements that arrive exactly at the deadline. With a
> 12-second tolerance window (one block), there is no margin to recover."*

and correctly separated 6 disagreements into **3 regressions** and **3 benign
cascades** caused by the earlier misses.

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
that constructs revoke calldata is **never entered** — there is nothing to sign
and nothing to send.

---

## KeeperHub surfaces used

| Surface | Where |
|---|---|
| **MCP** `execute_contract_call` | every grant, revoke, and live settlement |
| **Simulation** (`simulate: true`) | before every broadcast; `wouldRevert` aborts |
| **Audit trail** | `get_direct_execution_status` — independently re-read receipts |
| **Gas sponsorship** | `sponsored: true` on every transaction |
| **Idempotency keys** | scoped per **run and attempt**, with retry — see issue #1840 below |
| **Web3 plugin** | verified-ABI handling, EIP-1967/1822 proxy resolution |
| **Blockscout** | the read layer, exactly as KeeperHub's own architecture post recommends |

---

## Run it

```sh
npm install
cp .env.example .env          # ANTHROPIC_API_KEY + KEEPERHUB_API_KEY
npm test                      # 76 tests, no network
npm run eval                  # agent eval suites

# the whole thing, live
npx tsx scripts/scout.ts --keeper 0x… --chain 11155111 --out bundle.json
npm run analyze -- bundle.json
npx tsx scripts/migrate.ts --contract 0x… --variant faithful
npx tsx scripts/migrate.ts --contract 0x… --variant stale-threshold   # refused
```

Deployed on Sepolia, all verified:

| | |
|---|---|
| cycler (48s epoch / 12s window) | [`0x34d6B905…`](https://eth-sepolia.blockscout.com/address/0x34d6B90581EB625eEd64532d5056C5BdA3a99cE3) |
| vault / treasury / oracle | [`0xbcdFC978…`](https://eth-sepolia.blockscout.com/address/0xbcdFC978Aa7F49E84C50549D05Bd76eF214562Dd) · [`0x7150c2fC…`](https://eth-sepolia.blockscout.com/address/0x7150c2fC9Ebb7054049A0CA90e17F0D7888BdB8D) · [`0xaD4b48B7…`](https://eth-sepolia.blockscout.com/address/0xaD4b48B738B837b33FDC2F8812293c96E317008f) |
| dead keeper | `0x57e7e59fB71c100A235842Ed69eaF46A9567B1DD` |
| new keeper (KeeperHub) | `0x6e1a4201172f81a06E70cA176076B94e42e371f3` |

---

## Friction we hit, and would fix

Filed as we went. Each cost real time.

1. **`execute_contract_call` argument encoding** (upstream #1841). `chain_id` and
   `function_args` must be **strings**, and `function_args` a *stringified* JSON
   array. Nothing in the tool description says so; the natural first guess is a
   number and a real array, and both 400. Hit exactly as reported.

2. **Idempotency keys cache failures** (upstream #1840). A key scoped per logical
   action means a transient failure is replayed forever and can never recover.
   We scope per attempt (`${label}-real-a${n}`) and document why.

3. **Unverified contracts fail ABI auto-fetch** with a 400 that does not mention
   the `abi` field exists as a fallback. One line in the error would save the
   lookup.

4. **MCP handshake is unforgiving.** `tools/call` before
   `notifications/initialized` returns *"Session not initialized"*. The hint is
   good; a headless quickstart showing the three-call sequence would be better.

5. **A default User-Agent gets a 403** from the MCP endpoint. Silent and
   confusing from a fresh client.

---

## Honest limits

See [`LIMITS.md`](./LIMITS.md). Short version: Sepolia not mainnet; one contract
migrated end to end rather than the full multi-chain fan-out; the demo protocol
is ours; and the `stale-threshold` defect is planted (though the Adjudicator was
never told it existed — it diagnosed the root cause from behaviour).

Headline scores are on `claude-haiku-4-5`, the model the live runs used, so they
reproduce from a clean checkout. On `claude-opus-5` the same suites score 93.1%
and 100%. Set `UNDERSTUDY_MODEL` to switch.

Apache-2.0.
