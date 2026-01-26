/**
 * Trade execution for RadiantMM
 */

import type { UTXO, SwapParams, SwapResult, TradeRoute, TradeStep, PoolState, Output } from './types.js';
import { RadiantMMPool } from './pool.js';
import { RadiantMMError, ErrorCodes } from './errors.js';
import { calculateK, calculateSpotPrice, min } from './utils/math.js';
import { updateScriptState } from './utils/script.js';

export type { SwapParams, SwapResult, TradeRoute };

/**
 * Builder for constructing trade transactions
 */
export class TradeBuilder {
  private pools: RadiantMMPool[] = [];
  private fundingUtxos: UTXO[] = [];

  /**
   * Add a pool to use for trading
   */
  addPool(pool: RadiantMMPool): this {
    this.pools.push(pool);
    return this;
  }

  /**
   * Add multiple pools
   */
  addPools(pools: RadiantMMPool[]): this {
    this.pools.push(...pools);
    return this;
  }

  /**
   * Add a funding UTXO (user's RXD)
   */
  addFunding(utxo: UTXO): this {
    this.fundingUtxos.push(utxo);
    return this;
  }

  /**
   * Add multiple funding UTXOs
   */
  addFundings(utxos: UTXO[]): this {
    this.fundingUtxos.push(...utxos);
    return this;
  }

  /**
   * Get total funding available
   */
  get totalFunding(): bigint {
    return this.fundingUtxos.reduce((sum, utxo) => sum + utxo.value, 0n);
  }

  /**
   * Get total pool liquidity
   */
  get totalLiquidity(): bigint {
    return this.pools.reduce((sum, pool) => sum + pool.rxdAmount, 0n);
  }

  /**
   * Calculate optimal trade route across pools
   */
  calculateRoute(params: SwapParams): TradeRoute {
    if (this.pools.length === 0) {
      throw new RadiantMMError(
        ErrorCodes.POOL_NOT_FOUND,
        'No pools available for trading'
      );
    }

    // Sort pools by best price
    const sortedPools = [...this.pools].sort((a, b) => {
      if (params.direction === 'buy') {
        // For buying tokens, prefer pools with lower price (more tokens per RXD)
        return a.spotPrice - b.spotPrice;
      } else {
        // For selling tokens, prefer pools with higher price (more RXD per token)
        return b.spotPrice - a.spotPrice;
      }
    });

    const steps: TradeStep[] = [];
    let remainingAmount = params.amountIn;
    let totalAmountOut = 0n;
    let totalFee = 0n;

    // Distribute trade across pools
    for (const pool of sortedPools) {
      if (remainingAmount <= 0n) break;

      // Calculate how much to trade with this pool
      const amountForPool = this.calculatePoolAllocation(
        pool,
        remainingAmount,
        params.direction
      );

      if (amountForPool <= 0n) continue;

      let amountOut: bigint;
      let fee: bigint;
      let newState: PoolState;

      if (params.direction === 'buy') {
        const result = pool.getTokensForRxd(amountForPool);
        amountOut = result.tokensOut;
        fee = result.fee;
        newState = result.newState;
      } else {
        const result = pool.getRxdForTokens(amountForPool);
        amountOut = result.rxdOut;
        fee = result.fee;
        newState = result.newState;
      }

      steps.push({
        poolUtxo: pool.utxo,
        amountIn: amountForPool,
        amountOut,
        newState
      });

      remainingAmount -= amountForPool;
      totalAmountOut += amountOut;
      totalFee += fee;
    }

    if (steps.length === 0) {
      throw RadiantMMError.insufficientLiquidity(params.amountIn, 0n);
    }

    // Check slippage
    if (totalAmountOut < params.minAmountOut) {
      throw RadiantMMError.slippageExceeded(
        params.minAmountOut,
        totalAmountOut,
        Number((params.minAmountOut - totalAmountOut) * 100n / params.minAmountOut)
      );
    }

    const averagePrice = params.direction === 'buy'
      ? Number(params.amountIn - remainingAmount) / Number(totalAmountOut)
      : Number(totalAmountOut) / Number(params.amountIn - remainingAmount);

    return {
      steps,
      totalAmountIn: params.amountIn - remainingAmount,
      totalAmountOut,
      totalFee,
      averagePrice
    };
  }

