# RadiantMM Implementation Plan

## Executive Summary

This document outlines the complete implementation roadmap for RadiantMM, a Constant Product Market Maker protocol for Radiant blockchain. The project is divided into four phases spanning approximately 6-9 months.

---

## Phase 1: Core Contract Development (Weeks 1-6)

### 1.1 Contract Design & Specification (Week 1-2)

**Deliverables:**
- [ ] Finalize contract bytecode structure
- [ ] Define state script encoding format
- [ ] Document all execution paths
- [ ] Create test vector suite

**Tasks:**
```
1. Define locking script template
   - Code portion (immutable CPMM logic)
   - State separator usage
   - State portion (token amount, owner pkh)

2. Specify unlock conditions
   - Trade path: empty unlock script
   - Withdraw path: <sig> <pubkey>

3. Document edge cases
   - Maximum pool sizes (overflow prevention)
   - Minimum amounts (dust prevention)
   - Fee calculation precision
```

**Owner:** Contract Developer
**Dependencies:** None

### 1.2 RadiantScript Contract (Week 2-3)

**Deliverables:**
- [ ] RadiantScript source file (`RadiantMMPool.rxd`)
- [ ] Compiled bytecode
- [ ] Unit tests

**Contract Structure:**
```radiantscript
// File: contracts/RadiantMMPool.rxd

pragma radiant ^1.0.0;

contract RadiantMMPool(
    bytes20 ownerPkh,
    int tokenAmount
) {
    function withdraw(pubkey pk, sig s) {
        require(hash160(pk) == ownerPkh);
        require(checkSig(s, pk));
    }
    
    function trade() {
        // Verify contract continuity
        bytes inputBytecode = tx.inputs[this.activeInputIndex].lockingBytecode;
        bytes outputBytecode = tx.outputs[this.activeInputIndex].lockingBytecode;
        require(outputBytecode == inputBytecode);
        
        // Calculate K values
        int rxdIn = tx.inputs[this.activeInputIndex].value;
        int rxdOut = tx.outputs[this.activeInputIndex].value;
        int kIn = rxdIn * tokenAmount;
        
        // Get output token amount from state
        int tokenOut = getOutputTokenAmount();
        
        // Calculate fee
        int fee = abs(rxdOut - rxdIn) * 3 / 1000;
        int kOut = (rxdOut - fee) * tokenOut;
        
        require(kOut >= kIn);
    }
}
```

**Owner:** Contract Developer
**Dependencies:** 1.1

### 1.3 Raw Script Implementation (Week 3-4)

**Deliverables:**
- [ ] Hand-optimized Bitcoin Script
- [ ] Size optimization (<500 bytes target)
- [ ] Opcode-level documentation

**Script Template:**
```
# RadiantMM v1.0 - Optimized Script
# Total size target: <500 bytes

OP_DEPTH
OP_IF
    # Withdrawal
    OP_DUP OP_HASH160 <20:owner_pkh> OP_EQUALVERIFY OP_CHECKSIG
OP_ELSE
    # Trade verification
    OP_INPUTINDEX OP_OUTPUTBYTECODE
    OP_INPUTINDEX OP_UTXOBYTECODE
    OP_EQUALVERIFY
    
    # K_in calculation
    OP_INPUTINDEX OP_UTXOVALUE
    <8:token_amount>
    OP_MUL
    
    # Fee calculation
    OP_INPUTINDEX OP_UTXOVALUE
    OP_INPUTINDEX OP_OUTPUTVALUE
    OP_SUB OP_ABS
    OP_3 OP_MUL
    <2:03e8>  # 1000
    OP_DIV
    
    # K_out calculation
    OP_INPUTINDEX OP_OUTPUTVALUE
    OP_SWAP OP_SUB
    # TODO: Get output token amount from state
    OP_MUL
    
    # Verify K_out >= K_in
    OP_SWAP OP_GREATERTHANOREQUAL
OP_ENDIF
```

**Owner:** Contract Developer
**Dependencies:** 1.2

### 1.4 Contract Testing (Week 4-6)

