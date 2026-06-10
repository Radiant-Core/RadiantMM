# RadiantMM v3 — External Audit Hand-off Package

**Prepared:** 2026-06-09
**Target:** an external auditor starting cold. This is the single entry point.
**Status of the code:** all internally-identified findings (R1, R1b, R2–R6) are fixed and
re-verified on a local regtest node; the suite is green. The two remaining blockers before
mainnet funds are **(a) this external audit** and **(b) a testnet soak** — see
[`TESTNET-SOAK-PLAN.md`](./TESTNET-SOAK-PLAN.md). Neither has been performed; both are user/operator
actions, not claimed here.

> Honesty note: where a claim is backed by a test you can re-run, the test is cited. Where a claim
> is **not** test-backed, it is called out explicitly in §8 (Open assumptions & gaps). Do not treat
> the green matrix as a substitute for the audit — it is a regression gate, not a proof.

---

## 1. Scope

### In scope (the consensus-critical surface — audit this)

| File | Role |
|------|------|
| `contracts/v3/RadiantMMPool.rxd` | The pool **controller** covenant. Enforces the constant-product invariant, fee, reserve pairing, and code+state continuity. The RXD reserve lives in this UTXO. |
| `contracts/v3/RadiantMMToken.rxd` | The AMM-native fungible **token**. One code, three spend roles (`transfer`/`release`/`burn`) keyed by the UTXO's state section. The token reserve is a UTXO of this contract in the `release`/pool-marker role. |
| `contracts/v3/artifacts/RadiantMMPool.json` | **Compiled bytecode that actually runs at consensus.** Audit this, not just the `.rxd`. Field `asm`/`hex`. |
| `contracts/v3/artifacts/RadiantMMToken.json` | Compiled token bytecode. |
| `src/v3/builder.ts` | Off-chain transaction builder: `buildGenesis`, `buildBuy`, `buildSell`. Constructs the exact paired-UTXO txs the contract accepts, and the genesis-time R4 guard. |
| `src/v3/math.ts` | CPMM math (`verifyAccept`, `quoteBuy`, `quoteSell`, fee, dust, overflow bound). A faithful replica of the contract's accept criterion; reconciles to on-chain vectors. |
| `src/v3/contracts.ts` | Ref encoding, ASM substitution, `buildStatefulOutput`, `RESERVE_MARKER`, pool-script assembly. |
| `src/v3/index.ts` | Public surface. |

### Out of scope (do not audit as live code)

- `contracts/RadiantMMPool.{rxd,script}` and legacy `src/*.ts` (trade/pool/price) — the **v1**
  single-UTXO design. **UNSAFE — DO NOT DEPLOY** (banner-marked). Kept only for history. See R5.
- `SECURITY-AUDIT.md` — the **v1** audit; historical. The authoritative document is
  `SECURITY-AUDIT-v3.md` (and this package).
- `RadiantMM_Whitepaper.md`, `RadiantMM_Implementation_Plan.md` — design narrative, not consensus.

### What the auditor should produce

A judgement on **fund safety** of the v3 pool under adversarial conditions: can any party other than
the owner (via the disclosed `withdraw` custody path) extract value from a pool, brick it, or
mis-price a trade? Plus a review of the trust model (R3) and the overflow cap (R4) as design choices.

---

## 2. Architecture in one screen

A pool is **two co-spent UTXOs**, always at outputs 0 and 1 of every trade and of genesis:

```
input[0]/output[0] = controller  (RadiantMMPool)   value = R (RXD reserve)   carries singleton $poolRef, BARE (no state)
input[1]/output[1] = token reserve (RadiantMMToken) value = T (coloured tokens) state = 20-zero RESERVE_MARKER
input[2..]         = trader funding / trader token holder (a normal P2PKH / token holder UTXO)
```

- **Trade** spends both pool UTXOs: controller via `trade()` (scriptSig `OP_0`), reserve via
  `release()` (scriptSig `OP_1`), recreating both at outputs 0/1 with new values and the same
  code+state. K = R·T must not decrease after a 0.3% fee on the RXD delta.
- **Token amount = coloured-satoshi value** of the ref-bearing UTXO (Glyph-style). Conservation is
  enforced by `RadiantMMToken` (`codeScriptValueSum(in) == codeScriptValueSum(out)`), so the
  controller can read `tx.inputs[1].value` / `tx.outputs[1].value` as genuine token quantities (C1).
