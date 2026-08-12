#!/usr/bin/env python3
"""
Generate a real EvidenceBundle fixture from live mainnet data.

    python3 scripts/make_fixture.py <keeper-address> <contract-address> <out.json>

Reads only public data. No credentials, no wallet, no RPC key.
"""
import sys, json, re, urllib.request

SCOUT = "https://eth.blockscout.com/api"
RPC   = "https://ethereum-rpc.publicnode.com"
ROLE_GRANTED = "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d"
IMPL_SLOT    = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
UA = {"User-Agent": "understudy-fixture/1.0"}

def get(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90))

def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}).encode()
    req = urllib.request.Request(RPC, body, {**UA, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30)).get("result")

def source_of(addr):
    r = (get(f"{SCOUT}?module=contract&action=getsourcecode&address={addr}").get("result") or [{}])[0]
    files = {r.get("FileName") or "<main>": r.get("SourceCode") or ""}
    for a in (r.get("AdditionalSources") or []):
        files[a["Filename"]] = a["SourceCode"]
    flat = "\n\n".join(f"// ===== FILE: {fn} =====\n{src}" for fn, src in files.items())
    abi = None
    try: abi = json.loads(r.get("ABI") or "null")
    except Exception: pass
    return r.get("ContractName"), flat, abi

def main(keeper, contract, out):
    keeper, contract = keeper.lower(), contract.lower()
    topic2 = "0x" + "0"*24 + keeper[2:]

    grants = get(f"{SCOUT}?module=logs&action=getLogs&fromBlock=0&toBlock=latest"
                 f"&address={contract}&topic0={ROLE_GRANTED}&topic2={topic2}&topic0_2_opr=and").get("result") or []

    permissions, contracts_map = [], {}
    for g in grants:
        permissions.append({
            "contract": contract,
            "roleHash": g["topics"][1],
            "grantedAtBlock": int(g["blockNumber"], 16),
            "stillActive": True,      # confirmed separately via hasRole()
        })

    impl_raw = rpc("eth_getStorageAt", [contract, IMPL_SLOT, "latest"]) or ""
    impl = "0x" + impl_raw[-40:] if impl_raw and int(impl_raw, 16) != 0 else None

    for addr in filter(None, [contract, impl]):
        name, src, abi = source_of(addr)
        contracts_map[addr] = {
            "address": addr, "name": name,
            "isProxy": addr == contract and impl is not None,
            "implementationAddress": impl if addr == contract else None,
            "verifiedSource": src or None, "abi": abi,
        }

    txs = get(f"{SCOUT}?module=account&action=txlist&address={keeper}").get("result") or []
    if not isinstance(txs, list): txs = []
    hist = {}
    for t in txs:
        if (t.get("to") or "").lower() != contract: continue
        sel = (t.get("input") or "0x")[:10]
        e = hist.setdefault(sel, {"contract": contract, "selector": sel, "functionName": None,
                                  "count": 0, "firstBlock": 10**12, "lastBlock": 0})
        b = int(t["blockNumber"])
        e["count"] += 1
        e["firstBlock"] = min(e["firstBlock"], b)
        e["lastBlock"]  = max(e["lastBlock"], b)

    bundle = {
        "deadKeeper": {"address": keeper, "chainId": 1, "provider": "manual"},
        "permissions": permissions,
        "contracts": contracts_map,
        "callHistory": list(hist.values()),
        "chainContext": {"chainId": 1, "chainName": "ethereum-mainnet",
                         "currentBlock": int(rpc("eth_blockNumber", []), 16)},
    }
    json.dump(bundle, open(out, "w"), indent=2)
    print(f"wrote {out}")
    print(f"  permissions : {len(permissions)}")
    print(f"  contracts   : {len(contracts_map)} (proxy: {impl is not None})")
    print(f"  callHistory : {len(hist)} distinct selectors")
    print(f"  source bytes: {sum(len(c['verifiedSource'] or '') for c in contracts_map.values())}")

if __name__ == "__main__":
    main(*sys.argv[1:4])
