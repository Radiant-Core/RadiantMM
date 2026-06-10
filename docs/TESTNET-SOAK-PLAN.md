# RadiantMM v3 — Testnet Soak Plan

**Prepared:** 2026-06-09
**Companion to:** [`EXTERNAL-AUDIT-PACKAGE.md`](./EXTERNAL-AUDIT-PACKAGE.md), `SECURITY-AUDIT-v3.md`.

> **This plan is teed up but NOT executed.** Actually deploying to testnet, running the multi-day
> soak, and procuring the external audit are **user/operator actions**. Nothing here has been run on
> a public testnet. The helper scripts (`tools/soak/`) have been smoke-tested only on the local
> regtest node. Do not treat this document as evidence the soak passed — it is the runbook for
> making it pass.

---

## 0. Goal & exit criteria

**Goal:** demonstrate that the v3 paired-UTXO CPMM survives a sustained, adversarial, multi-pool run
on a public Radiant v3 testnet with **zero invariant violations** and **zero successful drains**,
before any mainnet funds are committed.

**The soak PASSES iff, for the full duration:**

- **P1** Every honest `buildBuy` / `buildSell` trade confirms and the pool head advances cleanly
  (monitor emits `trade-verified`, never `VIOLATION`).
- **P2** Every adversarial transaction fired (the buy matrix + sell matrix + standalone state-hijack
  PoC) is **rejected** by the testnet node with the expected reject reason — never accepted.
- **P3** The constant-product invariant holds on every observed hop: `kOut ≥ kIn` (monitor `I5`),
  i.e. no trade ever decreased K after fee. The cumulative K-slack is `≥ 0` at all times.
- **P4** Code + state continuity holds on both pool UTXOs on every hop (monitor `I1`/`I2`/`I3`):
  the controller stays bare and the reserve state stays the 20-zero marker. No `state-hijack` /
  `brick` shaped UTXO ever appears as a pool head.
- **P5** The owner `withdraw` path works for the owner key and **only** the owner key.
- **P6** No reserve-substitution / decoy-reserve / forked-controller transaction confirms (pairing +
  `$poolRef` singleton hold — monitor `I4`).

**The soak FAILS if** any adversarial tx confirms, any honest trade is rejected for a non-fee reason,
any K decrease is observed, or any continuity/pairing invariant is violated. A single P2/P3/P4
violation is disqualifying and must be root-caused before mainnet.

---

## 1. Target network

The Radiant ecosystem v3 testnet (per the v3.0.0 port change):

| | value |
|---|---|
| network | Radiant v3 **testnet** |
| RPC port | **27332** |
| P2P port | **27333** |
| on-disk subdir | `testnet/` |
| node | Radiant-Core **v3.0.0+** with native introspection + ref opcodes active (the same opcode set the regtest matrix runs against; v3.1.0 is also fine — the matrix was re-verified on v3.1.0 locally). |

Run an own `radiantd` in `-testnet` mode (do **not** reuse the regtest datadir). Sync to tip, fund a
soak wallet from the testnet faucet / by mining if the testnet allows it. **Do not touch any mainnet
node, the VPS, or any production indexer.**

---

## 2. What to deploy

Use the v3 SDK builder (`src/v3/builder.ts`) — the same code path the audit covers — to create
pools, not the hand-rolled `.cjs` harnesses (those are attack generators).

Deploy a **spread of pools** so the on-chain contract is exercised across reserve ratios and sizes
(the regtest matrix only ran one vector R=1,000,000 / T=100,000 — see audit-package §8 gap 3):

| pool | R (RXD sat) | T (tokens) | purpose |
|------|-------------|------------|---------|
| A | 1,000,000 | 100,000 | baseline (matches regtest) |
| B | 50,000,000 | 5,000 | RXD-heavy / high unit price |
| C | 100,000 | 50,000,000 | token-heavy / low unit price |
| D | near `R·T = 2^53−1` but under | … | R4 boundary: confirm it still trades just under the cap, and that `buildGenesis` refuses one just over |
| E | 600,000 | 600,000 | small, near-dust deltas to stress the fee ceiling + dust guard |

