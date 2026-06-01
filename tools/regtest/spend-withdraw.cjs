#!/usr/bin/env node
/*
 * Prove the BARE covenant spend machinery on regtest: spend the controller UTXO
 * (genesis out0) via withdraw() (function index 1). scriptSig = push(pk) push(sig) OP_1.
 * Sighash via radiantjs (Radiant forkid). This validates selector dispatch + checksig +
 * sighash for a bare Radiant covenant before tackling the full trade.
 */
const cp = require('child_process'), fs = require('fs');
const r = require('/Users/macbookair/CascadeProjects/RadiantMM/node_modules/@radiant-core/radiantjs');
const { Transaction, Script, PrivateKey, crypto } = r;
const BN = crypto.BN;
const Sighash = Transaction.Sighash;
const SIGHASH = crypto.Signature.SIGHASH_ALL | crypto.Signature.SIGHASH_FORKID;
const FLAGS = Script.Interpreter ? (Script.Interpreter.SCRIPT_ENABLE_SIGHASH_FORKID | Script.Interpreter.SCRIPT_VERIFY_STRICTENC) : undefined;
const RT = '/tmp/rmm-regtest';
const rcli = (...a) => cp.execFileSync('/Users/macbookair/CascadeProjects/Radiant-Core/build/src/radiant-cli', [`-datadir=${RT}`, '-rpcwallet=rmm', ...a], { encoding: 'utf8' }).trim();

const g = JSON.parse(fs.readFileSync(`${RT}/genesis.json`));
const gtxid = fs.readFileSync(`${RT}/genesis_txid.txt`, 'utf8').trim();
const ownerPriv = PrivateKey.fromWIF(g.ownerWif);
const ownerPub = ownerPriv.toPublicKey().toBuffer();
const controllerLock = Buffer.from(g.controllerLock, 'hex');

// fee funding coin
const u = JSON.parse(rcli('listunspent', '1', '9999999')).filter(x => x.amount >= 1)[0];
const fundPriv = PrivateKey.fromWIF(rcli('dumpprivkey', u.address));

const tx = new Transaction();
tx.from({ txId: gtxid, outputIndex: 0, script: g.controllerLock, satoshis: g.R });       // input0 = controller
tx.from({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: Math.round(u.amount * 1e8) }); // input1 = fee
const destAddr = rcli('getnewaddress');
const FEE = 5_000_000;
tx.to(destAddr, g.R + Math.round(u.amount * 1e8) - FEE);

// --- input0: controller withdraw covenant scriptSig = push(pk) push(sig) OP_1 ---
const sig0 = Sighash.sign(tx, ownerPriv, SIGHASH, 0, Script.fromBuffer(controllerLock), new BN(g.R), FLAGS);
const sig0buf = Buffer.concat([sig0.toDER(), Buffer.from([SIGHASH])]);
const ss0 = new Script();
ss0.add(Buffer.from(ownerPub));
ss0.add(sig0buf);
ss0.add(0x51); // OP_1 selector (withdraw = function index 1)
tx.inputs[0].setScript(ss0);

// --- input1: standard P2PKH sign ---
const fundSats = Math.round(u.amount * 1e8);
const sig1 = Sighash.sign(tx, fundPriv, SIGHASH, 1, Script.fromHex(u.scriptPubKey), new BN(fundSats), FLAGS);
const sig1buf = Buffer.concat([sig1.toDER(), Buffer.from([SIGHASH])]);
const ss1 = new Script();
ss1.add(sig1buf);
ss1.add(Buffer.from(fundPriv.toPublicKey().toBuffer()));
tx.inputs[1].setScript(ss1);

const hex = tx.serialize(true);
process.stdout.write('WITHDRAW_HEX:' + hex + '\n');
