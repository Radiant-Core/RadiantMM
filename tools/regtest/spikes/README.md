# RPL-LP Phase-0 spike

Blocking go/no-go gate for the LP-share covenant design (`docs/LP-SHARE-COVENANT-DESIGN.md`,
§13 Phase 0). Proves the three load-bearing primitives of the RPL-LP design **compose in one
transaction** on a real Radiant-Core regtest node, before any production covenant is written.

**Result: PASS 9/9** (Radiant-Core v3.1.x regtest, `SecurityUpgradeHeight=0` → post-upgrade
script semantics, the rules mainnet adopts at block 440000).

## What it proves

- **(a) Stateful controller mutate + read across a hop.** The controller carries
  `state = ver(1) || shareTotal(8 LE)`, deployed with an `OP_DROP` prologue. `addLiquidity` reads
  `S0` from its own input state (`stateScript.split(1)[1]`) and pins the output state to
  `S1 = S0 + dS`. Two consecutive adds (TEST 1, 2) show `shareTotal` evolving 500k→550k→660k on-chain.
- **(b) `refValueSum` delta pinned to the mint.** The mint pins
  `outputs.refValueSum($lpRef) - inputs.refValueSum($lpRef) == dS`. The co-spent LP-anchor passes
  through unchanged (its dust cancels in the delta), so the pin reads exactly the newly minted
  value. Over-mint (TEST 3, an extra share output) and free-mint (TEST 7, `dS` rounds to 0) are
  both REJECTED at the script level.
- **(c) Mint gated on the controller; transfer is not.** Keyless mint via the anchor's `vaultMove`
  requires `tx.inputs.refType($poolRef) == 2` (runtime), so a mint with no controller co-spent is
  REJECTED (TEST 5). A plain holder-to-holder `transfer()` succeeds with **no** `$poolRef` co-spent
  (TEST 6) — confirming the runtime `refType` gate introduces no static ref-induction taint on
  ordinary LP transfers.
- **Plus the LP-specific arithmetic** `dS = dR·S0/R` (the one thing RadiantSwap `Market.rxd` never
  needed — Market mints 1:1). Seeded `shareTotal (500k) ≠ R (1,000,000)` so value-per-share = 2 and
  the ratio is genuinely exercised: `dR=100,000 → dS=50,000` (TEST 1), verified on-chain.

## Files

- `RplLpProbe.rxd` — minimal stateful controller; one branch `addLiquidity` isolating the new
  arithmetic + delta-pin + state mutation. (The production controller adds the token-reserve leg,
  trade(), removeLiquidity, overflow guards, anchor pairing — see the design doc.)
- `LpShareProbe.rxd` — LP-share token, a clone of RadiantSwap `ShareToken.rxd` (`transfer` +
  `vaultMove`), proving the keyless-mint gate and no-taint transfer.
- `lp-spike.cjs` — self-contained harness (genesis + 2 honest adds + 4 reject cases + 1 transfer
  regression). Builds, broadcasts, mines, and asserts on a live node.
- `artifacts/` — compiled contracts (rxdc; 4× OP_MUL/OP_DIV, 0× OP_2MUL/OP_2DIV).

## Reproduce

Node setup (regtest, a free port — bind IPv4 explicitly to avoid clashing with other local
regtest daemons):

```sh
RT=/tmp/rmm-lp-spike; PORT=18477
radiantd -regtest -datadir=$RT -listen=0 -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 -rpcport=$PORT -daemon
echo $PORT > $RT/.port
radiant-cli -regtest -datadir=$RT -rpcport=$PORT -named createwallet wallet_name=lp
radiant-cli -regtest -datadir=$RT -rpcport=$PORT -rpcwallet=lp generatetoaddress 130 \
  "$(radiant-cli -regtest -datadir=$RT -rpcport=$PORT -rpcwallet=lp getnewaddress)"
```

Compile + run:

```sh
RXDC=/Users/macbookair/CascadeProjects/RadiantScript/packages/cashc/dist/main/cashc-cli.js
node "$RXDC" RplLpProbe.rxd  -o artifacts/RplLpProbe.json
node "$RXDC" LpShareProbe.rxd -o artifacts/LpShareProbe.json
node lp-spike.cjs   # expect PASS=9 FAIL=0
```

## Scope / honesty notes

- This is a **primitive-composition proof**, not the production covenant. It deliberately omits the
  token-reserve leg, `trade()`, `removeLiquidity`, the exact-ratio/`min()`-credit deposit rule, the
  full overflow-guard ladder, MINIMUM_LIQUIDITY lockup, and the 3-slot anchor outpoint-pairing.
- **Passthrough robustness** is demonstrated by the anchor (a co-spent `$lpRef` carrier) cancelling
  in the delta. Note an existing LP *holder* cannot be co-spent via `transfer()` in the same tx as a
  mint, because `LpShareProbe.transfer()`'s own conservation check
  (`inputs.codeScriptValueSum == outputs.codeScriptValueSum`) forbids the supply growth a mint
  causes — a useful constraint to carry into the production design (addLiquidity mints only to the
  depositor; it never needs to touch other holders).
- Production scale still **blocks on 128-bit limb math** (the `dR·S0` / `burned·R` products are
  O(R²) and exceed 2^53 before the trade K-product does). The spike runs inside the int64-safe
  envelope by construction.