`buildGenesis` must **reject** any pool with `R·T > 2^53−1`, sub-dust R, or non-positive T (R4 guard,
`src/v3/builder.ts:64–69`) — deploy a deliberately oversized one and confirm the builder throws
(off-chain, no broadcast).

---

## 3. Duration & cadence

| phase | length | activity |
|-------|--------|----------|
| **Burn-in** | day 0 (first few hours) | Deploy pools A–E. Fire 1 honest buy + 1 honest sell per pool; confirm each advances and the monitor verifies the hop. Fire the **full adversarial matrix** once against pool A and confirm all rejections. Establish the baseline. |
| **Soak** | **≥ 7 days** (14 recommended) | Continuous honest trade traffic + periodic adversarial probes. Monitor running the whole time. |
| **Adversarial sweep** | every **6 h** during soak | Re-fire the full buy matrix + sell matrix + standalone state-hijack PoC against the *current live pool head* (not just genesis). Each must reject. |
| **Honest traffic** | every **5–15 min** | A randomized honest buy or sell (varied Δ within the pool's tradeable band) on a randomly chosen pool, to keep pool heads advancing and accumulate hop coverage. |
| **Withdraw probe** | day 1 and day N | Owner `withdraw` succeeds with the owner key; an attacker `withdraw` with a wrong key is rejected. Re-fund/redeploy the pool after the owner-withdraw drains it. |
| **Wrap-up** | final day | Final full adversarial sweep; export the monitor log; tally hops, rejections, min observed K-slack. |

Rationale for ≥7 days: spans multiple testnet difficulty/retarget windows and enough blocks that any
reorg-/mempool-eviction interaction with the paired-UTXO model would surface. 14 days if the testnet
is low-traffic.

---

## 4. Metrics & invariants to monitor

`tools/soak/soak-monitor.cjs` (read-only) follows each pool forward from its genesis controller
outpoint and checks, **per hop**, the invariants below. It emits one JSON line per event and **exits
non-zero on the first violation** (so a supervisor/notifier catches it immediately).

| code | invariant | source of truth |
|------|-----------|-----------------|
| I1 | controller **code** continuity | `RadiantMMPool.rxd:71` |
| I2 | controller + reserve **state** continuity (R1/R1b) | `RadiantMMPool.rxd:72,74` |
| I3 | reserve **code** continuity | `RadiantMMPool.rxd:73` |
| I4 | reserve **pairing** (controller@0 + reserve@1 of the prior head co-spent) | `RadiantMMPool.rxd:55–57` |
| I5 | **constant product** `effRxdOut·tokOut ≥ rxdIn·tokIn`, `fee = ceil(0.3%·|Δrxd|)` | `RadiantMMPool.rxd:101–117` |
| I6 | positivity / dust (`rxd ≥ 546`, `tok > 0`) | `RadiantMMPool.rxd:93–96` |
| I7 | overflow bound `R·T ≤ 2^53−1` on the new head (R4) | `RadiantMMPool.rxd:101,115` |

Aggregate metrics to record over the run: total hops verified, total adversarial txs fired vs
rejected (must be N fired = N rejected), **minimum observed K-slack** (`kOut − kIn`; must stay `≥ 0`),
honest-trade confirm latency, and any node reject reasons seen on honest traffic (should be none
beyond transient mempool/fee).

Run the monitor per pool (one process each), e.g.:

```sh
RADIANT_CLI=/path/radiant-cli RMM_RT=/path/testnet-datadir \
  node tools/soak/soak-monitor.cjs <poolGenesisTxid> 0 --poll-ms=30000
```

Supervise it so a non-zero exit (a VIOLATION) pages you. A `--once` mode exists for cron-style checks.

---

## 5. Adversarial transactions to fire periodically

All already implemented as generators; the soak just re-runs them against the live testnet head.

**Buy matrix** — `tools/soak/run-buy-matrix.sh` (wraps `tools/regtest/trade-adversarial.cjs`):
`fee-underpay, k-violation, code-ctrl, code-reserve, strip-pool, layout, dust-rxd, zero-token,
dup-pool, state-hijack, brick` must REJECT; `valid, fee-min` must ACCEPT. Point the harness at the
**current pool head** (not genesis) by regenerating its `genesis.json`-equivalent from the live head,
or by extending the harness to read the head outpoint from an arg. Use `testmempoolaccept` so probes
don't consume the head.

**Sell matrix** — `tools/soak/run-sell-matrix.sh` (wraps `tools/regtest/trade-sell-adversarial.cjs`):
`theft-sig, holder-release, reserve-xfer, no-token-add, code-reserve, strip-pool` must REJECT;
honest `valid` sell must ACCEPT (`valid` runs last). Use `testmempoolaccept` so probes don't consume
the head. **This matrix requires a post-buy pool state as inputs** (controller'@vout0, reserve'@vout1,
trader holder@vout2 of a *mined* buy) and was *not* re-run in the 2026-06-09 pass — the soak is the
right place to exercise it continuously (audit-package §8 gap 1). The wrapper **auto-stages** that
post-buy pool when `$RMM_RT/buy_txid.txt` is missing, its reserve (`gettxout buy_txid 1`) is spent, or
it is from an older genesis lineage: it fires one `trade-buy.cjs` buy against the current genesis,
broadcasts it, and mines 1 block before running the sell variants against the resulting head. (It also
`loadwallet rmm` if `listwallets` lacks it.)

**Standalone drain PoC** — `tools/regtest/trade-attack-state-hijack.cjs attack`: the byte-for-byte
pre-fix exploit. Must REJECT at `OP_EQUALVERIFY` every time. This is the single most important probe:
if it ever confirms, the soak has failed catastrophically.

Recommended automation: a cron/systemd timer firing `tools/soak/run-buy-matrix.sh` +
`tools/soak/run-sell-matrix.sh` + the drain PoC every 6 h via `testmempoolaccept`, logging any
`allowed:true` on an attack variant (a non-zero exit from either wrapper) as a P2 failure.

---

## 6. Failure handling

- **Any adversarial tx confirms (P2 fail):** stop the soak. This is a live drain/brick. Capture the
  tx, the pool head, and the node version. Root-cause against the contract; this blocks mainnet.
- **Monitor emits VIOLATION (P3/P4/P6 fail):** capture the offending hop (`prev`/`next` txids) and
  the invariant code. Reproduce on regtest with the same shapes.
- **Honest trade rejected for a non-fee reason (P1 fail):** likely an SDK/builder bug, not a contract
  drain, but still disqualifying — fix and restart the clock.
- **Testnet reorg:** the monitor follows confirmed heads; after a reorg, restart it from the pool's
  current confirmed head. A reorg that orphaned an honest trade is fine; a reorg that *enabled* an
  adversarial confirm is a P2 failure.

---

## 7. Pre-flight checklist (before starting the soak)

- [ ] Local regtest matrix green (re-run `tools/soak/run-buy-matrix.sh` → 13/13 and
      `tools/soak/run-sell-matrix.sh` → 7/7; vitest 50/50; standalone PoC rejects). *(Buy done
      2026-06-09; sell wrapper added + green 2026-06-10 on regtest v3.1.1. Re-run on the soak box.)*
- [ ] `radiantd -testnet` synced to tip (RPC 27332), soak wallet funded.
- [ ] Pools A–E deployed via `buildGenesis`; genesis txids recorded.
- [ ] One monitor process per pool, supervised, paging on non-zero exit.
- [ ] Adversarial sweep timer installed (6 h), logging attack-accept as failure.
- [ ] Honest-traffic driver installed (5–15 min randomized buy/sell).
- [ ] Owner + attacker keys staged for the withdraw probe.

---

## 8. What the USER must still do (not performed here)

1. **Procure the external audit** (audit-package §1 "what the auditor should produce"). Not started.
2. **Run this soak** on a real Radiant v3 testnet for ≥7 days and meet P1–P6. Not started — only the
   local regtest smoke of the tooling has been done.
3. Decide R3 (single-custodian trust) and R4 (≥9e15 pool cap / 128-bit math) acceptability for the
   product before mainnet.

Everything needed to start — contracts, SDK, attack generators, the invariant monitor, the matrix
runner, and this runbook — is in the repo. The trigger is yours to pull.
