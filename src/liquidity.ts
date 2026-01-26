/**
 * Liquidity management for RadiantMM
 */

import type { UTXO, Output, PoolConfig, PoolState } from './types.js';
import { RadiantMMPool } from './pool.js';
import { buildPoolScript } from './utils/script.js';
import { calculateK } from './utils/math.js';
import { RadiantMMError, ErrorCodes } from './errors.js';
import { FEE_CONFIG } from './types.js';

export interface AddLiquidityParams {
  ownerPkh: Buffer;
  tokenRef?: Buffer;
  rxdAmount: bigint;
  tokenAmount: bigint;
}

export interface RemoveLiquidityParams {
  pool: RadiantMMPool;
  ownerPubkey: Buffer;
  signature: Buffer;
  receiverScript: Buffer;
}

/**
 * Manager for liquidity operations (add/remove)
 */
export class LiquidityManager {
  /**
   * Build transaction to create a new liquidity pool
   */
  buildCreatePoolTx(
    params: AddLiquidityParams,
    fundingUtxos: UTXO[]
  ): { inputs: UTXO[]; outputs: Output[] } {
    // Validate amounts
    if (params.rxdAmount < FEE_CONFIG.DUST_LIMIT) {
      throw RadiantMMError.amountTooSmall(params.rxdAmount, FEE_CONFIG.DUST_LIMIT);
    }
    
    if (params.tokenAmount <= 0n) {
      throw RadiantMMError.amountTooSmall(params.tokenAmount, 1n);
    }

    // Build pool locking script
    const poolScript = buildPoolScript(params.ownerPkh, params.tokenAmount);

    // Calculate K for logging/verification
    const k = calculateK(params.rxdAmount, params.tokenAmount);

    const inputs = [...fundingUtxos];
    const outputs: Output[] = [];

    // Pool output
    outputs.push({
      value: params.rxdAmount,
      scriptPubKey: poolScript
    });

    // Calculate change
    const totalInput = fundingUtxos.reduce((sum, u) => sum + u.value, 0n);
    const minerFee = 1000n;
    const changeAmount = totalInput - params.rxdAmount - minerFee;

    if (changeAmount > FEE_CONFIG.DUST_LIMIT) {
      // Change output (back to owner) - would need owner's P2PKH script
      outputs.push({
        value: changeAmount,
        scriptPubKey: this.buildP2PKHScript(params.ownerPkh)
      });
    }

    return { inputs, outputs };
  }

  /**
   * Build transaction to withdraw liquidity from a pool
   */
  buildWithdrawTx(params: RemoveLiquidityParams): {
    inputs: UTXO[];
    outputs: Output[];
    unlockScript: Buffer;
  } {
    const pool = params.pool;
    
    // Build unlock script for withdrawal path: <sig> <pubkey>
    const unlockScript = Buffer.concat([
      this.pushData(params.signature),
      this.pushData(params.ownerPubkey)
    ]);

    const inputs = [pool.utxo];
    
    // All funds go to receiver
    const outputs: Output[] = [{
      value: pool.rxdAmount - 1000n, // Minus miner fee
      scriptPubKey: params.receiverScript
    }];

    return { inputs, outputs, unlockScript };
  }

  /**
   * Calculate optimal liquidity amounts to maintain current price
   */
  calculateOptimalLiquidity(
    existingPool: RadiantMMPool,
    rxdToAdd: bigint
  ): { rxdAmount: bigint; tokenAmount: bigint } {
    // To maintain price: newTokens / newRxd = currentTokens / currentRxd
    // tokenAmount = rxdToAdd * currentTokenAmount / currentRxdAmount
    const tokenAmount = (rxdToAdd * existingPool.tokenAmount) / existingPool.rxdAmount;

    return {
      rxdAmount: rxdToAdd,
      tokenAmount
    };
  }

  /**
   * Estimate APY based on trading volume
   */
  estimateAPY(
    pool: RadiantMMPool,
    dailyVolumeRxd: bigint
  ): number {
    // Fee is 0.3% of volume
    const dailyFees = (dailyVolumeRxd * 3n) / 1000n;
    const yearlyFees = dailyFees * 365n;
    
    // APY = yearlyFees / poolLiquidity * 100
    const apy = Number(yearlyFees * 100n) / Number(pool.rxdAmount);
    
    return apy;
  }

  /**
   * Calculate impermanent loss for a position
   */
  calculateImpermanentLoss(
    initialPrice: number,
    currentPrice: number
  ): number {
    // IL formula: 2 * sqrt(priceRatio) / (1 + priceRatio) - 1
    const priceRatio = currentPrice / initialPrice;
    const sqrtRatio = Math.sqrt(priceRatio);
    const il = (2 * sqrtRatio) / (1 + priceRatio) - 1;
    
    return Math.abs(il) * 100; // Return as percentage
  }

  /**
   * Build P2PKH script from public key hash
   */
  private buildP2PKHScript(pkh: Buffer): Buffer {
    return Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 PUSH20
      pkh,
      Buffer.from([0x88, 0xac]) // OP_EQUALVERIFY OP_CHECKSIG
    ]);
  }

  /**
   * Create push data opcode
   */
  private pushData(data: Buffer): Buffer {
    const len = data.length;
    if (len <= 75) {
      return Buffer.concat([Buffer.from([len]), data]);
    }
    if (len <= 255) {
      return Buffer.concat([Buffer.from([0x4c, len]), data]);
    }
    throw new Error('Data too large for push');
  }
}
