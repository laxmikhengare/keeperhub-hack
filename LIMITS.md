# Limits

What is real, what is staged, and what we did not get to. Written so a reviewer
does not have to find these out by reading the code.

## Real

- **Every transaction is a live Sepolia transaction executed through KeeperHub.**
  Nine of them, mined, with receipts KeeperHub independently re-read from chain.
  Nothing is mocked, replayed, or simulated for the demo.
- **The Analyst and Adjudicator run against live chain data.** No canned model
  responses anywhere in the pipeline.
- **The role-resolution problem is genuine.** Our contract's role preimages are
  namespaced (`keccak256("LegacyProtocol.KEEPER_ROLE")`), so hashing the
  identifier matches nothing — the same construction Lido uses in production.
  Four of the eval fixtures are real Ethereum **mainnet** bundles, including a
  proxy whose logic is only reachable through the EIP-1967 slot.
- **The interlock is structural, not cosmetic.** On `not_ready` the function
  returns before any calldata is constructed.

## Staged

- **The protocol being migrated is ours.** `LegacyProtocol` is a real deployed,
  verified contract doing real settlement work, but we wrote it. We are not
  migrating a third party's production protocol, and would not without consent.
- **The "dead" keeper is a keypair we created and then abandoned**, holding
  `KEEPER_ROLE` and with real settlement history. It stands in for a keeper whose
  provider shut down. We did not migrate an actually-orphaned mainnet keeper.
- **The rebuilt keeper's defect is planted.** The `stale-threshold` variant is a
  deliberate stale-read off-by-one. It is a realistic migration bug, and the
  Adjudicator was not told it existed — it diagnosed the root cause from
  behaviour — but we chose the bug.
- **KeeperHub's wallet was granted `DEFAULT_ADMIN_ROLE` out of band**, by us, as
  setup. A real deployment would authorise the migration agent through governance
  or a multisig. Understudy cannot grant itself admin, and should not be able to.

## Not done

- **Sepolia only.** No mainnet run, and no multi-chain fan-out. The state machine
  holds per-chain state but has only ever been exercised on one.
- **One contract migrated end to end.** Five are deployed and the Scout maps all
  of them; the full pipeline has been run against `cycler`.
- **Chainlink registry discovery is not wired in.** The Scout finds permissions by
  `RoleGranted` reverse lookup. Reading `KeeperRegistry.getActiveUpkeepIDs()` to
  enumerate dying upkeeps is proven in `spike/blast-radius.sh` but is not part of
  the pipeline.
- **The Builder does not generate workflows from the Analyst's
  `automationIntent`.** The rebuilt keeper's condition is implemented in
  `src/shadow`. The Analyst *does* reconstruct intent and it is used as evidence;
  it does not yet drive `create_workflow`.
- **No dashboard.** Output is terminal plus a JSONL journal per run under `runs/`.

## Numbers, qualified

- **The headline scores are `claude-haiku-4-5`** — the model the live runs
  actually used, so a reviewer reproduces them from a clean checkout. Role
  classification 89.7% (26/29), adjudication 8/8. On `claude-opus-5` the same
  suites score 93.1% and 8/8. We report the lower number because it is the one
  the demo ran on. Set `UNDERSTUDY_MODEL` to switch.
- **Adjudication is 100% on both models**, including the two twin scenarios at
  an identical 97% agreement with opposite verdicts. That suite gates an
  irreversible action, so anything below 100% would be a blocker rather than a
  score.
- **Read the classification baseline next to the accuracy.** The label set skews
  `load_bearing`, so answering `load_bearing` every time scores 72.4%. The
  20.7-point gap is the number that means something.
- **`uncovered samples: 0`** counts moments when *no keeper at all* held the
  role — the property the migration is responsible for. It is sampled at each
  state transition, not per block, so it is evidence rather than proof.
  `degraded samples` is reported separately and is usually non-zero on arrival,
  because the abandoned keeper had already stopped settling. That gap is not
  ours and we do not claim credit for closing it.

## Known rough edges

- Retries are bounded at 3 attempts with a fixed backoff. A migration that
  fails all three leaves the old keeper in place — correct, but it needs a
  human, and there is no alerting.
- `verifyLive` waits up to 180s for the job to become due and then gives up. On a
  contract with a long epoch that is a false negative, not a real regression.
- The Scout's global reverse lookup (no `--contracts`) is untested at mainnet
  scale in the pipeline. The spike handled 126 contracts; the TypeScript port has
  only been run scoped.
