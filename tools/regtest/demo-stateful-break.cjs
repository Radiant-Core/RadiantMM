#!/usr/bin/env node
/*
 * EMPIRICAL DEMONSTRATION of the stateful-dispatch break + the OP_DROP fix.
 *
 * Mints ONE stateful holder token UTXO ( <push pkh> OP_STATESEPARATOR <code> ) and then tries
 * to spend it via transfer() with the canonical scriptSig [senderPk, s, OP_0].
 *
 *   mode=naive : <code> is the raw cashscript dispatch (OP_DUP OP_0 OP_NUMEQUAL ...).
 *                The state push (pkh) lands on top of the stack; OP_DUP OP_0 OP_NUMEQUAL then
 *                runs on the 20-byte pkh, which is out of script-number range => REJECT.
 *   mode=drop  : <code> = OP_DROP <dispatch>. OP_DROP consumes the leading state push, so the
 *                selector is on top and dispatch + checkSig run => ACCEPT.
 *
 * Usage: RMM_RT=/tmp/rmm-regtest-sell node demo-stateful-break.cjs naive|drop
 */
const cp = require('child_process'), fs = require('fs');
const rs = require('/Users/macbookair/CascadeProjects/RadiantScript/packages/cashscript/dist/main/index.js');
const r = require('/Users/macbookair/CascadeProjects/RadiantMM/node_modules/@radiant-core/radiantjs');
const { Transaction, Script, PrivateKey, crypto, Opcode } = r;
const BN = crypto.BN, Sighash = Transaction.Sighash;
const SIGHASH = crypto.Signature.SIGHASH_ALL | crypto.Signature.SIGHASH_FORKID;
const FLAGS = Script.Interpreter.SCRIPT_ENABLE_SIGHASH_FORKID | Script.Interpreter.SCRIPT_VERIFY_STRICTENC;
const RT = process.env.RMM_RT || '/tmp/rmm-regtest';
const ART = '/Users/macbookair/CascadeProjects/RadiantMM/.claude/worktrees/agent-affdaa2c21f6a9686/contracts/v3/artifacts';
const rcli = (...a) => cp.execFileSync('/Users/macbookair/CascadeProjects/Radiant-Core/build/src/radiant-cli', [`-datadir=${RT}`, '-rpcwallet=rmm', ...a], { encoding: 'utf8' }).trim();
const toHex = (b) => Buffer.from(b).toString('hex');
const mode = process.argv[2] || 'naive';

function outpointRef(txidDisplay, vout) {
  const txidLE = Buffer.from(txidDisplay, 'hex').reverse();
  const v = Buffer.alloc(4); v.writeUInt32LE(vout, 0);
  return Buffer.concat([txidLE, v]);
}
function buildCode(asm, subs) {
  let a = asm;
  for (const [k, v] of Object.entries(subs)) a = a.split(k).join(v);
  return Buffer.from(Script.fromASM(a).toBuffer());
}

// --- MINT one stateful holder (cover BOTH refs from two spent outpoints, like genesis) ---
const tokenArt = JSON.parse(fs.readFileSync(`${ART}/RadiantMMToken.json`));
const coins = JSON.parse(rcli('listunspent', '1', '9999999')).filter(x => x.amount >= 1);
const u = coins[0], uPool = coins[1];
const tokenRef = outpointRef(u.txid, u.vout);
const poolRef = outpointRef(uPool.txid, uPool.vout); // mint poolRef too so creation is valid
const subs = { '$tokenRef': toHex(tokenRef), '$poolRef': toHex(poolRef) };
const prefix = mode === 'drop' ? 'OP_DROP ' : '';
const code = buildCode(prefix + tokenArt.asm, subs);

const holderPriv = PrivateKey.fromWIF(rcli('dumpprivkey', u.address));
const holderPub = holderPriv.toPublicKey().toBuffer();
const holderPkh = r.crypto.Hash.sha256ripemd160(holderPub);
const holderLock = Buffer.from(rs.buildStatefulOutput(holderPkh, code));
const poolPriv = PrivateKey.fromWIF(rcli('dumpprivkey', uPool.address));

