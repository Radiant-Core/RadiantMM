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

## SDK rebuilt for the paired model (task #7)

`src/v3/` is the paired-UTXO SDK (legacy single-UTXO `src/*.ts` kept only for its math/
encoding tests; not deployable). Exported as `v3` from the package root.
- `v3/math.ts` — CPMM math kept BYTE-CONSISTENT with the on-chain `trade()` (ceiling fee,
  `verifyAccept` = exact contract criterion). `quoteBuy(1e6,1e5,1e5)` ⇒ fee 300, reserveOut
  90934, out 9066 — the validated on-chain numbers; 90933 is rejected. 7 unit tests.
- `v3/contracts.ts` — bare ref-script building via radiantjs `Script.fromASM` substitution
  (cashscript's serializer mis-encodes ref operands), ref encoding, inline `buildStatefulOutput`.
- `v3/builder.ts` — `buildGenesis` + `buildBuy` (proven on-chain), `quoteSell` (controller side
  symmetric; trader stateful-token spend pending the sell-path work).
- Integration: `tools/regtest/sdk-smoke.mts` drives genesis+buy through the SDK on regtest —
  genesis txid matched the SDK's prediction; buy accepted (R 1e6→1.1e6, T 1e5→90934, out 9066).
- `tsc --noEmit` clean; `vitest run` 46/46 (incl. legacy + v3 math).
