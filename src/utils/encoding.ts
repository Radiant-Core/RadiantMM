/**
 * Encoding utilities for RadiantMM
 */

/**
 * Convert a hex string to Buffer
 */
export function hexToBuffer(hex: string): Buffer {
  if (hex.startsWith('0x')) {
    hex = hex.slice(2);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Convert a Buffer to hex string
 */
export function bufferToHex(buf: Buffer): string {
  return buf.toString('hex');
}

/**
 * Reverse a buffer (for txid display)
 */
export function reverseBuffer(buf: Buffer): Buffer {
  return Buffer.from(buf).reverse();
}

/**
 * Convert a number to little-endian buffer
 */
export function numberToLE(n: number | bigint, bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  if (typeof n === 'bigint') {
    if (bytes === 8) {
      buf.writeBigInt64LE(n, 0);
    } else {
      // Convert to number for smaller sizes
      buf.writeIntLE(Number(n), 0, bytes);
    }
  } else {
    buf.writeIntLE(n, 0, bytes);
  }
  return buf;
}

/**
 * Convert a little-endian buffer to number
 */
export function leToNumber(buf: Buffer): number {
  return buf.readIntLE(0, buf.length);
}

/**
 * Convert a little-endian buffer to bigint
 */
export function leToBigInt(buf: Buffer): bigint {
  if (buf.length === 8) {
    return buf.readBigInt64LE(0);
  }
  // For smaller buffers, read as number then convert
  return BigInt(buf.readIntLE(0, buf.length));
}

/**
 * Encode a string as UTF-8 buffer
 */
export function stringToBuffer(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

/**
 * Decode a buffer as UTF-8 string
 */
export function bufferToString(buf: Buffer): string {
  return buf.toString('utf8');
}

/**
 * Concatenate multiple buffers
 */
export function concatBuffers(...buffers: Buffer[]): Buffer {
  return Buffer.concat(buffers);
}

/**
 * Compare two buffers for equality
 */
export function buffersEqual(a: Buffer, b: Buffer): boolean {
  return a.equals(b);
}

/**
 * Create a buffer of zeros
 */
export function zeroBuffer(length: number): Buffer {
  return Buffer.alloc(length);
}

/**
 * Slice a buffer with bounds checking
 */
export function safeSlice(buf: Buffer, start: number, end?: number): Buffer {
  const actualEnd = end ?? buf.length;
  if (start < 0 || actualEnd > buf.length || start > actualEnd) {
    throw new Error(`Invalid slice bounds: ${start}-${actualEnd} for buffer of length ${buf.length}`);
  }
  return buf.subarray(start, actualEnd);
}
