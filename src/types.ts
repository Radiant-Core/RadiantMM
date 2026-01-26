/**
 * Core types for RadiantMM SDK
 * 
 * Glyph v2 Token Standard Support
 * Reference: https://github.com/Radiant-Core/Glyph-Token-Standards
 */

/**
 * Glyph v2 Protocol IDs
 */
export const GlyphProtocol = {
  GLYPH_FT: 1,        // Fungible Token
  GLYPH_NFT: 2,       // Non-Fungible Token
  GLYPH_DAT: 3,       // Data Storage
  GLYPH_DMINT: 4,     // Decentralized Minting
  GLYPH_MUT: 5,       // Mutable State
  GLYPH_BURN: 6,      // Explicit Burn
  GLYPH_CONTAINER: 7, // Container/Collection
  GLYPH_ENCRYPTED: 8, // Encrypted Content
  GLYPH_TIMELOCK: 9,  // Timelocked Reveal
  GLYPH_AUTHORITY: 10, // Issuer Authority
  GLYPH_WAVE: 11,     // WAVE Naming
} as const;

export type GlyphProtocolId = typeof GlyphProtocol[keyof typeof GlyphProtocol];

/**
 * Glyph v2 token metadata (minimal for pool operations)
 */
export interface GlyphTokenMeta {
  v: number;              // Version (2 for v2)
  p: number[];            // Protocol IDs
  ticker?: string;        // Token ticker
  decimals?: number;      // Token decimals (default 8)
  royalty?: {
    bps: number;          // Royalty basis points (0-10000)
    address: string;      // Royalty recipient
    enforced?: boolean;   // On-chain enforcement
  };
}

/**
 * Check if token is a valid v2 FT for pool operations
 */
export function isValidPoolToken(meta: GlyphTokenMeta): boolean {
  return meta.v === 2 && 
         Array.isArray(meta.p) && 
         meta.p.includes(GlyphProtocol.GLYPH_FT);
}

/**
 * Get token decimals (default 8 per Glyph v2 spec)
 */
export function getTokenDecimals(meta: GlyphTokenMeta): number {
  return typeof meta.decimals === 'number' ? meta.decimals : 8;
}

/**
 * Check if token has enforced royalties that affect trades
 */
export function hasEnforcedRoyalty(meta: GlyphTokenMeta): boolean {
  return !!meta.royalty?.enforced && meta.royalty.bps > 0;
}

/**
 * Calculate royalty amount for a trade
 */
export function calculateRoyalty(amount: bigint, meta: GlyphTokenMeta): bigint {
  if (!meta.royalty || meta.royalty.bps <= 0) return 0n;
  return (amount * BigInt(meta.royalty.bps)) / 10000n;
}

/** A UTXO (Unspent Transaction Output) */
export interface UTXO {
  txid: string;
  vout: number;
  value: bigint;
  scriptPubKey: Buffer;
}

/** A transaction output */
export interface Output {
  value: bigint;
  scriptPubKey: Buffer;
}

/** Pool configuration parameters */
export interface PoolConfig {
  ownerPkh: Buffer;      // 20 bytes - owner's public key hash
  tokenRef?: Buffer;     // 32 bytes - Glyph token reference (optional for RXD-only pools)
}

/** Current state of a pool */
export interface PoolState {
  rxdAmount: bigint;     // RXD satoshis in pool
  tokenAmount: bigint;   // Token units in pool
  k: bigint;             // Constant product (rxdAmount * tokenAmount)
}

/** Parameters for a swap operation */
export interface SwapParams {
  direction: 'buy' | 'sell';  // buy = RXD->TOKEN, sell = TOKEN->RXD
  amountIn: bigint;           // Amount of input asset
  minAmountOut: bigint;       // Minimum acceptable output (slippage protection)
  receiver: Buffer;           // Recipient's scriptPubKey
}

/** Result of a swap calculation */
export interface SwapResult {
  amountOut: bigint;          // Tokens/RXD received
  fee: bigint;                // Fee paid (in RXD)
  priceImpact: number;        // Price impact percentage
  newPoolState: PoolState;    // Pool state after trade
}

/** A step in a multi-pool trade route */
export interface TradeStep {
  poolUtxo: UTXO;
  amountIn: bigint;
  amountOut: bigint;
  newState: PoolState;
}

/** Complete trade route across multiple pools */
export interface TradeRoute {
  steps: TradeStep[];
  totalAmountIn: bigint;
  totalAmountOut: bigint;
  totalFee: bigint;
  averagePrice: number;
}

/** Price quote for a token */
export interface PriceQuote {
  spotPrice: number;          // Current spot price (RXD per token)
  poolCount: number;          // Number of pools in aggregate
  totalLiquidity: bigint;     // Total RXD liquidity
  timestamp: number;          // Quote timestamp
}

/** Price impact analysis */
export interface PriceImpact {
  spotPriceBefore: number;
  spotPriceAfter: number;
  impactPercent: number;
  slippagePercent: number;
}

/** Network configuration */
export interface NetworkConfig {
  electrumHost: string;
  electrumPort: number;
  electrumProtocol: 'tcp' | 'ssl';
}

/** Fee configuration */
export const FEE_CONFIG = {
  POOL_FEE_NUMERATOR: 3n,      // 0.3% fee
  POOL_FEE_DENOMINATOR: 1000n,
  DUST_LIMIT: 546n,            // Minimum satoshi output
} as const;

/** Contract constants */
export const CONTRACT_CONFIG = {
  STATE_SIZE: 8,               // Token amount size in bytes
  OWNER_PKH_SIZE: 20,          // Owner public key hash size
  TOKEN_REF_SIZE: 32,          // Token reference size
  MAX_SCRIPT_SIZE: 500,        // Target max script size
} as const;
