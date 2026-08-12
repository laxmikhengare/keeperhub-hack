/**
 * SCOUT — stage 1.
 *
 * Reads public chain data and assembles the EvidenceBundle that the Analyst
 * consumes. Every field is observed, never inferred: this stage does not
 * decide what anything *means*. Resolving role names, judging which
 * permissions matter, and reconstructing intent are all the Analyst's job.
 *
 * The split is deliberate. Deterministic collection belongs in code; judgment
 * under incomplete evidence belongs in the model.
 */

import type { EvidenceBundle } from '../agent/types.js';
import {
  chainFor,
  getLogs,
  getSource,
  getTxList,
  type SourceResult,
} from './explorer.js';
import {
  ROLE_GRANTED_TOPIC,
  addressTopic,
  buildSelectorMap,
  currentBlock,
  hasRole,
  implementationOf,
} from './chain.js';

export interface ScoutOptions {
  deadKeeper: string;
  chainId: number;
  provider?: EvidenceBundle['deadKeeper']['provider'];
  /**
   * Restrict the scan to these contracts. Omit for a full reverse lookup
   * across every contract on the chain — correct, but slow on mainnet where a
   * governance address can hold roles on hundreds of contracts.
   */
  contracts?: string[];
  /** Called with human-readable progress. */
  onProgress?: (msg: string) => void;
}

export async function buildEvidenceBundle(opts: ScoutOptions): Promise<EvidenceBundle> {
  const { chainId } = opts;
  const keeper = opts.deadKeeper.toLowerCase();
  const log = opts.onProgress ?? (() => {});
  const chain = chainFor(chainId);

  // ── 1. Blast radius ──────────────────────────────────────────────────────
  // Every RoleGranted whose `account` topic is the dead keeper. With no address
  // filter this is the reverse lookup: which contracts trust this address?
  log(`scanning RoleGranted for ${keeper} on ${chain.name}…`);
  const topic2 = addressTopic(keeper);

  const raw = opts.contracts?.length
    ? (
        await Promise.all(
          opts.contracts.map((c) =>
            getLogs(chainId, { address: c, topic0: ROLE_GRANTED_TOPIC, topic2 }),
          ),
        )
      ).flat()
    : await getLogs(chainId, { topic0: ROLE_GRANTED_TOPIC, topic2 });

  // Deduplicate: a role can be granted, revoked, and granted again. Keep the
  // most recent grant per (contract, role) — that is the one whose liveness
  // we then confirm.
  const byPair = new Map<string, { contract: string; roleHash: string; grantedAtBlock: number }>();
  for (const l of raw) {
    const contract = l.address.toLowerCase();
    const roleHash = l.topics[1];
    if (!roleHash) continue;
    const block = Number(BigInt(l.blockNumber));
    const key = `${contract}:${roleHash}`;
    const prev = byPair.get(key);
    if (!prev || block > prev.grantedAtBlock) {
      byPair.set(key, { contract, roleHash, grantedAtBlock: block });
    }
  }
  log(`  ${raw.length} grant events → ${byPair.size} unique (contract, role) pairs`);

  // ── 2. Confirm each grant is still live ──────────────────────────────────
  // A log is history. Only current state decides whether a permission exists.
  const pairs = [...byPair.values()];
  const permissions: EvidenceBundle['permissions'] = [];
  for (const p of pairs) {
    const stillActive = await hasRole(chainId, p.contract, p.roleHash, keeper);
    permissions.push({ ...p, stillActive });
  }
  const live = permissions.filter((p) => p.stillActive).length;
  log(`  confirmed on-chain: ${live} active, ${permissions.length - live} revoked`);

  // ── 3. Source + ABI, following proxies ───────────────────────────────────
  // Roles are held on the proxy; the logic that gates them lives in the
  // implementation. Fetch both or the Analyst has nothing to read.
  const targets = [...new Set(permissions.map((p) => p.contract))];
  const contracts: EvidenceBundle['contracts'] = {};
  const abiByAddress: Record<string, unknown[] | null> = {};

  for (const addr of targets) {
    const impl = await implementationOf(chainId, addr);
    const src: SourceResult = await getSource(chainId, addr);
    contracts[addr] = {
      address: addr,
      name: src.name,
      isProxy: impl !== null,
      implementationAddress: impl,
      verifiedSource: src.flattened,
      abi: src.abi,
    };
    abiByAddress[addr] = src.abi;
    log(`  ${addr} ${src.name ?? '(unverified)'}${impl ? ' [proxy]' : ''}`);

    if (impl) {
      const key = impl.toLowerCase();
      if (!contracts[key]) {
        const isrc = await getSource(chainId, impl);
        contracts[key] = {
          address: key,
          name: isrc.name,
          isProxy: false,
          implementationAddress: null,
          verifiedSource: isrc.flattened,
          abi: isrc.abi,
        };
        // Calls go to the proxy but decode against the implementation's ABI.
        if (isrc.abi) abiByAddress[addr] = isrc.abi;
        log(`    └─ impl ${key} ${isrc.name ?? '(unverified)'}`);
      }
    }
  }

  // ── 4. What the keeper actually did ──────────────────────────────────────
  // Zero history is a real and meaningful answer, not a failure: a role that
  // has never been exercised is the Analyst's hardest classification.
  log(`fetching call history for ${keeper}…`);
  let callHistory: EvidenceBundle['callHistory'] = [];
  try {
    const txs = await getTxList(chainId, keeper);
    const agg = new Map<string, EvidenceBundle['callHistory'][number]>();
    const targetSet = new Set(targets);

    for (const t of txs) {
      const to = (t.to ?? '').toLowerCase();
      if (!targetSet.has(to)) continue;
      if (t.isError === '1') continue; // a reverted call is not evidence of use
      const selector = (t.input ?? '0x').slice(0, 10);
      if (selector.length < 10) continue; // plain transfer, no calldata

      const block = Number(t.blockNumber);
      const key = `${to}:${selector}`;
      const prev = agg.get(key);
      if (prev) {
        prev.count += 1;
        prev.firstBlock = Math.min(prev.firstBlock, block);
        prev.lastBlock = Math.max(prev.lastBlock, block);
      } else {
        agg.set(key, {
          contract: to,
          selector,
          functionName: buildSelectorMap(abiByAddress[to] ?? null)[selector] ?? null,
          count: 1,
          firstBlock: block,
          lastBlock: block,
        });
      }
    }
    callHistory = [...agg.values()].sort((a, b) => b.count - a.count);
  } catch (e) {
    // History is enrichment. Losing it degrades classification confidence but
    // must not fail the scan — say so rather than silently returning [].
    log(`  ⚠ call history unavailable (${(e as Error).message}) — proceeding without it`);
  }
  log(`  ${callHistory.length} distinct (contract, selector) pairs`);

  return {
    deadKeeper: { address: keeper, chainId, provider: opts.provider ?? 'manual' },
    permissions,
    contracts,
    callHistory,
    chainContext: {
      chainId,
      chainName: chain.name,
      currentBlock: await currentBlock(chainId),
    },
  };
}