- **Reserve isolation** is by **outpoint pairing**: `input[1]` must be vout 1 of the same prior tx
  that created `input[0]` (this controller), and `$poolRef` is a singleton, so no decoy reserve and
  no forked second controller can be substituted (see `RadiantMMPool.rxd:53–57`).
- **Custody** (`withdraw`) is a single-owner signature path that can remove all RXD. This is **by
  design and is the central trust assumption** — see R3.

---

## 3. Threat model

**Adversary:** any party that can construct and broadcast a transaction; specifically a non-owner who
wants to extract value from, mis-price, or freeze a pool at fee-only cost. The adversary can:
co-spend the pool UTXOs, supply arbitrary additional inputs/outputs, choose output scripts and
values, choose the dispatch branch (`trade`/`release`/`transfer`/`burn`), and present decoy token or
controller UTXOs.

**Trusted:** Radiant consensus (script verification, ref/colour induction, value conservation of
coloured satoshis), and the pool **owner** for custody only (R3). The owner is *not* trusted for
trade pricing — `trade()` is permissionless and consensus-enforced.

**Assets:** the RXD reserve R (controller value) and the token reserve T (reserve-UTXO value).

**Out-of-model:** miner censorship / ordering, Radiant-Core consensus bugs themselves, key
management of the owner, front-running/MEV economics (price is deterministic per-block but ordering
within a block is a miner concern), and the economic soundness of a single-custodian pool (that is a
disclosed product decision, R3).

**Security goal (the invariant the auditor should try to break):** *No transaction that spends a pool
controller is valid unless it recreates the controller and its paired token reserve faithfully (same
code, same state, value only changing) and leaves K = R·T non-decreasing after fee — except the
owner-signed `withdraw`.* Everything in §5 is a corollary of this goal.

---

## 4. Known findings — fixed & verified

All from `SECURITY-AUDIT-v3.md` (2026-06-04 red-team). Each row points to the **fix location** and
the **test that proves it**. Re-run instructions in §6.

| ID | Sev | Finding | Fix (file:line) | Proof |
|----|-----|---------|-----------------|-------|
| **R1** | 🔴 Crit | **Reserve state hijack.** Controller checked **code-only** continuity on output[1] and never its state. Since every token UTXO shares one code (`OP_DROP <tokenAsm>`), an attacker recreated output[1] with the same code but **their own pkh** as state → the reserve became a holder UTXO they own; K passed trivially via a no-op trade. **Entire token reserve drainable for a fee.** Proven on-chain pre-fix. | `RadiantMMPool.rxd:74` adds `require(tx.outputs[1].stateScript == tx.inputs[1].stateScript)` → compiled to `OP_STATESCRIPTBYTECODE_OUTPUT`. | Standalone byte-for-byte PoC `tools/regtest/trade-attack-state-hijack.cjs` (the exact pre-fix drain tx) now **REJECTS at `OP_EQUALVERIFY`**. Matrix variant `state-hijack` in `tools/regtest/trade-adversarial.cjs` also rejects at the script level (after the 2026-06-09 token-code fix). |
| **R1b** | 🟠 High | **Symmetric controller brick.** output[0] (the bare controller) could be recreated **stateful** (same code + junk state), passing code-only continuity and freezing all future dispatch → permanent RXD freeze. | `RadiantMMPool.rxd:72` adds `require(tx.outputs[0].stateScript == tx.inputs[0].stateScript)` (anti-brick). | Matrix variant `brick` rejects at `OP_EQUALVERIFY`. |
| R2 | 🟠 High | **Reserve-input identity by induction only.** `trade()` reads `tokIn = inputs[1].value` without proving input[1] is *the* `$tokenRef` reserve; soundness rested on the outpoint-pairing chain that R1 broke. | Restored by the R1 fix: pinning reserve **code + state** each hop re-establishes the induction (every reserve output is provably the marker-state token reserve). Pairing itself at `RadiantMMPool.rxd:55–57`. | Same as R1 — once R1's state pin holds, the chain is unbroken. The `code-reserve`, `strip-pool`, `state-hijack` matrix variants exercise substitution attempts; all reject. |
| R3 | 🟡 Med | **Custodial trust.** `withdraw(pk,s)` releases **all** RXD to the single `ownerPkh` holder; no LP-share, timelock, or quorum. | **By design — disclosed**, not "fixed". `RadiantMMPool.rxd:6–9, 121–124`. | N/A (intended behaviour). The auditor must opine on whether this is acceptable for the product, or whether an LP-share covenant is required before calling it permissionless. |
| R4 | 🟡 Med | **K overflow guard is also a hard size cap.** Guard `R·T ≤ 2^53−1` (a 2^63−1 literal mis-encodes to a 9-byte script number; see RadiantScript MUL/DIV notes). A pool funded past ~9e15 is permanently **untradeable**. | Mitigated: `buildGenesis` rejects out-of-range / sub-dust / non-positive reserves at creation. `src/v3/builder.ts:64–69` (`if (k > MAX) throw`), `MAX = 9_007_199_254_740_991n` in `src/v3/math.ts:23`. | `tests/v3-builder.test.ts`. |
| R5 | ⚪ Low | **Stale v1 audit + unsafe v1 artifacts in-tree.** | v1 contracts banner-marked **UNSAFE — DO NOT DEPLOY**; `SECURITY-AUDIT.md` redirects here. | Inspect the banners; out of audit scope (§1). |
| R6 | ⚪ Low | **SDK↔harness deployment drift.** Reserve deployed stateful by the SDK but bare by some harnesses; the inconsistency masked the R1 gap in tests. | `tools/regtest/trade-adversarial.cjs` aligned to the stateful marker; bare reserve now correctly rejected; `state-hijack`/`brick` variants added. **2026-06-09:** harness token-code corrected so those two variants reject at the contract's own state check rather than the earlier ref-operations gate. | The matrix run in §6. |

