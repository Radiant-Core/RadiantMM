# RadiantMM

A Constant Product Market Maker (CPMM) protocol for Radiant blockchain using micro-pools architecture.

## Overview

RadiantMM enables trustless, permissionless token swaps on Radiant blockchain. Each liquidity provider operates independent CPMM contracts (micro-pools) that can be aggregated for larger trades.

### Key Features

- **Trustless**: No intermediaries or custodians
- **Permissionless**: Anyone can create pools or trade
- **Scalable**: Micro-pools eliminate global state bottlenecks
- **Composable**: Multiple pools can be aggregated in single transactions
- **Low Fees**: 0.3% trading fee accrues to liquidity providers

## Installation

```bash
npm install
```

## Development

```bash
# Build
npm run build

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Lint
npm run lint
```

## Project Structure

```
RadiantMM/
├── contracts/              # Smart contract code
│   ├── RadiantMMPool.rxd   # RadiantScript source
│   └── RadiantMMPool.script # Optimized Bitcoin Script
├── src/                    # TypeScript SDK
│   ├── index.ts            # Main exports
│   ├── pool.ts             # Pool class
│   ├── trade.ts            # Trade execution
│   ├── liquidity.ts        # LP operations
│   ├── price.ts            # Price calculations
│   ├── transaction.ts      # TX building
│   ├── errors.ts           # Error handling
│   ├── types.ts            # Type definitions
│   └── utils/
│       ├── script.ts       # Script encoding/decoding
│       ├── math.ts         # BigInt math operations
│       └── encoding.ts     # Buffer utilities
├── tests/                  # Test suite
├── docs/                   # Documentation
│   └── CONTRACT_SPEC.md    # Contract specification
└── package.json
```

## Usage

### Create a Pool

```typescript
import { LiquidityManager, buildPoolScript } from 'radiantmm';

const manager = new LiquidityManager();
const ownerPkh = Buffer.from('your_pubkey_hash', 'hex');

const { inputs, outputs } = manager.buildCreatePoolTx({
  ownerPkh,
  rxdAmount: 10000n,    // 10,000 satoshis
  tokenAmount: 1000n     // 1,000 tokens
}, fundingUtxos);
```

### Execute a Trade

```typescript
import { TradeBuilder, RadiantMMPool } from 'radiantmm';

const builder = new TradeBuilder();
builder.addPool(pool).addFunding(fundingUtxo);

const route = builder.calculateRoute({
  direction: 'buy',
  amountIn: 1000n,
  minAmountOut: 90n,
  receiver: receiverScript
});

const { inputs, outputs } = builder.buildTradeTransaction(route, params);
```

### Get Price Quote

```typescript
import { PriceCalculator } from 'radiantmm';

const calc = new PriceCalculator();
calc.setPools(pools);

const quote = calc.getPrice();
console.log(`Spot price: ${quote.spotPrice} RXD per token`);

const impact = calc.getPriceImpact(1000n, 'buy');
console.log(`Price impact: ${impact.impactPercent}%`);
```

## Contract Mechanics

### Constant Product Formula

```
K = x × y
```

Where:
- `K` = constant product (invariant)
- `x` = RXD amount (satoshis)
- `y` = Token amount

### Trade Execution

For any trade, the contract verifies:

```
K_output ≥ K_input
```

Where a 0.3% fee is subtracted from the RXD side.

### Execution Paths

1. **Withdrawal** (owner only): Provide `<signature> <pubkey>` to reclaim funds
2. **Trade** (anyone): Empty unlock script triggers trade verification

## Documentation

- [Whitepaper](./RadiantMM_Whitepaper.md)
- [Implementation Plan](./RadiantMM_Implementation_Plan.md)
- [Contract Specification](./docs/CONTRACT_SPEC.md)

## License

MIT
