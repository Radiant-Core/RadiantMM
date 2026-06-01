/**
 * RadiantMM v3 SDK — paired-UTXO CPMM (validated on regtest).
 *
 * Math (`math.ts`) is byte-consistent with the on-chain controller; builders
 * (`builder.ts`) construct the genesis + buy transactions proven on-chain; script
 * helpers (`contracts.ts`) build the bare ref-bearing locking scripts. See
 * ../../contracts/v3/ and ../../docs/REDESIGN_C1_C2.md.
 */
export * from './math.js';
export * from './contracts.js';
export * from './builder.js';
