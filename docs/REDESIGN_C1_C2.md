# Redesign proposal: fixing C1 (unbacked tokens) and C2 (frozen state)

**Status:** DRAFT — design-level. Pending verification of exact Radiant reference-opcode
semantics on regtest. Do **not** deploy from this document.

This proposal addresses the two critical findings in `SECURITY-AUDIT.md`:

- **C1** — token reserves are unbacked integers; no Glyph token is enforced on-chain.
- **C2** — the continuity check compares the full locking bytecode, freezing the state so
  no swap can occur.

Companion draft: `contracts/RadiantMMPool.v2.draft.rxd`.

---

## 1. The security property we need

A pool UTXO holds two assets:

1. **RXD** — the UTXO's native satoshi value (`rxd`).
2. **A specific Glyph fungible token** — identified by `tokenRef`, with quantity `token`.

The constant-product invariant `(rxd_out − fee) · token_out ≥ rxd_in · token_in` is only
meaningful if **`token_in` and `token_out` are the real token quantities carried by the
pool's own input and continuing output** — not numbers the spender writes into free-form
state. That single property is the whole fix for C1.

The current contract derives `token_*` from the state integer, which the spender controls,
so it can be fabricated. The redesign must derive `token_*` from the actual on-chain token
amount, which Radiant's reference system conserves at consensus.

## 2. Two changes

### 2.1 Code-only continuity (fixes C2)

Replace the full-bytecode comparison with a comparison of the **code portion only**, so the
state (and the token quantity) is allowed to change while the logic is immutable:

- Split each locking bytecode at the state separator and compare the code halves; or
- Use the active-/code-bytecode introspection that already excludes the state portion.

The pool's `tokenRef` must also be carried unchanged on the continuing output (ref
continuity), so the pool can never silently change which token it trades.

### 2.2 Real token binding (fixes C1)

- Require `tokenRef` to be present on the pool input (`OP_REQUIREINPUTREF`-style assertion)
  and propagated to the continuing pool output.
- Compute `token_in` / `token_out` from the **token amount carried by the pool's own
  input/output**, not from the state field.

Radiant conserves a ref's total token value across a transaction's inputs and outputs, so:
- a **buy** (trader adds RXD, removes tokens) forces `token_out < token_in`, with the
  difference necessarily landing in the trader's output;
- a **sell** (trader adds tokens, removes RXD) forces `token_out > token_in`, and the trader
  must actually supply those tokens as a real input.

The trader cannot fabricate `token_out`, because it reflects tokens that consensus requires
to physically exist and be conserved.

## 3. Open question to resolve on regtest (do this first)

**How do we read the token amount carried by *one specific* output/UTXO — the pool's — as
opposed to the global sum across the whole transaction?**

- A global `REFVALUESUM_*` over all inputs is wrong for the **sell** path: the seller also
  holds the token on the input side, so a global sum would over-count `token_in`.
- We need a **per-index** read of the pool input (`this.activeInputIndex`) and the continuing
  output (same index), restricted to `tokenRef`.

Resolve which of these Radiant actually provides before writing final bytecode:
1. A per-output / per-utxo ref-value introspection opcode (preferred — read it directly).
2. If only transaction-wide sums exist: constrain the tx shape (e.g. the pool is the only
   ref holder on a given side, or the trader's token in/out is a separate enforced ref), and
   derive the pool quantity by subtraction — each added constraint is an attack surface and
   must be tested adversarially.

The draft contract marks these reads as `poolTokenIn()` / `poolTokenOut()` precisely because
the opcode-level implementation depends on this answer.

## 4. Regtest test plan (must pass before any deployment)

Positive:
1. Buy: trader adds RXD, receives the correct token delta, K holds → accepted.
2. Sell: trader supplies tokens, receives RXD, K holds → accepted.
3. Owner withdrawal with valid sig → accepted.

Adversarial (all must be **rejected**):
4. **C1 drain:** set pool output RXD far below input and write a huge `token_out` without
   moving any real tokens → must fail (this is the current contract's fatal case).
5. Buy/sell that decreases K by 1 → must fail.
6. Trade that changes the code portion → must fail.
7. Trade that changes/strips `tokenRef` on the output → must fail.
8. Trade that does not recreate the pool at the expected output index → must fail.
9. Zero / dust token or RXD reserves on the output → must fail (no division/own-goal states).
10. Fee rounding: smallest non-zero delta still charges a non-zero fee (ceiling division).
11. Overflow: reserves near the int limit behave per the node's actual script-number
    semantics (verify whether `OP_MUL` overflows or uses big-int math on the target node).

Only once 1–11 behave correctly on regtest should this leave DRAFT status.