**Deliverables:**
- [ ] Unit test suite (50+ test cases)
- [ ] Integration tests
- [ ] Fuzz testing harness
- [ ] Test coverage report

**Test Categories:**
```
1. Happy Path Tests
   - Basic trade (RXD → TOKEN)
   - Basic trade (TOKEN → RXD)
   - Owner withdrawal
   - Multi-pool aggregation

2. Edge Case Tests
   - Minimum trade amounts
   - Maximum pool sizes
   - Zero-value edge cases
   - Overflow boundaries

3. Security Tests
   - Invalid signature rejection
   - Wrong owner rejection
   - K violation rejection
   - Bytecode modification rejection

4. Fuzz Tests
   - Random valid trades
   - Random invalid trades
   - Malformed transactions
```

**Test Framework:**
```typescript
// tests/radiantmm.test.ts
import { RadiantMMPool, TestHarness } from '../src';

describe('RadiantMM Pool', () => {
    let harness: TestHarness;
    
    beforeEach(() => {
        harness = new TestHarness();
    });
    
    describe('Trade Execution', () => {
        it('should accept valid RXD->TOKEN trade', async () => {
            const pool = await harness.createPool(10000, 1000);
            const result = await harness.executeTrade(pool, 1000, 'buy');
            expect(result.success).toBe(true);
            expect(result.newK).toBeGreaterThanOrEqual(result.oldK);
        });
        
        it('should reject trade violating K', async () => {
            const pool = await harness.createPool(10000, 1000);
            const result = await harness.executeInvalidTrade(pool);
            expect(result.success).toBe(false);
            expect(result.error).toContain('K_OUT_LESS_THAN_K_IN');
        });
    });
});
```

**Owner:** QA Engineer
**Dependencies:** 1.3

---

## Phase 2: SDK Development (Weeks 7-10)

### 2.1 Core SDK Library (Week 7-8)

**Deliverables:**
- [ ] TypeScript SDK package
- [ ] Pool UTXO parsing
- [ ] Transaction building
- [ ] Price calculations

**SDK Structure:**
```
packages/radiantmm-sdk/
├── src/
│   ├── index.ts
│   ├── pool.ts           # Pool class
│   ├── trade.ts          # Trade execution
│   ├── liquidity.ts      # LP operations
│   ├── price.ts          # Price calculations
│   ├── transaction.ts    # TX building
│   └── utils/
│       ├── script.ts     # Script encoding
│       ├── math.ts       # BigInt operations
│       └── encoding.ts   # State encoding
├── tests/
├── package.json
└── tsconfig.json
```

**Core Classes:**
```typescript
// src/pool.ts
export class RadiantMMPool {
    readonly utxo: UTXO;
    readonly rxdAmount: bigint;
    readonly tokenAmount: bigint;
    readonly ownerPkh: Buffer;
    readonly tokenRef?: Buffer;
    
    get k(): bigint {
        return this.rxdAmount * this.tokenAmount;
    }
    
    get spotPrice(): number {
        return Number(this.rxdAmount) / Number(this.tokenAmount);
    }
    
    getTokensForRxd(rxdIn: bigint): bigint {
        const newRxd = this.rxdAmount + rxdIn;
        const newTokens = this.k / newRxd;
        return this.tokenAmount - newTokens;
    }
    
    getRxdForTokens(tokensIn: bigint): bigint {
        const newTokens = this.tokenAmount + tokensIn;
        const newRxd = this.k / newTokens;
        return this.rxdAmount - newRxd;
    }
}

// src/trade.ts
export class TradeBuilder {
    private pools: RadiantMMPool[] = [];
    private inputUtxos: UTXO[] = [];
    
    addPool(pool: RadiantMMPool): this {
        this.pools.push(pool);
        return this;
    }
    
    addFunding(utxo: UTXO): this {
        this.inputUtxos.push(utxo);
        return this;
    }
    
    async buildSwapTx(params: SwapParams): Promise<Transaction> {
        // Route trade across pools
        const route = this.calculateOptimalRoute(params);
        
        // Build transaction
        const tx = new Transaction();
        
        // Add pool inputs/outputs
        for (const step of route) {
            tx.addInput(step.pool.utxo);
            tx.addOutput(step.newPoolOutput);
        }
        
        // Add funding and change
        tx.addInput(...this.inputUtxos);
        tx.addOutput(params.receiverOutput);
        tx.addOutput(params.changeOutput);
        
        return tx;
    }
}
```

