/**
 * Script encoding/decoding utilities for RadiantMM
 */

import { CONTRACT_CONFIG } from '../types.js';
import { RadiantMMError, ErrorCodes } from '../errors.js';

/** Opcode constants */
export const OP = {
  // Stack
  OP_0: 0x00,
  OP_DEPTH: 0x74,
  OP_DROP: 0x75,
  OP_DUP: 0x76,
  OP_NIP: 0x77,
  OP_SWAP: 0x7c,
  OP_TUCK: 0x7d,
  OP_ROT: 0x7b,
  
  // Control
  OP_IF: 0x63,
  OP_ELSE: 0x67,
  OP_ENDIF: 0x68,
  
  // Crypto
  OP_HASH160: 0xa9,
  OP_CHECKSIG: 0xac,
  
  // Comparison
  OP_EQUAL: 0x87,
  OP_EQUALVERIFY: 0x88,
  OP_LESSTHANOREQUAL: 0xa1,
  OP_GREATERTHANOREQUAL: 0xa2,
  
  // Arithmetic
  OP_ADD: 0x93,
  OP_SUB: 0x94,
  OP_MUL: 0x95,
  OP_DIV: 0x96,
  OP_ABS: 0x90,
  
  // Splice
  OP_SIZE: 0x82,
  OP_SPLIT: 0x7f,
  
  // Conversion
  OP_BIN2NUM: 0x81,
  OP_NUM2BIN: 0x80,
  
  // Introspection (Radiant-specific)
  OP_INPUTINDEX: 0xc0,
  OP_UTXOVALUE: 0xc5,
  OP_OUTPUTVALUE: 0xc6,
  OP_UTXOBYTECODE: 0xc7,
  OP_OUTPUTBYTECODE: 0xc8,
  
  // State (Radiant-specific)
  OP_STATESEPARATOR: 0xbd,
  
  // Push data
  OP_PUSHDATA1: 0x4c,
  OP_PUSHDATA2: 0x4d,
} as const;

/** Pool state structure */
export interface DecodedState {
  tokenAmount: bigint;
}

/** Pool script structure */
export interface DecodedScript {
  codeHash: Buffer;
  ownerPkh: Buffer;
  state: DecodedState;
}

/**
 * Encode token amount as 8-byte little-endian buffer
 */
export function encodeTokenAmount(amount: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(amount, 0);
  return buf;
}

/**
 * Decode token amount from 8-byte little-endian buffer
 */
export function decodeTokenAmount(buf: Buffer): bigint {
  if (buf.length !== 8) {
    throw new RadiantMMError(
      ErrorCodes.INVALID_STATE,
      `Invalid token amount size: ${buf.length}, expected 8`
    );
  }
  return buf.readBigInt64LE(0);
}

/**
 * Encode pool state
 */
export function encodeState(tokenAmount: bigint): Buffer {
  return encodeTokenAmount(tokenAmount);
}

/**
 * Decode pool state from script
 */
export function decodeState(script: Buffer): DecodedState {
  // State is the last 8 bytes after OP_STATESEPARATOR
  const separatorIndex = script.lastIndexOf(OP.OP_STATESEPARATOR);
  
  if (separatorIndex === -1) {
    throw new RadiantMMError(
      ErrorCodes.INVALID_SCRIPT,
      'No state separator found in script'
    );
  }
  
  const stateData = script.subarray(separatorIndex + 1);
  
  if (stateData.length < CONTRACT_CONFIG.STATE_SIZE) {
    throw new RadiantMMError(
      ErrorCodes.INVALID_STATE,
      `State too small: ${stateData.length} bytes`
    );
  }
  
  const tokenAmount = decodeTokenAmount(stateData.subarray(0, 8));
  
  return { tokenAmount };
}

/**
 * Build complete pool locking script
 */
export function buildPoolScript(ownerPkh: Buffer, tokenAmount: bigint): Buffer {
  if (ownerPkh.length !== CONTRACT_CONFIG.OWNER_PKH_SIZE) {
    throw new RadiantMMError(
      ErrorCodes.INVALID_SCRIPT,
      `Invalid owner PKH size: ${ownerPkh.length}, expected ${CONTRACT_CONFIG.OWNER_PKH_SIZE}`
    );
  }
  
  const code = buildCodePortion(ownerPkh);
  const state = encodeState(tokenAmount);
  
  return Buffer.concat([code, Buffer.from([OP.OP_STATESEPARATOR]), state]);
}

