#!/usr/bin/env node
/*
 * Genesis: mint $poolRef (singleton) + $tokenRef and deploy the v3 pool on regtest.
 *
 * Ref induction rule (Radiant-Core validation.h validateTransactionReferenceOperations):
 * an output ref is valid iff it equals a spent input's outpoint (txid_internal_LE + vout_LE)
 * or is carried from an input. So we mint:
 *   $poolRef  = outpoint of input[0]  (singleton, on the controller output)
 *   $tokenRef = outpoint of input[1]  (normal ref, on the token-reserve + user-token outputs)
 *
 * Genesis tx layout:
 *   in[0], in[1]      = funding P2PKH coins (their outpoints become the refs)
 *   out[0]            = controller (bare code; carries $poolRef); value = RXD reserve R
 *   out[1]            = token reserve (marker state; carries $tokenRef); value = T_pool
 *   out[2]            = user tokens (userPkh state; carries $tokenRef); value = T_user
 *   out[3]            = RXD change (P2PKH)
 *
 * STATEFUL-DISPATCH FIX (unifies BUY + SELL; see ../../contracts/v3/BUILD_NOTES.md
 * "Stateful-dispatch resolution"). Every token UTXO is deployed STATEFUL
 * ( <push state> OP_STATESEPARATOR <code> ) and the token CODE carries an `OP_DROP` PROLOGUE.
 * When a bare/stateful Radiant script is spent, VerifyScript runs the whole scriptPubKey, so
 * the state push lands on TOP of the stack before the code runs. OP_DROP consumes it, leaving
 * the stack identical to cashscript's P2SH execution stack ([args..., selector]) so the
 * compiled `OP_DUP OP_0 OP_NUMEQUAL OP_IF` selector dispatch works for STATEFUL HOLDER spends
 * (transfer()) — which a SELL requires. transfer()'s pkh auth reads the holder pkh from
 * tx.inputs[i].stateScript via context (OP_STATESCRIPTBYTECODE_UTXO), NOT the stack, so
 * dropping the on-stack copy is safe. The reserve uses a 20-zero-byte marker state. All token
 * UTXOs share ONE (OP_DROP-prefixed) code, so codeScriptValueSum conservation still groups them.
 * The controller (out0) is unchanged/BARE (it dispatches cleanly with the selector on top).
 *
 * Override the datadir with RMM_RT=/path (defaults to /tmp/rmm-regtest).
 */
const path = require('path');
const cp = require('child_process');
const RS = '/Users/macbookair/CascadeProjects/RadiantScript/packages/cashscript/dist/main/index.js';
const rs = require(RS);
const r = require('/Users/macbookair/CascadeProjects/RadiantMM/node_modules/@radiant-core/radiantjs');
const { Transaction, Script, PrivateKey, Networks } = r;
const fs = require('fs');

const RT = process.env.RMM_RT || '/tmp/rmm-regtest';
const ART = '/Users/macbookair/CascadeProjects/RadiantMM/contracts/v3/artifacts';
function rcli(...args) {
  const out = cp.execFileSync('/Users/macbookair/CascadeProjects/Radiant-Core/build/src/radiant-cli',
    [`-datadir=${RT}`, '-rpcwallet=rmm', ...args], { encoding: 'utf8' });
  return out.trim();
}
const toHex = (b) => Buffer.from(b).toString('hex');
// ref = internal-order txid (reverse of display hex) + vout LE(4)
function outpointRef(txidDisplay, vout) {
  const txidLE = Buffer.from(txidDisplay, 'hex').reverse();
  const v = Buffer.alloc(4); v.writeUInt32LE(vout, 0);
  return Buffer.concat([txidLE, v]); // 36 bytes
}

// --- pick two funding coins ---
const unspent = JSON.parse(rcli('listunspent', '1', '9999999')).filter(u => u.amount >= 1);
const cA = unspent[0], cB = unspent[1];
const refPool = outpointRef(cA.txid, cA.vout);
const refToken = outpointRef(cB.txid, cB.vout);
console.log('poolRef =', toHex(refPool));
console.log('tokenRef=', toHex(refToken));

// owner key (reuse cA's key as owner for the demo)
const wifA = rcli('dumpprivkey', cA.address);
const wifB = rcli('dumpprivkey', cB.address);
const ownerPriv = PrivateKey.fromWIF(wifA);
const ownerPkh = r.crypto.Hash.sha256ripemd160(ownerPriv.toPublicKey().toBuffer());
// a "user" key for the user-token output (reuse B)
const userPriv = PrivateKey.fromWIF(wifB);
const userPkh = r.crypto.Hash.sha256ripemd160(userPriv.toPublicKey().toBuffer());

