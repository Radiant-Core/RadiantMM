import { describe, it, expect } from 'vitest';
import { quoteBuy, quoteSell, verifyAccept, ceilingFee, DUST } from '../src/v3/math.js';

describe('v3 CPMM math — matches the on-chain contract', () => {
  const R = 1_000_000n, T = 100_000n;

  it('quoteBuy reproduces the validated on-chain buy exactly', () => {
    const q = quoteBuy(R, T, 100_000n);
    expect(q.fee).toBe(300n);
    expect(q.rxdReserveOut).toBe(1_100_000n);
    expect(q.tokenReserveOut).toBe(90_934n); // matches regtest txid 5a3a7e... / 2c2b0b...
    expect(q.amountOut).toBe(9_066n);
  });

  it('verifyAccept agrees with the contract at the fee boundary (90934 ok, 90933 not)', () => {
    expect(verifyAccept(R, T, 1_100_000n, 90_934n).ok).toBe(true);
    expect(verifyAccept(R, T, 1_100_000n, 90_933n).ok).toBe(false); // ceiling fee enforced to the satoshi
  });

  it('quoteBuy output is always accepted by verifyAccept', () => {
    for (const rxdIn of [1_000n, 50_000n, 100_000n, 500_000n, 5_000_000n]) {
      const q = quoteBuy(R, T, rxdIn);
      expect(verifyAccept(R, T, q.rxdReserveOut, q.tokenReserveOut).ok).toBe(true);
      // one less token in the reserve (one more to the trader) must be rejected
      expect(verifyAccept(R, T, q.rxdReserveOut, q.tokenReserveOut - 1n).ok).toBe(false);
    }
  });

  it('quoteSell output is always accepted, and 1 more RXD out is rejected', () => {
    for (const tokensIn of [1_000n, 25_000n, 100_000n, 1_000_000n]) {
      const q = quoteSell(R, T, tokensIn);
      expect(verifyAccept(R, T, q.rxdReserveOut, q.tokenReserveOut).ok).toBe(true);
      expect(verifyAccept(R, T, q.rxdReserveOut - 1n, q.tokenReserveOut).ok).toBe(false);
    }
  });

  it('ceilingFee matches the contract formula (delta*3 + 999)/1000', () => {
    for (const d of [0n, 1n, 333n, 100_000n, 999n, 1000n, 1001n]) {
      expect(ceilingFee(d)).toBe((d * 3n + 999n) / 1000n);
    }
  });

  it('K is preserved or grows across a buy then sell round trip (fee accrues to pool)', () => {
    const buy = quoteBuy(R, T, 100_000n);
    const R2 = buy.rxdReserveOut, T2 = buy.tokenReserveOut;
    const sell = quoteSell(R2, T2, buy.amountOut); // sell the tokens back
    // pool ends with at least the original K (fees stay in the pool)
    expect(sell.rxdReserveOut * sell.tokenReserveOut >= R * T).toBe(true);
  });

  it('rejects dust / degenerate reserves', () => {
    expect(verifyAccept(R, T, DUST - 1n, 90_934n).ok).toBe(false);
    expect(verifyAccept(R, T, 1_100_000n, 0n).ok).toBe(false);
  });
});
