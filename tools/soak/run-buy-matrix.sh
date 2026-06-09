#!/usr/bin/env bash
# run-buy-matrix.sh — run the full buy-side adversarial matrix against a live node
# NON-DESTRUCTIVELY via testmempoolaccept (the genesis pool UTXOs are reused for every
# variant; nothing is mined). Prints a PASS/FAIL table and exits non-zero on any mismatch.
#
# Usage:
#   RMM_RT=/tmp/rmm-regtest \
#   RADIANT_CLI=/path/to/radiant-cli \
#   HARNESS=/path/to/RadiantMM/tools/regtest/trade-adversarial.cjs \
#   ./run-buy-matrix.sh
#
# Requires: the node up at RMM_RT (wallet `rmm` loaded, funded), genesis.json + genesis_txid.txt
# present in RMM_RT, and `node` with the repo node_modules + RadiantScript SDK reachable.
set -uo pipefail

RMM_RT="${RMM_RT:-/tmp/rmm-regtest}"
RADIANT_CLI="${RADIANT_CLI:-/Users/macbookair/CascadeProjects/Radiant-Core/build/src/radiant-cli}"
HARNESS="${HARNESS:-$(cd "$(dirname "$0")/.." && pwd)/regtest/trade-adversarial.cjs}"
RCLI() { "$RADIANT_CLI" -datadir="$RMM_RT" -rpcwallet=rmm "$@"; }

# variant -> expected outcome, per the harness header. Only `valid` and `fee-min` ACCEPT; every
# other variant is an attack/violation that MUST REJECT. (macOS ships bash 3.2 with no associative
# arrays, so expectation is derived by name rather than a map.)
VARIANTS="valid fee-min fee-underpay k-violation code-ctrl code-reserve strip-pool \
          layout dust-rxd zero-token dup-pool state-hijack brick"
expected_for() { case "$1" in valid|fee-min) echo ACCEPT ;; *) echo REJECT ;; esac; }

printf "%-14s %-7s %-7s %-6s  %s\n" VARIANT EXPECT GOT MATCH REASON
pass=0; fail=0
for v in $VARIANTS; do
  out="$(node "$HARNESS" "$v" 2>&1)"
  hex="$(printf '%s\n' "$out" | sed -n 's/^HEX://p')"
  if [ -z "$hex" ]; then
    got=ERROR; reason="$(printf '%s\n' "$out" | tail -1)"
  else
    res="$(RCLI testmempoolaccept "[\"$hex\"]" 2>&1)"
    got="$(printf '%s' "$res" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const a=JSON.parse(d);process.stdout.write(a[0].allowed?'ACCEPT':'REJECT');process.stderr.write(a[0]['reject-reason']||'')}catch(e){process.stdout.write('ERR');process.stderr.write(d)}})" 2> /tmp/rmm_reason)"
    reason="$(cat /tmp/rmm_reason 2>/dev/null)"
  fi
  exp="$(expected_for "$v")"
  if [ "$got" = "$exp" ]; then m=PASS; pass=$((pass+1)); else m=FAIL; fail=$((fail+1)); fi
  printf "%-14s %-7s %-7s %-6s  %s\n" "$v" "$exp" "$got" "$m" "$reason"
done
echo "------"
echo "PASS=$pass FAIL=$fail TOTAL=$((pass+fail))"
[ "$fail" -eq 0 ]