/**
 * Build the code portion of the pool script (immutable logic)
 */
function buildCodePortion(ownerPkh: Buffer): Buffer {
  const parts: Buffer[] = [];
  
  // OP_DEPTH OP_IF
  parts.push(Buffer.from([OP.OP_DEPTH, OP.OP_IF]));
  
  // Withdrawal path: OP_DUP OP_HASH160 <20:ownerPkh> OP_EQUALVERIFY OP_CHECKSIG
  parts.push(Buffer.from([OP.OP_DUP, OP.OP_HASH160]));
  parts.push(pushData(ownerPkh));
  parts.push(Buffer.from([OP.OP_EQUALVERIFY, OP.OP_CHECKSIG]));
  
  // OP_ELSE
  parts.push(Buffer.from([OP.OP_ELSE]));
  
  // Trade path - contract continuity
  parts.push(Buffer.from([
    OP.OP_INPUTINDEX, OP.OP_OUTPUTBYTECODE,
    OP.OP_INPUTINDEX, OP.OP_UTXOBYTECODE,
    OP.OP_EQUALVERIFY
  ]));
  
  // K_in calculation: rxd_in * token_in
  parts.push(Buffer.from([
    OP.OP_INPUTINDEX, OP.OP_UTXOVALUE,        // [rxd_in]
    OP.OP_INPUTINDEX, OP.OP_UTXOBYTECODE,     // [rxd_in, bytecode]
    OP.OP_SIZE                                 // [rxd_in, bytecode, len]
  ]));
  parts.push(pushNumber(8n));                  // [rxd_in, bytecode, len, 8]
  parts.push(Buffer.from([
    OP.OP_SUB,                                 // [rxd_in, bytecode, len-8]
    OP.OP_SPLIT,                               // [rxd_in, code, state]
    OP.OP_NIP,                                 // [rxd_in, state]
    OP.OP_BIN2NUM,                             // [rxd_in, token_in]
    OP.OP_TUCK,                                // [token_in, rxd_in, token_in]
    OP.OP_MUL,                                 // [token_in, k_in]
    OP.OP_SWAP                                 // [k_in, token_in]
  ]));
  
  // Fee calculation: |rxd_out - rxd_in| * 3 / 1000
  parts.push(Buffer.from([
    OP.OP_INPUTINDEX, OP.OP_UTXOVALUE,        // [k_in, token_in, rxd_in]
    OP.OP_INPUTINDEX, OP.OP_OUTPUTVALUE,      // [k_in, token_in, rxd_in, rxd_out]
    OP.OP_TUCK,                                // [k_in, token_in, rxd_out, rxd_in, rxd_out]
    OP.OP_SUB,                                 // [k_in, token_in, rxd_out, delta]
    OP.OP_ABS                                  // [k_in, token_in, rxd_out, |delta|]
  ]));
  parts.push(pushNumber(3n));                  // [k_in, token_in, rxd_out, |delta|, 3]
  parts.push(Buffer.from([OP.OP_MUL]));        // [k_in, token_in, rxd_out, |delta|*3]
  parts.push(pushNumber(1000n));               // [k_in, token_in, rxd_out, |delta|*3, 1000]
  parts.push(Buffer.from([
    OP.OP_DIV,                                 // [k_in, token_in, rxd_out, fee]
    OP.OP_SUB                                  // [k_in, token_in, eff_rxd_out]
  ]));
  
  // K_out calculation: eff_rxd_out * token_out
  parts.push(Buffer.from([
    OP.OP_INPUTINDEX, OP.OP_OUTPUTBYTECODE,   // [k_in, token_in, eff_rxd, out_bytecode]
    OP.OP_SIZE                                 // [k_in, token_in, eff_rxd, out_bytecode, len]
  ]));
  parts.push(pushNumber(8n));
  parts.push(Buffer.from([
    OP.OP_SUB,                                 // [k_in, token_in, eff_rxd, out_bytecode, len-8]
    OP.OP_SPLIT,                               // [k_in, token_in, eff_rxd, code, state]
    OP.OP_NIP,                                 // [k_in, token_in, eff_rxd, state]
    OP.OP_BIN2NUM,                             // [k_in, token_in, eff_rxd, token_out]
    OP.OP_MUL                                  // [k_in, token_in, k_out]
  ]));
  
  // Verify K_out >= K_in
  parts.push(Buffer.from([
    OP.OP_ROT,                                 // [token_in, k_out, k_in]
    OP.OP_DROP,                                // [k_out, k_in]
    OP.OP_SWAP,                                // [k_in, k_out]
    OP.OP_LESSTHANOREQUAL                      // [k_in <= k_out]
  ]));
  
  // OP_ENDIF
  parts.push(Buffer.from([OP.OP_ENDIF]));
  
  return Buffer.concat(parts);
}

