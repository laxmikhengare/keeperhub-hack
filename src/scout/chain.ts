/**
 * Direct node reads. Everything here is `eth_call` / `eth_getStorageAt` against
 * current state — cheap, unrestricted on free tiers, and always authoritative.
 *
 * Historical logs deliberately do NOT live here: free RPC tiers reject archive
 * `eth_getLogs`. Those go through the explorer (see explorer.ts).
 */

import { createPublicClient, http, keccak256, toHex, type Address, type Hex } from 'viem';
import { chainFor } from './explorer.js';

/** EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1 */
const EIP1967_IMPL =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex;
/** EIP-1822 (UUPS) logic slot: keccak256("PROXIABLE") */
const EIP1822_LOGIC =
  '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7' as Hex;

const ZERO = '0x0000000000000000000000000000000000000000';

export function client(chainId: number) {
  const { rpc } = chainFor(chainId);
  return createPublicClient({ transport: http(rpc) });
}

export const roleHash = (preimage: string): Hex => keccak256(toHex(preimage));

/** `RoleGranted(bytes32 role, address account, address sender)` */
export const ROLE_GRANTED_TOPIC =
  '0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d';

/** Left-pad an address into a 32-byte log topic. */
export function addressTopic(addr: string): string {
  return '0x' + '0'.repeat(24) + addr.toLowerCase().replace(/^0x/, '');
}

const HAS_ROLE_ABI = [
  {
    name: 'hasRole',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/**
 * Is the grant still live *right now*?
 *
 * A RoleGranted log is history — the role may have been revoked since. Every
 * permission we report is confirmed against current state, because acting on a
 * stale grant is the failure mode this whole product exists to prevent.
 */
export async function hasRole(
  chainId: number,
  contract: string,
  role: string,
  account: string,
): Promise<boolean> {
  try {
    return (await client(chainId).readContract({
      address: contract as Address,
      abi: HAS_ROLE_ABI,
      functionName: 'hasRole',
      args: [role as Hex, account as Address],
    })) as boolean;
  } catch {
    // Not an AccessControl contract, or the call reverted. Absence of a
    // confirmation is not evidence of a live grant — report it as inactive.
    return false;
  }
}

/** Resolve a proxy's implementation, or null if the address is not a proxy. */
export async function implementationOf(
  chainId: number,
  address: string,
): Promise<string | null> {
  const c = client(chainId);
  for (const slot of [EIP1967_IMPL, EIP1822_LOGIC]) {
    try {
      const raw = await c.getStorageAt({ address: address as Address, slot });
      if (!raw) continue;
      const impl = '0x' + raw.slice(-40);
      if (impl.toLowerCase() !== ZERO) return impl;
    } catch {
      /* try the next slot */
    }
  }
  return null;
}

export async function currentBlock(chainId: number): Promise<number> {
  return Number(await client(chainId).getBlockNumber());
}

/** 4-byte selector → function name, from an ABI. */
export function buildSelectorMap(abi: unknown[] | null): Record<string, string> {
  const map: Record<string, string> = {};
  if (!abi) return map;
  for (const item of abi as any[]) {
    if (item?.type !== 'function' || !item.name) continue;
    const sig = `${item.name}(${(item.inputs ?? [])
      .map((i: any) => canonicalType(i))
      .join(',')})`;
    map[keccak256(toHex(sig)).slice(0, 10)] = item.name;
  }
  return map;
}

/** Tuples must expand to their component types for the selector to be correct. */
function canonicalType(input: any): string {
  if (input.type?.startsWith('tuple')) {
    const inner = (input.components ?? []).map(canonicalType).join(',');
    return `(${inner})${input.type.slice(5)}`;
  }
  return input.type;
}
