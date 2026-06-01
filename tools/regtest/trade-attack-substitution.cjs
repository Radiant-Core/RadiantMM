#!/usr/bin/env node
/*
 * BUY trade on regtest: trader adds RXD to the pool and takes tokens, while the
 * controller enforces K = R*T (after 0.3% fee) and both pool UTXOs are recreated.
 *
 * inputs : [0]=controller (selector 0 trade)  [1]=reserve (selector 1 release)  [2]=trader RXD (P2PKH)
 * outputs: [0]=controller' (R')  [1]=reserve' (T', bare)  [2]=trader tokens (stateful)  [3]=RXD change
 * trade()/release() are permissionless — no covenant signatures, only selectors + structure.
 */
const cp = require('child_process'), fs = require('fs');
const rs = require('/Users/macbookair/CascadeProjects/RadiantScript/packages/cashscript/dist/main/index.js');
const r = require('/Users/macbookair/CascadeProjects/RadiantMM/node_modules/@radiant-core/radiantjs');
const { Transaction, Script, PrivateKey, crypto } = r;
const BN = crypto.BN, Sighash = Transaction.Sighash;
const SIGHASH = crypto.Signature.SIGHASH_ALL | crypto.Signature.SIGHASH_FORKID;
const FLAGS = Script.Interpreter.SCRIPT_ENABLE_SIGHASH_FORKID | Script.Interpreter.SCRIPT_VERIFY_STRICTENC;
const RT = '/tmp/rmm-regtest';
const rcli = (...a) => cp.execFileSync('/Users/macbookair/CascadeProjects/Radiant-Core/build/src/radiant-cli', [`-datadir=${RT}`, '-rpcwallet=rmm', ...a], { encoding: 'utf8' }).trim();
const toHex = (b) => Buffer.from(b).toString('hex');

const g = JSON.parse(fs.readFileSync(`${RT}/genesis.json`));
const gtxid = fs.readFileSync(`${RT}/genesis_txid.txt`, 'utf8').trim();
const controllerLock = Buffer.from(g.controllerLock, 'hex'); // poolCode (bare)
const tokenCode = Buffer.from(g.reserveLock, 'hex');         // tokenCode (bare reserve)

// --- pool state + a chosen buy ---
const R = g.R, T = g.T_pool;            // 1,000,000 RXD ; 100,000 tokens
const addRxd = 100_000;                 // trader adds this much RXD
const Rp = R + addRxd;                  // 1,100,000
const fee = Math.ceil(Math.abs(Rp - R) * 3 / 1000);   // ceil(300)=300
const effRxdOut = Rp - fee;
// K: effRxdOut * Tp >= R*T  => Tp >= ceil(R*T/effRxdOut)
const Tp = Math.ceil((R * T) / effRxdOut);             // new token reserve
const tokensOut = T - Tp;                              // to trader
console.log(`buy: R ${R}->${Rp}, T ${T}->${Tp}, tokensOut ${tokensOut}, fee ${fee}`);
console.log(`K_in=${R*T}  K_out=${effRxdOut*Tp}  ok=${effRxdOut*Tp >= R*T}`);

// trader key (new) for received tokens
const traderAddr = rcli('getnewaddress');
const traderPkh = Buffer.from(r.Address.fromString(traderAddr).hashBuffer);
const traderTokenLock = Buffer.from(rs.buildStatefulOutput(traderPkh, tokenCode));

// trader RXD funding coin
const u = JSON.parse(rcli('listunspent', '1', '9999999')).filter(x => x.amount >= 1)[0];
const fundPriv = PrivateKey.fromWIF(rcli('dumpprivkey', u.address));
const fundSats = Math.round(u.amount * 1e8);
const FEE_TX = 5_000_000;
const changeAddr = rcli('getnewaddress');
const change = fundSats - addRxd - FEE_TX; // trader pays addRxd into pool + tx fee

// --- assemble trade tx ---
const tx = new Transaction();
tx.from({ txId: gtxid, outputIndex: 0, script: g.controllerLock, satoshis: R });          // in0 controller
tx.from({ txId: gtxid, outputIndex: 2, script: g.reserveLock, satoshis: 50000 });  // in1 DECOY (genesis:2 user tokens)
tx.from({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: fundSats });// in2 funding
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(controllerLock), satoshis: Rp }));        // out0
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(tokenCode), satoshis: Tp }));            // out1
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(traderTokenLock), satoshis: tokensOut }));// out2
tx.to(changeAddr, change);                                                                                // out3

// in0/in1: permissionless covenant — scriptSig = just the function selector
tx.inputs[0].setScript(Script.fromBuffer(Buffer.from([0x00])));  // OP_0  -> trade (index 0)
tx.inputs[1].setScript(Script.fromBuffer(Buffer.from([0x51])));  // OP_1  -> release (index 1)
// in2: standard P2PKH signature
const sig = Sighash.sign(tx, fundPriv, SIGHASH, 2, Script.fromHex(u.scriptPubKey), new BN(fundSats), FLAGS);
const ss = new Script();
ss.add(Buffer.concat([sig.toDER(), Buffer.from([SIGHASH])]));
ss.add(Buffer.from(fundPriv.toPublicKey().toBuffer()));
tx.inputs[2].setScript(ss);

process.stdout.write('TRADE_HEX:' + tx.serialize(true) + '\n');
