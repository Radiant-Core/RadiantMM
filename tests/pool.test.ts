/**
 * Tests for RadiantMM Pool class
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RadiantMMPool } from '../src/pool.js';
import { buildPoolScript } from '../src/utils/script.js';
import type { UTXO } from '../src/types.js';

describe('RadiantMMPool', () => {
  const ownerPkh = Buffer.alloc(20, 0x01);
  
  function createMockUtxo(rxdAmount: bigint, tokenAmount: bigint): UTXO {
    return {
      txid: 'a'.repeat(64),
      vout: 0,
      value: rxdAmount,
      scriptPubKey: buildPoolScript(ownerPkh, tokenAmount)
    };
  }

  describe('fromUtxo', () => {
    it('should parse pool from UTXO', () => {
      const utxo = createMockUtxo(10000n, 1000n);
      const pool = RadiantMMPool.fromUtxo(utxo);
      
      expect(pool.rxdAmount).toBe(10000n);
      expect(pool.tokenAmount).toBe(1000n);
      expect(pool.k).toBe(10_000_000n);
    });

    it('should calculate spot price', () => {
      const utxo = createMockUtxo(10000n, 1000n);
      const pool = RadiantMMPool.fromUtxo(utxo);
      
      expect(pool.spotPrice).toBe(10); // 10 RXD per token
    });
  });

  describe('getTokensForRxd', () => {
    it('should calculate tokens out for RXD input', () => {
      const utxo = createMockUtxo(10000n, 1000n);
      const pool = RadiantMMPool.fromUtxo(utxo);
      
      const { tokensOut, fee, newState } = pool.getTokensForRxd(1000n);
      
      expect(tokensOut).toBeGreaterThan(0n);
      expect(fee).toBeGreaterThan(0n);
      expect(newState.rxdAmount).toBe(11000n);
      expect(newState.tokenAmount).toBe(1000n - tokensOut);
    });
  });

  describe('getRxdForTokens', () => {
    it('should calculate RXD out for token input', () => {
      const utxo = createMockUtxo(10000n, 1000n);
      const pool = RadiantMMPool.fromUtxo(utxo);
      
      const { rxdOut, fee, newState } = pool.getRxdForTokens(100n);
      
      expect(rxdOut).toBeGreaterThan(0n);
      expect(fee).toBeGreaterThan(0n);
      expect(newState.tokenAmount).toBe(1100n);
      expect(newState.rxdAmount).toBe(10000n - rxdOut);
    });
  });

  describe('getPriceImpact', () => {
    it('should calculate price impact for buy', () => {
      const utxo = createMockUtxo(10000n, 1000n);
      const pool = RadiantMMPool.fromUtxo(utxo);
      
      const impact = pool.getPriceImpact(1000n, 'buy');
      
      expect(impact).toBeGreaterThan(0);
      expect(impact).toBeLessThan(100);
    });

    it('should increase with larger trades', () => {
      const utxo = createMockUtxo(10000n, 1000n);
      const pool = RadiantMMPool.fromUtxo(utxo);
      
      const smallImpact = pool.getPriceImpact(100n, 'buy');
      const largeImpact = pool.getPriceImpact(5000n, 'buy');
      
      expect(largeImpact).toBeGreaterThan(smallImpact);
    });
  });

  describe('hasLiquidity', () => {
    it('should return true for valid trade', () => {
      const utxo = createMockUtxo(10000n, 1000n);
      const pool = RadiantMMPool.fromUtxo(utxo);
      
      expect(pool.hasLiquidity(1000n, 'buy')).toBe(true);
      expect(pool.hasLiquidity(100n, 'sell')).toBe(true);
    });
  });

  describe('toJSON', () => {
    it('should serialize pool info', () => {
      const utxo = createMockUtxo(10000n, 1000n);
      const pool = RadiantMMPool.fromUtxo(utxo);
      
      const json = pool.toJSON();
      
      expect(json.rxdAmount).toBe('10000');
      expect(json.tokenAmount).toBe('1000');
      expect(json.k).toBe('10000000');
      expect(json.spotPrice).toBe(10);
    });
  });
});
