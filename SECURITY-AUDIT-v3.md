# RadiantMM v3 Security Audit & Red-Team

**Date:** 2026-06-04
**Scope:** the **v3 paired-UTXO CPMM** — `contracts/v3/RadiantMMPool.rxd`, `contracts/v3/RadiantMMToken.rxd`, their compiled artifacts in `contracts/v3/artifacts/`, the v3 SDK under `src/v3/`, and the regtest harnesses under `tools/regtest/`.
**Method:** static review of the compiled bytecode (consensus is what runs, not the `.rxd` source) + **live exploitation on a regtest node** (`/tmp/rmm-regtest`, Radiant-Core v3.0.0, block 138+).
**Note:** the older `SECURITY-AUDIT.md` reviews the **v1** single-UTXO design (commit `8661256`) and is now historical; it does **not** describe the v3 contracts deployed here.

## Verdict

**All identified issues fixed and re-verified on regtest; still gated on an external audit + testnet soak before mainnet funds.** v3 fixed the v1 criticals (real coloured-satoshi reserves, code-only continuity, outpoint pairing). This pass found and fixed a new **critical, fully-exploitable fund-loss bug** (R1): the controller did not constrain the *state* of the recreated pool outputs, so any unprivileged user could seize the entire token reserve for a transaction fee — **proven on-chain** (txids below), then closed by pinning code **and state** continuity on both pool UTXOs. The exact exploit is now rejected at script verification, with the full buy/sell adversarial matrix (21 cases) re-validated green and no regression to honest buy/sell/transfer. See [Fixes applied & verification](#fixes-applied--verification).

---

## Severity summary

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| **R1** | 🔴 **Critical** | Reserve **state hijack** — controller checked code-only continuity on output[1], never its state → entire token reserve drainable for free | **FIXED** — code+state continuity; exploit proven, then re-proven rejected |
| **R1b** | 🟠 High | Symmetric **controller brick** — output[0] could be recreated stateful (same code), freezing all future dispatch (permanent RXD freeze) | **FIXED** — output[0] state pinned (anti-brick) |
| R2 | 🟠 High | `input[1]` read as the reserve (`tokIn = inputs[1].value`) without verifying it carries `$tokenRef`; safety rested on outpoint-pairing induction that R1 broke | **FIXED** (induction restored: reserve code+state pinned each hop from genesis) |
| R3 | 🟡 Medium | Custodial trust: `withdraw()` lets the single owner remove **all** RXD with one signature — no LP-share accounting, timelock, or multi-LP model | **Disclosed** in contract header + here (by design) |
| R4 | 🟡 Medium | K overflow guard caps `R·T ≤ 2^53−1`; a pool funded past that is permanently **untradeable** (liveness DoS / hard size cap) | **Mitigated** — `buildGenesis` rejects out-of-range reserves; documented |
| R5 | ⚪ Low | Stale `SECURITY-AUDIT.md` (describes v1); legacy `src/*.ts` + `contracts/RadiantMMPool.{rxd,script}` (unsafe v1) remain in-tree | **Addressed** — v1 files banner-marked UNSAFE; old audit redirects here |
| R6 | ⚪ Low | SDK ↔ harness drift: reserve deployed **stateful** by the SDK but **bare** by some harnesses; the inconsistency masked the gap in tests | **Addressed** — `trade-adversarial.cjs` aligned to stateful marker (bare now correctly rejected) |

---

## 🔴 R1 — Reserve state hijack (entire token reserve drainable for free)

**Location:** `contracts/v3/RadiantMMPool.rxd:52-64` → compiled `contracts/v3/artifacts/RadiantMMPool.json`
The controller's `trade()` enforces continuity on the token-reserve output with **code only**:

```
OP_1 OP_CODESCRIPTBYTECODE_OUTPUT  OP_1 OP_CODESCRIPTBYTECODE_UTXO  OP_EQUALVERIFY   // outputs[1].codeScript == inputs[1].codeScript
```

`OP_CODESCRIPTBYTECODE_*` returns only the bytes **after** `OP_STATESEPARATOR`. The controller contains **no** `OP_STATESCRIPTBYTECODE_OUTPUT` and never reads output[1]'s state (verified by grep of the artifact: 2× `OP_CODESCRIPTBYTECODE_OUTPUT`, **0×** `OP_STATESCRIPT*_OUTPUT`).

Every token UTXO shares one code, `OP_DROP <tokenAsm>`, **independent of its state section**. So an attacker can recreate output[1] with:
- the **same code** (`OP_DROP <tokenAsm>`) → passes code-only continuity, and
- a **state of their choosing** (`<attackerPkh>` instead of the 20-zero `RESERVE_MARKER`) → turns the pool reserve into an ordinary **holder UTXO the attacker owns**.

The token contract's `release()` path (which moves the reserve) only enforces value **conservation** and code/ref counts — it does **not** constrain output states either. And the constant-product check is trivially satisfied by a **no-op trade**: set `rxdOut = rxdIn` (fee = 0) and `tokOut = tokIn`, so `K_out = R·T = K_in`.

### Attack transaction
```
in [0] controller (genesis:0)  scriptSig = OP_0   (trade)
in [1] reserve    (genesis:1)  scriptSig = OP_1   (release)
in [2] P2PKH funding (pays only the miner fee)
out[0] controller'  = same code, value R           (faithful — keeps $poolRef singleton)
out[1] = <push attackerPkh> OP_STATESEPARATOR OP_DROP <tokenAsm>,  value T   ← SEIZURE
out[2] RXD change to attacker
```
All controller checks pass (pairing, code continuity ×2, `$poolRef` singleton, `$tokenRef` ≥ 1, dust, K). The attacker now owns output[1] = the full token reserve, then spends it with their own signature via `transfer()` — no pool needed.

### Proof (live, regtest — all confirmed)
| Step | txid | Result |
|------|------|--------|
| Genesis (R=1,000,000 sat RXD, T=100,000 tokens, reserve state = 20-zero marker) | `071b6346…2af22ad8` | mined |
| **Attack** (out[1] state = attacker pkh `9e3d8ada…`, value 100,000) | `0dfb703e…2fa38a85` | **ACCEPTED** ✅ |
| Cash-out (`transfer()` with attacker key, **no pool input**) → 100,000 `$tokenRef` tokens to a fresh attacker holder | `9d522a48…9e863c2f` | **ACCEPTED** ✅ |

Reproduce: `tools/regtest/trade-attack-state-hijack.cjs` (broadcast `ATTACK_HEX`, then `… cashout <ATTACK_TXID>`). The existing `trade-adversarial.cjs` misses this: its `code-reserve` variant uses the *wrong* code (rejected by continuity); **no** variant recreates output[1] with the *correct* code and a *different state*.

**Impact.** Complete loss of the token side of every pool, by any user, at fee-only cost. The RXD side is left stranded (the controller's paired reserve is now spent away), recoverable only by the owner via `withdraw()`.

### Fix
Bind the reserve output's **identity**, not just its code. Either is sufficient; (a) is the minimal change:

- **(a) Full-bytecode (code+state) continuity on the reserve.** Add
  `require(tx.outputs[1].stateScript == tx.inputs[1].stateScript);`
  (`OP_STATESCRIPTBYTECODE_OUTPUT` == `..._UTXO`). The reserve state is always the marker and never legitimately changes, so this never produces a false rejection, and it pins output[1] to the marker — the attacker's holder state is rejected. (Value still varies freely; `nValue` is not part of the locking bytecode.)
- **(b) Reserve-identity singleton.** Carry a singleton `$reserveRef` in the reserve and require `tx.outputs.refOutputCount($reserveRef) == 1` with it on output[1]. This additionally closes R2 (proves input[1] is *the* reserve).

After the fix, re-run the full adversarial matrix **plus** the new `trade-attack-state-hijack` variant and confirm rejection on buy **and** sell.

---

## 🟠 R2 — Reserve input identity rests on induction that R1 breaks

`trade()` reads `tokIn = tx.inputs[1].value` and never verifies input[1] carries `$tokenRef` or uses the token code. Soundness depends purely on the outpoint-pairing chain (input[1] = vout 1 of the controller's creating tx) holding by induction from an honest genesis. R1 breaks that chain (output[1] becomes an attacker holder), after which `inputs[1].value` is no longer a guaranteed token quantity. Fix (b) above (reserve-identity singleton) closes this directly; fix (a) restores the induction by pinning the reserve state each hop.

## 🟡 R3 — Custodial trust model

`withdraw(pk, s)` releases the **entire** RXD reserve to whoever holds `ownerPkh`'s key, with no LP-share token, timelock, or quorum. There is no multi-LP liquidity model — this is a **single-custodian** pool. Anyone providing value to it must trust the owner not to rug. Disclose prominently; consider an LP-share covenant before calling this a permissionless AMM.

## 🟡 R4 — Overflow guard is also a hard size cap

The guard `rxdIn ≤ (2^53−1)/tokIn` (and the symmetric `effRxdOut ≤ (2^53−1)/tokOut`) keeps `R·T ≤ 2^53−1 ≈ 9.0e15`. The bound exists because a `2^63−1` literal mis-encodes to a 9-byte (out-of-range) script number (see `radiantscript_muldiv` notes). Consequence: a pool whose `R·T` exceeds ~9e15 (e.g. ~95M RXD against ~95M tokens, or any skewed equivalent) can **never trade** — every `trade()` aborts at the guard. Large pools need 128-bit intermediate math (split-limb `R·T`), not a single `OP_MUL`. Until then, document the cap and reject genesis params that exceed it.

## ⚪ R5 — Stale audit + unsafe legacy artifacts in-tree

`SECURITY-AUDIT.md` documents the v1 design and reads as the repo's audit of record. The v1 `contracts/RadiantMMPool.{rxd,script}` (unbacked-integer reserves, C1) and the legacy `src/*.ts` trade/pool/price modules remain present and importable. Quarantine or delete them, and make `SECURITY-AUDIT-v3.md` the authoritative document, so the broken v1 can't be deployed by mistake.

## ⚪ R6 — SDK ↔ harness deployment drift

`src/v3/builder.ts` builds the reserve as `buildStatefulOutput(RESERVE_MARKER, tokenCode)` (stateful); some attack harnesses build it as bare `tokenCode`. Both satisfy the controller's code-only continuity — which is precisely the surface R1 exploits. Pick one canonical reserve encoding and assert it in tests, then add the R1 variant so the gap can't regress.

---

## Carried-over status (informational)

The v1 SDK bugs H1 (state parser scanned `0xbd`) and H2 (sell-path double-count) were fixed earlier and have regression tests. The v3 math (`src/v3/math.ts`) is a faithful replica of the contract's accept criterion and reconciles to the on-chain fee/reserve vectors. None of that mitigates R1, which lives in the contract.

## Fixes applied & verification

**Fix (chosen: full code+state continuity on both pool UTXOs).** `contracts/v3/RadiantMMPool.rxd` `trade()` now requires, in addition to code continuity:
```
require(tx.outputs[0].stateScript == tx.inputs[0].stateScript);  // controller stays bare (anti-brick, R1b)
require(tx.outputs[1].stateScript == tx.inputs[1].stateScript);  // reserve marker state preserved (R1)
```
The reserve state is always the 20-zero marker and the controller is always bare, so this never rejects an honest trade; the token **amount** still varies freely (nValue is not part of the scriptPubkey). This also restores the induction that closes R2 (each hop pins the reserve's code **and** state, so `inputs[1]` is provably the genuine `$tokenRef` reserve). Recompiled with the fixed `rxdc` (`@radiantscript/rxdc` HEAD `7d11a8a`, the MUL/DIV-lowering fix) — the new artifact has `OP_MUL`/`OP_DIV` (not `OP_2MUL`/`OP_2DIV`) and 2× `OP_STATESCRIPTBYTECODE_OUTPUT`. `tx.outputs[i].stateScript` is a first-class compiler construct → `OP_STATESCRIPTBYTECODE_OUTPUT` (0xec), which radiantjs `Script.fromASM` inlines.

**Other fixes.** R4: `src/v3/builder.ts` `buildGenesis` now rejects `R·T > 2^53−1` (and sub-dust / non-positive reserves) so an untradeable pool can't be minted (unit tests in `tests/v3-builder.test.ts`). R3: trust model disclosed in the contract header. R5: v1 `contracts/RadiantMMPool.{rxd,script}` banner-marked **UNSAFE — DO NOT DEPLOY**, and `SECURITY-AUDIT.md` redirects here. R6: `tools/regtest/trade-adversarial.cjs` deploys the reserve as the stateful marker (matching the SDK), and gained `state-hijack` + `brick` variants.

**Regtest re-validation (same local v3.0.0 node).** Fresh genesis on the fixed artifact, then:

| Case | Pre-fix | Post-fix |
|------|---------|----------|
| **R1 state-hijack** (the exact exploit `0dfb703e…`, byte-for-byte) | ACCEPTED ❌ | **REJECTED** ✅ `Script failed an OP_EQUALVERIFY operation` — the added state-continuity check, the only contract change |
| **R1b controller-brick** (stateful out0) | ACCEPTED ❌ | **REJECTED** ✅ |
| Buy adversarial matrix (fee-underpay, k-violation, code-ctrl, code-reserve, strip-pool, layout, dust-rxd, zero-token, dup-pool) | REJECTED | **REJECTED** ✅ (all 9) |
| Honest **buy** | ACCEPTED | **ACCEPTED** ✅ (no regression) |
| Sell adversarial matrix (theft-sig, holder-release, reserve-xfer, no-token-add, code-reserve, strip-pool) | REJECTED | **REJECTED** ✅ (all 6) |
| Honest **sell** | ACCEPTED | **ACCEPTED** ✅ (no regression) |
| Free wallet→wallet **transfer** (no pool) | ACCEPTED | **ACCEPTED** ✅ (transferability preserved) |

21/21 expected outcomes. Driver: `/tmp/rmm-validate.sh`; the standalone exploit + its cash-out path remain in `tools/regtest/trade-attack-state-hijack.cjs`. SDK: `tsc --noEmit` clean, `vitest` 50/50.

The standalone PoC is the clean isolation of the fix — it is the *byte-for-byte* tx that drained the pool pre-fix, so its post-fix `OP_EQUALVERIFY` failure is attributable solely to the added state check. The `trade-adversarial.cjs` `state-hijack`/`brick` variants are also rejected, but at Radiant's earlier ref-operations consensus gate (`bad-txns-…-reference-operations`) due to that harness's different change/output shaping — still a correct rejection for the matrix, just not the script-level isolation the standalone PoC gives.

## Remaining before mainnet

1. **External audit + testnet soak** — fund-safety is not solo-certifiable; this is the one true blocker left.
2. **128-bit K math** if pools larger than `R·T = 2^53−1` are ever needed (currently rejected at genesis, R4).
3. Decide whether the single-custodian trust model (R3) is acceptable or an LP-share covenant is required before calling this a permissionless AMM.