// --- build BARE code from the compiled ASM via radiantjs (correct ref-opcode inlining) ---
// cashscript's own asmToScript serializes OP_PUSHINPUTREF operands WRONG (data-push instead
// of the raw 36-byte operand consensus expects). radiantjs Script.fromASM inlines them
// correctly (d8<ref36>), matching Photonic's ftScript. We substitute the constant
// placeholders ($poolRef/$tokenRef/$ownerPkh) into the ASM, then serialize with radiantjs.
const tokenArt = JSON.parse(fs.readFileSync(`${ART}/RadiantMMToken.json`));
const poolArt = JSON.parse(fs.readFileSync(`${ART}/RadiantMMPool.json`));
function buildCode(asm, subs) {
  let a = asm;
  for (const [k, v] of Object.entries(subs)) a = a.split(k).join(v);
  if (a.includes('$')) throw new Error('unsubstituted placeholder in ASM: ' + a.match(/\$\w+/));
  return Buffer.from(Script.fromASM(a).toBuffer());
}
const subs = { '$poolRef': toHex(refPool), '$tokenRef': toHex(refToken), '$ownerPkh': toHex(ownerPkh) };
// OP_DROP PROLOGUE on the token code (see header) — consumes the leading state push so the
// stateful holder/reserve spends dispatch like cashscript's P2SH stack.
const tokenCode = buildCode('OP_DROP ' + tokenArt.asm, subs);
const poolCode = buildCode(poolArt.asm, subs);   // controller unchanged (bare, clean dispatch)
console.log('controller code bytes:', poolCode.length, ' token code bytes (w/ OP_DROP):', tokenCode.length);

// --- build locking scripts ---
const MARKER = Buffer.alloc(20, 0);                                               // reserve marker = 20 zero bytes
const reserveLock = Buffer.from(rs.buildStatefulOutput(MARKER, tokenCode));        // out1 (STATEFUL marker)
const userLock = Buffer.from(rs.buildStatefulOutput(userPkh, tokenCode));          // out2 (stateful holder)
const controllerLock = poolCode;                                                  // out0 (bare, no state)

// reserve values
const R = 1_000_000;    // RXD reserve (sats)
const T_pool = 100_000; // token reserve (sats == tokens)
const T_user = 50_000;  // user tokens

// --- assemble genesis tx ---
const tx = new Transaction();
for (const c of [cA, cB]) {
  tx.from({ txId: c.txid, outputIndex: c.vout, script: c.scriptPubKey, satoshis: Math.round(c.amount * 1e8) });
}
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(controllerLock), satoshis: R }));
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(reserveLock), satoshis: T_pool }));
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(userLock), satoshis: T_user }));
const totalIn = Math.round((cA.amount + cB.amount) * 1e8);
const FEE = 5_000_000; // ~10k photons/byte, generous
const changeAddr = rcli('getnewaddress');
tx.to(changeAddr, totalIn - R - T_pool - T_user - FEE);
tx.sign([ownerPriv, userPriv]);

// --- DEBUG: scan refs in each output script + input outpoint refs ---
function scanRefs(buf) {
  const found = { push: [], require: [], singleton: [], disallowSib: [] };
  let i = 0;
  while (i < buf.length) {
    const op = buf[i];
    if (op === 0xd0 || op === 0xd1 || op === 0xd2 || op === 0xd3 || op === 0xd8) {
      const ref = buf.slice(i + 1, i + 37).toString('hex');
      if (op === 0xd0) found.push.push(ref);
      else if (op === 0xd1) found.require.push(ref);
      else if (op === 0xd8) { found.singleton.push(ref); found.push.push(ref); found.disallowSib.push(ref); }
      i += 37; continue;
    }
    // skip pushdata
    if (op >= 1 && op <= 75) { i += 1 + op; continue; }
    if (op === 0x4c) { i += 2 + buf[i + 1]; continue; }
    if (op === 0x4d) { i += 3 + buf.readUInt16LE(i + 1); continue; }
    i += 1;
  }
  return found;
}
const inRefs = [cA, cB].map(c => outpointRef(c.txid, c.vout).toString('hex'));
console.log('INPUT outpoint-refs:', inRefs);
console.log('out0 controller refs:', scanRefs(controllerLock));
console.log('out1 reserve refs:', scanRefs(reserveLock));
console.log('out2 user refs:', scanRefs(userLock));

const hex = tx.serialize(true);
fs.writeFileSync(`${RT}/genesis.json`, JSON.stringify({
  poolRef: toHex(refPool), tokenRef: toHex(refToken),
  ownerPkh: toHex(ownerPkh), userPkh: toHex(userPkh),
  ownerWif: wifA, userWif: wifB,
  controllerLock: toHex(controllerLock),
  tokenCode: toHex(tokenCode),       // OP_DROP-prefixed token code (shared by reserve + holders)
  marker: toHex(MARKER),             // reserve marker state (20 zero bytes)
  reserveLock: toHex(reserveLock),   // stateful marker reserve (out1)
  userLock: toHex(userLock),         // stateful holder (out2)
  R, T_pool, T_user,
}, null, 2));
process.stdout.write('GENESIS_HEX:' + hex + '\n');
