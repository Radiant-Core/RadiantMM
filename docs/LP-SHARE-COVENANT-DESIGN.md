# RadiantMM v3 — LP-Share Covenant Design (RPL-LP)

**Status:** Design / synthesis. Supersedes the three R3-fix drafts (LP-FT-V2, NFT-v4, RatioLock-LP).
**Replaces:** `RadiantMMPool.withdraw()` (finding R3, single-custodian rug).
**Target node:** Radiant-Core v3.1.1. **Compiler:** RadiantScript ^1.1.0 (MUL/DIV lowering fix on `main`).

> Provenance: produced by a 17-agent design workflow (4 constraint readers → 3 independent designs →
> 9 adversarial judges → synthesis). The three submitted designs scored 4.7 / 4.7 / 4.0 of 10 — all
> failed the security lens on one shared root cause (below). This doc is the synthesized hybrid, not
> any single submission, and is **design-stage**: nothing here is implemented or verified on-chain yet.
> The Phase 0 spike (§13) is a blocking go/no-go gate before any further work.

---

## 0. Thesis in one paragraph

Three independent designs all tried to mint LP shares with Uniswap's `shares = dR·S/R`. That formula needs the **global circulating LP supply `S`**, and a UTXO covenant **cannot observe a global aggregate it does not co-spend**: `tx.inputs.refValueSum($lpRef)` (confirmed an INPUT-aggregate in `RadiantScript/.../Globals.ts`) sums only co-spent inputs, so a spender SETS `S` by choosing which of their own LP UTXOs to include — an unbounded drain on remove and a brick (S=0) on honest add. **RPL-LP refuses to read absolute supply anywhere.** It expresses every covenant check as a **value/ref delta** (the proven `Market.rxd` `split`/`merge` pattern, already in production) plus **one in-controller scalar** for the single place a share→reserve scale is unavoidable. LP shares become **value-accruing 1:1 claims**, not proportional supply fractions. Result: a trustless multi-LP pool that uses no opcode Radiant lacks.

---

## 1. What was salvaged, what was discarded

**Discarded (the shared fatal flaw):** any formula reading `S = refValueSum($lpRef)` as an absolute denominator (`dR·S/R`, `burned·R/S`). Forgeable input → drain + brick. All three drafts share this; it is unfixable as specified.

**Grafted from LP-FT-V2:** third co-spent **LP-anchor at vout 2** bound by outpoint pairing to `inputs[0]`'s txid; separate `$lpRef` + separate code group (no `codeScriptValueSum` collision with `$tokenRef`); runtime `refType($poolRef)==2` mint/burn gate (taint-safe, never `requireInputRef`); anti-DoS anchor-state re-pin every hop; `withdraw()`/`ownerPkh` deletion; the explicit per-multiply overflow-guard discipline.

**Grafted from RatioLock-LP:** **exact-ratio deposits** (`dT·R == dR·T`) — kills off-ratio skim AND removes the `min()`/`sqrt` requirement; the 546-photon anchor doubling as `MINIMUM_LIQUIDITY` dead-share lockup; pool-favorable rounding; the honest overflow ledger.

**Grafted from NFT-v4:** **one readable scalar in controller state** as the share denominator (read by `stateScript.split`, the `Market.rxd:127` idiom) instead of an unobservable supply sum; the **state SHAPE + version-byte pin on EVERY branch** to re-close R1b once the controller is stateful; fee-accrual-for-free observation.

**Grafted from RadiantSwap Market.rxd (the audited safe primitive):** **delta-pinning** — pin a ref-value delta to a co-spent value delta, never an absolute read. This is the load-bearing correctness mechanism.

---

## 2. Accounting model — value-accrual, not proportional supply

