#!/usr/bin/env node
/*
 * Buy-side adversarial matrix. Builds a base valid buy, then mutates it per the
 * `variant` argv, prints the tx hex. The caller submits and checks the result.
 * All variants except `valid` and `fee-min` MUST be rejected by the contract.
 *
 *   valid       : the correct buy (Tp=90934)            -> ACCEPT
 *   fee-min     : Tp exactly at the K+fee minimum       -> ACCEPT (boundary)
 *   fee-underpay: Tp one below the minimum (ignores fee)-> REJECT (K)
 *   k-violation : take far too many tokens              -> REJECT (K)
 *   code-ctrl   : recreate controller with wrong code   -> REJECT (C2 continuity)
 *   code-reserve: recreate reserve with wrong code      -> REJECT (C2 continuity)
 *   strip-pool  : recreate controller w/o $poolRef      -> REJECT (continuity/refcount)
 *   layout      : put controller at out2, junk at out0  -> REJECT (continuity@0)
 *   dust-rxd    : RXD reserve out0 below 546            -> REJECT (dust guard)
 *   zero-token  : token reserve out1 = 0                -> REJECT (tokOut>0)
 *   dup-pool    : two outputs carry $poolRef            -> REJECT (singleton/refcount)
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

const variant = process.argv[2] || 'valid';
const g = JSON.parse(fs.readFileSync(`${RT}/genesis.json`));
const gtxid = fs.readFileSync(`${RT}/genesis_txid.txt`, 'utf8').trim();
const controllerLock = Buffer.from(g.controllerLock, 'hex');
const tokenCode = Buffer.from(g.reserveLock, 'hex');
const R = g.R, T = g.T_pool;
const addRxd = 100_000, Rp = R + addRxd;
const fee = Math.ceil(addRxd * 3 / 1000);             // 300
const effRxdOut = Rp - fee;                           // 1,099,700
const TpMin = Math.ceil((R * T) / effRxdOut);         // 90,934 (min that satisfies K)
let Tp = TpMin;
if (variant === 'fee-underpay') Tp = TpMin - 1;       // 90,933 -> K fails by 1
if (variant === 'k-violation')  Tp = 80_000;          // gross drain
let tokensOut = T - Tp;

const traderAddr = rcli('getnewaddress');
const traderPkh = Buffer.from(r.Address.fromString(traderAddr).hashBuffer);
const traderTokenLock = Buffer.from(rs.buildStatefulOutput(traderPkh, tokenCode));
const p2pkh = (addr) => Script.fromAddress(addr).toBuffer();

const u = JSON.parse(rcli('listunspent', '1', '9999999')).filter(x => x.amount >= 1)[0];
const fundPriv = PrivateKey.fromWIF(rcli('dumpprivkey', u.address));
const fundSats = Math.round(u.amount * 1e8);
const FEE_TX = 6_000_000;
const changeAddr = rcli('getnewaddress');

// output values per variant (keep value balanced: sum(out)=sum(in)-FEE_TX)
let rxdOut0 = Rp, tokOut1 = Tp, tOut2 = tokensOut;
let lock0 = controllerLock, lock1 = tokenCode, lock2 = traderTokenLock;
const junk = p2pkh(rcli('getnewaddress'));            // a non-covenant script

if (variant === 'code-ctrl')    lock0 = junk;                         // wrong controller code
if (variant === 'code-reserve') lock1 = junk;                         // wrong reserve code
if (variant === 'strip-pool')   lock0 = p2pkh(rcli('getnewaddress')); // controller code w/o $poolRef
if (variant === 'dust-rxd')     rxdOut0 = 500;                        // below 546
if (variant === 'zero-token') { tokOut1 = 0; tOut2 = T; }             // reserve drained to 0 (conserved to trader)

const tx = new Transaction();
tx.from({ txId: gtxid, outputIndex: 0, script: g.controllerLock, satoshis: R });
tx.from({ txId: gtxid, outputIndex: 1, script: g.reserveLock, satoshis: T });
tx.from({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: fundSats });

if (variant === 'layout') {
  // controller recreated at out2 instead of out0; out0 = junk
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(junk), satoshis: rxdOut0 }));
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(tokenCode), satoshis: tokOut1 }));
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(controllerLock), satoshis: 546 }));
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(traderTokenLock), satoshis: tOut2 }));
} else if (variant === 'dup-pool') {
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(controllerLock), satoshis: rxdOut0 }));
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(tokenCode), satoshis: tokOut1 }));
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(controllerLock), satoshis: 546 })); // 2nd $poolRef carrier
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(traderTokenLock), satoshis: tOut2 }));
} else {
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(lock0), satoshis: rxdOut0 }));
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(lock1), satoshis: tokOut1 }));
  if (tOut2 > 0) tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(lock2), satoshis: tOut2 }));
}
// change soaks up the remainder so value balances regardless of the mutation
const outSoFar = tx.outputs.reduce((s, o) => s + o.satoshis, 0);
tx.to(changeAddr, R + T + fundSats - outSoFar - FEE_TX);

tx.inputs[0].setScript(Script.fromBuffer(Buffer.from([0x00]))); // trade
tx.inputs[1].setScript(Script.fromBuffer(Buffer.from([0x51]))); // release
const sig = Sighash.sign(tx, fundPriv, SIGHASH, 2, Script.fromHex(u.scriptPubKey), new BN(fundSats), FLAGS);
const ss = new Script(); ss.add(Buffer.concat([sig.toDER(), Buffer.from([SIGHASH])])); ss.add(Buffer.from(fundPriv.toPublicKey().toBuffer()));
tx.inputs[2].setScript(ss);

process.stdout.write(`VARIANT:${variant} Tp=${Tp} K_out=${effRxdOut * tokOut1} K_in=${R * T}\n`);
process.stdout.write('HEX:' + tx.serialize(true) + '\n');