**Owner:** SDK Developer
**Dependencies:** 1.3

### 2.2 Electrum Integration (Week 8-9)

**Deliverables:**
- [ ] Pool discovery via Electrum
- [ ] UTXO fetching
- [ ] Transaction broadcasting

**Integration:**
```typescript
// src/electrum.ts
export class RadiantMMElectrum {
    private client: ElectrumClient;
    
    async discoverPools(tokenRef?: Buffer): Promise<RadiantMMPool[]> {
        // Get all UTXOs matching RadiantMM script pattern
        const scriptHash = this.getPoolScriptHash();
        const utxos = await this.client.getUtxos(scriptHash);
        
        // Parse each UTXO into Pool object
        return utxos.map(utxo => RadiantMMPool.fromUtxo(utxo));
    }
    
    async broadcastTrade(tx: Transaction): Promise<string> {
        return this.client.broadcast(tx.toHex());
    }
}
```

**Owner:** SDK Developer
**Dependencies:** 2.1

### 2.3 Price Oracle (Week 9-10)

**Deliverables:**
- [ ] Real-time price aggregation
- [ ] TWAP calculation
- [ ] Price feed API

**Implementation:**
```typescript
// src/oracle.ts
export class RadiantMMOracle {
    private pools: Map<string, RadiantMMPool[]> = new Map();
    
    async getPrice(tokenRef: string): Promise<PriceData> {
        const pools = await this.getPools(tokenRef);
        
        // Aggregate prices weighted by liquidity
        let totalWeight = 0n;
        let weightedPrice = 0n;
        
        for (const pool of pools) {
            const weight = pool.rxdAmount;
            weightedPrice += pool.spotPrice * weight;
            totalWeight += weight;
        }
        
        return {
            spot: Number(weightedPrice / totalWeight),
            pools: pools.length,
            totalLiquidity: totalWeight
        };
    }
    
    async getTwap(tokenRef: string, period: number): Promise<number> {
        // Calculate time-weighted average price
        const prices = await this.getHistoricalPrices(tokenRef, period);
        return prices.reduce((a, b) => a + b, 0) / prices.length;
    }
}
```

**Owner:** SDK Developer
**Dependencies:** 2.2

---

## Phase 3: Interface Development (Weeks 11-16)

### 3.1 Web Application (Week 11-14)

**Deliverables:**
- [ ] React web application
- [ ] Swap interface
- [ ] Pool creation UI
- [ ] Portfolio view

**Tech Stack:**
- Framework: React 18 + Vite
- Styling: TailwindCSS
- State: Zustand
- Wallet: Photonic wallet integration

**UI Components:**
```
frontend/
├── src/
│   ├── App.tsx
│   ├── components/
│   │   ├── SwapCard.tsx
│   │   ├── PoolList.tsx
│   │   ├── CreatePool.tsx
│   │   ├── PriceChart.tsx
│   │   └── WalletConnect.tsx
│   ├── hooks/
│   │   ├── useRadiantMM.ts
│   │   ├── usePools.ts
│   │   └── useWallet.ts
│   ├── pages/
│   │   ├── Swap.tsx
│   │   ├── Pools.tsx
│   │   ├── Create.tsx
│   │   └── Portfolio.tsx
│   └── lib/
│       └── radiantmm.ts
├── package.json
└── vite.config.ts
```