const TOK = 10_000;
const fundSats = Math.round(u.amount * 1e8);
const poolSats = Math.round(uPool.amount * 1e8);
const mintTx = new Transaction();
mintTx.from({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: fundSats });
mintTx.from({ txId: uPool.txid, outputIndex: uPool.vout, script: uPool.scriptPubKey, satoshis: poolSats });
mintTx.addOutput(new Transaction.Output({ script: Script.fromBuffer(holderLock), satoshis: TOK }));
// also carry poolRef on a throwaway output so the singleton/ref is minted (kept simple: a bare
// OP_PUSHINPUTREF poolRef OP_DROP output) — only needed so creation-time induction is satisfied.
const poolRefOut = Buffer.from(Script.fromASM(`OP_PUSHINPUTREF ${toHex(poolRef)} OP_DROP OP_1`).toBuffer());
mintTx.addOutput(new Transaction.Output({ script: Script.fromBuffer(poolRefOut), satoshis: 546 }));
mintTx.to(rcli('getnewaddress'), fundSats + poolSats - TOK - 546 - 5_000_000);
mintTx.sign([holderPriv, poolPriv]);
const mintHex = mintTx.serialize(true);
const mintTxid = rcli('sendrawtransaction', mintHex);
rcli('generatetoaddress', '1', rcli('getnewaddress'));
console.log(`[${mode}] minted stateful holder ${mintTxid}:0  (code ${code.length}B, prefix='${prefix.trim() || 'none'}')`);

// --- SPEND it via transfer() to a new holder (same code/ref) ---
const dest = Buffer.from(r.Address.fromString(rcli('getnewaddress')).hashBuffer);
const destLock = Buffer.from(rs.buildStatefulOutput(dest, code));
const fund2 = JSON.parse(rcli('listunspent', '1', '9999999')).filter(x => x.amount >= 1)[0];
const fund2Priv = PrivateKey.fromWIF(rcli('dumpprivkey', fund2.address));
const fund2Sats = Math.round(fund2.amount * 1e8);

// in2 spends the mint's poolRef-carrying output (out1) so $poolRef is present in an INPUT.
// This satisfies the static ref-operations check (the token code statically references
// $poolRef via OP_REQUIREINPUTREF), ISOLATING dispatch as the only variable between modes.
const tx = new Transaction();
tx.from({ txId: mintTxid, outputIndex: 0, script: toHex(holderLock), satoshis: TOK });   // in0 the holder
tx.from({ txId: fund2.txid, outputIndex: fund2.vout, script: fund2.scriptPubKey, satoshis: fund2Sats }); // in1 fee
tx.from({ txId: mintTxid, outputIndex: 1, script: toHex(poolRefOut), satoshis: 546 });   // in2 poolRef carrier
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(destLock), satoshis: TOK })); // conserve tokens
tx.to(rcli('getnewaddress'), fund2Sats + 546 - 5_000_000);

// in0 transfer(): [senderPk, s, OP_0]
const sig0 = Sighash.sign(tx, holderPriv, SIGHASH, 0, Script.fromBuffer(holderLock), new BN(TOK), FLAGS);
const ss0 = new Script();
ss0.add(Buffer.from(holderPub));
ss0.add(Buffer.concat([sig0.toDER(), Buffer.from([SIGHASH])]));
ss0.add(Opcode.OP_0);
tx.inputs[0].setScript(ss0);
// in1 funding
const sig1 = Sighash.sign(tx, fund2Priv, SIGHASH, 1, Script.fromHex(fund2.scriptPubKey), new BN(fund2Sats), FLAGS);
const ss1 = new Script();
ss1.add(Buffer.concat([sig1.toDER(), Buffer.from([SIGHASH])]));
ss1.add(Buffer.from(fund2Priv.toPublicKey().toBuffer()));
tx.inputs[1].setScript(ss1);
// in2 poolRef carrier: locking script self-satisfies (OP_PUSHINPUTREF poolRef OP_DROP OP_1), empty scriptSig
tx.inputs[2].setScript(new Script());

const res = (() => { try { return 'ACCEPTED ' + rcli('sendrawtransaction', tx.serialize(true)); }
  catch (e) { return 'REJECTED ' + String(e.stderr || e.message).split('\n').filter(Boolean).slice(-1)[0]; } })();
console.log(`[${mode}] transfer() spend: ${res}`);
