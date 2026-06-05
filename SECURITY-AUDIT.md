# RadiantMM Security Audit

> ⚠️ **HISTORICAL — this document audits the v1 single-UTXO design (commit `8661256`).**
> The current contracts are the **v3 paired-UTXO model**; see **[SECURITY-AUDIT-v3.md](SECURITY-AUDIT-v3.md)**
> for the authoritative audit (incl. the R1 reserve-state-hijack finding, now fixed + regtest-verified).

**Date:** 2026-05-31
**Scope:** `contracts/RadiantMMPool.rxd`, `contracts/RadiantMMPool.script`, the TypeScript SDK under `src/`, `tests/`, and the specs (`docs/CONTRACT_SPEC.md`, `RadiantMM_Whitepaper.md`).
**Commit reviewed:** `8661256` (`main`).

## Verdict

**Do not deploy.** In its current form the contract is simultaneously **non-functional as an AMM** and **unsafe as a token custodian**. The two top findings are structural, not incidental — there is no version of the current contract design that is both able to trade *and* safe.

The SDK contains additional independent correctness bugs. Two of them have been fixed in this pass (see [Fixed in this pass](#fixed-in-this-pass)); the rest are documented with recommended fixes.

---

## Severity summary

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| C1 | 🔴 Critical | Token reserves are unbacked integers — no Glyph token is enforced on-chain | Open (contract redesign) |
| C2 | 🔴 Critical | Continuity check freezes pool state — no swap is possible | Open (contract redesign) |
| H1 | 🟠 High | SDK state parser scans for `0xbd`, disagreeing with the on-chain encoding | **Fixed** |
| H2 | 🟠 High | `buildTradeTransaction` sell path double-counts proceeds → invalid tx | **Fixed** |
| H3 | 🟠 High | Token side of every swap is unimplemented in the tx builder | Open |
| H4 | 🟠 High | Deployable `.script` diverges from `.rxd`; no compile step | Open |
| M1 | 🟡 Medium | Floor-division fee allows zero-fee trades | Open |
| M2 | 🟡 Medium | No on-chain overflow guard in `.script`; int64 assumptions unverified | Open |
| M3 | 🟡 Medium | Multi-pool aggregation not implemented; no per-pool cap | Open |
| M4 | 🟡 Medium | Price oracle is manipulable and lossy (`Number(bigint)`) | Open |
| L1 | ⚪ Low | No signing / sighash implementation; no e2e or script-interpreter tests | Open |
| L2 | ⚪ Low | Fragile `parsePoolScript` ownerPkh extraction; placeholder `codeHash` | Open |
| L3 | ⚪ Low | Hardcoded miner fee; unused `tokenRef`; unenforced royalties; misc | Open |

---

## 🔴 C1 — Token reserves are unbacked integers; no Glyph token is enforced on-chain

**Location:** `contracts/RadiantMMPool.rxd:36-76`, `contracts/RadiantMMPool.script:36-119`

The trade path reads the token reserve from the script's *state field* and treats it as the token balance:

```
int tokenIn  = tx.inputs[this.activeInputIndex].stateValue;   // input state
int tokenOut = tx.outputs[this.activeInputIndex].stateValue;  // output state, written by the spender
```

Nothing ties these numbers to a real on-chain asset:

- The `tokenRef` contract parameter is **declared but never referenced** anywhere in either contract.
- **No reference opcode is used at all** — `OP_PUSHINPUTREF`, `OP_REQUIREINPUTREF`, `OP_REFVALUESUM_UTXOS`, `OP_REFVALUESUM_OUTPUTS` appear in the whitepaper (§3.3, §4.3) as the intended mechanism but are absent from the implementation. A grep of `contracts/` and `src/` returns zero ref-opcode usages.

**Impact.** The "token reserve" is an integer the spender chooses in the output. The K-check `(rxd_out − fee)·token_out ≥ rxd_in·token_in` can be satisfied with a *fabricated* `token_out`. If trades are enabled (see C2), an attacker drains the pool's RXD:

1. Spend the pool on the trade path.
2. Set `rxd_out` far below `rxd_in` (pocket the difference as real RXD).
3. Set `token_out` arbitrarily large so `(rxd_out − fee)·token_out ≥ rxd_in·token_in` still holds.

No real tokens are required because tokens were never on-chain assets here — only numbers in the covenant state.

**Recommendation.** Bind the state to a real Glyph token, per the whitepaper:
- Embed the token ref and enforce its presence on the pool input/output with `OP_REQUIREINPUTREF` / a singleton ref.
- Derive `token_in` / `token_out` from the *actual* token quantity carried by the UTXO/output using `OP_REFVALUESUM_UTXOS` / `OP_REFVALUESUM_OUTPUTS`, rather than trusting the free-form state integer.
- Validate on regtest that a trade that does not move the corresponding token quantity fails.

---

## 🔴 C2 — Continuity check freezes pool state; no swap is possible

**Location:** `contracts/RadiantMMPool.rxd:37-41`, `contracts/RadiantMMPool.script:44-54`

The contract enforces continuity by comparing the **full locking bytecode** of the input and output:

```
bytes inputBytecode  = tx.inputs[this.activeInputIndex].lockingBytecode;
bytes outputBytecode = tx.outputs[this.activeInputIndex].lockingBytecode;
require(outputBytecode == inputBytecode);
```

The locking bytecode includes the state portion (`<8:token_amount>`). Requiring full equality therefore forces `token_out == token_in` and, via the fee/K logic, `rxd_out ≥ rxd_in`. The contract then proceeds to read `token_in` and `token_out` as if they could differ — a self-contradiction. The only state transition the contract permits is *donating* RXD to a pool whose token count can never change. The single working path is owner withdrawal.

`docs/CONTRACT_SPEC.md` §2.2 states the intent ("verifies the code portion remains identical while allowing the state portion to change"), but neither implementation does this.

**Impact.** As written, the contract cannot perform any swap. If the check is relaxed to *code-only* (the documented intent) without first fixing C1, the pool becomes trivially drainable (C1). Both criticals must be fixed together.

**Recommendation.** Compare only the code portion: split the locking bytecode at the state separator (or use the active-bytecode introspection that excludes state) and compare *that*. Combine with C1's token binding so legitimate state changes are constrained to real token movements.

---

## 🟠 H1 — SDK state parser scans for `0xbd`, disagreeing with the on-chain encoding — **FIXED**

**Location:** `src/utils/script.ts` (`decodeState`, `parsePoolScript`, `updateScriptState`)

The on-chain script extracts state by fixed length (`OP_SIZE 8 OP_SUB OP_SPLIT OP_NIP` — the last 8 bytes). The SDK instead located the state by scanning for the separator byte `0xbd` via `Buffer.lastIndexOf(0xbd)`. But `0xbd` is also a legal data byte inside the 8-byte little-endian token amount, so the scan can land *inside* the state.

**Proof of concept (confirmed):** building a pool with token amount `189n` (`0xbd 00 00 …`) and decoding it threw `State too small: 7 bytes` — the SDK could not read a valid pool. Any reserve whose LE encoding contains a `0xbd` byte was affected.

**Fix applied.** `decodeState`, `parsePoolScript`, and `updateScriptState` now locate the state by fixed length (`script.length − STATE_SIZE`), matching the on-chain encoding, and assert that the byte immediately preceding the state is `OP_STATESEPARATOR`. Regression test added in `tests/script.test.ts`.

---

## 🟠 H2 — `buildTradeTransaction` sell path double-counts proceeds — **FIXED**

**Location:** `src/trade.ts` (`buildTradeTransaction`)

For a sell, the RXD proceeds (`route.totalAmountOut`) were paid to the receiver output **and** added again into the change calculation (`+ receivedFromTrade`), so the transaction's outputs exceeded its inputs.

**Proof of concept (confirmed):** a sell of 500 tokens against a 100,000-sat / 10,000-token pool produced outputs exceeding inputs by 3,748 sat — an over-spending, unbroadcastable transaction.

**Fix applied.** The erroneous `+ receivedFromTrade` term was removed; the pool output already releases the proceeds to the receiver. After the fix, `Σ outputs == Σ inputs − minerFee` for the sell path (regression test added in `tests/trade.test.ts`).

> Note: this fix corrects the value arithmetic only. The token side is still unimplemented — see H3.

---

## 🟠 H3 — Token side of every swap is unimplemented in the tx builder

**Location:** `src/trade.ts:186-234`

`buildTradeTransaction` never creates or consumes a Glyph token input/output. On a buy it pays the receiver a 546-sat dust output but no token; on a sell it never takes the trader's tokens as an input. Combined with C1, the builder does not produce a real token swap. This must be rebuilt once C1's token binding exists, including the corresponding token inputs/outputs and ref propagation.

---

## 🟠 H4 — Deployable `.script` diverges from `.rxd`; no compile step

**Location:** `contracts/RadiantMMPool.script` vs `contracts/RadiantMMPool.rxd`

`.rxd` is v1.1 (ceiling-division fee + overflow guards). `.script` is v1.0 (floor-division fee, no overflow guard). There is no build step that compiles `.rxd → .script`, so the artifact most likely to be deployed is the older, weaker, hand-written one. Additionally, `docs/CONTRACT_SPEC.md` §6.1's own worked example shows the naive K math *rejecting a legitimate trade* — the rounding direction is wrong on paper. Establish a single source of truth and a compile/verify step, and pin a known-good test vector set.

---

## 🟡 M1 — Floor-division fee allows zero-fee trades

**Location:** `src/utils/math.ts:142` (`calculateFee`), `contracts/RadiantMMPool.script:89-92`

`fee = amount * 3 / 1000` with floor division yields `0` for any RXD delta below 334 sat. This enables fee-free micro-trades and slow LP-fee leakage. Only `.rxd` uses ceiling division; the deployable `.script` and the SDK do not. Align all three on ceiling division.

## 🟡 M2 — No on-chain overflow guard in `.script`; int64 assumptions unverified

**Location:** `contracts/RadiantMMPool.script`, `src/utils/math.ts:11-14`

`.rxd` guards `rxd ≤ MAX_INT64 / token` before multiplying; `.script` does not. The SDK uses `MAX_SAFE_VALUE = 2^62` while the contract constant is `2^63 − 1`. Whether `OP_MUL` overflows or uses big-int arithmetic on the target Radiant node is not verified by any test. Confirm the node's script-number semantics and make the guard consistent across `.rxd`, `.script`, and the SDK.

## 🟡 M3 — Multi-pool aggregation not implemented; no per-pool cap

**Location:** `src/trade.ts:163-181` (`calculatePoolAllocation`)

`calculatePoolAllocation` returns the entire remaining amount to the first sorted pool, so the headline "aggregate multiple pools for larger trades" feature does not exist, and there is no per-pool size cap (a large input into a small pool executes at a terrible price with no guard beyond global slippage). Implement real allocation across pools, or document the single-pool limitation.

## 🟡 M4 — Price oracle is manipulable and lossy

**Location:** `src/price.ts:34-66` (`getPrice`)

`getPrice` computes a liquidity-weighted average of spot prices using `Number(bigint)`. Anyone can create a pool with a skewed price and large RXD to move the reported aggregate, and values above `2^53` lose precision. Do not use this as a price feed without manipulation-resistant aggregation (e.g. TWAP over confirmed state, outlier rejection) and exact arithmetic.

---

## ⚪ Low / Informational

- **L1 — No signing, no e2e tests.** `TransactionBuilder.getSigningData` throws `Not implemented` (`src/transaction.ts:187-191`); there is no sighash/FORKID support, so the SDK cannot actually sign or broadcast. The 31 passing tests exercise SDK arithmetic against *mock* pools only — nothing runs the contract through a Radiant script interpreter or regtest, so a green suite is not evidence the contract works.
- **L2 — Fragile parsing.** `parsePoolScript` extracts the owner PKH via `indexOf([0x76,0xa9])` and assumes a single-byte push (`src/utils/script.ts`); `codeHash` is returned as a zero buffer placeholder.
- **L3 — Misc.** Hardcoded `minerFee = 1000n` in `trade.ts`/`liquidity.ts`; `tokenRef` is a dead parameter across the SDK; royalty helpers in `src/types.ts` are never enforced on-chain; `encodeTokenAmount` has no negative/range guard. Reentrancy is correctly N/A under the UTXO model.

---

## Remediation roadmap

1. **Contract redesign (C1 + C2) — blocking.** Add Glyph token binding via reference opcodes and derive reserves from real token quantities; change continuity to code-only. Validate on regtest with adversarial cases (forged `token_out`, no token movement, state freeze). A design-level proposal, draft contract, and regtest test plan are in [`docs/REDESIGN_C1_C2.md`](docs/REDESIGN_C1_C2.md) and [`contracts/RadiantMMPool.v2.draft.rxd`](contracts/RadiantMMPool.v2.draft.rxd) (both DRAFT — pending regtest validation of exact ref-opcode semantics).
2. **Tx builder (H2 fixed, H3 open).** Rebuild trade and withdraw flows around the new contract, including token inputs/outputs, real signing (L1), and dynamic fees.
3. **Consistency (H4, M1, M2).** Single source of truth for the contract; compile/verify step; align fee rounding and overflow handling across `.rxd`, `.script`, and the SDK.
4. **Routing & oracle (M3, M4).** Implement real multi-pool allocation; harden the price oracle.
5. **Testing (L1).** Add script-interpreter and regtest end-to-end tests, including the adversarial drain attempts above, before any public deployment.

## Already fixed in this pass

- **H1** — state parsing now length-based and consistent with the on-chain encoding (`src/utils/script.ts`), with a regression test.
- **H2** — sell-path double-count removed (`src/trade.ts`), with a balance regression test.
