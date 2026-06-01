# Redesign: fixing C1 (unbacked tokens) and C2 (frozen state)

**Status:** design RESOLVED at the consensus level; contract bytecode + tx shape still
pending regtest validation. Do **not** deploy from this document yet.

This addresses the two critical findings in `SECURITY-AUDIT.md`:

- **C1** — token reserves are unbacked integers; no Glyph token is enforced on-chain.
- **C2** — the continuity check compares the full locking bytecode, freezing the state so
  no swap can occur.

The open question that blocked the previous draft (§3 below) is now answered directly from
the Radiant-Node consensus interpreter and the canonical Glyph FT contract, rather than left
for regtest. The answer materially changes the pool architecture — see §0.

Companion draft: `contracts/RadiantMMPool.v2.draft.rxd` (its single-UTXO assumption is
superseded by §0; treat it as historical).

---

## 0. The finding that changes everything: a Glyph FT *is* coloured RXD

On Radiant, a Glyph fungible token's **amount is the satoshi value (`nValue`) of the
ref-bearing UTXO**. There is no separate "amount" field — 1 token = 1 photon, coloured by the
token's 36-byte ref.

Evidence (consensus + canonical contract, not inference):

- **Canonical FT contract** — `Photonic-Wallet/packages/lib/src/script.ts` `ftScript()`:
  ```
  P2PKH(owner)
  OP_STATESEPARATOR
  OP_PUSHINPUTREF <ref>
  OP_REFOUTPUTCOUNT_OUTPUTS
  OP_INPUTINDEX OP_CODESCRIPTBYTECODE_UTXO OP_HASH256 OP_DUP
  OP_CODESCRIPTHASHVALUESUM_UTXOS   OP_OVER OP_CODESCRIPTHASHVALUESUM_OUTPUTS
  OP_GREATERTHANOREQUAL OP_VERIFY                 // Σ value(in, this code) ≥ Σ value(out, this code)
  OP_CODESCRIPTHASHOUTPUTCOUNT_OUTPUTS OP_NUMEQUALVERIFY  // every ref-output uses this exact code
  ```
  Conservation is enforced on **summed `nValue`** grouped by code-script-hash. The token
  quantity carried by a UTXO is therefore exactly its satoshi value.
- **Canonical transfer** — `Photonic-Wallet/packages/lib/src/transfer.tsx`: a transfer of
  `value` tokens emits `{ script: toScript, value }` and FT change `{ script: fromScript,
  value: accum.sum - value }`. Balances are summed satoshi values. (Confirms the above.)
- **Interpreter** — `Radiant-Node/src/script/interpreter.cpp` + `script_execution_context.h`:
  `OP_REFVALUESUM_{UTXOS,OUTPUTS}(ref)` returns `Σ nValue / SATOSHI` over inputs/outputs
  carrying `ref`. `OP_CODESCRIPTHASHVALUESUM_*` does the same grouped by code-script-hash.

### Consequences

1. **A single-UTXO pool is impossible.** If the pool UTXO carries `tokenRef`, its *entire*
   `nValue` is the token reserve — there is no room for an independent RXD reserve in the same
   output. RXD reserve and token reserve must live in **separate UTXOs**.
2. **`token_in` / `token_out` are just `.value`** of the token-reserve input/output — real,
   consensus-conserved coloured satoshis, not a spender-written state integer. This *is* the
   C1 fix, and it falls out for free once the reserve is a real ref-bearing UTXO.
3. **The state/code split is the C2 fix and the custody mechanism.** Radiant does *not* enforce
   "pre-separator must be pushes only" (`CScript::GetPushRefs` in `script.cpp` only locates the
   separator; stock `ftScript` itself puts a full P2PKH before the separator). So:
   - **code** (post-`OP_STATESEPARATOR`) = the ref-conservation logic, byte-identical across
     every UTXO of the token;
   - **state** (pre-separator) = the *gate* deciding who may spend (a signature for a user; the
     **AMM covenant** for a pool-held reserve).
   Because conservation only hashes the code portion, a pool can custody a *stock* Glyph FT by
   recreating it with the **same code** and an **AMM gate in the state** — `m == n` still holds,
   so the token's own contract accepts the move.

---

## 1. The security property we need

The constant-product invariant `(rxd_out − fee) · token_out ≥ rxd_in · token_in` is only
meaningful if `token_in`/`token_out` are the **real token quantities carried by the pool's own
reserve UTXOs**. Per §0 those quantities are the reserve UTXO's `nValue`, conserved at
consensus — so the spender cannot fabricate them. That single fact is the whole fix for C1.

## 2. The two changes

### 2.1 Code-only continuity (fixes C2)

Replace the full-bytecode comparison with a **code-portion** comparison so state (gate/owner)
may change while logic stays immutable:

```
OP_INPUTINDEX OP_CODESCRIPTBYTECODE_UTXO   // this input's code
<poolOutIdx> OP_CODESCRIPTBYTECODE_OUTPUT  // recreated pool output's code
OP_EQUALVERIFY
```

`OP_CODESCRIPTBYTECODE_{UTXO,OUTPUT}` return exactly the bytes from `OP_STATESEPARATOR` to the
end (see interpreter §2281–2327), so this is a direct, no-arithmetic split.

### 2.2 Real token binding (fixes C1)

