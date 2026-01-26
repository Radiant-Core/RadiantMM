# RadiantMM: An Efficient Constant Product Market Maker on Radiant Through Micro-Pools

**Version 1.0**  
**January 2026**

---

## Abstract

This paper introduces RadiantMM, a Constant Product Market Maker (CPMM) implementation on the Radiant blockchain using a micro-pools architecture. By leveraging Radiant's unique UTXO model with native introspection opcodes and reference system, RadiantMM enables decentralized liquidity pools for trading RXD against Glyph tokens. The micro-pools approach eliminates the need for global state management, allowing individual liquidity providers to operate independent CPMM contracts that can be aggregated for larger trades. This design achieves unprecedented scalability while maintaining the security guarantees of the underlying blockchain.

---

## 1. Introduction

### 1.1 Background

Constant Function Market Makers (CFMMs) have revolutionized decentralized finance by providing algorithmic liquidity without traditional order books. The most successful implementation, the Constant Product Market Maker (CPMM), uses the invariant `K = x * y` to price assets, where `x` and `y` represent the quantities of two assets in a liquidity pool.

### 1.2 Motivation

Radiant blockchain offers several unique properties that make it ideal for implementing on-chain CPMM contracts:

1. **UTXO Model**: Enables atomic, composable transactions
2. **Native Introspection**: Opcodes to inspect transaction inputs/outputs within Script
3. **Reference System**: Unique singleton and fungible token support via `OP_PUSHINPUTREF`
4. **64-bit Arithmetic**: Native support for large number operations
5. **Low Fees**: Economically viable for frequent small trades

Currently, Radiant lacks a native decentralized exchange. RadiantMM fills this gap by providing trustless, non-custodial token swaps directly on-chain.

### 1.3 Design Goals

- **Trustless**: No intermediaries or custodians
- **Permissionless**: Anyone can create pools or trade
- **Scalable**: Micro-pools eliminate global state bottlenecks
- **Composable**: Multiple pools can be aggregated in single transactions
- **Simple**: Minimal contract complexity reduces attack surface

---

## 2. Radiant Preliminaries

### 2.1 UTXO Model

Radiant uses the Unspent Transaction Output (UTXO) model where each output can contain:
- Native RXD (satoshis)
- Locking script (spending conditions)
- Reference data (for Glyph tokens)

### 2.2 Introspection Opcodes

Radiant provides native introspection capabilities:

| Opcode | Function |
|--------|----------|
| `OP_INPUTINDEX` | Returns index of current input being evaluated |
| `OP_UTXOVALUE` | Returns satoshi value of a UTXO |
| `OP_OUTPUTVALUE` | Returns satoshi value of an output |
| `OP_UTXOBYTECODE` | Returns locking script of a UTXO |
| `OP_OUTPUTBYTECODE` | Returns locking script of an output |
| `OP_TXVERSION` | Returns transaction version |
| `OP_TXINPUTCOUNT` | Returns number of inputs |
| `OP_TXOUTPUTCOUNT` | Returns number of outputs |

### 2.3 Reference System

Radiant's reference system enables token functionality:

| Opcode | Function |
|--------|----------|
| `OP_PUSHINPUTREF` | Push a reference onto stack |
| `OP_REQUIREINPUTREF` | Require specific reference in inputs |
| `OP_REFVALUESUM_UTXOS` | Sum values of UTXOs with reference |
| `OP_REFVALUESUM_OUTPUTS` | Sum values of outputs with reference |
| `OP_REFOUTPUTCOUNT_UTXOS` | Count UTXOs with reference |
| `OP_REFOUTPUTCOUNT_OUTPUTS` | Count outputs with reference |

### 2.4 Arithmetic Opcodes

Radiant supports 64-bit signed arithmetic:

| Opcode | Function |
|--------|----------|
| `OP_MUL` | Multiplication |
| `OP_DIV` | Integer division |
| `OP_MOD` | Modulo |
| `OP_ADD` | Addition |
| `OP_SUB` | Subtraction |
| `OP_ABS` | Absolute value |

---

## 3. RadiantMM Contract Structure

### 3.1 Micro-Pools Concept

RadiantMM deviates from the traditional single large liquidity pool model by utilizing multiple small-scale CPMM contracts called **micro-pools**. Each liquidity provider operates their own set of micro-pools.

**Advantages:**
- No global state coordination required
- Each pool is independent and can be created permissionlessly
- Pools can be aggregated for larger trades
- LP retains full ownership and earns 100% of fees from their pool

### 3.2 Pool Types

RadiantMM supports two pool configurations:

#### Type A: RXD/Glyph Token Pools
Pools containing RXD and a Glyph fungible token, identified by reference.

#### Type B: RXD-Only Pools (Wrapped RXD)
Pools for trading between RXD and a contract-wrapped representation, useful for creating synthetic positions.

### 3.3 Constant Product Property

The contract enforces the constant product formula:

```
K = x * y
```

Where:
- `K` = constant product (invariant)
- `x` = quantity of RXD (in satoshis)
- `y` = quantity of tokens (or token-equivalent value)

For any trade, the contract verifies:

