/**
 * Math utilities for RadiantMM
 * 
 * All calculations use BigInt for precision with 64-bit values.
 */

import { RadiantMMError } from '../errors.js';
import { FEE_CONFIG } from '../types.js';

/** Maximum safe value for multiplication (2^62 to allow headroom) */
export const MAX_SAFE_VALUE = 2n ** 62n;

/** Maximum value for 64-bit signed integer */
export const MAX_INT64 = 2n ** 63n - 1n;

/**
 * Calculate the constant product K = rxd * token
 */
export function calculateK(rxdAmount: bigint, tokenAmount: bigint): bigint {
  checkOverflow(rxdAmount, tokenAmount, 'calculateK');
  return rxdAmount * tokenAmount;
}

/**
 * Calculate tokens out for a given RXD input (buy tokens)
 * 
 * Formula: tokensOut = tokenReserve - (K / (rxdReserve + rxdIn))
 */
export function calculateTokensOut(
  rxdReserve: bigint,
  tokenReserve: bigint,
  rxdIn: bigint
): { tokensOut: bigint; fee: bigint } {
  if (rxdIn <= 0n) {
    throw RadiantMMError.amountTooSmall(rxdIn, 1n);
  }

  const k = calculateK(rxdReserve, tokenReserve);
  const fee = calculateFee(rxdIn);
  const effectiveRxdIn = rxdIn - fee;
  
  const newRxdReserve = rxdReserve + effectiveRxdIn;
  const newTokenReserve = k / newRxdReserve;
  
  const tokensOut = tokenReserve - newTokenReserve;
  
  if (tokensOut <= 0n) {
    throw RadiantMMError.insufficientLiquidity(1n, tokensOut);
  }
  
  return { tokensOut, fee };
}

/**
 * Calculate RXD out for a given token input (sell tokens)
 * 
 * Formula: rxdOut = rxdReserve - (K / (tokenReserve + tokensIn))
 */
export function calculateRxdOut(
  rxdReserve: bigint,
  tokenReserve: bigint,
  tokensIn: bigint
): { rxdOut: bigint; fee: bigint } {
  if (tokensIn <= 0n) {
    throw RadiantMMError.amountTooSmall(tokensIn, 1n);
  }

  const k = calculateK(rxdReserve, tokenReserve);
  const newTokenReserve = tokenReserve + tokensIn;
  const newRxdReserve = k / newTokenReserve;
  
  const grossRxdOut = rxdReserve - newRxdReserve;
  const fee = calculateFee(grossRxdOut);
  const rxdOut = grossRxdOut - fee;
  
  if (rxdOut <= 0n) {
    throw RadiantMMError.insufficientLiquidity(1n, rxdOut);
  }
  
  return { rxdOut, fee };
}

/**
 * Calculate required RXD input to receive exact tokens out
 */
export function calculateRxdInForExactTokensOut(
  rxdReserve: bigint,
  tokenReserve: bigint,
  tokensOut: bigint
): { rxdIn: bigint; fee: bigint } {
  if (tokensOut >= tokenReserve) {
    throw RadiantMMError.insufficientLiquidity(tokensOut, tokenReserve - 1n);
  }

  const k = calculateK(rxdReserve, tokenReserve);
  const newTokenReserve = tokenReserve - tokensOut;
  const newRxdReserve = (k + newTokenReserve - 1n) / newTokenReserve; // Ceiling division
  
  const grossRxdIn = newRxdReserve - rxdReserve;
  
  // Account for fee: effectiveIn = grossIn - fee, so grossIn = effectiveIn * 1000 / 997
  const rxdIn = (grossRxdIn * FEE_CONFIG.POOL_FEE_DENOMINATOR + 
                 FEE_CONFIG.POOL_FEE_DENOMINATOR - FEE_CONFIG.POOL_FEE_NUMERATOR - 1n) /
                (FEE_CONFIG.POOL_FEE_DENOMINATOR - FEE_CONFIG.POOL_FEE_NUMERATOR);
  
  const fee = calculateFee(rxdIn);
  
  return { rxdIn, fee };
}

/**
 * Calculate required tokens input to receive exact RXD out
 */
export function calculateTokensInForExactRxdOut(
  rxdReserve: bigint,
  tokenReserve: bigint,
  rxdOut: bigint
): { tokensIn: bigint; fee: bigint } {
  // Account for fee on output: netRxdOut = grossRxdOut - fee
  // grossRxdOut = netRxdOut * 1000 / 997
  const grossRxdOut = (rxdOut * FEE_CONFIG.POOL_FEE_DENOMINATOR + 
                       FEE_CONFIG.POOL_FEE_DENOMINATOR - FEE_CONFIG.POOL_FEE_NUMERATOR - 1n) /
                      (FEE_CONFIG.POOL_FEE_DENOMINATOR - FEE_CONFIG.POOL_FEE_NUMERATOR);
  
  if (grossRxdOut >= rxdReserve) {
    throw RadiantMMError.insufficientLiquidity(grossRxdOut, rxdReserve - 1n);
  }

  const k = calculateK(rxdReserve, tokenReserve);
  const newRxdReserve = rxdReserve - grossRxdOut;
  const newTokenReserve = (k + newRxdReserve - 1n) / newRxdReserve; // Ceiling division
  
  const tokensIn = newTokenReserve - tokenReserve;
  const fee = grossRxdOut - rxdOut;
  
  return { tokensIn, fee };
}

/**
 * Calculate fee for a given amount (0.3%)
 */
export function calculateFee(amount: bigint): bigint {
  const absAmount = amount < 0n ? -amount : amount;
  return (absAmount * FEE_CONFIG.POOL_FEE_NUMERATOR) / FEE_CONFIG.POOL_FEE_DENOMINATOR;
}

/**
 * Calculate spot price (RXD per token)
 */
export function calculateSpotPrice(rxdReserve: bigint, tokenReserve: bigint): number {
  if (tokenReserve === 0n) return 0;
  return Number(rxdReserve) / Number(tokenReserve);
}

/**
 * Calculate price impact of a trade
 */
export function calculatePriceImpact(
  rxdReserve: bigint,
  tokenReserve: bigint,
  rxdDelta: bigint,
  tokenDelta: bigint
): number {
  const priceBefore = calculateSpotPrice(rxdReserve, tokenReserve);
  const priceAfter = calculateSpotPrice(
    rxdReserve + rxdDelta,
    tokenReserve + tokenDelta
  );
  
  if (priceBefore === 0) return 0;
  return Math.abs((priceAfter - priceBefore) / priceBefore) * 100;
}

/**
 * Verify K invariant is maintained (K_out >= K_in)
 */
export function verifyKInvariant(
  rxdIn: bigint,
  tokenIn: bigint,
  rxdOut: bigint,
  tokenOut: bigint,
  fee: bigint
): boolean {
  const kIn = calculateK(rxdIn, tokenIn);
  const effectiveRxdOut = rxdOut - fee;
  const kOut = effectiveRxdOut * tokenOut;
  return kOut >= kIn;
}

/**
 * Check for potential overflow before multiplication
 */
function checkOverflow(a: bigint, b: bigint, operation: string): void {
  if (a > MAX_SAFE_VALUE || b > MAX_SAFE_VALUE) {
    throw RadiantMMError.overflow(operation, a, b);
  }
  if (a > 0n && b > MAX_INT64 / a) {
    throw RadiantMMError.overflow(operation, a, b);
  }
}

/**
 * Absolute value for BigInt
 */
export function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/**
 * Minimum of two BigInts
 */
export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Maximum of two BigInts
 */
export function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
