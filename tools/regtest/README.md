# RadiantMM regtest harness

Local consensus-level validation environment for the v3 contracts.

## Node

Uses the locally-built v3.0.0 node:

```sh
RT=/tmp/rmm-regtest
mkdir -p "$RT"
/Users/macbookair/CascadeProjects/Radiant-Core/build/src/radiantd \
  -datadir="$RT" -listen=0 -rpcport=18443 -daemon
# wrapper:
printf '#!/bin/zsh\nexec /Users/macbookair/CascadeProjects/Radiant-Core/build/src/radiant-cli -datadir=%s -rpcwallet=rmm "$@"\n' "$RT" > "$RT/rcli"
chmod +x "$RT/rcli"
"$RT/rcli" createwallet rmm
"$RT/rcli" generatetoaddress 115 "$("$RT/rcli" getnewaddress)"   # ER@100, PushTXState@110 active
```

All reference/introspection opcodes are active by height ~111
(`SCRIPT_NATIVE_INTROSPECTION` is always on; `ERHeight=100`, `PushTXStateHeight=110` on regtest).

## Tx construction

`@radiant-core/radiantjs` builds and signs txs the node accepts (proven — see
`build-and-broadcast.cjs`). Broadcast the resulting hex with `rcli sendrawtransaction <hex>`.

**Min relay fee:** ~10,000 photons/byte. Budget ~`size_bytes * 10000` sat per tx.

## Next steps (see ../contracts/v3/BUILD_NOTES.md §"Remaining")

1. Genesis: build the bare-script controller (out0, singleton `$poolRef`) + token reserve
   (out1, marker state, `$tokenRef`) with `Transaction` + `Glyph` ref helpers.
2. Trade: spend both, recreate both, with a valid K; broadcast; assert acceptance.
3. Adversarial matrix (REDESIGN §4): assert each drain/cheat is rejected.
