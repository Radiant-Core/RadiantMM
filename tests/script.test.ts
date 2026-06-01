/**
 * Tests for RadiantMM script encoding/decoding
 *
 * Regression coverage for H1: the state must be located by fixed length
 * (matching the on-chain `OP_SIZE 8 OP_SUB OP_SPLIT`), NOT by scanning for the
 * separator byte 0xbd, which is also a legal data byte inside the token amount.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPoolScript,
  decodeState,
  parsePoolScript,
  updateScriptState,
} from '../src/utils/script.js';

describe('script state parsing', () => {
  const ownerPkh = Buffer.alloc(20, 0x11);

  describe('round-trips token amounts whose encoding contains 0xbd', () => {
    // 0xbd === OP_STATESEPARATOR. These amounts have a 0xbd byte somewhere in
    // their little-endian encoding and previously broke the lastIndexOf scan.
    const tricky = [
      189n, // 0xbd 00 00 00 00 00 00 00
      0xbdbdn, // 0xbd 0xbd ...
      0x00bd00bd00bdn,
      0x7fbdbdbdbdbdbdn,
    ];

    for (const amount of tricky) {
      it(`decodes ${amount}`, () => {
        const script = buildPoolScript(ownerPkh, amount);
        expect(decodeState(script).tokenAmount).toBe(amount);
        expect(parsePoolScript(script).state.tokenAmount).toBe(amount);
        expect(parsePoolScript(script).ownerPkh.equals(ownerPkh)).toBe(true);
      });
    }
  });

  it('round-trips ordinary amounts', () => {
    const script = buildPoolScript(ownerPkh, 1000n);
    expect(decodeState(script).tokenAmount).toBe(1000n);
  });

  it('updateScriptState preserves the code portion and rewrites state', () => {
    const script = buildPoolScript(ownerPkh, 1000n);
    const updated = updateScriptState(script, 0xbdn);

    // Code portion (everything but the trailing 8 state bytes) is unchanged.
    expect(updated.subarray(0, updated.length - 8))
      .toEqual(script.subarray(0, script.length - 8));
    // New state decodes back to the requested amount.
    expect(decodeState(updated).tokenAmount).toBe(0xbdn);
    expect(parsePoolScript(updated).ownerPkh.equals(ownerPkh)).toBe(true);
  });

  it('rejects a script too small to contain state', () => {
    expect(() => decodeState(Buffer.alloc(4))).toThrow();
  });
});