### The R1 fix, precisely

`RadiantMMPool.rxd:71–74` (the four continuity requires):

```
require(tx.outputs[0].codeScript  == tx.inputs[0].codeScript);   // controller code
require(tx.outputs[0].stateScript == tx.inputs[0].stateScript);  // controller stays bare (anti-brick, R1b)
require(tx.outputs[1].codeScript  == tx.inputs[1].codeScript);   // token reserve code
require(tx.outputs[1].stateScript == tx.inputs[1].stateScript);  // reserve marker state preserved — R1 fix
```

Compiled artifact (`contracts/v3/artifacts/RadiantMMPool.json`) contains **2× `OP_STATESCRIPTBYTECODE_OUTPUT`**
and **2× `OP_CODESCRIPTBYTECODE_OUTPUT`** (verified 2026-06-09), and **0× `OP_2MUL`/`OP_2DIV`** with
**3× `OP_MUL`/`OP_DIV`** — i.e. the RadiantScript MUL/DIV-lowering bug is *not* present in this build.

---

## 5. Invariants the CPMM must preserve

The auditor should attempt to violate each. The matrix variant that *should* already reject the
attempt is named; if you find a path that violates an invariant and is **not** caught, that is a
finding.

1. **Constant product (no value extraction by trade).** For any `trade()`,
   `effRxdOut · tokOut ≥ rxdIn · tokIn`, where `effRxdOut = rxdOut − fee`, `fee = ceil(0.3% · |Δrxd|)`.
   → `fee-underpay`, `k-violation`.  (`RadiantMMPool.rxd:101–117`.)
2. **Code continuity, both pool UTXOs.** outputs[0/1].codeScript == inputs[0/1].codeScript.
   → `code-ctrl`, `code-reserve`, `strip-pool`.
3. **State continuity, both pool UTXOs (R1/R1b).** outputs[0/1].stateScript == inputs[0/1].stateScript.
   The controller is always bare; the reserve state is always the 20-zero `RESERVE_MARKER`. **Value
   may change; code and state may not.** → `state-hijack`, `brick`.
4. **Reserve pairing / anti-substitution.** input[1] is vout 1 of the same tx that created input[0];
   input[0] is vout 0. → covered by pairing; decoy-reserve attempts fail before pricing.
5. **`$poolRef` singleton.** Exactly one output carries `$poolRef` (`refOutputCount == 1`).
   → `dup-pool` (rejects at the ref-operations gate — the correct gate for a duplicated singleton).
6. **Token presence on the reserve.** The recreated reserve carries `$tokenRef` (`refOutputCount ≥ 1`).
7. **No degenerate reserves.** `rxdIn, rxdOut ≥ 546` (dust); `tokIn, tokOut > 0`.
   → `dust-rxd`, `zero-token`.