- The token-reserve UTXO carries `tokenRef` (`OP_PUSHINPUTREF`/`OP_REQUIREINPUTREF`) and is
  recreated carrying the same ref (ref continuity).
- `token_in = value(tokenReserveInput)`, `token_out = value(tokenReserveOutput)`.
- A **buy** (trader adds RXD, takes tokens) forces `token_out < token_in`; the difference must
  land in the trader's token output (Glyph conservation guarantees it physically exists).
- A **sell** forces `token_out > token_in`; the trader must supply real token inputs.

## 3. RESOLVED — per-output amount read

> *Previous open question: how to read the token amount of one specific output, vs the tx-wide
> sum?*

**Answer:** you don't need a per-ref-per-index amount opcode. Because token amount = `nValue`
(§0), the per-output amount is simply `tx.outputs[i].value` / `tx.inputs[i].value`. The role of
the ref opcodes is only to **prove** that value is genuinely coloured `tokenRef` (and bound to
the FT conservation code), not to compute it.

The reads the final contract uses, all confirmed present in Radiant-Node:

| Need | Opcode | Returns |
|------|--------|---------|
| code-only continuity | `OP_CODESCRIPTBYTECODE_UTXO/_OUTPUT` | bytes after `OP_STATESEPARATOR` |
| token-reserve amount | `tx.inputs[i].value` / `tx.outputs[i].value` | coloured satoshis = token qty |
| ref present on an output | `OP_REFDATASUMMARY_OUTPUT(i)` | concat of refs on output `i` |
| ref type (normal/singleton) | `OP_REFTYPE_OUTPUT(ref)` | 0 none / 1 normal / 2 singleton |
| tx-wide token conservation | `OP_REFVALUESUM_UTXOS/_OUTPUTS(ref)` | Σ coloured satoshis |

The previous worry about a global `REFVALUESUM` over-counting the sell-side token-in dissolves:
the pool reads its *own* reserve UTXO's `.value` by index, and uses tx-wide sums only as a
conservation cross-check if desired.

## 3.5 Architecture: a paired-UTXO pool

A pool is **two co-spent UTXOs**, recreated together every trade:

- **RXD reserve** `R` — plain satoshis, locked by the pool code `P_rxd`.
- **Token reserve** `T` — coloured `tokenRef`; `value == T == token reserve`. Locked by an
  FT whose **code = stock Glyph conservation code** (so it stays the same token) and whose
  **state = AMM gate** `P_ft` (so only a valid trade can move it).

Both reserve scripts introspect *the other* reserve's matching input/output by index, so each
side can enforce the **joint** invariant `R' · T' ≥ R · T` (after fee) even though each UTXO
runs only its own script. Trade tx shape:

```
inputs:  [pool RXD reserve R] [pool token reserve T] [trader funding / trader tokens]
outputs: [pool RXD reserve R'] [pool token reserve T'] [trader tokens / trader RXD] [change]
```

Open design sub-points to settle on regtest (engineering, not feasibility):

1. **Cross-UTXO binding** — how each reserve identifies its sibling (fixed relative indices vs a
   singleton "pool id" ref carried by both reserves; a singleton via `OP_PUSHINPUTREFSINGLETON`
   is the robust choice — it prevents a second forged reserve from impersonating the pool).
2. **Stack discipline** of state-gate-then-conservation-code when custodying a stock FT (the
   gate must leave the stack exactly as the conservation code expects).
3. **Fee + rounding** placement so it cannot be gamed across the two outputs.

### Hard constraint to flag

The stock Glyph FT permanently binds its token to its own code script
(`OP_CODESCRIPTHASHOUTPUTCOUNT_OUTPUTS OP_NUMEQUALVERIFY` requires *every* ref-output to use it).
Custody is therefore only possible by keeping that **exact code** and varying only the state
gate (§0.3). If a future Glyph version changes the FT code, the pool's token-reserve code must
track it. A pool cannot hold a token under arbitrary alternative code.

## 4. Regtest test plan (must pass before leaving DRAFT)

Positive:
1. Buy: trader adds RXD, receives correct token delta, K holds → accepted.
2. Sell: trader supplies real `tokenRef` tokens, receives RXD, K holds → accepted.
3. Owner withdrawal with valid sig → accepted.
4. Round-trip: a token can move user→pool→user and is still recognised as the same FT by the
   indexer (code-hash unchanged).

Adversarial (all must be **rejected**):
5. **C1 drain:** lower the token-reserve output `value` (or strip the ref) without delivering
   the tokens to the trader → fail.
6. Buy/sell that decreases K by 1 → fail.
7. Trade that changes the code portion of either reserve → fail.
8. Trade that changes/strips `tokenRef` (or the pool-id singleton) on a reserve output → fail.
9. Fake sibling: forge a second token-reserve to spoof the joint check → fail (singleton blocks
   the duplicate ref).
10. Pool not recreated at the expected output indices → fail.
11. Zero/dust reserve on either output → fail.
12. Fee rounding: smallest non-zero delta still charges a non-zero (ceiling) fee.
13. Overflow: reserves near the int limit behave per the node's actual script-number semantics
    (verify whether `OP_MUL` overflows or uses big-int math on the target node).

Only once 1–13 behave correctly on regtest should this leave DRAFT and a `v3` contract replace
the superseded single-UTXO `v2.draft`.
