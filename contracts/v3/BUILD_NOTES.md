# v3 build & regtest validation notes

Status of the v3 paired-UTXO CPMM (`RadiantMMToken.rxd` + `RadiantMMPool.rxd`).

## Done
- **Design** resolved from consensus + canonical Glyph `ftScript` (../../docs/REDESIGN_C1_C2.md).
- **Contracts** written and **compiling** under the Radiant `rxdc` compiler. Artifacts in
  `artifacts/`. They embody:
  - **C1** — token reserve = real coloured-satoshi `.value` (not spender state).
  - **C2** — code-only continuity via `tx.outputs[i].codeScript == tx.inputs[i].codeScript`.
  - **Reserve isolation** — outpoint pairing: input[0]/input[1] must come from the same prior
    tx at vouts 0/1, defeating decoy-reserve substitution (the K-drain).
  - K invariant (overflow-guarded, 0.3% ceiling fee), dust guards, owner withdraw.
- **Compiler bug fixed** upstream: `rxdc` was lowering `*`/`/` to `OP_2MUL`/`OP_2DIV` (×2/÷2),
  which silently broke the K math. Fixed in RadiantScript (`fix/numeric-mul-div-lowering`);
  the artifacts here are compiled with the fixed compiler. **Recompile with the fixed `rxdc`.**
- **Regtest** node available locally: `Radiant-Core/build/src/radiantd` (v3.0.0), all ref
  opcodes active by height ~115 (ER@100, PushTXState@110). Run isolated:
  `radiantd -datadir=/tmp/rmm-regtest -listen=0 -rpcport=18443 -daemon`.
- **Tx pipeline PROVEN on regtest:** `@radiant-core/radiantjs` (exports `Transaction`,
  `PrivateKey`, `Script`, `Networks.regtest`, `Transaction.Sighash`, and a full `Glyph`
  ref/token module) builds + signs a tx that the node accepts and mines. Confirmed the
  Radiant min-relay floor empirically: ~10,000 photons/byte (a ~226-byte tx needs ~2.3M sat
  fee; 5,000 sat was rejected `min relay fee not met`). This is the foundation for building
  the genesis + paired-covenant trade txs. See `tools/regtest/`.

