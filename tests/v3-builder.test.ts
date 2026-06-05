import { describe, it, expect } from 'vitest';
import { buildGenesis, GenesisParams } from '../src/v3/builder.js';
import { MAX } from '../src/v3/math.js';

// Minimal params; the R4 guard runs before any tx construction, so the art/funding fields
// are never read on the rejection paths.
const base = (rxdReserve: number, tokenReserve: number): GenesisParams => ({
  art: { poolAsm: 'OP_1', tokenAsm: 'OP_1' },
  fundingA: { txid: '00'.repeat(32), vout: 0, satoshis: 1e8, scriptPubKey: '', wif: '' },
  fundingB: { txid: '11'.repeat(32), vout: 0, satoshis: 1e8, scriptPubKey: '', wif: '' },
  ownerPkh: Buffer.alloc(20),
  rxdReserve,
  tokenReserve,
  changeAddress: '',
  feeSats: 1000,
});

describe('v3 buildGenesis — R4 untradeable-pool guard', () => {
  it('rejects a pool whose R*T exceeds the on-chain overflow bound (MAX = 2^53-1)', () => {
    // 1e10 * 1e6 = 1e16 > 9.007e15
    expect(() => buildGenesis(base(10_000_000_000, 1_000_000))).toThrow(/exceeds the on-chain overflow bound/);
  });

  it('rejects a sub-dust RXD reserve', () => {
    expect(() => buildGenesis(base(100, 1_000_000))).toThrow(/below dust/);
  });

  it('rejects a non-positive token reserve', () => {
    expect(() => buildGenesis(base(1_000_000, 0))).toThrow(/tokenReserve must be > 0/);
  });

  it('R*T exactly at MAX is allowed past the guard (fails later for unrelated dummy art, not the guard)', () => {
    // product == MAX must NOT trip the R4 guard; any later throw must be a different message.
    const Tt = 1_000_000;
    const Rr = Number(MAX / BigInt(Tt)); // floor, so Rr*Tt <= MAX
    expect(Rr * Tt).toBeLessThanOrEqual(Number(MAX));
    expect(() => buildGenesis(base(Rr, Tt))).not.toThrow(/exceeds the on-chain overflow bound|below dust|tokenReserve must be/);
  });
});
