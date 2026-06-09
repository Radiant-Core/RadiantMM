# RadiantMM v3 soak / verification tooling

Helpers for the external-audit hand-off and the testnet soak. See
[`../../docs/EXTERNAL-AUDIT-PACKAGE.md`](../../docs/EXTERNAL-AUDIT-PACKAGE.md) and
[`../../docs/TESTNET-SOAK-PLAN.md`](../../docs/TESTNET-SOAK-PLAN.md).

> Read-only / non-destructive by default. **Actually running a multi-day soak and procuring the
> external audit are user actions** — these scripts are the tooling, not the soak itself.

## `run-buy-matrix.sh`

Runs the full buy-side adversarial matrix (`../regtest/trade-adversarial.cjs`, 13 variants) against
a live node **via `testmempoolaccept`** (nothing is mined; the pool head is reused for every
variant). Prints a PASS/FAIL table and exits non-zero on any mismatch.

```sh
RMM_RT=/tmp/rmm-regtest \
RADIANT_CLI=/path/to/radiant-cli \
HARNESS=/abs/path/RadiantMM/tools/regtest/trade-adversarial.cjs \
  ./run-buy-matrix.sh
```

Expected: `valid`, `fee-min` ACCEPT; the other 11 REJECT (`state-hijack`/`brick` at script-level
`OP_EQUALVERIFY` = the R1/R1b state-continuity check; `dup-pool` at reject-code 19 = the singleton-ref
gate). 13/13. Last green: 2026-06-09, regtest node v3.1.0.

## `soak-monitor.cjs`

Read-only pool invariant monitor. Follows a pool forward from its genesis controller outpoint and
checks, per hop, code+state continuity (I1–I3, R1/R1b), reserve pairing (I4), constant product
(I5), positivity/dust (I6), and the overflow bound (I7). Emits one JSON line per event; **exits
non-zero on the first violation**.

```sh
# single pass (cron-friendly)
RADIANT_CLI=/path/radiant-cli RMM_RT=/path/datadir \
  node soak-monitor.cjs <controllerTxid> 0 --once

# continuous, polling every 30s (omit the txid to read genesis_txid.txt from RMM_RT)
RADIANT_CLI=/path/radiant-cli RMM_RT=/path/datadir \
  node soak-monitor.cjs --poll-ms=30000
```

Events: `START`, `OK`/`trade-verified` (with `R`,`T`,`K`,`fee`,`kSlackVsPrior`), `IDLE`
(no new trade), `ERROR`, and `VIOLATION` (then exit 1). Requires `txindex=1` on the node (the
regtest datadir sets it) so it can locate the spending tx by scanning recent blocks.

Validated 2026-06-09 on regtest: it verified a real honest-trade hop
(genesis → head, R 1,000,000→1,100,000, T 100,000→90,934, K-slack +119,800) and idled on the new head.

## Paths

The `.cjs` harnesses under `../regtest/` use **absolute, machine-specific paths** to the Radiant-Core
binary and the RadiantScript SDK. Adjust them for your box before running on a soak host.