## Key deployment constraints discovered (for the regtest harness)
1. **BARE scripts, not P2SH.** cashscript's `contract.address` is P2SH (`OP_HASH160 <h>
   OP_EQUAL`), which hides the code and carries no refs — Radiant introspection/ref tracking
   would see nothing. Deploy each pool UTXO as a **bare** locking script via
   `buildStatefulOutput(stateData, codeScript)` → `<push state> OP_STATESEPARATOR <code>`,
   exactly like Photonic `ftScript`. The code (with its `pushInputRef*`) must be in the
   scriptPubKey so the UTXO actually carries the refs.
2. **State is a single data push** (`encodePush`). Opcodes placed in the state section do NOT
   execute — they are inert data. (This is why the reserve singleton had to be replaced by
   outpoint pairing.) Holder state = `0x14 <20-byte pkh>`; reserve marker state = `0x14` + 20
   zero bytes.
3. **Genesis minting** (must be built raw, e.g. with `@radiant-core/radiantjs`):
   - `$tokenRef` / `$poolRef` are 36-byte refs = an input's outpoint (txid[32] + vout_le[4]).
   - Genesis tx spends a funding UTXO and creates, at fixed vouts: out0 = controller (carries
     singleton `$poolRef`), out1 = token reserve (carries `$tokenRef`, marker state), plus the
     initial RXD and token reserves. Confirm the exact normal-ref vs singleton induction rule
     empirically on regtest (node is ground truth).
4. **Covenant unlocking** = function args + cashscript function-selector; signing uses Radiant
   sighash (forkid). The high-level `contract.functions.x().to().send()` assumes P2SH UTXOs
   from a provider, so the paired bare-script trade tx likely needs raw construction with
   radiantjs + broadcast via `radiant-cli sendrawtransaction`.

## Remaining (the "trade" proof) — REDESIGN §4 matrix
Positive: genesis → buy → sell → owner-withdraw accepted; token round-trips as the same FT.
Adversarial (all rejected): C1 drain (decoy reserve / fake tokOut), K−1, code change, marker/
ref strip, fake sibling, pool not at out0/1, dust, fee rounding, overflow.
Then: rebuild the SDK tx-builder for the paired model (H3), reconcile artifacts (H4), e2e tests.

**Fund-safety still requires external audit + testnet soak regardless of regtest results.**

## VALIDATED ON REGTEST (v3.0.0 local node) — 2026-06-01

The full paired-UTXO CPMM is proven at consensus level:

| Scenario | Result | Proof |
|----------|--------|-------|
| Genesis: mint `$poolRef`+`$tokenRef`, deploy pool bare | ACCEPTED | `genesis.cjs` |
| Bare covenant spend (controller `withdraw`) | ACCEPTED | `spend-withdraw.cjs` |
| Reserve spend (`release`) | ACCEPTED | isolation test |
| **Buy trade** (controller `trade` + reserve `release`, both recreated, K holds) | **ACCEPTED** | `trade-buy.cjs` (R 1e6→1.1e6, T 1e5→90934, K_out≥K_in) |
| **K-violating drain** (take 20k tokens for 100k RXD) | **REJECTED** | `trade-attack-kviolation.cjs` (false top stack) |
| **Reserve substitution** (decoy token UTXO as input[1]) | **REJECTED** | `trade-attack-substitution.cjs` (OP_NUMEQUALVERIFY on outpointIndex) |

### Full BUY-side adversarial matrix (`tools/regtest/trade-adversarial.cjs`) — all as expected

| Variant | Expected | Result | Guard that fired |
|---------|----------|--------|------------------|
| valid (Tp=90934) | accept | ✅ accepted | — (K_out 100000119800 ≥ K_in 1e11) |
| fee-underpay (Tp=90933) | reject | ✅ rejected | K (ceiling fee enforced to the satoshi) |
| k-violation (take 20k) | reject | ✅ rejected | `require(kOut>=kIn)` |
| code-ctrl (wrong out0 code) | reject | ✅ rejected | C2 continuity `outputs[0].codeScript` |
| code-reserve (wrong out1 code) | reject | ✅ rejected | C2 continuity `outputs[1].codeScript` |
| strip-pool (out0 w/o $poolRef) | reject | ✅ rejected | continuity / `refOutputCount($poolRef)==1` |
| layout (controller at out2) | reject | ✅ rejected | continuity@out0 |
| dust-rxd (out0 < 546) | reject | ✅ rejected | `require(rxdOut>=546)` |
| zero-token (out1 = 0) | reject | ✅ rejected | `require(tokOut>0)` |
| dup-pool (two $poolRef outs) | reject | ✅ rejected | singleton-sibling (ref-operations layer) |
| reserve-substitution (decoy in[1]) | reject | ✅ rejected | outpoint pairing `OP_NUMEQUALVERIFY` |

C1 (real coloured-satoshi reserves + outpoint-pairing isolation) and C2 (code-only continuity)
are enforced by consensus on the BUY side. Overflow guard (2^53 bound) is present but not
exercised at scale (would need ~petaphoton funding).

**Remaining:** SELL path (spends stateful user tokens — needs state-on-stack dispatch resolved;
being done by a separate agent), then SDK tx-builder rebuild + external audit before mainnet.

## STATEFUL-DISPATCH RESOLUTION + SELL PATH VALIDATED ON REGTEST — 2026-06-01

### The problem (root cause, confirmed against Radiant-Core)
A SELL requires the trader to SPEND their own token holder UTXO, which is stateful:
`<push 20-byte pkh> OP_STATESEPARATOR <code>`. `VerifyScript` (interpreter.cpp:2870-2877) runs
the scriptSig then the **whole** scriptPubKey on a shared stack; execution starts at
`script.begin()` (interpreter.cpp:260) and **every push — including the state section's
`0x14 <pkh>` — lands on the stack**. `OP_STATESEPARATOR` is a NOP (interpreter.cpp:1979-1983).
So when `<code>` starts, the 20-byte pkh is on TOP of the stack — but cashscript's compiled
function dispatch is `OP_DUP OP_0 OP_NUMEQUAL OP_IF ...`, which expects the **function selector**
on top. `OP_NUMEQUAL` on a 20-byte value is out of script-number range → the spend fails. No
scriptSig can fix this: the scriptSig runs *before* the scriptPubKey, so the state push always
ends up above the selector. (The reserve dodged this earlier by being deployed bare — but a
holder cannot be bare: `transfer()` reads the owner pkh from `tx.inputs[i].stateScript`, so the
pkh must be committed in state.)

The production Photonic/Glyph `ftScript` avoids the problem a different way: its state section
is *executable* P2PKH (`OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG`) and it has **no
selector dispatch** at all — single-purpose. cashscript's multi-function (`transfer`/`release`/
`burn`) selector model is fundamentally incompatible with a passive leading state push.

### The fix — `OP_DROP` prologue + uniform stateful deployment
Prepend a single `OP_DROP` to the **token** code section at deploy time, so the code becomes
`OP_DROP <cashscript dispatch>`. The leading state push (exactly one item — `buildStatefulOutput`
emits one `encodePush`) is consumed by `OP_DROP`, leaving the stack identical to cashscript's
P2SH execution stack `[args…, selector]`; selector dispatch then runs unchanged. `transfer()`
still authenticates by reading the pkh from `stateScript` via introspection
(`OP_STATESCRIPTBYTECODE_UTXO`), NOT from the dropped on-stack copy, so dropping it is safe.

To keep `OP_DROP` valid for **every** token spend, all token UTXOs are deployed STATEFUL so each
always has exactly one leading state push to drop:
- **Holder**: state = `<20-byte pkh>` (spent via `transfer()`/`burn()`, sig-gated).
- **Pool reserve**: state = `<20 zero bytes>` marker (spent via `release()`; 20 zeros are not the
  hash160 of any key, so the reserve cannot be hijacked onto `transfer()`).
The state section is **before** `OP_STATESEPARATOR`, so `codeScript` (the bytes the node hashes
for `codeScriptValueSum`/`codeScriptCount` and the controller's continuity check) is identical
(`OP_DROP <dispatch>`) for the reserve and every holder → token-value conservation still groups
them as one token. The **controller** (pool) code is unchanged/BARE — it is spent with the
selector on top and no state, so it must NOT get an `OP_DROP`.

This is a deploy-time wrapper (like `buildStatefulOutput` itself), applied in `genesis.cjs`
(`buildCode('OP_DROP ' + tokenArt.asm, …)`); the `.rxd` source is unchanged. The controller's
`release()`-gating, outpoint pairing and K logic are all unchanged.

### Validated on the local v3.0.0 regtest (datadir /tmp/rmm-regtest-sell, port 18444)

| Scenario | Result | Proof |
|----------|--------|-------|
| Genesis with `OP_DROP` token code + stateful reserve | ACCEPTED | `genesis.cjs` (R=1e6, T=1e5, user=5e4) |
| **BUY regression** (reserve now stateful, `release` dispatches after `OP_DROP`) | **ACCEPTED** | `trade-buy.cjs` (R 1e6→1.1e6, T 1e5→90934) |
| **SELL** (trader spends stateful holder via `transfer()`, reserve grows, takes RXD) | **ACCEPTED** | `trade-sell.cjs` — R 1.1e6→1000573, T 90934→100000, trader recv 99427 sat; K_out==K_in=100027400000 |
| **K-violating SELL** (take 1 sat more RXD than K allows) | **REJECTED** | `trade-attack-sell-kviolation.cjs` (false/empty top stack — `require(kOut>=kIn)`) |
| **Naive stateful holder `transfer()`** (no `OP_DROP`) | **REJECTED** | `demo-stateful-break.cjs naive` (mandatory-script-verify-flag-failed — dispatch break) |
| **`OP_DROP` stateful holder `transfer()`** (control, same ref env) | **ACCEPTED** | `demo-stateful-break.cjs drop` |

The SELL spends 4 inputs: in0 controller `OP_0`(trade), in1 reserve `OP_1`(release), **in2 the
stateful holder via `transfer()`** (scriptSig `push(senderPk) push(s) OP_0`, 108 B), in3 P2PKH
funding (tx fee — the pool's RXD is too small to cover the ~10k photon/byte min-relay floor).
Token conservation held (reserve_in 90934 + holder_in 9066 == reserve_out 100000 + change 0).
K is enforced to the satoshi: the valid Rp=1000573 was accepted and Rp=1000572 (the adversarial)
was rejected — adjacent integers straddling the K floor.

The transfer() scriptSig order is `push(senderPk) push(s) OP_0` (verified on regtest). After
`OP_DROP` consumes the pkh, cashscript's `OP_SWAP OP_2 OP_PICK OP_CHECKSIGVERIFY` prologue
consumes `[senderPk, s, selector]` such that `OP_CHECKSIG` sees the pubkey on top of the sig.

### ⚠ FINDING (new, audit-relevant): the token is NOT freely transferable — every transfer needs `$poolRef` in an input
While building the standalone dispatch demo I found that a holder `transfer()` is rejected with
`bad-txns-inputs-outputs-invalid-transaction-reference-operations` UNLESS the spending tx also
carries `$poolRef` in one of its inputs — even though `transfer()` never executes the `release()`
branch that uses it.

Root cause (Radiant-Core `validation.h` `validateTransactionReferenceOperations`, lines
1056-1064): the ref-induction check is **static**. It scans each *output's* script for
`OP_REQUIREINPUTREF` refs (`buildRefSetFromScript` walks the whole script, both IF/ELSE branches,
ignoring runtime control flow) and requires every such ref to appear in the **input** push-ref
set (`requireRefSatisfied = validatePushRefRule(inputPushRefSet, outputRequireRefSet)`). The
RadiantMMToken code shares ONE script across holders and the reserve, and that script contains
`requireInputRef($poolRef)` in the `release()` branch. So **every** newly-created token output
(including an ordinary holder→holder transfer's recipient output) statically references `$poolRef`
and therefore requires `$poolRef` to be carried by some input of the creating tx.

Confirmed empirically: `demo-stateful-break.cjs` only succeeds once a `$poolRef`-carrying UTXO is
co-spent (`drop` mode → ACCEPTED; without it → ref-operations reject). `$poolRef` is a singleton
that lives on the pool controller, so:
- **Pool trades are unaffected** — buy/sell always co-spend the controller, so `$poolRef` is
  present. The SELL above is fully valid. ✅
- **Wallet-to-wallet transfers are effectively blocked** — a user cannot move tokens without
  co-spending the pool controller, which contradicts `transfer()`'s stated goal of letting tokens
  "circulate without a central authority." This is almost certainly an unintended defect.

Why it's not trivially fixable: splitting the holder code (transfer/burn, no `$poolRef`) from the
reserve code (release, with `$poolRef`) would give them different `codeScript` hashes, which
breaks the shared-`codeScriptValueSum` conservation that ties reserve growth/shrink to holder
tokens during a trade (a buy moves value from the reserve code-group into a holder of a *different*
code-group → conservation fails). Recommended directions for review:
  1. Decide whether free transferability is required. If the token is only ever meant to move
     through the pool, document that as intended and the current code is fine.
  2. If free transfer IS required: redesign so `release()` proves controller co-spend WITHOUT a
     static `OP_REQUIREINPUTREF` in the shared code — e.g. verify the controller via a value/
     introspection check the static scanner doesn't flag, or carry the reserve↔controller binding
     entirely in the controller (it already enforces outpoint pairing), dropping `$poolRef` from
     the token code. Each option needs its own regtest + adversarial pass.

### Other minor follow-ups
- Selling the full holder balance still emits a 0-value token-change output (out3). Harmless on
  regtest and conservation-consistent, but a production builder should omit a 0-token change.

**Fund-safety still requires external audit + testnet soak regardless of regtest results.**