```
K_output >= K_input - fee_allowance
```

### 3.4 Fee Structure

A 0.3% fee accrues to liquidity providers:

```
fee = |RXD_out - RXD_in| * 3 / 1000
```

The fee is subtracted from the output side, ensuring `K` remains constant or increases.

---

## 4. Contract Logic

### 4.1 Contract Paths

The RadiantMM contract supports two execution paths:

#### Path 1: Withdrawal (Owner Only)
```
IF <signature> <pubkey>:
    Verify pubkey hash matches owner
    Verify signature
    Allow any output configuration
```

#### Path 2: Trade (Anyone)
```
ELSE:
    Verify contract continuity (same bytecode in output)
    Verify reference continuity (same token in output)
    Calculate K_input = UTXO_value * token_amount
    Calculate fee
    Calculate K_output = (output_value - fee) * output_token_amount
    Verify K_output >= K_input
```

### 4.2 Contract Pseudocode

```
# Check if withdrawal (owner provides signature)
OP_DEPTH
OP_IF
    # Withdrawal path
    OP_DUP
    OP_HASH160
    <owner_pkh>
    OP_EQUALVERIFY
    OP_CHECKSIG
OP_ELSE
    # Trade path
    
    # Verify contract lives on in corresponding output
    OP_INPUTINDEX
    OP_OUTPUTBYTECODE
    OP_INPUTINDEX
    OP_UTXOBYTECODE
    OP_EQUALVERIFY
    
    # Verify reference continuity (token identity)
    OP_INPUTINDEX
    <token_ref>
    OP_REQUIREINPUTREF
    
    # Calculate input K
    OP_INPUTINDEX
    OP_UTXOVALUE          # RXD in
    <token_amount_in>     # From state or reference
    OP_MUL                # K_input
    
    # Calculate fee: |delta_rxd| * 3 / 1000
    OP_INPUTINDEX
    OP_UTXOVALUE
    OP_INPUTINDEX
    OP_OUTPUTVALUE
    OP_SUB
    OP_ABS
    3
    OP_MUL
    1000
    OP_DIV                # fee
    
    # Calculate effective output K
    OP_INPUTINDEX
    OP_OUTPUTVALUE
    OP_SWAP
    OP_SUB                # RXD_out - fee
    <token_amount_out>    # From state or calculation
    OP_MUL                # K_output
    
    # Verify K_output >= K_input
    OP_SWAP
    OP_GREATERTHANOREQUAL
OP_ENDIF
```

### 4.3 Token Amount Tracking

For Glyph token pools, token amounts can be tracked via:

**Option A: State Script**
Store token amount in the state portion of the locking script using `OP_STATESEPARATOR`.

**Option B: Reference Value**
Use `OP_REFVALUESUM_UTXOS` and `OP_REFVALUESUM_OUTPUTS` to track token quantities.

**Option C: Auxiliary UTXO**
Include token amount as a separate UTXO that must accompany the pool UTXO.

---

## 5. Aggregating Micro-Pools

### 5.1 Multi-Pool Trades

Multiple micro-pools can be combined in a single transaction to increase available liquidity:

```
Transaction:
  Inputs:
    [0] Pool A (10,000 RXD, 100 TOKEN)
    [1] Pool B (5,000 RXD, 50 TOKEN)
    [2] Trader's RXD
  Outputs:
    [0] Pool A (11,000 RXD, 91 TOKEN)
    [1] Pool B (5,500 RXD, 46 TOKEN)
    [2] Trader receives 13 TOKEN
    [3] Change to trader
```

Each pool independently verifies its own K constraint, but liquidity is effectively combined.

### 5.2 Routing Algorithm

For optimal execution, trades should be routed across pools to minimize slippage:

1. Query all available pools for the token pair
2. Sort by effective price
3. Split trade across pools to minimize price impact
4. Construct single transaction consuming multiple pools

---

## 6. Use Cases

### 6.1 Decentralized Token Exchange

Primary use case: trustless swaps between RXD and Glyph tokens.

### 6.2 Atomic Merchant Payments

A customer holding RXD can pay a merchant requesting a specific token in a single atomic transaction:

```
Inputs:
  [0] CPMM Pool (RXD + TOKEN)
  [1] Customer's RXD
Outputs:
  [0] CPMM Pool (rebalanced)
  [1] Merchant receives TOKEN
  [2] Customer receives RXD change
```

### 6.3 Liquidity Provision

Token holders can earn passive income by creating micro-pools and collecting the 0.3% trading fee.

### 6.4 Price Discovery

Aggregated pool prices provide on-chain price discovery for Glyph tokens.

---

## 7. Security Considerations

### 7.1 Overflow Protection

Radiant's 64-bit arithmetic limits maximum pool sizes to prevent overflow:
- Max RXD per pool: ~92 billion satoshis (~920 RXD)
- For larger pools, amounts should be scaled or multiple pools used

### 7.2 MEV (Miner Extractable Value)

RadiantMM does not include native MEV protection. Potential mitigations:
- **Commit-reveal**: Two-phase trades (increases latency)
- **Batch auctions**: Aggregate trades per block
- **Slippage limits**: User-specified maximum price deviation

