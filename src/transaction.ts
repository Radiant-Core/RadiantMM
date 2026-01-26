/**
 * Transaction building utilities for RadiantMM
 */

import type { UTXO, Output } from './types.js';

export type { UTXO, Output };

/**
 * Simple transaction builder for RadiantMM
 */
export class TransactionBuilder {
  private version: number = 2;
  private inputs: TransactionInput[] = [];
  private outputs: TransactionOutput[] = [];
  private locktime: number = 0;

  /**
   * Set transaction version
   */
  setVersion(version: number): this {
    this.version = version;
    return this;
  }

  /**
   * Add an input from a UTXO
   */
  addInput(utxo: UTXO, unlockScript?: Buffer): this {
    this.inputs.push({
      txid: utxo.txid,
      vout: utxo.vout,
      scriptSig: unlockScript || Buffer.alloc(0),
      sequence: 0xffffffff,
      prevScriptPubKey: utxo.scriptPubKey,
      prevValue: utxo.value
    });
    return this;
  }

  /**
   * Add multiple inputs
   */
  addInputs(utxos: UTXO[], unlockScripts?: Buffer[]): this {
    utxos.forEach((utxo, i) => {
      this.addInput(utxo, unlockScripts?.[i]);
    });
    return this;
  }

  /**
   * Add an output
   */
  addOutput(output: Output): this {
    this.outputs.push({
      value: output.value,
      scriptPubKey: output.scriptPubKey
    });
    return this;
  }

  /**
   * Add multiple outputs
   */
  addOutputs(outputs: Output[]): this {
    outputs.forEach(output => this.addOutput(output));
    return this;
  }

  /**
   * Set locktime
   */
  setLocktime(locktime: number): this {
    this.locktime = locktime;
    return this;
  }

  /**
   * Get total input value
   */
  get totalInputValue(): bigint {
    return this.inputs.reduce((sum, input) => sum + input.prevValue, 0n);
  }

  /**
   * Get total output value
   */
  get totalOutputValue(): bigint {
    return this.outputs.reduce((sum, output) => sum + output.value, 0n);
  }

  /**
   * Get implied miner fee
   */
  get fee(): bigint {
    return this.totalInputValue - this.totalOutputValue;
  }

  /**
   * Estimate transaction size in bytes
   */
  estimateSize(): number {
    // Base: version (4) + input count (1-9) + output count (1-9) + locktime (4)
    let size = 10;
    
    // Each input: prevout (36) + scriptSig length (1-9) + scriptSig + sequence (4)
    for (const input of this.inputs) {
      size += 36 + 1 + input.scriptSig.length + 4;
    }
    
    // Each output: value (8) + scriptPubKey length (1-9) + scriptPubKey
    for (const output of this.outputs) {
      size += 8 + 1 + output.scriptPubKey.length;
    }
    
    return size;
  }

  /**
   * Calculate recommended fee based on size
   */
  recommendedFee(satPerByte: number = 1): bigint {
    return BigInt(Math.ceil(this.estimateSize() * satPerByte));
  }

  /**
   * Serialize transaction to hex
   */
  toHex(): string {
    const parts: Buffer[] = [];
    
    // Version (4 bytes, little-endian)
    const versionBuf = Buffer.alloc(4);
    versionBuf.writeUInt32LE(this.version, 0);
    parts.push(versionBuf);
    
    // Input count (varint)
    parts.push(this.encodeVarint(this.inputs.length));
    
    // Inputs
    for (const input of this.inputs) {
      // Previous output txid (32 bytes, reversed)
      const txidBuf = Buffer.from(input.txid, 'hex').reverse();
      parts.push(txidBuf);
      
      // Previous output index (4 bytes, little-endian)
      const voutBuf = Buffer.alloc(4);
      voutBuf.writeUInt32LE(input.vout, 0);
      parts.push(voutBuf);
      
      // Script length + script
      parts.push(this.encodeVarint(input.scriptSig.length));
      parts.push(input.scriptSig);
      
      // Sequence (4 bytes, little-endian)
      const seqBuf = Buffer.alloc(4);
      seqBuf.writeUInt32LE(input.sequence, 0);
      parts.push(seqBuf);
    }
    
    // Output count (varint)
    parts.push(this.encodeVarint(this.outputs.length));
    
    // Outputs
    for (const output of this.outputs) {
      // Value (8 bytes, little-endian)
      const valueBuf = Buffer.alloc(8);
      valueBuf.writeBigUInt64LE(output.value, 0);
      parts.push(valueBuf);
      
      // Script length + script
      parts.push(this.encodeVarint(output.scriptPubKey.length));
      parts.push(output.scriptPubKey);
    }
    
    // Locktime (4 bytes, little-endian)
    const locktimeBuf = Buffer.alloc(4);
    locktimeBuf.writeUInt32LE(this.locktime, 0);
    parts.push(locktimeBuf);
    
    return Buffer.concat(parts).toString('hex');
  }

  /**
   * Get transaction data for signing
   */
  getSigningData(inputIndex: number, hashType: number = 0x41): Buffer {
    // Simplified - in production would implement full sighash algorithm
    // with FORKID support for Radiant
    throw new Error('Not implemented - use external signing library');
  }

  /**
   * Encode a variable-length integer
   */
  private encodeVarint(n: number): Buffer {
    if (n < 0xfd) {
      return Buffer.from([n]);
    } else if (n <= 0xffff) {
      const buf = Buffer.alloc(3);
      buf[0] = 0xfd;
      buf.writeUInt16LE(n, 1);
      return buf;
    } else if (n <= 0xffffffff) {
      const buf = Buffer.alloc(5);
      buf[0] = 0xfe;
      buf.writeUInt32LE(n, 1);
      return buf;
    } else {
      const buf = Buffer.alloc(9);
      buf[0] = 0xff;
      buf.writeBigUInt64LE(BigInt(n), 1);
      return buf;
    }
  }

  /**
   * Clear the builder
   */
  clear(): this {
    this.inputs = [];
    this.outputs = [];
    this.locktime = 0;
    return this;
  }
}

interface TransactionInput {
  txid: string;
  vout: number;
  scriptSig: Buffer;
  sequence: number;
  prevScriptPubKey: Buffer;
  prevValue: bigint;
}

interface TransactionOutput {
  value: bigint;
  scriptPubKey: Buffer;
}
