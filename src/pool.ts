/**
 * RadiantMM Pool class
 * 
 * Represents a single micro-pool UTXO containing RXD and tokens.
 */

import type { UTXO, PoolState, PoolConfig } from './types.js';
import { decodeState, parsePoolScript } from './utils/script.js';
import { calculateK, calculateSpotPrice, calculateTokensOut, calculateRxdOut } from './utils/math.js';
import { RadiantMMError, ErrorCodes } from './errors.js';

export { PoolState };

/**
 * Represents a RadiantMM liquidity pool
 */
export class RadiantMMPool {
  readonly utxo: UTXO;
  readonly rxdAmount: bigint;
  readonly tokenAmount: bigint;
  readonly ownerPkh: Buffer;
  readonly tokenRef?: Buffer;

  private constructor(
    utxo: UTXO,
    rxdAmount: bigint,
    tokenAmount: bigint,
    ownerPkh: Buffer,
    tokenRef?: Buffer
  ) {
    this.utxo = utxo;
    this.rxdAmount = rxdAmount;
    this.tokenAmount = tokenAmount;
    this.ownerPkh = ownerPkh;
    this.tokenRef = tokenRef;
  }

  /**
   * Create a Pool instance from a UTXO
   */
  static fromUtxo(utxo: UTXO): RadiantMMPool {
    try {
      const parsed = parsePoolScript(utxo.scriptPubKey);
      
      return new RadiantMMPool(
        utxo,
        utxo.value,
        parsed.state.tokenAmount,
        parsed.ownerPkh
      );
    } catch (error) {
      throw new RadiantMMError(
        ErrorCodes.INVALID_POOL_STATE,
        `Failed to parse pool UTXO: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { txid: utxo.txid, vout: utxo.vout }
      );
    }
  }

  /**
   * Create a new pool configuration (for pool creation)
   */
  static create(config: PoolConfig, rxdAmount: bigint, tokenAmount: bigint): {
    config: PoolConfig;
    state: PoolState;
  } {
    return {
      config,
      state: {
        rxdAmount,
        tokenAmount,
        k: calculateK(rxdAmount, tokenAmount)
      }
    };
  }

  /**
   * Get the constant product K
   */
  get k(): bigint {
    return calculateK(this.rxdAmount, this.tokenAmount);
  }

  /**
   * Get the current spot price (RXD per token)
   */
  get spotPrice(): number {
    return calculateSpotPrice(this.rxdAmount, this.tokenAmount);
  }

  /**
   * Get current pool state
   */
  get state(): PoolState {
    return {
      rxdAmount: this.rxdAmount,
      tokenAmount: this.tokenAmount,
      k: this.k
    };
  }

  /**
   * Get pool identifier (txid:vout)
   */
  get id(): string {
    return `${this.utxo.txid}:${this.utxo.vout}`;
  }

  /**
   * Calculate tokens received for a given RXD input
   */
  getTokensForRxd(rxdIn: bigint): { tokensOut: bigint; fee: bigint; newState: PoolState } {
    const { tokensOut, fee } = calculateTokensOut(
      this.rxdAmount,
      this.tokenAmount,
      rxdIn
    );

    const newState: PoolState = {
      rxdAmount: this.rxdAmount + rxdIn,
      tokenAmount: this.tokenAmount - tokensOut,
      k: calculateK(this.rxdAmount + rxdIn, this.tokenAmount - tokensOut)
    };

    return { tokensOut, fee, newState };
  }

  /**
   * Calculate RXD received for a given token input
   */
  getRxdForTokens(tokensIn: bigint): { rxdOut: bigint; fee: bigint; newState: PoolState } {
    const { rxdOut, fee } = calculateRxdOut(
      this.rxdAmount,
      this.tokenAmount,
      tokensIn
    );

    const newState: PoolState = {
      rxdAmount: this.rxdAmount - rxdOut,
      tokenAmount: this.tokenAmount + tokensIn,
      k: calculateK(this.rxdAmount - rxdOut, this.tokenAmount + tokensIn)
    };

    return { rxdOut, fee, newState };
  }

  /**
   * Calculate price impact for a trade
   */
  getPriceImpact(rxdIn: bigint, direction: 'buy' | 'sell'): number {
    const priceBefore = this.spotPrice;
    
    let priceAfter: number;
    if (direction === 'buy') {
      const { newState } = this.getTokensForRxd(rxdIn);
      priceAfter = calculateSpotPrice(newState.rxdAmount, newState.tokenAmount);
    } else {
      const { newState } = this.getRxdForTokens(rxdIn);
      priceAfter = calculateSpotPrice(newState.rxdAmount, newState.tokenAmount);
    }
    
    return Math.abs((priceAfter - priceBefore) / priceBefore) * 100;
  }

  /**
   * Check if this pool has sufficient liquidity for a trade
   */
  hasLiquidity(amount: bigint, direction: 'buy' | 'sell'): boolean {
    if (direction === 'buy') {
      // Buying tokens: check if pool has enough tokens
      try {
        this.getTokensForRxd(amount);
        return true;
      } catch {
        return false;
      }
    } else {
      // Selling tokens: check if pool has enough RXD
      try {
        this.getRxdForTokens(amount);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Serialize pool info for display
   */
  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      txid: this.utxo.txid,
      vout: this.utxo.vout,
      rxdAmount: this.rxdAmount.toString(),
      tokenAmount: this.tokenAmount.toString(),
      k: this.k.toString(),
      spotPrice: this.spotPrice,
      ownerPkh: this.ownerPkh.toString('hex')
    };
  }
}
