/**
 * RadiantMM v3 CPMM math — kept BYTE-FOR-BYTE consistent with the on-chain
 * controller `trade()` (contracts/v3/RadiantMMPool.rxd), so any amounts the SDK
 * produces are accepted by consensus and any it rejects the contract rejects.
 *
 * Contract acceptance criterion for a trade that turns (R,T) into (rxdOut,tokOut):
 *   require rxdOut >= DUST && R >= DUST && T > 0 && tokOut > 0
 *   require R   <= MAX / T
 *   fee        = ceil(|rxdOut - R| * 3 / 1000)            // ceiling, favours the pool
 *   effRxdOut  = rxdOut - fee;  require effRxdOut > 0
 *   require effRxdOut <= MAX / tokOut
 *   require effRxdOut * tokOut >= R * T                    // constant product
 *
 * Validated on regtest: quoteBuy(1_000_000, 100_000, 100_000) =>
 *   { fee: 300, rxdReserveOut: 1_100_000, tokenReserveOut: 90_934, tokensOut: 9_066 }
 * and tokenReserveOut 90_933 is rejected (fee enforced to the satoshi).
 */

export const FEE_NUM = 3n;
export const FEE_DEN = 1000n;
export const DUST = 546n;
/** JS-safe overflow bound, matching the contract's 2^53-1 (a 2^63-1 literal mis-encodes). */
export const MAX = 9_007_199_254_740_991n;

export function abs(n: bigint): bigint { return n < 0n ? -n : n; }
export function ceilDiv(a: bigint, b: bigint): bigint { return (a + b - 1n) / b; }

/** Ceiling fee on an RXD delta — matches `(delta*3 + 999) / 1000` in the contract. */
export function ceilingFee(rxdDelta: bigint): bigint {
  return ceilDiv(abs(rxdDelta) * FEE_NUM, FEE_DEN);
}

export interface AcceptCheck { ok: boolean; reason?: string; fee: bigint; kIn: bigint; kOut: bigint; }

/** Exact replica of the contract's trade() acceptance test. */
export function verifyAccept(R: bigint, T: bigint, rxdOut: bigint, tokOut: bigint): AcceptCheck {
  const fail = (reason: string, fee = 0n, kIn = 0n, kOut = 0n): AcceptCheck => ({ ok: false, reason, fee, kIn, kOut });
  if (R < DUST) return fail('rxdIn < DUST');
  if (rxdOut < DUST) return fail('rxdOut < DUST');
  if (T <= 0n) return fail('tokIn <= 0');
  if (tokOut <= 0n) return fail('tokOut <= 0');
  if (R > MAX / T) return fail('R*T overflow guard');
  const kIn = R * T;
  const fee = ceilingFee(rxdOut - R);
  const effRxdOut = rxdOut - fee;
  if (effRxdOut <= 0n) return fail('effRxdOut <= 0', fee);
  if (effRxdOut > MAX / tokOut) return fail('effRxdOut*tokOut overflow guard', fee);
  const kOut = effRxdOut * tokOut;
  if (kOut < kIn) return fail('K decreased', fee, kIn, kOut);
  return { ok: true, fee, kIn, kOut };
}

export interface Quote {
  rxdReserveOut: bigint;   // new RXD reserve (controller output value)
  tokenReserveOut: bigint; // new token reserve (reserve output value)
  fee: bigint;             // ceiling fee charged on the RXD delta
  amountOut: bigint;       // tokens to trader (buy) or RXD to trader (sell)
}

/**
 * BUY: trader adds `rxdIn` RXD, receives the maximum tokens the invariant allows.
 * New RXD reserve = R + rxdIn; minimum new token reserve = ceil(R*T / effRxdOut).
 */
export function quoteBuy(R: bigint, T: bigint, rxdIn: bigint): Quote {
  if (rxdIn <= 0n) throw new Error('rxdIn must be > 0');
  const rxdReserveOut = R + rxdIn;
  const fee = ceilingFee(rxdIn);                 // |rxdOut - R| == rxdIn
  const effRxdOut = rxdReserveOut - fee;
  if (effRxdOut <= 0n) throw new Error('fee exceeds input');
  const tokenReserveOut = ceilDiv(R * T, effRxdOut);   // smallest reserve that keeps K
  const amountOut = T - tokenReserveOut;
  if (amountOut <= 0n) throw new Error('amount too small for any token out');
  return { rxdReserveOut, tokenReserveOut, fee, amountOut };
}

/**
 * SELL: trader adds `tokensIn` tokens, receives the maximum RXD the invariant allows.
 * New token reserve = T + tokensIn. The fee depends on the RXD delta, so we take the
 * largest withdrawal `d` with d + ceil(d*3/1000) <= R - ceil(R*T/(T+tokensIn)), then
 * confirm with verifyAccept (steps down at most a couple of satoshis for the ceiling).
 */
export function quoteSell(R: bigint, T: bigint, tokensIn: bigint): Quote {
  if (tokensIn <= 0n) throw new Error('tokensIn must be > 0');
  const tokenReserveOut = T + tokensIn;
  const effRxdOutMin = ceilDiv(R * T, tokenReserveOut); // effRxdOut must be >= this
  // budget for (withdrawal + fee): R - effRxdOutMin
  const budget = R - effRxdOutMin;
  if (budget <= 0n) throw new Error('no RXD out for this size');
  // d + ceil(d*3/1000) <= budget  ->  d ~= budget * 1000 / 1003
  let d = (budget * FEE_DEN) / (FEE_DEN + FEE_NUM);
  // step down until it actually verifies (handles ceiling rounding)
  while (d > 0n && !verifyAccept(R, T, R - d, tokenReserveOut).ok) d -= 1n;
  if (d <= 0n) throw new Error('amount too small for any RXD out');
  const rxdReserveOut = R - d;
  const fee = ceilingFee(d);
  return { rxdReserveOut, tokenReserveOut, fee, amountOut: d };
}

/** Spot price: RXD per token (float, for display only). */
export function spotPrice(R: bigint, T: bigint): number {
  return T === 0n ? 0 : Number(R) / Number(T);
}