  /**
   * Calculate how much to allocate to a single pool
   */
  private calculatePoolAllocation(
    pool: RadiantMMPool,
    maxAmount: bigint,
    direction: 'buy' | 'sell'
  ): bigint {
    // For simplicity, use entire remaining amount for single pool
    // In production, this would implement optimal routing
    if (direction === 'buy') {
      // Limit to available pool liquidity (can't buy more tokens than exist)
      const maxTokens = pool.tokenAmount - 1n; // Leave at least 1 token
      if (maxTokens <= 0n) return 0n;
      return maxAmount;
    } else {
      // Limit to available RXD (can't receive more RXD than pool has)
      const maxRxd = pool.rxdAmount - 1n;
      if (maxRxd <= 0n) return 0n;
      return maxAmount;
    }
  }

  /**
   * Build the trade transaction inputs and outputs
   */
  buildTradeTransaction(route: TradeRoute, params: SwapParams): {
    inputs: UTXO[];
    outputs: Output[];
  } {
    const inputs: UTXO[] = [];
    const outputs: Output[] = [];

    // Add pool inputs and outputs
    for (const step of route.steps) {
      inputs.push(step.poolUtxo);

      // Create updated pool output with new state
      const newScript = updateScriptState(
        step.poolUtxo.scriptPubKey,
        step.newState.tokenAmount
      );

      outputs.push({
        value: step.newState.rxdAmount,
        scriptPubKey: newScript
      });
    }

    // Add funding inputs
    inputs.push(...this.fundingUtxos);

    // Add receiver output (tokens or RXD depending on direction)
    outputs.push({
      value: params.direction === 'sell' ? route.totalAmountOut : 546n, // Dust for token output
      scriptPubKey: params.receiver
    });

    // Calculate and add change output
    const totalInputValue = this.fundingUtxos.reduce((sum, u) => sum + u.value, 0n);
    const usedForTrade = params.direction === 'buy' ? route.totalAmountIn : 0n;
    const receivedFromTrade = params.direction === 'sell' ? route.totalAmountOut : 0n;
    const minerFee = 1000n; // Estimate, should be calculated based on tx size

    const changeAmount = totalInputValue - usedForTrade + receivedFromTrade - minerFee;

    if (changeAmount > 546n) {
      outputs.push({
        value: changeAmount,
        scriptPubKey: params.receiver // Change back to sender
      });
    }

    return { inputs, outputs };
  }

  /**
   * Get a quote for a swap without executing
   */
  getQuote(params: SwapParams): SwapResult {
    const route = this.calculateRoute(params);
    
    const initialState = this.pools[0].state;
    const finalState = route.steps[route.steps.length - 1].newState;
    
    const priceImpact = Math.abs(
      (calculateSpotPrice(finalState.rxdAmount, finalState.tokenAmount) -
       calculateSpotPrice(initialState.rxdAmount, initialState.tokenAmount)) /
      calculateSpotPrice(initialState.rxdAmount, initialState.tokenAmount)
    ) * 100;

    return {
      amountOut: route.totalAmountOut,
      fee: route.totalFee,
      priceImpact,
      newPoolState: finalState
    };
  }

  /**
   * Reset the builder
   */
  clear(): this {
    this.pools = [];
    this.fundingUtxos = [];
    return this;
  }
}

/**
 * Verify a trade transaction meets K invariant requirements
 */
export function verifyTrade(
  poolStateBefore: PoolState,
  poolStateAfter: PoolState,
  fee: bigint
): boolean {
  const kBefore = poolStateBefore.k;
  const effectiveRxdAfter = poolStateAfter.rxdAmount - fee;
  const kAfter = effectiveRxdAfter * poolStateAfter.tokenAmount;
  
  return kAfter >= kBefore;
}
