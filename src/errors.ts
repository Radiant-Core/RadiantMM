/**
 * RadiantMM Error handling
 */

export enum ErrorCodes {
  // Pool errors (1xx)
  INVALID_POOL_STATE = 100,
  POOL_NOT_FOUND = 101,
  INSUFFICIENT_LIQUIDITY = 102,
  
  // Trade errors (2xx)
  INVALID_TRADE = 200,
  SLIPPAGE_EXCEEDED = 201,
  K_VIOLATION = 202,
  AMOUNT_TOO_SMALL = 203,
  AMOUNT_TOO_LARGE = 204,
  
  // Transaction errors (3xx)
  INVALID_TRANSACTION = 300,
  INSUFFICIENT_FUNDS = 301,
  INVALID_SIGNATURE = 302,
  BROADCAST_FAILED = 303,
  
  // Script errors (4xx)
  INVALID_SCRIPT = 400,
  INVALID_STATE = 401,
  SCRIPT_TOO_LARGE = 402,
  
  // Math errors (5xx)
  OVERFLOW = 500,
  UNDERFLOW = 501,
  DIVISION_BY_ZERO = 502,
}

export class RadiantMMError extends Error {
  readonly code: ErrorCodes;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCodes, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RadiantMMError';
    this.code = code;
    this.details = details;
  }

  static poolNotFound(txid: string, vout: number): RadiantMMError {
    return new RadiantMMError(
      ErrorCodes.POOL_NOT_FOUND,
      `Pool not found: ${txid}:${vout}`,
      { txid, vout }
    );
  }

  static insufficientLiquidity(required: bigint, available: bigint): RadiantMMError {
    return new RadiantMMError(
      ErrorCodes.INSUFFICIENT_LIQUIDITY,
      `Insufficient liquidity: required ${required}, available ${available}`,
      { required: required.toString(), available: available.toString() }
    );
  }

  static slippageExceeded(expected: bigint, actual: bigint, maxSlippage: number): RadiantMMError {
    return new RadiantMMError(
      ErrorCodes.SLIPPAGE_EXCEEDED,
      `Slippage exceeded: expected ${expected}, got ${actual}, max ${maxSlippage}%`,
      { expected: expected.toString(), actual: actual.toString(), maxSlippage }
    );
  }

  static kViolation(kIn: bigint, kOut: bigint): RadiantMMError {
    return new RadiantMMError(
      ErrorCodes.K_VIOLATION,
      `K violation: K_in=${kIn}, K_out=${kOut}`,
      { kIn: kIn.toString(), kOut: kOut.toString() }
    );
  }

  static overflow(operation: string, a: bigint, b: bigint): RadiantMMError {
    return new RadiantMMError(
      ErrorCodes.OVERFLOW,
      `Overflow in ${operation}: ${a} and ${b}`,
      { operation, a: a.toString(), b: b.toString() }
    );
  }

  static amountTooSmall(amount: bigint, minimum: bigint): RadiantMMError {
    return new RadiantMMError(
      ErrorCodes.AMOUNT_TOO_SMALL,
      `Amount ${amount} below minimum ${minimum}`,
      { amount: amount.toString(), minimum: minimum.toString() }
    );
  }
}