### 7.3 Impermanent Loss

Standard CPMM impermanent loss applies. LPs should understand the risks before providing liquidity.

### 7.4 Contract Bugs

The contract should undergo:
- Formal verification where possible
- Multiple independent audits
- Gradual rollout with TVL caps

---

## 8. Comparison with Cauldron (BCH)

| Feature | Cauldron (BCH) | RadiantMM |
|---------|----------------|-----------|
| Blockchain | Bitcoin Cash | Radiant |
| Token System | CashTokens | Glyph/References |
| Pool Type | Micro-pools | Micro-pools |
| Curve | CPMM (x*y=k) | CPMM (x*y=k) |
| Fee | 0.3% | 0.3% |
| MEV Protection | None | None (Phase 1) |
| Integer Size | 64-bit | 64-bit |
| Introspection | Native | Native |

---

## 9. Future Work

### 9.1 Phase 2: MEV Protection
Implement commit-reveal or joint-execution schemes.

### 9.2 Phase 3: Alternative Curves
- Concentrated liquidity (Uniswap V3 style)
- Stableswap curves for pegged assets
- Custom curves via parameterization

### 9.3 Phase 4: Governance Token
Optional protocol token for:
- Fee sharing across all pools
- Protocol parameter governance
- Liquidity mining incentives

---

## 10. Conclusion

RadiantMM brings efficient, trustless token exchange to the Radiant blockchain by adapting the proven Cauldron micro-pools architecture. The design leverages Radiant's native introspection and reference opcodes to implement CPMM contracts without requiring any protocol changes. By enabling permissionless liquidity provision and atomic swaps, RadiantMM serves as a foundational building block for Radiant's DeFi ecosystem.

---

## References

1. Johannsson, D.V. "Cauldron: An efficient Constant Product Market Maker Contract on Bitcoin Cash Through Micro-Pools." Riften Labs, 2023.

2. Berenzon, D. "Constant Function Market Makers: DeFi's 'Zero to One' Innovation." Bollinger Investment Group, 2020.

3. Adams, H., et al. "Uniswap v2 Core." Uniswap, 2020.

4. Radiant Blockchain. "REP-0002: Introspection Opcodes." Radiant Enhancement Proposals.

5. Radiant Blockchain. "REP-0003: Reference System." Radiant Enhancement Proposals.

---

## Appendix A: Full Contract Code (RadiantScript)

```radiantscript
// RadiantMM Micro-Pool Contract v1.0
// SPDX-License-Identifier: MIT

pragma radiant ^1.0.0;

contract RadiantMMPool(
    bytes20 ownerPkh,      // Owner's public key hash
    bytes32 tokenRef       // Glyph token reference
) {
    // Withdrawal: owner reclaims all funds
    function withdraw(pubkey pk, sig s) {
        require(hash160(pk) == ownerPkh);
        require(checkSig(s, pk));
    }
    
    // Trade: anyone can swap while maintaining K
    function trade() {
        // Verify contract continuity
        require(tx.outputs[this.activeInputIndex].lockingBytecode == 
                tx.inputs[this.activeInputIndex].lockingBytecode);
        
        // Get input values
        int rxdIn = tx.inputs[this.activeInputIndex].value;
        int tokenIn = getTokenAmount(this.activeInputIndex, true);
        int kInput = rxdIn * tokenIn;
        
        // Get output values  
        int rxdOut = tx.outputs[this.activeInputIndex].value;
        int tokenOut = getTokenAmount(this.activeInputIndex, false);
        
        // Calculate fee: 0.3% of RXD delta
        int fee = abs(rxdOut - rxdIn) * 3 / 1000;
        
        // Calculate effective output K
        int kOutput = (rxdOut - fee) * tokenOut;
        
        // Enforce constant product
        require(kOutput >= kInput);
    }
}
```

---

## Appendix B: Example Transactions

### B.1 Pool Creation

```
Inputs:
  [0] Owner's RXD (funding)
  [1] Owner's Glyph tokens
Outputs:
  [0] RadiantMM Pool (10,000 RXD + 1,000 TOKEN)
      K = 10,000 * 1,000 = 10,000,000
```

### B.2 Buy Tokens (RXD → TOKEN)

```
Initial: Pool has 10,000 RXD, 1,000 TOKEN (K = 10,000,000)
Trade: Buy 100 TOKEN

Required RXD = (10,000 * 1,000) / (1,000 - 100) - 10,000
             = 10,000,000 / 900 - 10,000
             = 11,111.11 - 10,000
             = 1,111.11 RXD + fee

Final: Pool has 11,114.45 RXD, 900 TOKEN
```

### B.3 Sell Tokens (TOKEN → RXD)

```
Initial: Pool has 10,000 RXD, 1,000 TOKEN (K = 10,000,000)
Trade: Sell 100 TOKEN

RXD out = 10,000 - (10,000,000 / (1,000 + 100))
        = 10,000 - 9,090.91
        = 909.09 RXD - fee

Final: Pool has 9,093.64 RXD, 1,100 TOKEN
```

---

*© 2026 Radiant Community. This document is released under the MIT License.*
