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
