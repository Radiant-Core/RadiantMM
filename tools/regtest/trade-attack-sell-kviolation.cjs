#!/usr/bin/env node
/*
 * ADVERSARIAL SELL (must be REJECTED): the trader supplies `tokensIn` tokens but takes MORE
 * RXD than the constant-product invariant allows (Rp pushed below the K floor), draining the
 * pool. The controller's `require(kOut >= kIn)` rejects it ("false/empty top stack element").
 *
 * Identical construction to trade-sell.cjs but with a K-violating Rp (default: the largest
 * RXD-out that still breaks K by the smallest margin — i.e. the tightest "K-1" attack).
 *
 * Args: node trade-attack-sell-kviolation.cjs [tokensIn] [Rp]
 * Override datadir with RMM_RT=/path (defaults to /tmp/rmm-regtest).
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
const toHex = (b) => Buffer.from(b).toString('hex');

const g = JSON.parse(fs.readFileSync(`${RT}/genesis.json`));
const controllerLock = Buffer.from(g.controllerLock, 'hex');
const tokenCode = Buffer.from(g.tokenCode, 'hex');
const marker = Buffer.from(g.marker, 'hex');

const buyTxid = fs.readFileSync(`${RT}/buy_txid.txt`, 'utf8').trim();
const buyMeta = JSON.parse(fs.readFileSync(`${RT}/buy_meta.json`, 'utf8'));
const R = buyMeta.Rp, T = buyMeta.Tp;
const out1 = JSON.parse(rcli('gettxout', buyTxid, '1'));
const reserveLockHex = out1.scriptPubKey.hex;
const out2 = JSON.parse(rcli('gettxout', buyTxid, '2'));
const traderLockHex = out2.scriptPubKey.hex;
const traderTokAmt = Math.round(out2.value * 1e8);
const traderAddr = r.Address.fromPublicKeyHash(Buffer.from(buyMeta.traderPkh, 'hex'), r.Networks.get('regtest') || r.Networks.testnet).toString();
const traderPriv = PrivateKey.fromWIF(rcli('dumpprivkey', traderAddr));
const traderPub = traderPriv.toPublicKey().toBuffer();
const traderPkh = Buffer.from(buyMeta.traderPkh, 'hex');

const tokensIn = parseInt(process.argv[2] || String(buyMeta.tokensOut), 10);
const T_p = T + tokensIn;
function feeOf(Rp) { return Math.ceil(Math.abs(Rp - R) * 3 / 1000); }
function kHolds(Rp) { return (Rp - feeOf(Rp)) * T_p >= R * T; }
let Rp;
if (process.argv[3]) {
  Rp = parseInt(process.argv[3], 10);     // explicit K-violating Rp
} else {
  // largest Rp that still BREAKS K (tightest attack): find the legit floor, then go 1 below.
  let floor = R; while (floor > 546 && kHolds(floor - 1)) floor -= 1;  // floor = smallest legit Rp
  Rp = floor - 1;                                                       // one short -> K violated
}
const fee = feeOf(Rp);
const effRxdOut = Rp - fee;
const rxdToTrader = R - Rp;
console.log(`ADVERSARIAL sell: R ${R}->${Rp}, T ${T}->${T_p}, tokensIn ${tokensIn}, rxdToTrader ${rxdToTrader}, fee ${fee}`);
console.log(`K_in=${R * T}  effRxdOut*Tp=${effRxdOut * T_p}  K ok=${effRxdOut * T_p >= R * T} (expect false)`);

const tokenChange = traderTokAmt - tokensIn;
const reserveOutLock = Buffer.from(rs.buildStatefulOutput(marker, tokenCode));
const traderTokenChangeLock = Buffer.from(rs.buildStatefulOutput(traderPkh, tokenCode));
const u = JSON.parse(rcli('listunspent', '1', '9999999')).filter(x => x.amount >= 1)[0];
const fundPriv = PrivateKey.fromWIF(rcli('dumpprivkey', u.address));
const fundSats = Math.round(u.amount * 1e8);
const FEE_TX = 5_000_000;
const changeAddr = rcli('getnewaddress');
const rxdOutAddr = rcli('getnewaddress');
const totalIn = R + T + traderTokAmt + fundSats;
const change = totalIn - Rp - T_p - rxdToTrader - tokenChange - FEE_TX;

const tx = new Transaction();
tx.from({ txId: buyTxid, outputIndex: 0, script: g.controllerLock, satoshis: R });
tx.from({ txId: buyTxid, outputIndex: 1, script: reserveLockHex, satoshis: T });
tx.from({ txId: buyTxid, outputIndex: 2, script: traderLockHex, satoshis: traderTokAmt });
tx.from({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: fundSats });
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(controllerLock), satoshis: Rp }));
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(reserveOutLock), satoshis: T_p }));
tx.to(rxdOutAddr, rxdToTrader);
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(traderTokenChangeLock), satoshis: tokenChange }));
tx.to(changeAddr, change);

tx.inputs[0].setScript(Script.fromBuffer(Buffer.from([0x00])));
tx.inputs[1].setScript(Script.fromBuffer(Buffer.from([0x51])));
const sig2 = Sighash.sign(tx, traderPriv, SIGHASH, 2, Script.fromHex(traderLockHex), new BN(traderTokAmt), FLAGS);
const ss2 = new Script();
ss2.add(Buffer.from(traderPub));
ss2.add(Buffer.concat([sig2.toDER(), Buffer.from([SIGHASH])]));
ss2.add(Opcode.OP_0);
tx.inputs[2].setScript(ss2);
const sig3 = Sighash.sign(tx, fundPriv, SIGHASH, 3, Script.fromHex(u.scriptPubKey), new BN(fundSats), FLAGS);
const ss3 = new Script();
ss3.add(Buffer.concat([sig3.toDER(), Buffer.from([SIGHASH])]));
ss3.add(Buffer.from(fundPriv.toPublicKey().toBuffer()));
tx.inputs[3].setScript(ss3);

process.stdout.write('TRADE_HEX:' + tx.serialize(true) + '\n');
