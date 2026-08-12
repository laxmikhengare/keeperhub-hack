/**
 * Blockscout client — the read layer.
 *
 * KeeperHub's own architecture post argues for exactly this split: Blockscout
 * for reads, KeeperHub for execution. Everything here is public data; no API
 * key, no wallet, no archive node.
 *
 * One constraint worth knowing: the free RPC tier rejects archive `eth_getLogs`,
 * so historical log queries MUST go through the explorer rather than the node.
 * That is not a workaround — it is why the read layer exists.
 */

export interface ChainConfig {
  chainId: number;
  name: string;
  explorerApi: string;
  explorerUi: string;
  rpc: string;
}

export const CHAINS: Record<number, ChainConfig> = {
  1: {
    chainId: 1,
    name: 'ethereum-mainnet',
    explorerApi: 'https://eth.blockscout.com/api',
    explorerUi: 'https://eth.blockscout.com',
    rpc: 'https://ethereum-rpc.publicnode.com',
  },
  11155111: {
    chainId: 11155111,
    name: 'ethereum-sepolia',
    explorerApi: 'https://eth-sepolia.blockscout.com/api',
    explorerUi: 'https://eth-sepolia.blockscout.com',
    rpc: process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
  },
  8453: {
    chainId: 8453,
    name: 'base-mainnet',
    explorerApi: 'https://base.blockscout.com/api',
    explorerUi: 'https://base.blockscout.com',
    rpc: 'https://mainnet.base.org',
  },
};

export function chainFor(chainId: number): ChainConfig {
  const c = CHAINS[chainId];
  if (!c) throw new Error(`unsupported chain ${chainId} — add it to CHAINS`);
  return c;
}

/**
 * A default User-Agent gets a 403 from several of these hosts. Every request
 * carries an explicit one. (Discovered the hard way; keep it.)
 */
const HEADERS = { 'User-Agent': 'understudy-scout/0.1', Accept: 'application/json' };

async function getJson(url: string, timeoutMs = 90_000): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export interface ExplorerLog {
  address: string;
  topics: string[];
  blockNumber: string;
  transactionHash: string;
}

/**
 * Query logs. Omitting `address` performs the reverse lookup — every contract
 * that emitted this topic combination — which is the whole basis of the
 * blast-radius scan.
 */
export async function getLogs(
  chainId: number,
  opts: { address?: string; topic0: string; topic2?: string; fromBlock?: number | 'earliest' },
): Promise<ExplorerLog[]> {
  const { explorerApi } = chainFor(chainId);
  const p = new URLSearchParams({
    module: 'logs',
    action: 'getLogs',
    fromBlock: String(opts.fromBlock ?? 0),
    toBlock: 'latest',
    topic0: opts.topic0,
  });
  if (opts.address) p.set('address', opts.address);
  if (opts.topic2) {
    p.set('topic2', opts.topic2);
    p.set('topic0_2_opr', 'and');
  }

  const out: ExplorerLog[] = [];
  const seen = new Set<string>();
  let page = 1;

  // Result sets are capped per page; page until a short page arrives.
  for (; page <= 20; page++) {
    p.set('page', String(page));
    p.set('offset', '1000');
    const d = await getJson(`${explorerApi}?${p}`);
    const rows = Array.isArray(d.result) ? (d.result as ExplorerLog[]) : [];
    for (const r of rows) {
      const k = `${r.transactionHash}:${r.topics.join(',')}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(r);
      }
    }
    if (rows.length < 1000) break;
  }
  return out;
}

export interface SourceResult {
  name: string | null;
  /** All source files concatenated with FILE markers, or null if unverified. */
  flattened: string | null;
  abi: unknown[] | null;
  isProxyHint: boolean;
}

export async function getSource(chainId: number, address: string): Promise<SourceResult> {
  const { explorerApi } = chainFor(chainId);
  const d = await getJson(
    `${explorerApi}?module=contract&action=getsourcecode&address=${address}`,
  );
  const r = (Array.isArray(d.result) ? d.result[0] : null) ?? {};

  const files: Record<string, string> = {};
  if (r.SourceCode) files[r.FileName || '<main>'] = r.SourceCode;
  for (const a of r.AdditionalSources ?? []) files[a.Filename] = a.SourceCode;

  const flattened = Object.keys(files).length
    ? Object.entries(files)
        .map(([fn, src]) => `// ===== FILE: ${fn} =====\n${src}`)
        .join('\n\n')
    : null;

  let abi: unknown[] | null = null;
  try {
    abi = r.ABI ? JSON.parse(r.ABI) : null;
  } catch {
    abi = null;
  }

  return {
    name: r.ContractName || null,
    flattened,
    abi,
    isProxyHint: r.IsProxy === true || r.IsProxy === 'true',
  };
}

export interface ExplorerTx {
  to: string | null;
  input: string;
  blockNumber: string;
  isError?: string;
}

export async function getTxList(chainId: number, address: string): Promise<ExplorerTx[]> {
  const { explorerApi } = chainFor(chainId);
  const out: ExplorerTx[] = [];
  for (let page = 1; page <= 10; page++) {
    const d = await getJson(
      `${explorerApi}?module=account&action=txlist&address=${address}&page=${page}&offset=1000&sort=asc`,
    );
    const rows = Array.isArray(d.result) ? (d.result as ExplorerTx[]) : [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