The covenant carries, in controller state, a single 8-byte integer **`shareTotal`** = total LP shares minted minus burned. It is mutated ONLY on add/remove and pinned `==` (frozen) on trade. It is the in-controller scalar (NFT-v4's idea); unlike a `refValueSum`, the covenant reads it directly and it is NOT spender-selectable. `shareTotal` is the trusted denominator, and the controller is the **sole authority that mutates it**, with every mutation consensus-pinned to a real reserve-value delta — so the controller cannot lie about its own supply across a hop.

Honest framing (see §11): we have NOT recovered free-fungible proportional shares; we have a **single stateful controller that is the authenticated bookkeeper of its own LP supply**, with every state transition covenant-pinned. That is trustless (no key can move funds outside the pinned rules) but is a weaker composability model than Uniswap LP tokens.

---

## 3. UTXO layout (canonical, enforced)

```
Every add/remove co-spends inputs 0,1,2; trade co-spends 0,1,2 (anchor pinned, supply frozen).
Genesis creates 0,1,2 (+ first LP holder).

  in/out[0] CONTROLLER     STATEFUL: ver(1)=0x01 || shareTotal(8 LE)   value=R   $poolRef (singleton)
  in/out[1] TOKEN RESERVE  state=RESERVE_MARKER (0x14||20 zero)         value=T   $tokenRef
  in/out[2] LP-ANCHOR      state=LP_MARKER     (0x14||20 zero)          value=546 $lpRef  [dead-share carrier, frozen]
  in   [3+] funding / LP holder UTXOs
  out  [3+] minted/returned LP holder UTXO, payouts, change
```

LP-anchor binding (extends the proven 2-slot pairing to a 3rd slot):
```
require(tx.inputs[2].outpointIndex == 2);
require(tx.inputs[2].outpointTransactionHash == tx.inputs[0].outpointTransactionHash);
require(tx.outputs[2].codeScript  == tx.inputs[2].codeScript);
require(tx.outputs[2].stateScript == tx.inputs[2].stateScript);   // LP_MARKER re-pin (anti-DoS, Market.rxd:52-56)
require(tx.outputs[2].value       == tx.inputs[2].value);         // 546 frozen
```

---

## 4. State byte-layout

**Controller (now stateful, fixed 9-byte shape):**
```
state = 0x01(ver) || shareTotal(8 LE)
deployed as:  <state-push> OP_STATESEPARATOR OP_DROP <controllerCode>   (OP_DROP prologue, Market idiom)
read:  bytes payload = inputs[0].stateScript.split(1)[1];
       require(inputs[0].stateScript.split(1)[0] == 0x01);          // SHAPE+VER pin EVERY branch
       int shareTotal = int(payload.split(8)[0]);
       require(shareTotal > 0);                                     // negative-decode guard, IMMEDIATELY after split
```
**Token reserve:** `RESERVE_MARKER` = 20 zero bytes. Unchanged from v3.
**LP-anchor:** `LP_MARKER` = 20 zero bytes. No key hashes to it → can't be dragged onto signed `transfer()/burn()`.
**LP holder UTXO:** `<20-byte lpHolderPkh>` (standard holder), code = `LpShareToken`.

---

## 5. Mint / burn math (delta-pinned, no absolute-supply read)

Definitions inside any branch (all observable):
```
R  = inputs[0].value ;  Rp = outputs[0].value
T  = inputs[1].value ;  Tp = outputs[1].value
dR = Rp - R ;  dT = Tp - T
S0 = shareTotal_in (from inputs[0] state)   // trusted in-controller scalar, NOT a sum
S1 = shareTotal_out (from outputs[0] state)
mintedDelta = outputs.refValueSum($lpRef) - inputs.refValueSum($lpRef)   // DELTA, invariant to passthrough
burned      = inputs.refValueSum($lpRef) - outputs.refValueSum($lpRef)   // DELTA, anchor cancels
```

### addLiquidity (mint) — selector 1
```
require(dR > 0); require(dT > 0); require(Rp >= 546);
require(dR <= MAX / T); require(dT <= MAX / R);          // overflow guards before ratio mul
require(dT * R == dR * T);                                // EXACT RATIO (no skim, no min())  [see §11.3 for min()-credit v1.1]
require(dR <= MAX / S0);                                  // overflow guard before dR*S0
int dS = dR * S0 / R;                                     // floor; depositor never over-credited
require(dS > 0);
require(S1 == S0 + dS);                                   // pin the controller's own supply mutation
require(mintedDelta == dS);                               // pin the ref-value DELTA == covenant-computed dS  (Market.rxd:61 idiom)
require(Rp <= MAX / Tp);                                  // mint-time K guard: an add can never push R*T past trade's cap (trade-freeze fix)
require(Rp <= MAX / S1);                                  // grow-to-unexitable guard (R*S1<=MAX keeps positions exitable)
// + anchor/singleton pins from §3
```
**Why safe where the drafts were not:** `S0` is read from the **singleton controller's pinned state**, not a co-spend-selectable sum; only one controller exists. `mintedDelta` is a refValueSum DELTA: passthrough LP inputs cancel. The unobservable global-supply quantity appears nowhere.

### removeLiquidity (burn) — selector 2
```
require(burned > 0); require(burned <= S0);
require(burned <= MAX / R); require(burned <= MAX / T);   // overflow guards
int dRmax = burned * R / S0;                              // floor toward pool
int dTmax = burned * T / S0;
require(R - Rp <= dRmax); require(T - Tp <= dTmax);       // LP cannot over-withdraw
require(R - Rp > 0); require(T - Tp > 0);                 // INSUFFICIENT_LIQUIDITY_BURNED
require(Rp >= 546); require(Tp > 0);                      // anti-drain-to-unspendable
require(S1 == S0 - burned);                               // pin supply mutation
require(S1 >= 1000);                                      // MINIMUM_LIQUIDITY floor -> no genesis-reset hole
```
**Fee accrual is automatic:** trade()'s K-non-decrease grows `R`/`T` while `shareTotal` is frozen, so `dRmax = burned·R/S0` reads the GROWN reserve — LPs withdraw fees pro-rata with no fee-claim path.

### trade — selector 0
Byte-identical K math (RadiantMMPool.rxd:86-117), PLUS anchor pinning (§3) and the state freeze:
```
require(outputs[0].stateScript == inputs[0].stateScript);            // freezes shareTotal + shape
require(outputs[0].stateScript.split(1)[0] == 0x01);                 // explicit version assert
require(outputs.refValueSum($lpRef) == inputs.refValueSum($lpRef));  // supply unchanged on a trade
```
**Honest note:** trade() is NOT byte-identical — the controller is now stateful (OP_DROP prologue) and gains anchor pinning + the version assert. The K sub-block is verbatim. Unavoidable for any multi-LP design.

---

## 6. Worked numbers

Seed (rule A, sqrt-free): `R0 = T0 = 1,000,000`. `shareTotal = 1,000,000`. Dead anchor = 546 (LP_MARKER, frozen). First LP holder receives `1,000,000 - 1000` = 999,000 shares; 1000 minted to a provably-dead OP_RETURN lockup (MINIMUM_LIQUIDITY).

**Add 10% at ratio:** `dR = 100,000`. Exact ratio: `dT·R == dR·T` → `dT·1e6 == 1e5·1e6` → `dT = 10,000` ✓. `dS = dR·S0/R = 100000·1000000/1000000 = 100,000`. Guards pass. New: `R=1.1M, T=110k, shareTotal=1.1M`. Depositor holds `100000/1.1M = 9.09%` ✓. `mintedDelta == 100000` pins issuance.

**Trade grows fees:** trades push `R → 1,210,000`, `T → 110,000`, `shareTotal` frozen at `1.1M`.

**Burn the 100,000-share position:** `burned = 100,000`. `dRmax = 100000·1,210,000/1,100,000 = 110,000`; `dTmax = 100000·110,000/1,100,000 = 10,000`. LP receives **110,000 RXD** (10,000 RXD fee earned) + 10,000 tokens. `shareTotal → 1,000,000` ✓.

**Off-ratio grief rejected:** `dR=100,000, dT=5,000`: `dT·R = 5e9 ≠ dR·T = 1e10` → reject.

**Rounding favors pool:** `R=1,000,001, burned=3, S0=7` → `dRmax = 428,571` (truncated from 428,571.857); the 0.857 photon stays in the pool. Theft-negative.

---

## 7. Overflow analysis vs 2^53-1, stacked on the existing K product

`MAX = 9_007_199_254_740_991` (2^53-1). The literal cap is `MAX`, NOT 2^63-1 (a 2^63-1 literal mis-encodes to 9 bytes and OP_DIV fails — confirmed RadiantMMPool.rxd:98-100 and math.ts). Radiant arithmetic is signed int64 with HARD overflow-FAIL (`safeMul`); every NEW multiply is guarded `a <= MAX/b` IMMEDIATELY before the product → an oversized op REJECTS, never wraps.

```
 product            ~magnitude   guard                       status vs existing K (R*T<=MAX)
 R * T (trade)       R*T          R <= MAX/T   (existing)     SAFE, == K cap
 dT*R, dR*T (ratio)  ~R*T         dR<=MAX/T, dT<=MAX/R        SAFE-ish, == K bound
 dR * S0 (mint)      ~R^2         dR <= MAX/S0                CAN EXCEED MAX when R>>T  (KILLER)
 burned*R (burn)     ~R^2         burned <= MAX/R             CAN EXCEED MAX (asymmetric pool)
 burned*T (burn)     ~R*T         burned <= MAX/T             SAFE-ish, == K bound
```

**The binding constraint (honest):** because `shareTotal ~ O(R)`, the mint/burn products are `O(R^2)` and exceed `MAX` BEFORE trade's `R·T` does whenever `R >> T`. Keeping ALL of `R^2, R·S0, burned·R, R·T` ≤ MAX forces `max(R,T) ≤ sqrt(MAX) ≈ 9.49e7` photons (~0.95 RXD/leg) for full-range ops. **The existing K cap does NOT imply the LP products are safe** — `R=1e8, T=1e7` gives `R·T=1e15<MAX` but `burned·R` up to `S0·R ≈ 1e16 > MAX`.

**This is a FUND-SAFETY boundary, not a sizing nicety:** a pool that trades into `R·S0 > MAX` makes large positions **un-exitable**. Defenses:
1. **v1 (bounded pools):** per-multiply guards (reject, never wrap) + a documented genesis pool cap so `R·S0, R·T ≤ MAX`. Plus the **mint-time `Rp·Tp ≤ MAX` guard** (the trade-bricking fix the FT-V2 math judge found: without it a legitimate add pushes K past trade()'s cap and freezes ALL trading) AND the **mint-time `R·S1 ≤ MAX` reject** so a pool can never be grown via small adds into an unexitable state (the NFT math judge's `dR·S` vs `R·S` correction).
2. **v2 (production, P0 not deferred):** 128-bit split-limb mul-then-div for `dR·S0/R`, `burned·R/S0`, `burned·T/S0` only — `OP_MUL` on 32-bit limbs + `OP_CAT/OP_SPLIT/OP_NUM2BIN/OP_BIN2NUM`. No new opcode; the single biggest implementation risk. Until it lands, pools MUST be capped at genesis to the exitable envelope.

**Division safety:** all OP_DIV truncate toward zero, rounded so dust favors the pool. Div-by-zero is impossible: `S0 = shareTotal ≥ 1000 > 0` on every post-genesis branch; first mint is a separate genesis branch with no `/R` or `/S0`. The negative-decode trap is closed by `require(shareTotal > 0)` IMMEDIATELY after every `split` read, before any comparison.

---

## 8. Security model

1. **First-depositor / share-inflation (ERC-4626 class).** (a) `MINIMUM_LIQUIDITY = 1000` dead shares to a provably-unspendable lockup so `shareTotal` is never tiny; (b) **exact-ratio deposits** make one-sided donation-into-pool impossible; (c) share math reads REAL `R = inputs[0].value`, not a donatable balance; (d) no raw-transfer-into-reserve path (reserve marker moves only under release()/controller). NOTE: 1000 dead shares is `~1e-6` of a 1e9-photon seed — a floor against `shareTotal→1`, NOT a sqrt(k)-scaled inflation defense. The real inflation defense is the exact-ratio rule + internal accounting (the FT-V2 judge correctly flagged a fixed 1000 alone is too small; we do not rely on it alone).

2. **Forged-supply drain (the flaw that killed all three drafts).** `S0` is read from the **singleton controller's pinned state**, not `refValueSum($lpRef)`. Exactly one controller (`$poolRef` singleton, `refOutputCount==1`), so no forged `S0`. Every mutation pinned `S1 == S0 ± delta` AND `mintedDelta/burned == delta`. The unobservable-global-supply quantity is gone.

3. **Share forgery / inflation mint.** A valid-code LP share is minted ONLY via `vaultMove()` gated on `refType($poolRef)==2` AND `LP_MARKER`; controller pins `mintedDelta == dS` with `dS` from REAL reserve growth (`dR>0`). A share born in any other tx has no controller pin and is never counted in `shareTotal`. (This is where NFT-v4 failed feasibility — per-output `refType` does not exist; RPL-LP uses tx-wide `refType` + delta pin, which is real.)

4. **Reserve drain via shrunk denominator (the RatioLock drain).** Impossible: denominator is trusted `S0`, not a co-spend-selectable sum. `removeLiquidity` bounds payout ABOVE by `burned·R/S0`, requires `burned ≤ S0`, `Rp ≥ 546`, `Tp > 0`.

5. **Off-ratio drain.** `require(dT·R == dR·T)` rejects non-proportional deposits.

6. **Brick (R1b).** Controller is now stateful → bare-controller pin replaced by **state SHAPE + version-byte pin on EVERY branch**; trade()'s `stateScript==stateScript` freezes `shareTotal` and shape. Anchor + reserve markers re-pinned every hop. `removeLiquidity` requires `S1 ≥ MINIMUM_LIQUIDITY` so the pool can never be drained to a re-bootstrappable empty state (the NFT brick/reset finding).

7. **Ref-substitution / decoy anchor.** Outpoint pairing binds `inputs[2]` to `inputs[0]`'s txid at vout 2; `$poolRef` singleton prevents forking; anchor value frozen.

8. **Ref-induction taint on free LP transfers.** `vaultMove()` uses RUNTIME `refType($poolRef)==2`, NEVER static `requireInputRef` (GetPushRefs scanner is flat/control-flow-blind). Verified verbatim against RadiantMMToken.rxd:62-69 and ShareToken.rxd:54.

9. **Independent conservation backstop.** `LpShareToken` uses `codeScriptValueSum`/`codeScriptCount` (confirmed Globals.ts) so the LP token's movement is conserved on transfer/burn — the controller is NOT the sole pin (the defense-in-depth RatioLock lost).

10. **Rounding theft.** All divisions floor toward the pool; `require(dS>0)`, `require(payouts>0)`, dust floors. Tiny ops leak value INTO the pool; relay fee makes grinding net-negative.

11. **Quote/execution consistency.** `S0`, `R`, `T` are read from the singleton controller's pinned state/value, so a front-runner cannot change realized `dS` by altering co-spent LP inputs — a strict improvement over the FT-V2 quote-griefing hazard.

---

## 9. Preserving R1 / R1b / R2

- **R1 (state pin):** preserved and extended; every pool UTXO pins BOTH code and state across every hop. The controller's state is now non-empty but is pinned by SHAPE+version on every branch and frozen on trade — the R1 reserve-hijack and the R1 controller-state-bolt brick are both still closed.
- **R1b (anti-brick):** generalized from "controller stays bare" to "controller keeps a fixed 9-byte shape"; no branch can reshape or add an unexpected state section.
- **R2 (reserve isolation by outpoint pairing):** preserved verbatim for the token reserve at index 1, extended identically to the LP-anchor at index 2.

---

## 10. Contract changes

- **`RadiantMMPool.rxd`:** DELETE `withdraw(pubkey,sig)` and `ownerPkh` (closes R3). ADD `$lpRef`. Controller becomes STATEFUL (OP_DROP prologue, 9-byte `ver||shareTotal`). ADD `addLiquidity` (sel 1), `removeLiquidity` (sel 2); `trade` (sel 0) K math verbatim + anchor pin + state freeze + version assert + supply-unchanged pin + mint-time guards. New code hash → new pool version (not in-place upgradeable).
- **`RadiantMMToken.rxd`:** UNCHANGED.
- **NEW `LpShareToken.rxd`:** clone of `ShareToken.rxd` with `$lpRef`/`$poolRef`; `transfer`/`burn` sig + `codeScriptValueSum` conservation; `vaultMove` keyless, `LP_MARKER` + runtime `refType($poolRef)==2`, controller pins the exact delta.
- **SDK (`v3/contracts.ts`, `v3/builder.ts`, `v3/math.ts`):** `buildGenesis` takes a 3rd funding outpoint (induces `$lpRef`), emits triple + 1000 dead shares + first-LP shares + initial `shareTotal`. ADD `buildAddLiquidity`/`buildRemoveLiquidity`. Extend `math.ts` with byte-consistent `verifyAddLiquidity`/`verifyRemoveLiquidity` mirrors incl. exact-ratio integer feasibility.

---

## 11. Upgrade & limitations (do not gloss)

1. **Not Uniswap-fungible.** LP shares are claims on a single stateful controller that bookkeeps its own supply (covenant-pinned), not free-floating proportional fractions. Fully-fungible proportional LP shares remain **blocked on a missing primitive** (global ref totalSupply read).
2. **int64 envelope is a fund-safety boundary.** v1 pools MUST be capped at genesis so `R·S0 ≤ MAX` (≈ legs ≤ 0.95 RXD for full-range ops). **128-bit limb math is P0**; until it lands, large positions can become un-exitable.
3. **Exact-ratio deposits are integer-constrained.** `dT·R == dR·T` has a small solution only when `dR` is a multiple of `R/gcd(R,T)`; after the ceiling fee drives `R,T` coprime, the minimum valid deposit can approach 100% of the pool (the RatioLock cliff). **Mitigation (recommended v1.1):** **min()-style credit** `dS = min(dR·S0/R, dT·S0/T)` so any over-supplied leg is donated (to all LPs, never extra shares) rather than rejected — keeps the delta-pin safety and restores usability. Ship exact-ratio for the audit, min()-credit for production.
4. **One liquidity op per block** (singleton-controller contention). Batcher deferred.
5. **trade() not byte-identical** — new pool version; fresh genesis or one-time owner-signed migration (final `withdraw` sig → new triple → `shareTotal=R0` to owner as LP #1), after which no signature bypass exists.
6. **Pool cannot be 100% drained** — MINIMUM_LIQUIDITY + dust floors park a permanent remnant. Acceptable.

---

## 12. Required regtest matrix (mirrors buy/sell matrices)

Positive: genesis(triple+dead+firstLP) → trade → addLiquidity(ratio) → trade(fees) → removeLiquidity(earns fees) → LP transfer → LP burn-on-remove.
Adversarial (ALL must REJECT): forged `shareTotal`, off-ratio deposit, over-mint (`mintedDelta > dS`), shrunk-denominator drain (must be inert — `S0` is in-controller), over-withdraw (`R-Rp > dRmax`), decoy/forged anchor, supply forgery (anchor value changed), drain-to-unspendable (`Rp<546` / `S1<MIN_LIQ`), K-freeze (add that pushes `R·T>MAX`), grow-to-unexitable (`R·S1>MAX`), per-multiply overflow, static-ref-taint regression (LP wallet transfer must NOT require `$poolRef`), trade-mutates-shareTotal, trade-strands-anchor.

---

## 13. Implementation plan

### Phase 0 — Spike & primitive proof (BLOCKING GATE) — ✅ PASSED 2026-06-13
**Gate cleared. PASS 9/9 on Radiant-Core v3.1.x regtest** (`SecurityUpgradeHeight=0` → post-upgrade
semantics). Artifacts: `tools/regtest/spikes/` (`RplLpProbe.rxd`, `LpShareProbe.rxd`, `lp-spike.cjs`,
`README.md`). Proven: (a) stateful controller mutates+reads its own `shareTotal` across two
consecutive adds; (b) `outputs.refValueSum($lpRef) - inputs.refValueSum($lpRef) == dS` pinned, with
the co-spent anchor cancelling in the delta — over-mint and free-mint both REJECTED at the script
level; (c) keyless mint REJECTED without the controller (`refType($poolRef)==2`), while a plain LP
`transfer()` is ACCEPTED with no `$poolRef` co-spent (no static ref-induction taint). Plus the
LP-specific `dS = dR·S0/R` arithmetic verified on-chain at value-per-share = 2 (seeded `S0≠R`):
`dR=100,000 → dS=50,000`. One carry-forward finding: an existing LP *holder* cannot be co-spent via
`transfer()` in the same tx as a mint (the token's own conservation check forbids the supply growth)
— fine, since addLiquidity only ever mints to the depositor.

The original spike spec (now satisfied):
Regtest spike proving the THREE load-bearing primitives compose in one tx on Radiant-Core v3.1.1:
(a) stateful controller with 9-byte `ver||shareTotal` state mutated across a hop and read back via `stateScript.split`;
(b) `mintedDelta = outputs.refValueSum($lpRef) - inputs.refValueSum($lpRef)` pinned `== dS` while a passthrough LP holder UTXO is co-spent (prove the passthrough cancels — the Market.rxd safety property applied to LP shares);
(c) `vaultMove` keyless mint gated on runtime `refType($poolRef)==2`, with a sibling regression tx proving a plain LP wallet-to-wallet transfer does NOT require `$poolRef`.
Deliverable: `tools/regtest/spikes/RplLpProbe.rxd` + a `.cjs` broadcasting all three with accept/reject asserts. **GATE: if (b) cannot be made invariant to passthrough, the approach is dead — fail fast.**

### Phase 1 — Contracts
- `contracts/v3/LpShareToken.rxd`: clone ShareToken.rxd with `$lpRef`/`$poolRef`; `transfer`/`burn` (sig + `codeScriptValueSum` conservation), `vaultMove` (LP_MARKER + runtime refType + controller-pinned delta). Audit compiled asm: NO static `OP_REQUIREINPUTREF($lpRef)` in any pre-induction branch.
- `contracts/v3/RadiantMMPool.rxd` v4: delete `withdraw`/`ownerPkh`; add `$lpRef`; OP_DROP prologue + 9-byte state; branches `trade`(0, K verbatim + anchor pin + state freeze + version assert + supply-unchanged + mint-time `Rp*Tp<=MAX`), `addLiquidity`(1, §5 incl. `R*S1<=MAX`), `removeLiquidity`(2, §5 incl. `S1>=MIN_LIQ`). Every new multiply preceded by its `a<=MAX/b` guard; every state-int read followed immediately by `require(>0)`.
- Deliverable: both compile clean under RadiantScript ^1.1.0 from the MUL/DIV-fixed `main` (verify asm OP_MUL/OP_DIV not OP_2MUL/OP_2DIV); covenant-lint clean.

### Phase 2 — SDK
- `v3/math.ts`: `verifyAddLiquidity(R,T,dR,dT,S0)` + `verifyRemoveLiquidity(R,T,burned,S0,Rp,Tp)` — byte-consistent mirrors of every guard/floor + exact-ratio integer-feasibility helper. Add min()-credit variant behind a flag (limitation §11.3). Property-test: 200k randomized mixed add/remove/trade sequences asserting zero value leak, monotonic non-decreasing value-per-share, `sum(LP shares) == shareTotal` (zero drift), solvency never violated.
- `v3/contracts.ts`: `buildLpScripts`, `LP_MARKER`, 3rd-ref induction at genesis.
- `v3/builder.ts`: `buildGenesis` (triple + 1000 dead OP_RETURN shares + first-LP holder + `shareTotal=R0`); `buildAddLiquidity`; `buildRemoveLiquidity`. Never build a tx `verify*` would reject.

### Phase 3 — Regtest harness (mirror existing buy/sell matrices one-to-one)
- `tools/regtest/lp-genesis.cjs`, `lp-add.cjs`, `lp-remove.cjs`, `lp-transfer.cjs`.
- `tools/regtest/lp-adversarial.cjs`: the full §12 reject matrix (14 cases), each broadcast and rejected with the expected reason.
- `tools/soak/run-lp-matrix.sh` + extend `soak-monitor.cjs` to track `shareTotal` vs summed LP holder value across a long random walk (drift detector).

### Phase 4 — Overflow / 128-bit decision (P0, blocking production)
- Implement + regtest 128-bit split-limb mul-then-div for `dR*S0/R`, `burned*R/S0`, `burned*T/S0` (OP_MUL on 32-bit limbs + OP_CAT/OP_SPLIT/OP_NUM2BIN/OP_BIN2NUM). Deliverable: standalone `tools/regtest/spikes/Limb128Probe.rxd` proving a >2^53 product round-trips back to int64, then wire into the two LP branches. If deferred, v1 ships with a HARD genesis pool cap enforcing `R*S0<=MAX`, asserted in `buildGenesis` AND on-chain at genesis, labeled "bounded pools only".

### Phase 5 — Docs, migration, soak
- Update `docs/CONTRACT_SPEC.md`; add `docs/MIGRATION_R3.md` (owner-signed convert: final `withdraw` sig → new triple → `shareTotal=R0` to owner).
- Testnet soak: extend `docs/TESTNET-SOAK-PLAN.md` with an LP track (genesis → N random add/remove/trade over M blocks; monitor solvency + drift + exitability of the largest position). External audit gate before mainnet, same as RadiantMM v3.

### Test matrix summary (all pass before merge)
| Category | Cases |
|---|---|
| Positive | genesis, add(ratio), add(min-credit), remove(partial), remove(with fees), LP transfer, LP burn-on-remove, trade unaffected |
| Drain | shrunk-denominator (inert), over-withdraw, off-ratio, forged shareTotal, decoy anchor, supply forgery |
| Brick | trade-mutates-shareTotal, trade-strands-anchor, drain-to-unspendable, S1<MIN_LIQ, state-reshape |
| Overflow | K-freeze (R*T>MAX), grow-to-unexitable (R*S1>MAX), per-multiply reject, 128-bit round-trip |
| Taint | LP wallet transfer must NOT require $poolRef |
| Invariant (soak) | sum(LP shares)==shareTotal, monotonic value-per-share, solvency, largest-position always exitable |

---

## 14. Viability verdict (honest)

**PARTIAL** — trustless multi-LP IS achievable on Radiant today, but NOT the Uniswap-V2 proportional model the briefs reached for, and not at unbounded pool size.

- **Achievable now, zero new opcodes:** a trustless, permissionless, multi-LP pool whose accounting is expressed entirely as covenant-observable VALUE/REF DELTAS plus a single in-controller scalar (RPL-LP). Provable because its accounting is structurally identical to RadiantSwap `Market.rxd`, already in production and audited. Removes the R3 single-custodian rug. Genuinely trustless with int64 math for symmetric/modestly-asymmetric pools up to ~9.0e15 in the binding products (R up to ~9.4e7 photons at 1:1).
- **NOT achievable today:** (1) the literal Uniswap `shares = dR·S/R` for free-floating fungible LP shares — needs global totalSupply, which has NO opcode and is forgeable via co-spend selection. HARD primitive gap; requires either a new consensus primitive (an `OP_TOTALSUPPLY`-style global-supply read for a ref) OR accepting the controller-as-authenticated-bookkeeper framing (which RPL-LP does, staying trustless because every mutation is pinned). (2) Production-scale pools (legs > ~0.95 RXD full-range) need 128-bit limb math — feasible on existing opcodes but substantial unwritten work, and P0 because the int64 cap is a fund-safety boundary (un-exitable large positions), not a sizing nicety.

**Bottom line:** ship RPL-LP for bounded pools now (trustless, audited-pattern-equivalent), promote 128-bit math to a hard prerequisite for production scale, and document that fully-fungible proportional LP shares à la Uniswap remain blocked on a missing global-supply primitive.
