#!/usr/bin/env bash
# run-sell-matrix.sh — run the full SELL-side adversarial matrix against a live node
# NON-DESTRUCTIVELY via testmempoolaccept (the post-buy pool UTXOs are reused for every variant;
# nothing is mined for the matrix itself). Prints a PASS/FAIL table and exits non-zero on any mismatch.
#
# Unlike the buy matrix, the sell harness needs a *post-buy* pool as its inputs (controller'@vout0,
# reserve'@vout1, trader holder@vout2 of a MINED buy) and reads $RMM_RT/buy_txid.txt + buy_meta.json.
# If that pool is missing, spent, or belongs to an OLDER genesis lineage — its controller no longer
# matches the current genesis.json; the sell harness builds its outputs from genesis.json, so a
# cross-lineage buy makes even the honest `valid` sell reject at ref code 19 — this wrapper STAGES a
# fresh one first: it runs trade-buy.cjs against the current genesis, broadcasts that buy, records the
# txid in $RMM_RT/buy_txid.txt, and mines 1 block. (The harnesses only print TRADE_HEX: and never
# broadcast themselves.) The staging buy is the ONLY thing this script mines; the matrix itself never
# touches the chain.
#
# Usage:
#   RMM_RT=/tmp/rmm-regtest \
#   RADIANT_CLI=/path/to/radiant-cli \
#   HARNESS=/path/to/RadiantMM/tools/regtest/trade-sell-adversarial.cjs \
#   BUY_HARNESS=/path/to/RadiantMM/tools/regtest/trade-buy.cjs \
#   ./run-sell-matrix.sh
#
# Requires: the node up at RMM_RT, genesis.json + genesis_txid.txt present in RMM_RT (with an UNSPENT
# genesis pool — needed only when staging), and `node` with the repo node_modules + RadiantScript SDK
# reachable. The wallet `rmm` is auto-loaded if listwallets lacks it (it is not auto-loaded after a
# daemon restart).
set -uo pipefail

RMM_RT="${RMM_RT:-/tmp/rmm-regtest}"
RADIANT_CLI="${RADIANT_CLI:-/Users/macbookair/CascadeProjects/Radiant-Core/build/src/radiant-cli}"
HARNESS="${HARNESS:-$(cd "$(dirname "$0")/.." && pwd)/regtest/trade-sell-adversarial.cjs}"
BUY_HARNESS="${BUY_HARNESS:-$(cd "$(dirname "$0")/.." && pwd)/regtest/trade-buy.cjs}"
export RMM_RT                                   # the .cjs harnesses read the datadir from the environment
RCLI() { "$RADIANT_CLI" -datadir="$RMM_RT" -rpcwallet=rmm "$@"; }

[ -f "$RMM_RT/genesis.json" ] || { echo "FATAL: $RMM_RT/genesis.json missing" >&2; exit 1; }

# --- ensure the rmm wallet is loaded (not auto-loaded after a daemon restart) ---
if ! "$RADIANT_CLI" -datadir="$RMM_RT" listwallets 2>/dev/null | grep -q '"rmm"'; then
  echo ">> loading wallet rmm"
  "$RADIANT_CLI" -datadir="$RMM_RT" loadwallet rmm >/dev/null 2>&1 \
    || { echo "FATAL: could not loadwallet rmm (does the wallet exist on disk?)" >&2; exit 1; }
fi

# --- ensure a usable post-buy pool exists; stage one if not ---
# pull a UTXO's scriptPubKey.hex out of `gettxout` (empty string if the output is null/spent)
spk_hex() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).scriptPubKey.hex)}catch(e){process.stdout.write("")}})'; }
gen_ctrl="$(node -e 'process.stdout.write(require(process.argv[1]).controllerLock)' "$RMM_RT/genesis.json" 2>/dev/null || true)"

buy_txid=""
[ -f "$RMM_RT/buy_txid.txt" ] && buy_txid="$(tr -d '[:space:]' < "$RMM_RT/buy_txid.txt" 2>/dev/null || true)"