8. **Token conservation & escape-prevention (token contract).** Every `$tokenRef` output uses the
   token code, and `codeScriptValueSum(in) == codeScriptValueSum(out)` (or `in − burnAmount` for
   `burn`). A holder UTXO (state = real pkh) can never reach `release()` (no key hashes to the marker);
   a reserve UTXO can never use `transfer()` (checkSig vs marker is unsatisfiable).
   → sell-side variants `theft-sig`, `holder-release`, `reserve-xfer` (see §6 note).
9. **Overflow safety / size cap (R4).** `R·T ≤ 2^53−1` enforced at runtime and at genesis.
10. **Custody is the only privileged path (R3).** Only `withdraw` with the owner signature removes
    value outside the trade invariant. No other signature-gated escape exists.

---

## 6. How to reproduce the verification

### 6.0 Prerequisites

- A Radiant-Core node (`radiantd`/`radiant-cli`) **with native introspection + ref opcodes active**.
  The harness was last run against the locally-built node at
  `/Users/macbookair/CascadeProjects/Radiant-Core/build/src/` (reported version `v3.1.0`; the
  contracts were authored/compiled under v3.0.0 — the matrix passes on both).
- A funded regtest wallet. The harness datadir is `/tmp/rmm-regtest` (RPC 18443, wallet `rmm`).
- `node` + the repo's `node_modules` (`@radiant-core/radiantjs`) and the RadiantScript SDK at
  `/Users/macbookair/CascadeProjects/RadiantScript/packages/cashscript/dist/`.

Bring up the regtest node and genesis per `tools/regtest/README.md` (mkdir datadir, start `radiantd
-datadir=/tmp/rmm-regtest -listen=0 -daemon`, `createwallet rmm`, mine ~115 blocks so ER@100 /
PushTXState@110 are active, then `node tools/regtest/genesis.cjs`). **Paths in the `.cjs` harnesses
are absolute and machine-specific — adjust the `Radiant-Core` / `RadiantScript` paths for your box.**

### 6.1 Vitest (off-chain math/builder/parser) — fast, no node needed

```sh
npx vitest run
```

Last run (2026-06-09): **50 passed / 50** across `tests/{v3-math,math,trade,script,pool,v3-builder}.test.ts`.
`npx tsc --noEmit` is clean.

### 6.2 Buy-side adversarial matrix (on-chain, consensus-level)

The harness prints a tx hex per variant; submit each to a live node. Using
`testmempoolaccept` validates against full consensus **and the script** without mining, so the
genesis pool UTXOs stay unspent and every variant reuses them. Helper:
`tools/soak/run-buy-matrix.sh` (added in this package). Or inline:

```sh
for v in valid fee-min fee-underpay k-violation code-ctrl code-reserve strip-pool \
         layout dust-rxd zero-token dup-pool state-hijack brick; do
  HEX=$(node tools/regtest/trade-adversarial.cjs "$v" | sed -n 's/^HEX://p')
  echo "$v: $(radiant-cli -datadir=/tmp/rmm-regtest -rpcwallet=rmm testmempoolaccept "[\"$HEX\"]")"
done
```

**Last run (2026-06-09, node v3.1.0, /tmp/rmm-regtest @ block 151), via `testmempoolaccept`:**

| variant | expected | got | reject-reason |
|---|---|---|---|
| valid | ACCEPT | ACCEPT | — |
| fee-min | ACCEPT | ACCEPT | — |
| fee-underpay | REJECT | REJECT | 16 false-top-stack (K) |
| k-violation | REJECT | REJECT | 16 false-top-stack (K) |
| code-ctrl | REJECT | REJECT | 16 OP_EQUALVERIFY (continuity) |
| code-reserve | REJECT | REJECT | 16 OP_EQUALVERIFY (continuity) |
| strip-pool | REJECT | REJECT | 16 OP_EQUALVERIFY (continuity) |
| layout | REJECT | REJECT | 16 OP_EQUALVERIFY (continuity@0) |
| dust-rxd | REJECT | REJECT | 16 OP_VERIFY (dust guard) |
| zero-token | REJECT | REJECT | 16 OP_VERIFY (tokOut>0) |
| dup-pool | REJECT | REJECT | 19 reference-operations (singleton-ref) |
| **state-hijack (R1)** | REJECT | REJECT | **16 OP_EQUALVERIFY (STATE continuity)** |
| **brick (R1b)** | REJECT | REJECT | **16 OP_EQUALVERIFY (STATE continuity)** |

