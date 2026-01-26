/**
 * Tests for RadiantMM Trade execution
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TradeBuilder, verifyTrade } from '../src/trade.js';
import { RadiantMMPool } from '../src/pool.js';
import { buildPoolScript } from '../src/utils/script.js';
import type { UTXO, SwapParams } from '../src/types.js';

describe('TradeBuilder', () => {
  const ownerPkh = Buffer.alloc(20, 0x01);
  const receiver = Buffer.alloc(25, 0x02);
  
  function createMockPool(rxdAmount: bigint, tokenAmount: bigint): RadiantMMPool {
    const utxo: UTXO = {
      txid: Math.random().toString(16).substring(2).padEnd(64, '0'),
      vout: 0,
      value: rxdAmount,
      scriptPubKey: buildPoolScript(ownerPkh, tokenAmount)
    };
    return RadiantMMPool.fromUtxo(utxo);
  }

  function createMockFunding(value: bigint): UTXO {
    return {
      txid: Math.random().toString(16).substring(2).padEnd(64, '0'),
      vout: 0,
      value,
      scriptPubKey: Buffer.alloc(25)
    };
  }

  describe('calculateRoute', () => {
    it('should calculate route for single pool buy', () => {
      const builder = new TradeBuilder();
      const pool = createMockPool(10000n, 1000n);
      
      builder.addPool(pool);
      
      const params: SwapParams = {
        direction: 'buy',
        amountIn: 1000n,
        minAmountOut: 1n,
        receiver
      };
      
      const route = builder.calculateRoute(params);
      
      expect(route.steps.length).toBe(1);
      expect(route.totalAmountIn).toBe(1000n);
      expect(route.totalAmountOut).toBeGreaterThan(0n);
      expect(route.totalFee).toBeGreaterThan(0n);
    });

    it('should calculate route for single pool sell', () => {
      const builder = new TradeBuilder();
      const pool = createMockPool(10000n, 1000n);
      
      builder.addPool(pool);
      
      const params: SwapParams = {
        direction: 'sell',
        amountIn: 100n,
        minAmountOut: 1n,
        receiver
      };
      
      const route = builder.calculateRoute(params);
      
      expect(route.steps.length).toBe(1);
      expect(route.totalAmountOut).toBeGreaterThan(0n);
    });

    it('should throw when no pools available', () => {
      const builder = new TradeBuilder();
      
      const params: SwapParams = {
        direction: 'buy',
        amountIn: 1000n,
        minAmountOut: 1n,
        receiver
      };
      
      expect(() => builder.calculateRoute(params)).toThrow();
    });

    it('should throw when slippage exceeded', () => {
      const builder = new TradeBuilder();
      const pool = createMockPool(10000n, 1000n);
      
      builder.addPool(pool);
      
      const params: SwapParams = {
        direction: 'buy',
        amountIn: 1000n,
        minAmountOut: 1000n, // Impossible to get this many tokens
        receiver
      };
      
      expect(() => builder.calculateRoute(params)).toThrow();
    });
  });

  describe('getQuote', () => {
    it('should return swap quote', () => {
      const builder = new TradeBuilder();
      const pool = createMockPool(10000n, 1000n);
      
      builder.addPool(pool);
      
      const params: SwapParams = {
        direction: 'buy',
        amountIn: 1000n,
        minAmountOut: 1n,
        receiver
      };
      
      const quote = builder.getQuote(params);
      
      expect(quote.amountOut).toBeGreaterThan(0n);
      expect(quote.fee).toBeGreaterThan(0n);
      expect(quote.priceImpact).toBeGreaterThan(0);
    });
  });

  describe('buildTradeTransaction', () => {
    it('should build transaction with inputs and outputs', () => {
      const builder = new TradeBuilder();
      const pool = createMockPool(10000n, 1000n);
      const funding = createMockFunding(5000n);
      
      builder.addPool(pool).addFunding(funding);
      
      const params: SwapParams = {
        direction: 'buy',
        amountIn: 1000n,
        minAmountOut: 1n,
        receiver
      };
      
      const route = builder.calculateRoute(params);
      const { inputs, outputs } = builder.buildTradeTransaction(route, params);
      
      // Should have pool + funding inputs
      expect(inputs.length).toBe(2);
      
      // Should have pool output + receiver + possibly change
      expect(outputs.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('verifyTrade', () => {
  it('should verify valid trade', () => {
    const before = { rxdAmount: 10000n, tokenAmount: 1000n, k: 10_000_000n };
    const after = { rxdAmount: 11000n, tokenAmount: 910n, k: 10_010_000n };
    
    const isValid = verifyTrade(before, after, 3n);
    expect(isValid).toBe(true);
  });

  it('should reject invalid trade', () => {
    const before = { rxdAmount: 10000n, tokenAmount: 1000n, k: 10_000_000n };
    const after = { rxdAmount: 11000n, tokenAmount: 800n, k: 8_800_000n };
    
    const isValid = verifyTrade(before, after, 3n);
    expect(isValid).toBe(false);
  });
});
