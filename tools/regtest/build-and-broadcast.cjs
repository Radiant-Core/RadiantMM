#!/usr/bin/env node
/*
 * Foundational regtest tx-build proof: spend a P2PKH coin via radiantjs and
 * print raw hex for `rcli sendrawtransaction`. Verified to build a node-valid
 * signed tx on the local v3.0.0 regtest (Radiant sighash/forkid handled by
 * radiantjs). Use this as the starting point for the genesis + paired trade
 * builders (see ../contracts/v3/BUILD_NOTES.md).
 *
 * Usage: node build-and-broadcast.cjs <txid> <vout> <satoshis> <scriptPubKeyHex> <wif> <destAddr> [feeSats]
 */
const path = require('path');
const r = require(path.join(__dirname, '../../node_modules/@radiant-core/radiantjs'));
const { Transaction, PrivateKey } = r;

const [, , txid, voutS, satsS, spk, wif, dest, feeS] = process.argv;
if (!dest) {
  console.error('usage: build-and-broadcast.cjs <txid> <vout> <sats> <scriptPubKeyHex> <wif> <dest> [feeSats]');
  process.exit(1);
}
const fee = parseInt(feeS || '3000000', 10); // ~10k photons/byte floor; ~226B tx => ~2.3M
const tx = new Transaction()
  .from({ txId: txid, outputIndex: parseInt(voutS, 10), script: spk, satoshis: parseInt(satsS, 10) })
  .to(dest, parseInt(satsS, 10) - fee)
  .sign(PrivateKey.fromWIF(wif));

process.stdout.write(tx.serialize(true) + '\n');