13/13 as expected. The standalone byte-for-byte exploit
`node tools/regtest/trade-attack-state-hijack.cjs attack` → `testmempoolaccept` also **rejects at
`OP_EQUALVERIFY`** — the cleanest isolation of the R1 fix.

> Note on gates: `dup-pool` rejects at consensus reject-code **19** (`...reference-operations`), which
> is the *correct* gate for a duplicated singleton ref — it never reaches the covenant. The R1/R1b
> variants reject at code **16** (script `OP_EQUALVERIFY`), i.e. at the contract's own
> state-continuity check, which is the behaviour we want to demonstrate.

### 6.3 Sell-side adversarial matrix (on-chain, consensus-level)

`tools/regtest/trade-sell-adversarial.cjs` covers sell-specific surface (`theft-sig`,
`holder-release`, `reserve-xfer`, `no-token-add`, `code-reserve`, `strip-pool`). Unlike the buy
matrix it requires a **post-BUY pool state** as inputs (controller', reserve', trader holder), which
the genesis-only datadir does not stage — so historically this was the one matrix that had to be
hand-staged. Helper: `tools/soak/run-sell-matrix.sh` (added in this package) now automates exactly
that. Whenever `buy_txid.txt` is missing, the recorded buy's reserve (`gettxout buy_txid 1`) is
spent, or the recorded buy is from an older genesis lineage (its controller no longer matches the
current `genesis.json`, which would make even the honest `valid` sell reject at ref code 19), it
stages a fresh pool — runs `trade-buy.cjs` against the current genesis, broadcasts it, and mines 1
block — then runs the six reject variants + honest `valid` through `testmempoolaccept`, printing a
PASS/FAIL table and exiting non-zero on any mismatch. The staging buy is the only thing it mines; the
matrix itself reuses the post-buy UTXOs non-destructively, exactly like §6.2. Run it (from the repo
root; the wrapper resolves the harness paths relative to itself):

```sh
RMM_RT=/tmp/rmm-regtest \
RADIANT_CLI=/Users/macbookair/CascadeProjects/Radiant-Core/build/src/radiant-cli \
  tools/soak/run-sell-matrix.sh
```

**Last run (2026-06-10, node v3.1.1, /tmp/rmm-regtest), via `testmempoolaccept`:**

| variant | expected | got | reject-reason |
|---|---|---|---|
| theft-sig | REJECT | REJECT | 16 OP_EQUALVERIFY (pkh-bind) |
| holder-release | REJECT | REJECT | 16 OP_NUMEQUALVERIFY (controller pairing) |
| reserve-xfer | REJECT | REJECT | 16 OP_EQUALVERIFY (transfer-marker) |
| no-token-add | REJECT | REJECT | 16 false-top-stack (K) |
| code-reserve | REJECT | REJECT | 16 OP_EQUALVERIFY (continuity) |
| strip-pool | REJECT | REJECT | 16 OP_EQUALVERIFY (continuity) |
| valid | ACCEPT | ACCEPT | — |

7/7 as expected (six rejects + honest sell; `valid` runs last so the reject probes never disturb it).
The staging, reuse, wallet-auto-load, and fail-exit paths were all exercised on this run. This
re-confirms SECURITY-AUDIT-v3.md's original 6/6-rejecting + honest-sell record (2026-06-04) against
Core v3.1.1 — so this is no longer a matrix the auditor must re-stage from scratch; re-running the
wrapper reproduces it. Note this remains a **regtest**, single-genesis re-run, not a public-testnet
soak — the soak (`TESTNET-SOAK-PLAN.md`, §8) still exercises the sell path across varied pools.

---

## 7. Contract entry-point quick reference

`RadiantMMPool`:
- `trade()` — permissionless. Enforces pairing, code+state continuity ×2, `$poolRef` singleton,
  `$tokenRef` presence, dust, positivity, overflow guard, fee, and `kOut ≥ kIn`.
- `withdraw(pubkey pk, sig s)` — owner-only (`hash160(pk) == ownerPkh && checkSig`). Removes RXD. R3.

`RadiantMMToken` (one code, role selected by state section):
- `transfer(pubkey, sig)` — holder move; `hash160(pk) == embeddedPkh`; conservation + escape-prevent.
- `release()` — no signature; valid **only** if the genuine controller (`refType($poolRef) == 2`) is
  co-spent and the UTXO is at input index 1; conservation + escape-prevent. `refType` (runtime) is
  used deliberately instead of `requireInputRef` so the static ref-induction scanner does not force
  `$poolRef` onto ordinary holder transfers (which would break free wallet-to-wallet transfers).