need_stage=1; stage_reason="no $RMM_RT/buy_txid.txt"
if [ -n "$buy_txid" ] && [ -f "$RMM_RT/buy_meta.json" ]; then
  v0="$(RCLI gettxout "$buy_txid" 0 2>/dev/null | spk_hex || true)"
  v1="$(RCLI gettxout "$buy_txid" 1 2>/dev/null | spk_hex || true)"   # the task's stated check: vout 1 == null
  if [ -z "$v1" ]; then
    stage_reason="post-buy pool reserve (vout 1) is missing/spent"
  elif [ -z "$v0" ]; then
    stage_reason="post-buy pool controller (vout 0) is missing/spent"
  elif [ -n "$gen_ctrl" ] && [ "$v0" != "$gen_ctrl" ]; then
    stage_reason="post-buy pool is from an older genesis lineage (controller != current genesis.json)"
  else
    need_stage=0
  fi
fi

if [ "$need_stage" -eq 1 ]; then
  echo ">> staging a fresh post-buy pool — reason: $stage_reason"
  [ -f "$RMM_RT/genesis_txid.txt" ] || { echo "FATAL: $RMM_RT/genesis_txid.txt missing — cannot stage a buy" >&2; exit 1; }
  bout="$(node "$BUY_HARNESS" 2>&1)"
  bhex="$(printf '%s\n' "$bout" | sed -n 's/^TRADE_HEX://p')"
  if [ -z "$bhex" ]; then
    echo "FATAL: trade-buy.cjs emitted no TRADE_HEX — cannot stage. Harness output:" >&2
    printf '%s\n' "$bout" >&2
    exit 1
  fi
  btxid="$(RCLI sendrawtransaction "$bhex" 2>&1)"
  if ! printf '%s' "$btxid" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "FATAL: could not broadcast the staging buy: $btxid" >&2
    exit 1
  fi
  printf '%s\n' "$btxid" > "$RMM_RT/buy_txid.txt"
  RCLI generatetoaddress 1 "$(RCLI getnewaddress)" >/dev/null \
    || { echo "FATAL: could not mine the staging buy" >&2; exit 1; }
  buy_txid="$btxid"
  echo ">> staged buy_txid=$btxid (broadcast + mined 1 block)"
fi

echo ">> testing post-buy pool buy_txid=$buy_txid"

# variant -> expected outcome, per the harness header. Only `valid` ACCEPTs; every other variant is
# an attack/violation that MUST REJECT. `valid` runs LAST so the reject probes never disturb it.
# (macOS ships bash 3.2 with no associative arrays, so the expectation is derived by name.)
VARIANTS="theft-sig holder-release reserve-xfer no-token-add code-reserve strip-pool valid"
expected_for() { case "$1" in valid) echo ACCEPT ;; *) echo REJECT ;; esac; }

printf "%-16s %-7s %-7s %-6s  %s\n" VARIANT EXPECT GOT MATCH REASON
pass=0; fail=0
for v in $VARIANTS; do
  out="$(node "$HARNESS" "$v" 2>&1)"
  hex="$(printf '%s\n' "$out" | sed -n 's/^TRADE_HEX://p')"
  if [ -z "$hex" ]; then
    got=ERROR; reason="$(printf '%s\n' "$out" | tail -1)"
  else
    res="$(RCLI testmempoolaccept "[\"$hex\"]" 2>&1)"
    got="$(printf '%s' "$res" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const a=JSON.parse(d);process.stdout.write(a[0].allowed?'ACCEPT':'REJECT');process.stderr.write(a[0]['reject-reason']||'')}catch(e){process.stdout.write('ERR');process.stderr.write(d)}})" 2> /tmp/rmm_sell_reason)"
    reason="$(cat /tmp/rmm_sell_reason 2>/dev/null)"
  fi
  exp="$(expected_for "$v")"
  if [ "$got" = "$exp" ]; then m=PASS; pass=$((pass+1)); else m=FAIL; fail=$((fail+1)); fi
  printf "%-16s %-7s %-7s %-6s  %s\n" "$v" "$exp" "$got" "$m" "$reason"
done
echo "------"
echo "PASS=$pass FAIL=$fail TOTAL=$((pass+fail))"
[ "$fail" -eq 0 ]
