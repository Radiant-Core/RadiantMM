#!/usr/bin/env node
/*
 * SELL-side adversarial matrix. Each variant (except `valid`) must be REJECTED by the node.
 * Run against a post-BUY pool (controller'=in0, reserve'=in1, trader holder=in2). All reject
 * variants leave the pool untouched; run `valid` last to confirm the pool still trades.
 *
 * Variants (sell-specific attack surface the BUY side never exercised):
 *   valid          : honest sell (ACCEPT)
 *   theft-sig      : move the holder's tokens with the ATTACKER's key (transfer pkh-bind) -> REJECT
 *   holder-release : spend the holder via release() (OP_1) to skip the signature           -> REJECT
 *   reserve-xfer   : spend the reserve via transfer() (OP_0) to bypass the controller       -> REJECT
 *   no-token-add   : take RXD but DON'T grow the reserve (keep tokens as change)            -> REJECT (K)
 *   code-reserve   : recreate the reserve with the WRONG (non-token) code                   -> REJECT (continuity)
 *   strip-pool     : recreate controller without $poolRef                                   -> REJECT
 *
 * Usage: RMM_RT=/tmp/rmm-regtest-sell node trade-sell-adversarial.cjs <variant>
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
const V = process.argv[2] || 'valid';

const g = JSON.parse(fs.readFileSync(`${RT}/genesis.json`));
const controllerLock = Buffer.from(g.controllerLock, 'hex');
const tokenCode = Buffer.from(g.tokenCode, 'hex');
const marker = Buffer.from(g.marker, 'hex');

const buyTxid = fs.readFileSync(`${RT}/buy_txid.txt`, 'utf8').trim();
const buyMeta = JSON.parse(fs.readFileSync(`${RT}/buy_meta.json`, 'utf8'));
const R = buyMeta.Rp, T = buyMeta.Tp;
const out1 = JSON.parse(rcli('gettxout', buyTxid, '1')); const reserveLockHex = out1.scriptPubKey.hex;
const out2 = JSON.parse(rcli('gettxout', buyTxid, '2')); const traderLockHex = out2.scriptPubKey.hex;
const traderTokAmt = Math.round(out2.value * 1e8);
const traderAddr = r.Address.fromPublicKeyHash(Buffer.from(buyMeta.traderPkh, 'hex'), r.Networks.get('regtest') || r.Networks.testnet).toString();
const traderPriv = PrivateKey.fromWIF(rcli('dumpprivkey', traderAddr));
const traderPub = traderPriv.toPublicKey().toBuffer();
const traderPkh = Buffer.from(buyMeta.traderPkh, 'hex');

// honest sell economics (minimal valid Rp -> tightest K)
const tokensIn = buyMeta.tokensOut;          // sell back what the buy gave (9066)
const T_p = T + tokensIn;
const feeOf = (Rp) => Math.ceil(Math.abs(Rp - R) * 3 / 1000);
const kHolds = (Rp) => (Rp - feeOf(Rp)) * T_p >= R * T;
let Rp = R; while (Rp > 546 && kHolds(Rp - 1)) Rp -= 1;
const rxdToTrader = R - Rp;
const tokenChange = traderTokAmt - tokensIn;

const reserveOutLock = Buffer.from(rs.buildStatefulOutput(marker, tokenCode));
const traderChangeLock = Buffer.from(rs.buildStatefulOutput(traderPkh, tokenCode));

// funding
const u = JSON.parse(rcli('listunspent', '1', '9999999')).filter(x => x.amount >= 1)[0];
const fundPriv = PrivateKey.fromWIF(rcli('dumpprivkey', u.address));
const fundSats = Math.round(u.amount * 1e8);
const FEE_TX = 5_000_000;
const rxdOutAddr = rcli('getnewaddress');
const changeAddr = rcli('getnewaddress');

function signP2PKH(tx, i, priv, spkHex, sats) {
  const sig = Sighash.sign(tx, priv, SIGHASH, i, Script.fromHex(spkHex), new BN(sats), FLAGS);
  const ss = new Script(); ss.add(Buffer.concat([sig.toDER(), Buffer.from([SIGHASH])])); ss.add(Buffer.from(priv.toPublicKey().toBuffer()));
  tx.inputs[i].setScript(ss);
}
function transferSig(tx, i, priv, pub, lockHex, sats) {           // transfer(): push(senderPk) push(s) OP_0
  const sig = Sighash.sign(tx, priv, SIGHASH, i, Script.fromHex(lockHex), new BN(sats), FLAGS);
  const ss = new Script(); ss.add(Buffer.from(pub)); ss.add(Buffer.concat([sig.toDER(), Buffer.from([SIGHASH])])); ss.add(Opcode.OP_0);
  tx.inputs[i].setScript(ss);
}

let tx = new Transaction();
let note = '';

// ---- structurally-distinct attacks ----
if (V === 'reserve-xfer') {
  // Spend the RESERVE via transfer() (OP_0) with the attacker's key, bypassing the controller.
  // transfer() requires hash160(senderPk)==<marker(20 zeros)>, unsatisfiable.
  note = 'spend reserve via transfer() to bypass controller pricing';
  const atk = PrivateKey.fromWIF(rcli('dumpprivkey', rcli('getnewaddress')));
  tx.from({ txId: buyTxid, outputIndex: 1, script: reserveLockHex, satoshis: T });        // in0 reserve as transfer target
  tx.from({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: fundSats });
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(traderChangeLock), satoshis: T })); // move reserve tokens to attacker-controlled holder
  tx.to(changeAddr, fundSats - FEE_TX);
  transferSig(tx, 0, atk, atk.toPublicKey().toBuffer(), reserveLockHex, T);
  signP2PKH(tx, 1, fundPriv, u.scriptPubKey, fundSats);
} else if (V === 'holder-release') {
  // Spend the trader HOLDER via release() (OP_1, no sig) by co-spending the controller, to skip
  // the holder's signature. The controller's outpoint pairing requires in1 to be the reserve
  // (co-created vout 1); the holder is vout 2 -> pairing rejects.
  note = 'drag holder onto release() (skip signature) — controller pairing must reject';
  Rp; // controller still recreated
  tx.from({ txId: buyTxid, outputIndex: 0, script: g.controllerLock, satoshis: R });       // in0 controller (trade)
  tx.from({ txId: buyTxid, outputIndex: 2, script: traderLockHex, satoshis: traderTokAmt });// in1 HOLDER via release (decoy reserve)
  tx.from({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: fundSats });
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(controllerLock), satoshis: Rp }));            // out0 controller'
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(reserveOutLock), satoshis: traderTokAmt }));  // out1 (token code)
  tx.to(rxdOutAddr, R - Rp);
  tx.to(changeAddr, fundSats - FEE_TX);
  tx.inputs[0].setScript(Script.fromBuffer(Buffer.from([0x00])));   // controller trade
  tx.inputs[1].setScript(Script.fromBuffer(Buffer.from([0x51])));   // holder via release (no sig!)
  signP2PKH(tx, 2, fundPriv, u.scriptPubKey, fundSats);
} else {
  // ---- value/selector mutations on the honest 4-in / 5-out sell ----
  tx.from({ txId: buyTxid, outputIndex: 0, script: g.controllerLock, satoshis: R });        // in0 controller
  tx.from({ txId: buyTxid, outputIndex: 1, script: reserveLockHex, satoshis: T });          // in1 reserve
  tx.from({ txId: buyTxid, outputIndex: 2, script: traderLockHex, satoshis: traderTokAmt }); // in2 holder
  tx.from({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: fundSats }); // in3 funding

  let outCtrlVal = Rp, outResVal = T_p, outRxd = rxdToTrader, outChange = tokenChange;
  let ctrlOutLock = controllerLock, resOutLock = reserveOutLock;

  if (V === 'no-token-add') { note = 'take RXD but reserve does NOT grow'; outResVal = T; outChange = traderTokAmt; }
  else if (V === 'code-reserve') { note = 'recreate reserve with wrong (non-token) code'; resOutLock = Buffer.from(rs.buildStatefulOutput(marker, Buffer.from([0x51]))); }
  else if (V === 'strip-pool') { note = 'recreate controller without $poolRef'; ctrlOutLock = Buffer.from(Script.fromASM('OP_1').toBuffer()); }
  else if (V !== 'valid' && V !== 'theft-sig') { throw new Error('unknown variant ' + V); }

  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(ctrlOutLock), satoshis: outCtrlVal })); // out0
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(resOutLock), satoshis: outResVal }));   // out1
  tx.to(rxdOutAddr, outRxd);                                                                              // out2
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(traderChangeLock), satoshis: outChange })); // out3
  const totalIn = R + T + traderTokAmt + fundSats;
  tx.to(changeAddr, totalIn - outCtrlVal - outResVal - outRxd - outChange - FEE_TX);                      // out4

  tx.inputs[0].setScript(Script.fromBuffer(Buffer.from([0x00])));  // trade
  tx.inputs[1].setScript(Script.fromBuffer(Buffer.from([0x51])));  // release
  if (V === 'theft-sig') {                       // attacker signs in2 with their OWN key
    note = "move holder's tokens with the attacker's key (pkh-bind must reject)";
    const atk = PrivateKey.fromWIF(rcli('dumpprivkey', rcli('getnewaddress')));
    transferSig(tx, 2, atk, atk.toPublicKey().toBuffer(), traderLockHex, traderTokAmt);
  } else {
    transferSig(tx, 2, traderPriv, traderPub, traderLockHex, traderTokAmt);
  }
  signP2PKH(tx, 3, fundPriv, u.scriptPubKey, fundSats);
}

console.log(`[${V}] ${note || 'honest sell'}`);
process.stdout.write('TRADE_HEX:' + tx.serialize(true) + '\n');