**Swap Interface Mockup:**
```
┌─────────────────────────────────────┐
│  RadiantMM         [Connect Wallet] │
├─────────────────────────────────────┤
│                                     │
│  ┌─────────────────────────────┐   │
│  │ From                         │   │
│  │ RXD                    1000 │   │
│  │ Balance: 50,000             │   │
│  └─────────────────────────────┘   │
│              ↓                      │
│  ┌─────────────────────────────┐   │
│  │ To                          │   │
│  │ GLYPH              ≈ 95.2  │   │
│  │ Balance: 0                  │   │
│  └─────────────────────────────┘   │
│                                     │
│  Rate: 1 RXD = 0.0952 GLYPH        │
│  Slippage: 0.5%                    │
│  Fee: 3 RXD (0.3%)                 │
│                                     │
│  [        Swap        ]            │
│                                     │
└─────────────────────────────────────┘
```

**Owner:** Frontend Developer
**Dependencies:** 2.1, 2.2

### 3.2 Indexer Service (Week 14-16)

**Deliverables:**
- [ ] Pool indexing service
- [ ] REST API
- [ ] WebSocket updates
- [ ] Historical data

**Architecture:**
```
indexer/
├── src/
│   ├── index.ts
│   ├── scanner.ts        # Block scanner
│   ├── parser.ts         # Pool UTXO parser
│   ├── database.ts       # PostgreSQL interface
│   ├── api/
│   │   ├── routes.ts
│   │   ├── pools.ts
│   │   └── prices.ts
│   └── websocket.ts
├── Dockerfile
└── docker-compose.yml
```

**API Endpoints:**
```
GET  /api/v1/pools                    # List all pools
GET  /api/v1/pools/:tokenRef          # Pools for token
GET  /api/v1/pools/:poolId            # Single pool
GET  /api/v1/price/:tokenRef          # Current price
GET  /api/v1/price/:tokenRef/history  # Price history
POST /api/v1/quote                    # Get swap quote
WS   /ws/pools                        # Real-time updates
```

**Database Schema:**
```sql
CREATE TABLE pools (
    id SERIAL PRIMARY KEY,
    utxo_txid VARCHAR(64) NOT NULL,
    utxo_vout INTEGER NOT NULL,
    rxd_amount BIGINT NOT NULL,
    token_amount BIGINT NOT NULL,
    token_ref VARCHAR(64),
    owner_pkh VARCHAR(40) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    spent_at TIMESTAMP,
    UNIQUE(utxo_txid, utxo_vout)
);

CREATE TABLE trades (
    id SERIAL PRIMARY KEY,
    pool_id INTEGER REFERENCES pools(id),
    txid VARCHAR(64) NOT NULL,
    rxd_delta BIGINT NOT NULL,
    token_delta BIGINT NOT NULL,
    fee BIGINT NOT NULL,
    timestamp TIMESTAMP DEFAULT NOW()
);

CREATE TABLE prices (
    id SERIAL PRIMARY KEY,
    token_ref VARCHAR(64) NOT NULL,
    price DECIMAL(20, 8) NOT NULL,
    liquidity BIGINT NOT NULL,
    timestamp TIMESTAMP DEFAULT NOW()
);
```

**Owner:** Backend Developer
**Dependencies:** 2.2

---

## Phase 4: Security & Launch (Weeks 17-24)

### 4.1 Security Audit (Week 17-20)

**Deliverables:**
- [ ] External audit report
- [ ] Vulnerability remediation
- [ ] Formal verification (if feasible)

**Audit Scope:**
1. Smart contract bytecode
2. SDK transaction building
3. Price calculation logic
4. State encoding/decoding

**Audit Firms (Suggested):**
- Trail of Bits
- OpenZeppelin
- Consensys Diligence
- Independent Bitcoin Script experts

**Budget Estimate:** $30,000 - $80,000

**Owner:** Security Lead
**Dependencies:** 1.4, 2.1

### 4.2 Testnet Deployment (Week 20-22)

**Deliverables:**
- [ ] Testnet contract deployment
- [ ] Public beta testing
- [ ] Bug bounty program
- [ ] Documentation

**Testnet Checklist:**
```
[ ] Deploy sample pools
[ ] Test all trade scenarios
[ ] Stress test with concurrent trades
[ ] Monitor for edge cases
[ ] Gather community feedback
[ ] Document all issues found
```

