#!/usr/bin/env bash
# Day-1 spike for UNDERSTUDY: prove the blast-radius query works on real mainnet.
#
#   ./blast-radius.sh <account-address>
#
# Pipeline:
#   1. Blockscout  -> every RoleGranted(role, account=X, sender) across ALL contracts
#   2. eth_call    -> hasRole(role, X) to confirm the grant is STILL live today
#
# No API key. No archive node. Verified working 2026-08-05 on Ethereum mainnet.
set -euo pipefail

ACCT_RAW="${1:-0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c}"   # default: Lido DAO Agent
ACCT="$(echo "${ACCT_RAW#0x}" | tr 'A-Z' 'a-z')"

RPC="${RPC:-https://ethereum-rpc.publicnode.com}"
SCOUT="${SCOUT:-https://eth.blockscout.com}"

ROLE_GRANTED=0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d
HAS_ROLE_SEL=0x91d14854   # hasRole(bytes32,address)
TOPIC2="0x000000000000000000000000${ACCT}"

echo "== UNDERSTUDY blast radius =="
echo "account : 0x${ACCT}"
echo "chain   : ${RPC}"
echo

# ---- 1. discovery ------------------------------------------------------------
curl -s -m 120 \
  "${SCOUT}/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&topic0=${ROLE_GRANTED}&topic2=${TOPIC2}&topic0_2_opr=and" \
  > /tmp/understudy-grants.json

python3 - <<'PY' > /tmp/understudy-pairs.txt
import json
d = json.load(open('/tmp/understudy-grants.json'))
logs = d.get('result') or []
if not isinstance(logs, list):
    raise SystemExit(f"blockscout error: {d.get('message')} {str(logs)[:200]}")
seen, pairs = set(), []
for l in logs:
    k = (l['address'].lower(), l['topics'][1])
    if k not in seen:
        seen.add(k); pairs.append(k)
contracts = {c for c, _ in pairs}
print(f"# logs={len(logs)} pairs={len(pairs)} contracts={len(contracts)}")
for c, r in pairs:
    print(c, r)
PY

head -1 /tmp/understudy-pairs.txt | sed 's/^# /grants: /'
echo

# ---- 2. current-state confirmation -------------------------------------------
echo "confirming with hasRole() (first 20):"
active=0; revoked=0
while read -r C ROLE; do
  [ "${C:0:1}" = "#" ] && continue
  DATA="${HAS_ROLE_SEL}${ROLE#0x}000000000000000000000000${ACCT}"
  RES=$(curl -s -m 20 -X POST "$RPC" -H 'Content-Type: application/json' \
        --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$C\",\"data\":\"$DATA\"},\"latest\"],\"id\":1}" \
        | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('result','0x'))")
  case "$RES" in
    *1) echo "  ACTIVE   $C  role=${ROLE:0:14}.."; active=$((active+1));;
    *0) echo "  revoked  $C  role=${ROLE:0:14}.."; revoked=$((revoked+1));;
    *)  echo "  ?        $C  role=${ROLE:0:14}..";;
  esac
done < <(tail -n +2 /tmp/understudy-pairs.txt | head -20)

echo
echo "STILL ACTIVE: ${active}   REVOKED: ${revoked}"
echo
echo "Any of these that point at a dead keeper is a permission that must be migrated."
