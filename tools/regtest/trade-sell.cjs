#!/usr/bin/env node
/*
 * SELL trade on regtest: the trader SUPPLIES real $tokenRef tokens (spending their own
 * STATEFUL token UTXO via transfer()), the pool's token reserve GROWS, and the trader
 * receives RXD — all while the controller enforces K = R*T (after the 0.3% ceiling fee).
 *
 * This exercises the stateful-dispatch resolution (see genesis.cjs / BUILD_NOTES.md): the
 * trader's holder UTXO is `<push pkh> OP_STATESEPARATOR <code>`. When spent, the state push
 * lands on top of the stack; the token code's OP_DROP prologue consumes it, leaving the stack
 * identical to cashscript's P2SH stack so the transfer() selector dispatch + signature auth run.
 *
 * inputs : [0]=controller (sel0 trade)  [1]=reserve (sel1 release)
 *          [2]=trader stateful tokens (sel0 transfer + sig)  [3]=trader RXD funding (P2PKH)
 * outputs: [0]=controller' (R')  [1]=reserve' (T'=T+tokensIn, stateful marker)
 *          [2]=trader RXD out  [3]=trader token change (stateful)  [4]=RXD change
 *
 * transfer() scriptSig (verified on regtest): push(senderPk) push(s) OP_0
 *   cashscript's transfer body (OP_SWAP OP_2 OP_PICK OP_CHECKSIGVERIFY, which wants pubkey on
 *   top of the sig for OP_CHECKSIG) consumes the post-OP_DROP stack [senderPk, s, selector].
 *
 * Chains off trade-buy.cjs: reads the moved pool from the buy tx (out0=controller', out1=
 * reserve') and sells the trader's tokens minted at the buy's out2.
 * Requires the runner to have written ${RT}/buy_txid.txt after broadcasting the buy.
 *
 * Args: node trade-sell.cjs [tokensIn] [Rp]
 *   tokensIn = tokens the trader supplies (reserve grows by this)
 *   Rp       = new RXD reserve (trader takes R-Rp). Defaults give a valid (K-holding) sell.
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

// --- locate the moved pool (after the buy) + the trader's sell-side token ---
const buyTxid = fs.readFileSync(`${RT}/buy_txid.txt`, 'utf8').trim();
const buyMeta = JSON.parse(fs.readFileSync(`${RT}/buy_meta.json`, 'utf8'));
const R = buyMeta.Rp, T = buyMeta.Tp;                 // controller'/reserve' values from the buy
const out1 = JSON.parse(rcli('gettxout', buyTxid, '1'));   // stateful reserve' (in1)
const reserveLockHex = out1.scriptPubKey.hex;
const out2 = JSON.parse(rcli('gettxout', buyTxid, '2'));   // trader's stateful tokens (sell-side)
const traderLockHex = out2.scriptPubKey.hex;
const traderTokAmt = Math.round(out2.value * 1e8);

// The buy's out2 holder pkh == buyMeta.traderPkh; its key was a fresh wallet address. Recover
// the WIF from the wallet via the address derived from the pkh.
const traderAddr = r.Address.fromPublicKeyHash(Buffer.from(buyMeta.traderPkh, 'hex'), r.Networks.get('regtest') || r.Networks.testnet).toString();
const traderPriv = PrivateKey.fromWIF(rcli('dumpprivkey', traderAddr));
const traderPub = traderPriv.toPublicKey().toBuffer();
const traderPkh = Buffer.from(buyMeta.traderPkh, 'hex');

// --- sell params ---
const tokensIn = parseInt(process.argv[2] || String(buyMeta.tokensOut), 10); // default: sell back exactly what the buy gave
const T_p = T + tokensIn;
// default Rp: smallest valid (K-holding) new RXD reserve. effRxdOut*T_p >= R*T, eff=Rp-fee,
// fee=ceil(|Rp-R|*3/1000). Solve numerically downward from R.
function feeOf(Rp) { return Math.ceil(Math.abs(Rp - R) * 3 / 1000); }
function kHolds(Rp) { return (Rp - feeOf(Rp)) * T_p >= R * T; }
let Rp;
if (process.argv[3]) {
  Rp = parseInt(process.argv[3], 10);
} else {
  Rp = R;                       // walk down until just before K breaks
  while (Rp > 546 && kHolds(Rp - 1)) Rp -= 1;
}
const fee = feeOf(Rp);
const effRxdOut = Rp - fee;
const rxdToTrader = R - Rp;
console.log(`sell: R ${R}->${Rp}, T ${T}->${T_p}, tokensIn ${tokensIn}, rxdToTrader ${rxdToTrader}, fee ${fee}`);
console.log(`K_in=${R * T}  effRxdOut*Tp=${effRxdOut * T_p}  K ok=${effRxdOut * T_p >= R * T}`);
if (rxdToTrader < 0) throw new Error('Rp > R: not a sell');
if (tokensIn > traderTokAmt) throw new Error('tokensIn exceeds trader balance');

const tokenChange = traderTokAmt - tokensIn;
const reserveOutLock = Buffer.from(rs.buildStatefulOutput(marker, tokenCode));            // out1 reserve'
const traderTokenChangeLock = Buffer.from(rs.buildStatefulOutput(traderPkh, tokenCode));  // out3 token change

// RXD funding for the tx fee
const u = JSON.parse(rcli('listunspent', '1', '9999999')).filter(x => x.amount >= 1)[0];
const fundPriv = PrivateKey.fromWIF(rcli('dumpprivkey', u.address));
const fundSats = Math.round(u.amount * 1e8);
const FEE_TX = 5_000_000;
const changeAddr = rcli('getnewaddress');
const rxdOutAddr = rcli('getnewaddress');
const totalIn = R + T + traderTokAmt + fundSats;
const change = totalIn - Rp - T_p - rxdToTrader - tokenChange - FEE_TX;

const tx = new Transaction();
tx.from({ txId: buyTxid, outputIndex: 0, script: g.controllerLock, satoshis: R });   // in0 controller
tx.from({ txId: buyTxid, outputIndex: 1, script: reserveLockHex, satoshis: T });     // in1 reserve
tx.from({ txId: buyTxid, outputIndex: 2, script: traderLockHex, satoshis: traderTokAmt }); // in2 trader tokens
tx.from({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: fundSats }); // in3 funding
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(controllerLock), satoshis: Rp }));      // out0
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(reserveOutLock), satoshis: T_p }));     // out1 reserve'
tx.to(rxdOutAddr, rxdToTrader);                                                                          // out2 trader RXD
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(traderTokenChangeLock), satoshis: tokenChange })); // out3 token change
tx.to(changeAddr, change);                                                                               // out4 change

tx.inputs[0].setScript(Script.fromBuffer(Buffer.from([0x00])));  // OP_0 trade   (permissionless)
tx.inputs[1].setScript(Script.fromBuffer(Buffer.from([0x51])));  // OP_1 release (permissionless)

// in2: transfer() — scriptSig push(senderPk) push(s) OP_0 (selector). The state push is
// consumed by the token code's OP_DROP prologue, restoring cashscript's P2SH-style stack.
const sig2 = Sighash.sign(tx, traderPriv, SIGHASH, 2, Script.fromHex(traderLockHex), new BN(traderTokAmt), FLAGS);
const ss2 = new Script();
ss2.add(Buffer.from(traderPub));                                  // senderPk (bottom)
ss2.add(Buffer.concat([sig2.toDER(), Buffer.from([SIGHASH])]));  // s
ss2.add(Opcode.OP_0);                                             // selector 0 (transfer), top
tx.inputs[2].setScript(ss2);

// in3: P2PKH funding signature
const sig3 = Sighash.sign(tx, fundPriv, SIGHASH, 3, Script.fromHex(u.scriptPubKey), new BN(fundSats), FLAGS);
const ss3 = new Script();
ss3.add(Buffer.concat([sig3.toDER(), Buffer.from([SIGHASH])]));
ss3.add(Buffer.from(fundPriv.toPublicKey().toBuffer()));
tx.inputs[3].setScript(ss3);

process.stdout.write('TRADE_HEX:' + tx.serialize(true) + '\n');
