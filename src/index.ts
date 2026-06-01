/**
 * RadiantMM SDK
 *
 * TypeScript SDK for RadiantMM Constant Product Market Maker pools on Radiant.
 *
 * USE `v3` — the paired-UTXO model validated on regtest (genesis + buy + adversarial
 * matrix). Import as `import { v3 } from 'radiantmm'` (math/contracts/builder).
 *
 * The top-level exports below are the LEGACY single-UTXO v1 model, which is NOT
 * deployable (see docs/REDESIGN_C1_C2.md §0 — a Glyph FT amount is the UTXO's satoshi
 * value, so one UTXO can't hold independent RXD and token reserves). Kept only for the
 * SDK math/encoding tests; do not build live transactions with it.
 */
export * as v3 from './v3/index.js';

export { RadiantMMPool, PoolState } from './pool.js';
export { TradeBuilder, SwapParams, SwapResult, TradeRoute } from './trade.js';
export { LiquidityManager, AddLiquidityParams, RemoveLiquidityParams } from './liquidity.js';
export { PriceCalculator, PriceQuote, PriceImpact } from './price.js';
export { TransactionBuilder, UTXO, Output } from './transaction.js';
export { 
  encodeState, 
  decodeState, 
  buildPoolScript, 
  parsePoolScript 
} from './utils/script.js';
export { 
  calculateK, 
  calculateTokensOut, 
  calculateRxdOut, 
  calculateFee,
  MAX_SAFE_VALUE 
} from './utils/math.js';
export { RadiantMMError, ErrorCodes } from './errors.js';
export * from './types.js';
