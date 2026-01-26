# RadiantMM Contract Specification

## Overview

The RadiantMM contract implements a Constant Product Market Maker (CPMM) using Radiant's UTXO model. Each pool is an independent micro-pool that enforces the invariant `K = x * y` where `x` is RXD amount and `y` is token amount.

---

## 1. Bytecode Structure

### 1.1 Script Layout

```
[CODE_PORTION][OP_STATESEPARATOR][STATE_PORTION]
```

| Section | Description | Size |
|---------|-------------|------|
| Code Portion | Immutable CPMM logic | ~200-400 bytes |
| State Separator | `OP_STATESEPARATOR` (0xbd) | 1 byte |
| State Portion | Mutable pool state | ~30 bytes |

### 1.2 Code Portion Structure

```
OP_DEPTH                          // Check if withdrawal (sig+pk provided)
OP_IF
    // Withdrawal path
    OP_DUP OP_HASH160
    <20:owner_pkh>
    OP_EQUALVERIFY OP_CHECKSIG
OP_ELSE
    // Trade path
    [Contract continuity verification]
    [K calculation and enforcement]
OP_ENDIF
```

---

## 2. State Script Encoding

### 2.1 State Format

```
<8:token_amount><32:token_ref>
```

| Field | Type | Size | Description |
|-------|------|------|-------------|
| token_amount | int64 | 8 bytes | Current token quantity in pool |
| token_ref | bytes32 | 32 bytes | Glyph token reference (singleton ID) |

### 2.2 State Access

During trade execution:
- **Input state**: Read from `tx.inputs[activeInputIndex]` state portion
- **Output state**: Read from `tx.outputs[activeInputIndex]` state portion

The contract verifies the code portion remains identical while allowing the state portion to change.

---

## 3. Execution Paths

### 3.1 Path 1: Withdrawal (Owner)

**Trigger**: `unlockScript` contains `<signature> <pubkey>`

**Validation**:
1. `HASH160(pubkey) == ownerPkh` (embedded in code)
2. `CHECKSIG(signature, pubkey)` passes

**Constraints**: None on outputs - owner has full control

**Use Case**: Owner withdraws liquidity from pool

### 3.2 Path 2: Trade (Anyone)

**Trigger**: `unlockScript` is empty

**Validation**:
1. Output bytecode at same index equals input bytecode (continuity)
2. `K_output >= K_input` (constant product maintained)

**Constraints**:
- Pool must continue at same output index
- Token amounts must be correctly updated in state
- RXD + fee must maintain or increase K

---

## 4. K Invariant Calculation

### 4.1 Formula

```
K = RXD_amount × Token_amount
```

### 4.2 Trade Verification

For a valid trade:
```
K_out = (RXD_out - fee) × Token_out
K_in  = RXD_in × Token_in

require(K_out >= K_in)
```

### 4.3 Fee Calculation

```
fee = |RXD_out - RXD_in| × 3 / 1000    // 0.3%
```

---

## 5. Edge Cases & Limits

### 5.1 Maximum Pool Size

Due to 64-bit signed arithmetic:
- Max safe value: `2^63 - 1 = 9,223,372,036,854,775,807`
- Max K before overflow: `~9.2e18`
- Recommended max per asset: `~3e9` (3 billion satoshis / tokens)

### 5.2 Minimum Trade Size

To prevent dust and rounding exploits:
- Minimum RXD: 546 satoshis (dust limit)
- Minimum token: 1 unit
- Minimum K: 546

### 5.3 Zero-Value Handling

- `token_amount = 0`: Pool is RXD-only, invalid for trading
- `rxd_amount = 0`: Pool is empty, invalid for trading
- Both pools should be withdrawn by owner, not traded

### 5.4 Overflow Prevention

The contract should verify before multiplication:
```
if (rxd > MAX_SAFE / token) revert overflow
```

Where `MAX_SAFE = 2^62` to allow for fee calculations.

---

## 6. Test Vectors

### 6.1 Basic Trade (Buy Tokens)

```
Initial State:
  RXD: 10,000 sat
  Token: 1,000 units
  K: 10,000,000

Trade: Add 1,000 RXD to buy tokens

New RXD: 11,000 sat
New Token: 10,000,000 / 11,000 = 909 units (rounded down)
Tokens received: 1,000 - 909 = 91 tokens

Fee: 1,000 × 3 / 1000 = 3 sat

Verification:
  K_in = 10,000 × 1,000 = 10,000,000
  K_out = (11,000 - 3) × 909 = 9,991,863
  
  ERROR: K_out < K_in! Trade rejected.
  
Correct calculation:
  Required new token = ceil(K / (rxd_out - fee))
  = ceil(10,000,000 / 10,997) = 910 tokens
  Tokens received: 90 tokens
  
  K_out = 10,997 × 910 = 10,007,270 ✓
```

### 6.2 Basic Trade (Sell Tokens)

```
Initial State:
  RXD: 10,000 sat
  Token: 1,000 units
  K: 10,000,000

Trade: Add 100 tokens to get RXD

New Token: 1,100 units
New RXD: 10,000,000 / 1,100 = 9,090 sat (rounded down)
RXD received: 10,000 - 9,090 = 910 sat

Fee: 910 × 3 / 1000 = 2 sat (paid by trader)
Net RXD received: 908 sat

Verification:
  K_in = 10,000 × 1,000 = 10,000,000
  K_out = (9,090 + 2) × 1,100 = 10,001,200 ✓
```

### 6.3 Withdrawal

```
Unlock Script: <signature> <pubkey>
  
Validation:
  HASH160(pubkey) == ownerPkh: true
  CHECKSIG(sig, pk): true
  
Result: Script returns true, owner can spend to any outputs
```

---

## 7. Security Considerations

### 7.1 Reentrancy

Not applicable - UTXO model is inherently atomic.

### 7.2 Front-running (MEV)

Vulnerable to miner/mempool front-running. Mitigations:
- Slippage tolerance in SDK
- Future: commit-reveal scheme

### 7.3 Integer Overflow

Mitigated by:
- Maximum pool size limits
- SDK-side validation before tx construction

### 7.4 State Manipulation

Prevented by bytecode continuity check - attacker cannot modify the code portion.

---

## 8. Appendix: Opcode Reference

| Opcode | Hex | Description |
|--------|-----|-------------|
| OP_DEPTH | 0x74 | Push stack depth |
| OP_IF | 0x63 | Begin if block |
| OP_ELSE | 0x67 | Begin else block |
| OP_ENDIF | 0x68 | End if block |
| OP_DUP | 0x76 | Duplicate top stack item |
| OP_HASH160 | 0xa9 | SHA256 + RIPEMD160 |
| OP_EQUALVERIFY | 0x88 | Verify equality, abort if false |
| OP_CHECKSIG | 0xac | Verify signature |
| OP_INPUTINDEX | 0xc0 | Push current input index |
| OP_UTXOVALUE | 0xc5 | Push UTXO value at index |
| OP_OUTPUTVALUE | 0xc6 | Push output value at index |
| OP_UTXOBYTECODE | 0xc7 | Push UTXO bytecode at index |
| OP_OUTPUTBYTECODE | 0xc8 | Push output bytecode at index |
| OP_MUL | 0x95 | Multiply |
| OP_DIV | 0x96 | Divide |
| OP_ABS | 0x90 | Absolute value |
| OP_SUB | 0x94 | Subtract |
| OP_GREATERTHANOREQUAL | 0xa2 | Compare >= |
| OP_STATESEPARATOR | 0xbd | Separates code from state |