- `burn(pubkey, sig, int burnAmount)` — holder-signed supply reduction; `inTok − burnAmount == outTok`.

---

## 8. Open assumptions, limitations & gaps (read this)

**Gaps where "verified" is weaker than it sounds — disclose to the auditor:**

1. **Sell-side matrix — now automated and re-run (2026-06-10).** §6.3. Previously this matrix stood
   on the 2026-06-04 record only; the 2026-06-09 pass left the datadir at genesis and did not re-run
   it. `tools/soak/run-sell-matrix.sh` (commit `c77f553`) now stages the post-buy pool and runs the
   matrix in one step, and it was re-run **7/7 (six rejects + honest sell)** on /tmp/rmm-regtest
   against Core v3.1.1 on 2026-06-10 — so this gap is closed by tooling: the auditor re-runs the
   wrapper rather than hand-staging. Residual: that re-run is regtest + single-genesis, so
   public-testnet sell-path coverage still belongs to the soak (gap 3, `TESTNET-SOAK-PLAN.md`).
2. **`fee-min` boundary is computed, not separately fuzzed.** The matrix uses the analytically
   minimal `Tp` (`TpMin = ceil(R·T / effRxdOut)`) for both `valid` and `fee-min`; it confirms the
   K-boundary accepts at the minimum and rejects one below (`fee-underpay`), but does not fuzz a band
   of near-boundary values or rounding edge cases across many `(R,T,Δ)`. Worth property-based fuzzing.
3. **Single (R,T) regtest vector.** The on-chain matrix runs against one genesis (R=1,000,000 sat,
   T=100,000). The math is exercised across more vectors in vitest (`tests/v3-math.test.ts`), but the
   *contract* is not run on-chain across a spread of reserve ratios, large/small Δ, or near the R4
   overflow bound. The soak plan (`TESTNET-SOAK-PLAN.md`) addresses this with varied pools.
4. **Compiler trust.** Consensus runs the compiled artifact, not the `.rxd`. We checked the artifact
   has the expected opcodes (2× state-continuity, no 2MUL/2DIV), but a full audit should diff the
   artifact ASM against the source semantics line-by-line and ideally recompile with a pinned
   `rxdc` and confirm byte-identical output. The RadiantScript compiler itself has a documented
   MUL/DIV-lowering history (see repo memory `radiantscript_muldiv_bug`); confirm independently.
5. **Owner custody (R3) is unmitigated by design.** Any value added to a pool is recoverable by the
   owner. This is a product decision, not a bug, but it means **the pool is not trustless for
   liquidity providers**. If the audit's mandate is "permissionless AMM", this is a blocker until an
   LP-share covenant exists.
6. **R4 cap (~9e15) limits pool size.** Pools needing `R·T > 2^53−1` require 128-bit contract math
   that does not exist yet; `buildGenesis` rejects them. Confirm no honest large-pool path silently
   truncates.
7. **Environment specificity.** Harness paths are absolute and assume this developer's machine and a
   specific node build. Reproduce on a clean box to rule out path/version coupling.

**Assumptions inherited from Radiant consensus (treated as trusted):** native introspection opcode
semantics (`codeScript`/`stateScript`/`value`/`outpoint*`), coloured-satoshi value conservation,
singleton-ref enforcement, and `refType`/`refOutputCount` correctness. A compromise of any of these
invalidates the contract's safety argument and is out of this package's scope.

---

## 9. Pointers

- Full red-team write-up with the live pre-fix exploit txids: `SECURITY-AUDIT-v3.md`.
- Design rationale (C1/C2 redesign): `docs/REDESIGN_C1_C2.md`, `docs/CONTRACT_SPEC.md`.
- Regtest harness usage: `tools/regtest/README.md`.
- Testnet soak plan + monitor script: `docs/TESTNET-SOAK-PLAN.md`, `tools/soak/`.
- The fix commit for R1/R1b/R2 (contract + artifact): `618d728`
  (*fix(v3): close critical reserve state-hijack drain (R1) + harden pool continuity*).
- The harness diagnostic fix so state-hijack/brick reject at the script level: this branch
  (`docs/audit-prep-and-soak`), `test(v3): fix trade-adversarial token-code …`.
