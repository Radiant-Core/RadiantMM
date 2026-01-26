/**
 * Tests for RadiantMM math utilities
 */

import { describe, it, expect } from 'vitest';
import {
  calculateK,
  calculateTokensOut,
  calculateRxdOut,
  calculateFee,
  calculateSpotPrice,
  calculatePriceImpact,
  verifyKInvariant,
  MAX_SAFE_VALUE
} from '../src/utils/math.js';

describe('Math Utilities', () => {
  describe('calculateK', () => {
    it('should calculate K correctly', () => {
      const k = calculateK(10000n, 1000n);
      expect(k).toBe(10_000_000n);
    });

    it('should handle large values', () => {
      const k = calculateK(1_000_000_000n, 1_000_000n);
      expect(k).toBe(1_000_000_000_000_000n);
    });

    it('should handle zero values', () => {
      expect(calculateK(0n, 1000n)).toBe(0n);
      expect(calculateK(1000n, 0n)).toBe(0n);
    });
  });

  describe('calculateTokensOut', () => {
    it('should calculate tokens out for RXD input (buy)', () => {
      // Pool: 10000 RXD, 1000 tokens, K = 10,000,000
      // Add 1000 RXD
      const { tokensOut, fee } = calculateTokensOut(10000n, 1000n, 1000n);
      
      // Fee = 1000 * 3 / 1000 = 3 RXD
      expect(fee).toBe(3n);
      
      // New RXD = 10000 + 997 = 10997
      // New tokens = 10,000,000 / 10997 = 909.33... ≈ 909
      // Tokens out = 1000 - 909 = 91
      expect(tokensOut).toBeGreaterThan(0n);
      expect(tokensOut).toBeLessThan(1000n);
    });

    it('should reject zero input', () => {
      expect(() => calculateTokensOut(10000n, 1000n, 0n)).toThrow();
    });

    it('should reject negative input', () => {
      expect(() => calculateTokensOut(10000n, 1000n, -100n)).toThrow();
    });
  });

  describe('calculateRxdOut', () => {
    it('should calculate RXD out for token input (sell)', () => {
      // Pool: 10000 RXD, 1000 tokens, K = 10,000,000
      // Add 100 tokens
      const { rxdOut, fee } = calculateRxdOut(10000n, 1000n, 100n);
      
      // New tokens = 1100
      // New RXD = 10,000,000 / 1100 = 9090.9... ≈ 9090
      // Gross RXD out = 10000 - 9090 = 910
      // Fee = 910 * 3 / 1000 = 2
      expect(fee).toBeGreaterThan(0n);
      expect(rxdOut).toBeGreaterThan(0n);
      expect(rxdOut).toBeLessThan(10000n);
    });

    it('should reject zero input', () => {
      expect(() => calculateRxdOut(10000n, 1000n, 0n)).toThrow();
    });
  });

  describe('calculateFee', () => {
    it('should calculate 0.3% fee', () => {
      expect(calculateFee(1000n)).toBe(3n);
      expect(calculateFee(10000n)).toBe(30n);
      expect(calculateFee(100n)).toBe(0n); // Rounds down
    });

    it('should handle absolute value', () => {
      expect(calculateFee(-1000n)).toBe(3n);
    });
  });

  describe('calculateSpotPrice', () => {
    it('should calculate spot price', () => {
      const price = calculateSpotPrice(10000n, 1000n);
      expect(price).toBe(10); // 10 RXD per token
    });

    it('should handle zero token reserve', () => {
      const price = calculateSpotPrice(10000n, 0n);
      expect(price).toBe(0);
    });
  });

  describe('calculatePriceImpact', () => {
    it('should calculate price impact', () => {
      // Adding RXD increases price
      const impact = calculatePriceImpact(10000n, 1000n, 1000n, -100n);
      expect(impact).toBeGreaterThan(0);
    });
  });

  describe('verifyKInvariant', () => {
    it('should verify valid trade (K maintained)', () => {
      // Before: 10000 * 1000 = 10,000,000
      // After: 11000 * 910 = 10,010,000 (with fee accounted)
      const isValid = verifyKInvariant(
        10000n, 1000n,  // before
        11000n, 910n,   // after
        3n              // fee
      );
      expect(isValid).toBe(true);
    });

    it('should reject invalid trade (K decreased)', () => {
      const isValid = verifyKInvariant(
        10000n, 1000n,  // before
        11000n, 800n,   // after (too many tokens taken)
        3n
      );
      expect(isValid).toBe(false);
    });
  });
});
