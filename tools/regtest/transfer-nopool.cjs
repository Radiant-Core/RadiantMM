#!/usr/bin/env node
/*
 * Regression for the transferability defect: a holder→holder transfer() with NO pool
 * controller co-spent. Before the refType fix this was REJECTED
 * (bad-txns-...-reference-operations, because release()'s requireInputRef($poolRef) statically
 * tainted every token output). After the fix it must be ACCEPTED.
 *
 * Spends the genesis user-holder UTXO (out2, userPkh) via transfer() to a fresh holder.
 * inputs : [0] user holder (transfer: push(pk) push(sig) OP_0)  [1] P2PKH funding (fee)
 * outputs: [0] new holder (stateful)  [1] RXD change
 */
const cp = require('child_process'), fs = require('fs');
const rs = require('/Users/macbookair/CascadeProjects/RadiantScript/packages/cashscript/dist/main/index.js');
const r = require('/Users/macbookair/CascadeProjects/RadiantMM/node_modules/@radiant-core/radiantjs');
const { Transaction, Script, PrivateKey, crypto, Opcode } = r;
const BN = crypto.BN, Sighash = Transaction.Sighash;
const SIGHASH = crypto.Signature.SIGHASH_ALL | crypto.Signature.SIGHASH_FORKID;
const FLAGS = Script.Interpreter.SCRIPT_ENABLE_SIGHASH_FORKID | Script.Interpreter.SCRIPT_VERIFY_STRICTENC;
const RT = process.env.RMM_RT || '/tmp/rmm-regtest';
const rcli = (...a) => cp.execFileSync('/Users/macbookair/CascadeProjects/Radiant-Core/build/src/radiant-cli', [`-datadir=${RT}`, '-rpcwallet=rmm', ...a], { encoding: 'utf8' }).trim();

const g = JSON.parse(fs.readFileSync(`${RT}/genesis.json`));
const gtxid = fs.readFileSync(`${RT}/genesis_txid.txt`, 'utf8').trim();
const tokenCode = Buffer.from(g.tokenCode, 'hex');
const userPriv = PrivateKey.fromWIF(g.userWif);
const userPub = userPriv.toPublicKey().toBuffer();
const userPkh = Buffer.from(g.userPkh, 'hex');
const holderLock = Buffer.from(rs.buildStatefulOutput(userPkh, tokenCode)); // genesis out2
const tokAmt = g.T_user;

const recipientAddr = rcli('getnewaddress');
const recipientPkh = Buffer.from(r.Address.fromString(recipientAddr).hashBuffer);
const recipientLock = Buffer.from(rs.buildStatefulOutput(recipientPkh, tokenCode));

const u = JSON.parse(rcli('listunspent', '1', '9999999')).filter(x => x.amount >= 1)[0];
const fundPriv = PrivateKey.fromWIF(rcli('dumpprivkey', u.address));
const fundSats = Math.round(u.amount * 1e8);
const FEE_TX = 5_000_000;

const tx = new Transaction();
tx.from({ txId: gtxid, outputIndex: 2, script: holderLock.toString('hex'), satoshis: tokAmt });
tx.from({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: fundSats });
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(recipientLock), satoshis: tokAmt })); // out0
tx.to(rcli('getnewaddress'), tokAmt + fundSats - tokAmt - FEE_TX);                                      // out1 change

// in0: transfer() — push(senderPk) push(sig) OP_0; OP_DROP prologue consumes the state push
const sig0 = Sighash.sign(tx, userPriv, SIGHASH, 0, Script.fromBuffer(holderLock), new BN(tokAmt), FLAGS);
const ss0 = new Script();
ss0.add(Buffer.from(userPub));
ss0.add(Buffer.concat([sig0.toDER(), Buffer.from([SIGHASH])]));
ss0.add(Opcode.OP_0);
tx.inputs[0].setScript(ss0);
// in1: P2PKH funding
const sig1 = Sighash.sign(tx, fundPriv, SIGHASH, 1, Script.fromHex(u.scriptPubKey), new BN(fundSats), FLAGS);
const ss1 = new Script();
ss1.add(Buffer.concat([sig1.toDER(), Buffer.from([SIGHASH])]));
ss1.add(Buffer.from(fundPriv.toPublicKey().toBuffer()));
tx.inputs[1].setScript(ss1);

process.stdout.write('TRANSFER_HEX:' + tx.serialize(true) + '\n');
