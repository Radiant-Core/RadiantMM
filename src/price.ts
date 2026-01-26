/**
 * Price calculation and oracle for RadiantMM
 */

import type { PriceQuote, PriceImpact } from './types.js';
import { RadiantMMPool } from './pool.js';
import { calculateSpotPrice, calculateTokensOut, calculateRxdOut } from './utils/math.js';

export type { PriceQuote, PriceImpact };

/**
 * Price calculator for RadiantMM pools
 */
export class PriceCalculator {
  private pools: RadiantMMPool[] = [];

  /**
   * Set pools for price calculation
   */
  setPools(pools: RadiantMMPool[]): void {
    this.pools = pools;
  }

  /**
   * Add a pool
   */
  addPool(pool: RadiantMMPool): void {
    this.pools.push(pool);
  }

  /**
   * Get aggregated price quote across all pools
   */
  getPrice(): PriceQuote {
    if (this.pools.length === 0) {
      return {
        spotPrice: 0,
        poolCount: 0,
        totalLiquidity: 0n,
        timestamp: Date.now()
      };
    }

    // Calculate liquidity-weighted average price
    let totalWeight = 0n;
    let weightedPriceSum = 0;

    for (const pool of this.pools) {
      const weight = pool.rxdAmount;
      const price = pool.spotPrice;
      
      weightedPriceSum += price * Number(weight);
      totalWeight += weight;
    }

    const avgPrice = totalWeight > 0n 
      ? weightedPriceSum / Number(totalWeight)
      : 0;

    return {
      spotPrice: avgPrice,
      poolCount: this.pools.length,
      totalLiquidity: totalWeight,
      timestamp: Date.now()
    };
  }

  /**
   * Get price for a specific trade amount
   */
  getExecutionPrice(amountIn: bigint, direction: 'buy' | 'sell'): number {
    if (this.pools.length === 0) return 0;

    // For simplicity, use the pool with most liquidity
    const pool = this.pools.reduce((best, current) => 
      current.rxdAmount > best.rxdAmount ? current : best
    );

    if (direction === 'buy') {
      const { tokensOut } = calculateTokensOut(
        pool.rxdAmount,
        pool.tokenAmount,
        amountIn
      );
      return Number(amountIn) / Number(tokensOut);
    } else {
      const { rxdOut } = calculateRxdOut(
        pool.rxdAmount,
        pool.tokenAmount,
        amountIn
      );
      return Number(rxdOut) / Number(amountIn);
    }
  }

  /**
   * Calculate price impact for a trade
   */
  getPriceImpact(amountIn: bigint, direction: 'buy' | 'sell'): PriceImpact {
    if (this.pools.length === 0) {
      return {
        spotPriceBefore: 0,
        spotPriceAfter: 0,
        impactPercent: 0,
        slippagePercent: 0
      };
    }

    const pool = this.pools.reduce((best, current) => 
      current.rxdAmount > best.rxdAmount ? current : best
    );

    const spotPriceBefore = pool.spotPrice;
    
    let newRxd: bigint;
    let newToken: bigint;

    if (direction === 'buy') {
      const { tokensOut } = calculateTokensOut(
        pool.rxdAmount,
        pool.tokenAmount,
        amountIn
      );
      newRxd = pool.rxdAmount + amountIn;
      newToken = pool.tokenAmount - tokensOut;
    } else {
      const { rxdOut } = calculateRxdOut(
        pool.rxdAmount,
        pool.tokenAmount,
        amountIn
      );
      newRxd = pool.rxdAmount - rxdOut;
      newToken = pool.tokenAmount + amountIn;
    }

    const spotPriceAfter = calculateSpotPrice(newRxd, newToken);
    const impactPercent = Math.abs((spotPriceAfter - spotPriceBefore) / spotPriceBefore) * 100;
    
    // Slippage is the difference between spot and execution price
    const executionPrice = this.getExecutionPrice(amountIn, direction);
    const slippagePercent = Math.abs((executionPrice - spotPriceBefore) / spotPriceBefore) * 100;

    return {
      spotPriceBefore,
      spotPriceAfter,
      impactPercent,
      slippagePercent
    };
  }

  /**
   * Get best pool for a trade (lowest price impact)
   */
  getBestPool(amountIn: bigint, direction: 'buy' | 'sell'): RadiantMMPool | null {
    if (this.pools.length === 0) return null;

    let bestPool = this.pools[0];
    let bestImpact = Infinity;

    for (const pool of this.pools) {
      try {
        const impact = pool.getPriceImpact(amountIn, direction);
        if (impact < bestImpact) {
          bestImpact = impact;
          bestPool = pool;
        }
      } catch {
        // Pool doesn't have enough liquidity, skip
        continue;
      }
    }

    return bestPool;
  }

  /**
   * Get pools sorted by price (best first)
   */
  getPoolsSortedByPrice(direction: 'buy' | 'sell'): RadiantMMPool[] {
    return [...this.pools].sort((a, b) => {
      if (direction === 'buy') {
        // Lower price = more tokens per RXD = better for buyer
        return a.spotPrice - b.spotPrice;
      } else {
        // Higher price = more RXD per token = better for seller
        return b.spotPrice - a.spotPrice;
      }
    });
  }

  /**
   * Calculate TWAP (Time-Weighted Average Price)
   * Note: Requires historical price data, this is a placeholder
   */
  calculateTWAP(prices: { price: number; duration: number }[]): number {
    if (prices.length === 0) return 0;

    let totalWeight = 0;
    let weightedSum = 0;

    for (const { price, duration } of prices) {
      weightedSum += price * duration;
      totalWeight += duration;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }
}