**Bug Bounty Tiers:**
| Severity | Payout |
|----------|--------|
| Critical (fund loss) | $10,000 |
| High (incorrect K) | $5,000 |
| Medium (DOS) | $2,000 |
| Low (UI/UX) | $500 |

**Owner:** DevOps + Community
**Dependencies:** 4.1

### 4.3 Mainnet Launch (Week 22-24)

**Deliverables:**
- [ ] Mainnet deployment
- [ ] Initial liquidity pools
- [ ] Launch announcement
- [ ] Support documentation

**Launch Checklist:**
```
[ ] Final security review
[ ] Mainnet contract verified
[ ] Indexer running stable
[ ] Frontend deployed
[ ] Documentation complete
[ ] Support channels ready
[ ] Initial pools seeded
[ ] Announcement prepared
```

**TVL Targets:**
- Week 1: 10,000 RXD
- Month 1: 100,000 RXD
- Month 3: 1,000,000 RXD

**Owner:** Project Lead
**Dependencies:** 4.2

---

## Resource Requirements

### Team

| Role | FTE | Duration |
|------|-----|----------|
| Contract Developer | 1.0 | 6 weeks |
| SDK Developer | 1.0 | 4 weeks |
| Frontend Developer | 1.0 | 6 weeks |
| Backend Developer | 0.5 | 3 weeks |
| QA Engineer | 0.5 | 4 weeks |
| Security Lead | 0.5 | 4 weeks |
| DevOps | 0.25 | Ongoing |
| Project Lead | 0.25 | Ongoing |

### Infrastructure

| Service | Cost/Month |
|---------|------------|
| Indexer Server | $100 |
| Database (PostgreSQL) | $50 |
| Frontend Hosting | $20 |
| Electrum Nodes | $200 |
| Monitoring | $50 |
| **Total** | **$420/month** |

### Budget Summary

| Category | Estimate |
|----------|----------|
| Development (6 months) | $80,000 - $120,000 |
| Security Audit | $30,000 - $80,000 |
| Infrastructure (Year 1) | $5,000 |
| Bug Bounty Reserve | $20,000 |
| Marketing | $10,000 |
| **Total** | **$145,000 - $235,000** |

---

## Risk Assessment

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Contract bug | Medium | Critical | Audits, formal verification |
| Overflow attack | Low | Critical | Input validation, limits |
| MEV exploitation | High | Medium | Slippage limits, future MEV protection |
| Indexer failure | Medium | High | Redundancy, graceful degradation |

### Business Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Low adoption | Medium | High | Marketing, incentives |
| Competition | Medium | Medium | First mover advantage |
| Regulatory | Low | High | Decentralized design |

---

## Success Metrics

### Phase 1 Success Criteria
- [ ] Contract passes all 50+ unit tests
- [ ] Contract size < 500 bytes
- [ ] No critical vulnerabilities found

### Phase 2 Success Criteria
- [ ] SDK published to npm
- [ ] < 100ms price calculation
- [ ] Full test coverage

### Phase 3 Success Criteria
- [ ] UI usability score > 4/5
- [ ] < 3 second page load
- [ ] Mobile responsive

### Phase 4 Success Criteria
- [ ] Clean audit report
- [ ] > 10 testnet pools created
- [ ] > $10,000 TVL in month 1

---

## Timeline Summary

```
Week 1-2:   Contract Design
Week 2-4:   Contract Development
Week 4-6:   Contract Testing
Week 7-10:  SDK Development
Week 11-14: Web Application
Week 14-16: Indexer Service
Week 17-20: Security Audit
Week 20-22: Testnet Beta
Week 22-24: Mainnet Launch
```

**Total Duration: ~6 months**

---

## Next Steps

1. **Immediate (This Week)**
   - Review and approve implementation plan
   - Identify team members
   - Set up development repository

2. **Week 1**
   - Kick off contract design
   - Set up CI/CD pipeline
   - Create project documentation

3. **Ongoing**
   - Weekly progress reviews
   - Bi-weekly stakeholder updates
   - Monthly milestone assessments

---

*Document Version: 1.0*  
*Last Updated: January 2026*