/**
 * Parse pool script to extract components
 */
export function parsePoolScript(script: Buffer): DecodedScript {
  const separatorIndex = script.lastIndexOf(OP.OP_STATESEPARATOR);
  
  if (separatorIndex === -1) {
    throw new RadiantMMError(
      ErrorCodes.INVALID_SCRIPT,
      'No state separator found'
    );
  }
  
  const codePortion = script.subarray(0, separatorIndex);
  const statePortion = script.subarray(separatorIndex + 1);
  
  // Extract owner PKH from code (after OP_DUP OP_HASH160, before OP_EQUALVERIFY)
  // Pattern: 0x76 0xa9 [push] <20 bytes> 0x88
  const hash160Index = codePortion.indexOf(Buffer.from([OP.OP_DUP, OP.OP_HASH160]));
  if (hash160Index === -1) {
    throw new RadiantMMError(ErrorCodes.INVALID_SCRIPT, 'Owner PKH not found');
  }
  
  const pkhStart = hash160Index + 3; // After DUP, HASH160, and push opcode
  const ownerPkh = codePortion.subarray(pkhStart, pkhStart + 20);
  
  // Decode state
  const state = decodeState(script);
  
  // Calculate code hash (for continuity verification)
  const codeHash = Buffer.alloc(32); // Would use actual hash in production
  
  return {
    codeHash,
    ownerPkh,
    state
  };
}

/**
 * Create push data opcode sequence
 */
export function pushData(data: Buffer): Buffer {
  const len = data.length;
  
  if (len === 0) {
    return Buffer.from([OP.OP_0]);
  }
  
  if (len <= 75) {
    return Buffer.concat([Buffer.from([len]), data]);
  }
  
  if (len <= 255) {
    return Buffer.concat([Buffer.from([OP.OP_PUSHDATA1, len]), data]);
  }
  
  if (len <= 65535) {
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16LE(len, 0);
    return Buffer.concat([Buffer.from([OP.OP_PUSHDATA2]), lenBuf, data]);
  }
  
  throw new RadiantMMError(
    ErrorCodes.SCRIPT_TOO_LARGE,
    `Data too large for push: ${len} bytes`
  );
}

/**
 * Create push number opcode sequence (minimal encoding)
 */
export function pushNumber(n: bigint): Buffer {
  if (n === 0n) {
    return Buffer.from([OP.OP_0]);
  }
  
  if (n >= 1n && n <= 16n) {
    return Buffer.from([0x50 + Number(n)]); // OP_1 through OP_16
  }
  
  if (n === -1n) {
    return Buffer.from([0x4f]); // OP_1NEGATE
  }
  
  // Encode as minimal push
  const neg = n < 0n;
  let abs = neg ? -n : n;
  const bytes: number[] = [];
  
  while (abs > 0n) {
    bytes.push(Number(abs & 0xffn));
    abs >>= 8n;
  }
  
  // Add sign bit if needed
  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(neg ? 0x80 : 0x00);
  } else if (neg) {
    bytes[bytes.length - 1] |= 0x80;
  }
  
  return pushData(Buffer.from(bytes));
}

/**
 * Update state portion of a script (for creating output script)
 */
export function updateScriptState(script: Buffer, newTokenAmount: bigint): Buffer {
  const separatorIndex = script.lastIndexOf(OP.OP_STATESEPARATOR);
  
  if (separatorIndex === -1) {
    throw new RadiantMMError(ErrorCodes.INVALID_SCRIPT, 'No state separator');
  }
  
  const codePortion = script.subarray(0, separatorIndex + 1); // Include separator
  const newState = encodeState(newTokenAmount);
  
  return Buffer.concat([codePortion, newState]);
}
