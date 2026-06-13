#!/usr/bin/env node
'use strict';
/*
 * RPL-LP Phase-0 spike (BLOCKING GATE). Proves the three load-bearing primitives of the
 * LP-share design compose on Radiant-Core v3.1.x regtest:
 *   (a) a stateful controller mutates + reads its own in-state scalar shareTotal across a hop;
 *   (b) the LP-ref VALUE DELTA (refValueSum(out) - refValueSum(in)) is pinned == dS and is
 *       robust to a co-spent ref carrier (the anchor passes through; its value cancels);
 *   (c) keyless mint is gated on the controller singleton (refType($poolRef)==2), and a plain
 *       LP-holder transfer needs NO controller co-spent (no static ref-induction taint).
 * Plus the LP-specific arithmetic Market never needed: dS = dR*S0/R (seeded S0 != R so the
 * ratio is exercised, not identity).
 *
 * Self-contained: own rcli (regtest, port from $RT/.port, wallet 'lp'). Run after the node is up.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const CORE = '/Users/macbookair/CascadeProjects/Radiant-Core/build/src';
const RADIANT_CLI = `${CORE}/radiant-cli`;
const RT = process.env.RT || '/tmp/rmm-lp-spike';
const PORT = (fs.readFileSync(`${RT}/.port`, 'utf8') || '18477').trim();
const WALLET = 'lp';
const ART = path.join(__dirname, 'artifacts');

const r = require('/Users/macbookair/CascadeProjects/RadiantMM/node_modules/@radiant-core/radiantjs');
const { Transaction, Script, PrivateKey, crypto } = r;
const BN = crypto.BN;
const Sighash = Transaction.Sighash;
const SIGHASH = crypto.Signature.SIGHASH_ALL | crypto.Signature.SIGHASH_FORKID;
const FLAGS = Script.Interpreter.SCRIPT_ENABLE_SIGHASH_FORKID | Script.Interpreter.SCRIPT_VERIFY_STRICTENC;

const toHex = (b) => Buffer.from(b).toString('hex');
const fromHex = (h) => Buffer.from(h, 'hex');

function rcli(...args) {
  return cp.execFileSync(RADIANT_CLI,
    ['-regtest', `-datadir=${RT}`, `-rpcport=${PORT}`, `-rpcwallet=${WALLET}`, ...args],
    { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
}
function outpointRef(txidDisplay, vout) {
  const txidLE = fromHex(txidDisplay).reverse();
  const v = Buffer.alloc(4); v.writeUInt32LE(vout >>> 0, 0);
  return Buffer.concat([txidLE, v]);
}
function addressPkh(addr) { return Buffer.from(r.Address.fromString(addr).hashBuffer); }
function encodePush(data) {
  const n = data.length;
  if (n < 0x4c) return Buffer.concat([Buffer.from([n]), data]);
  if (n <= 0xff) return Buffer.concat([Buffer.from([0x4c, n]), data]);
  const h = Buffer.alloc(2); h.writeUInt16LE(n, 0);
  return Buffer.concat([Buffer.from([0x4d]), h, data]);
}
const OP_STATESEPARATOR = 0xbd;
function buildStatefulOutput(stateData, code) {
  return Buffer.concat([encodePush(stateData), Buffer.from([OP_STATESEPARATOR]), code]);
}
function buildCode(asm, subs) {
  let a = asm;
  for (const k of Object.keys(subs).sort((x, y) => y.length - x.length)) {
    const v = subs[k];
    a = a.split(k).join(typeof v === 'string' ? v.replace(/^0x/, '') : toHex(v));
  }
  const leftover = a.match(/\$\w+/);
  if (leftover) throw new Error(`unsubstituted ${leftover[0]}`);
  return Buffer.from(Script.fromASM(a).toBuffer());
}
function signP2PKH(tx, idx, priv, spkHex, sats) {
  const sig = Sighash.sign(tx, priv, SIGHASH, idx, Script.fromHex(spkHex), new BN(sats), FLAGS);
  const ss = new Script();
  ss.add(Buffer.concat([sig.toDER(), Buffer.from([SIGHASH])]));
  ss.add(Buffer.from(priv.toPublicKey().toBuffer()));
  tx.inputs[idx].setScript(ss);
}
function covenantSig(tx, idx, priv, spkHex, sats) {
  const sig = Sighash.sign(tx, priv, SIGHASH, idx, Script.fromHex(spkHex), new BN(sats), FLAGS);
  return Buffer.concat([sig.toDER(), Buffer.from([SIGHASH])]);
}
function buildSelectorScriptSig(pushes, selectorByte) {
  const parts = pushes.map((p) => encodePush(Buffer.from(p)));
  parts.push(Buffer.from([selectorByte]));
  return Script.fromBuffer(Buffer.concat(parts));
}
function broadcast(hex) {
  try { return { ok: true, txid: cp.execFileSync(RADIANT_CLI,
    ['-regtest', `-datadir=${RT}`, `-rpcport=${PORT}`, `-rpcwallet=${WALLET}`, 'sendrawtransaction', hex],
    { encoding: 'utf8', maxBuffer: 1 << 28 }).trim() }; }
  catch (e) { return { ok: false, error: (e.stderr || e.stdout || e.message || '').toString().trim() }; }
}
function mine(n = 1) { rcli('generatetoaddress', String(n), rcli('getnewaddress')); }
function pickCoin(minSats) {
  const u = JSON.parse(rcli('listunspent', '1', '9999999')).filter((x) => Math.round(x.amount * 1e8) >= minSats);
  if (!u.length) throw new Error(`no coin >= ${minSats}`);
  return u.sort((a, b) => b.amount - a.amount)[0];
}

// state = ver(1)=0x01 || shareTotal(8 LE)
function encShareState(shareTotal) {
  const b = Buffer.alloc(9); b[0] = 0x01;
  b.writeBigUInt64LE(BigInt(shareTotal), 1);
  return b;
}
const MARKER = Buffer.alloc(20, 0);
const DUST = 1000;
const FEE = 5_000_000;

const rplArt = JSON.parse(fs.readFileSync(`${ART}/RplLpProbe.json`, 'utf8'));
const lpArt = JSON.parse(fs.readFileSync(`${ART}/LpShareProbe.json`, 'utf8'));
// both stateful + selector-dispatched -> OP_DROP prologue
const buildControllerCode = (poolRef, lpRef) => buildCode('OP_DROP ' + rplArt.asm, { '$poolRef': poolRef, '$lpRef': lpRef });
const buildLpCode = (lpRef, poolRef) => buildCode('OP_DROP ' + lpArt.asm, { '$lpRef': lpRef, '$poolRef': poolRef });
// selectors
const ADDLIQ = 0x00;                 // RplLpProbe: addLiquidity (only fn)
const LP_TRANSFER = 0x00, LP_VAULTMOVE = 0x51;  // LpShareProbe: transfer, vaultMove

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };

// ---------------------------------------------------------------------------
// GENESIS: induce $poolRef (singleton) + $lpRef; deploy controller(R0, shareTotal=S0seed) + anchor.
// Seed S0seed != R0 so dS = dR*S0/R exercises a real ratio (value-per-share = R0/S0seed = 2).
// ---------------------------------------------------------------------------
const R0 = 1_000_000;
const S0seed = 500_000;

console.log('== GENESIS ==');
const cA = pickCoin(R0 + FEE + 10 * DUST);
const poolRef = outpointRef(cA.txid, cA.vout);
// second outpoint for $lpRef: use cA's wallet but a distinct coin
const cB = JSON.parse(rcli('listunspent', '1', '9999999'))
  .filter((x) => !(x.txid === cA.txid && x.vout === cA.vout) && Math.round(x.amount * 1e8) >= FEE)[0];
const lpRef = outpointRef(cB.txid, cB.vout);

const controllerCode = buildControllerCode(poolRef, lpRef);
const lpCode = buildLpCode(lpRef, poolRef);
const controllerLock = buildStatefulOutput(encShareState(S0seed), controllerCode);
const anchorLock = buildStatefulOutput(MARKER, lpCode);

{
  const aS = Math.round(cA.amount * 1e8), bS = Math.round(cB.amount * 1e8);
  const tx = new Transaction();
  tx.from({ txId: cA.txid, outputIndex: cA.vout, script: cA.scriptPubKey, satoshis: aS });
  tx.from({ txId: cB.txid, outputIndex: cB.vout, script: cB.scriptPubKey, satoshis: bS });
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(controllerLock), satoshis: R0 }));   // out0 controller
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(anchorLock), satoshis: DUST }));      // out1 lp-anchor
  tx.to(rcli('getnewaddress'), aS + bS - R0 - DUST - FEE);                                              // out2 change
  tx.sign([cA, cB].map((c) => PrivateKey.fromWIF(rcli('dumpprivkey', c.address))));
  const res = broadcast(tx.serialize(true));
  if (!res.ok) { bad(`genesis REJECTED: ${res.error}`); console.log(`\nFAIL=${fail}`); process.exit(1); }
  mine();
  global.G = { txid: res.txid, controller: { vout: 0, value: R0, shareTotal: S0seed },
    anchor: { vout: 1, value: DUST } };
  ok(`genesis: controller(R0=${R0}, shareTotal=${S0seed}) + lp-anchor; txid ${res.txid.slice(0, 16)}`);
  console.log(`    poolRef=${toHex(poolRef).slice(0, 24)}.. lpRef=${toHex(lpRef).slice(0, 24)}..`);
}

// ---------------------------------------------------------------------------
// addLiquidity builder. Mints dS = floor(dR*S0/R) LP shares to `mintPkh`.
// Variants let us forge fields for the adversarial cases.
//   opts: { dR, dSoverride, S1override, extraMintSats, omitController }
// in:  [0]=controller(addLiquidity) [1]=anchor(vaultMove) [2]=funding(P2PKH)
// out: [0]=controller'(R+dR, S1) [1]=anchor' [2]=minted LP holder(dS) [3]=change [+ extra mint]
// ---------------------------------------------------------------------------
function buildAddLiquidity(opts) {
  const G = global.G;
  const R = G.controller.value, S0 = G.controller.shareTotal;
  const dR = opts.dR;
  const Rp = R + dR;
  const dS = opts.dSoverride != null ? opts.dSoverride : Math.floor((dR * S0) / R);
  const S1 = opts.S1override != null ? opts.S1override : S0 + dS;

  const mintAddr = rcli('getnewaddress');
  const mintPriv = PrivateKey.fromWIF(rcli('dumpprivkey', mintAddr));
  const mintPkh = addressPkh(mintAddr);
  const mintLock = buildStatefulOutput(mintPkh, lpCode);

  const fund = pickCoin(dR + dS + (opts.extraMintSats || 0) + FEE + DUST);
  const fundPriv = PrivateKey.fromWIF(rcli('dumpprivkey', fund.address));
  const fundSats = Math.round(fund.amount * 1e8);

  const newCtrlLock = buildStatefulOutput(encShareState(S1), controllerCode);

  const tx = new Transaction();
  tx.from({ txId: G.txid, outputIndex: G.controller.vout, script: toHex(controllerLock), satoshis: R });   // in0
  if (!opts.omitController) {
    // (default path) anchor co-spent with controller
  }
  tx.from({ txId: G.txid, outputIndex: G.anchor.vout, script: toHex(anchorLock), satoshis: G.anchor.value }); // in1 anchor
  tx.from({ txId: fund.txid, outputIndex: fund.vout, script: fund.scriptPubKey, satoshis: fundSats });        // in2 funding

  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(newCtrlLock), satoshis: Rp }));             // out0 controller'
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(anchorLock), satoshis: G.anchor.value }));  // out1 anchor'
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(mintLock), satoshis: dS }));                // out2 minted holder
  let extraInfo = null;
  if (opts.extraMintSats) {
    const a2 = rcli('getnewaddress');
    const mint2Lock = buildStatefulOutput(addressPkh(a2), lpCode);
    tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(mint2Lock), satoshis: opts.extraMintSats })); // extra mint (attack)
    extraInfo = { addr: a2, sats: opts.extraMintSats };
  }
  const change = fundSats - dR - dS - (opts.extraMintSats || 0) - FEE;
  if (change < 0) throw new Error('funding too small');
  tx.to(rcli('getnewaddress'), change);                                                                        // change

  tx.inputs[0].setScript(new Script());                                   // controller addLiquidity (single-fn: no selector; OP_DROP eats state)
  tx.inputs[1].setScript(Script.fromBuffer(Buffer.from([LP_VAULTMOVE])));  // anchor vaultMove (keyless)
  signP2PKH(tx, 2, fundPriv, fund.scriptPubKey, fundSats);

  return { tx, R, S0, dR, Rp, dS, S1, mintAddr, mintPriv, mintPkh, expectedDS: Math.floor((dR * S0) / R) };
}

console.log('\n== TEST 1: honest addLiquidity (dS = dR*S0/R, ratio != 1) ==');
{
  const dR = 100_000;
  const a = buildAddLiquidity({ dR });
  console.log(`    R=${a.R} S0=${a.S0} dR=${dR} -> expected dS=${a.expectedDS} (value-per-share ${a.R / a.S0})`);
  const res = broadcast(a.tx.serialize(true));
  if (!res.ok) { bad(`honest addLiquidity REJECTED: ${res.error}`); }
  else {
    mine();
    // verify minted holder value on-chain
    const out2 = JSON.parse(rcli('gettxout', res.txid, '2'));
    const mintedSats = Math.round(out2.value * 1e8);
    if (mintedSats === a.expectedDS && a.expectedDS === 50_000) ok(`addLiquidity ACCEPTED; minted dS=${mintedSats} == dR*S0/R == 50000`);
    else bad(`minted ${mintedSats}, expected ${a.expectedDS}`);
    // advance live state
    global.G = { txid: res.txid, controller: { vout: 0, value: a.Rp, shareTotal: a.S1 }, anchor: { vout: 1, value: DUST },
      lastMint: { txid: res.txid, vout: 2, value: a.dS, addr: a.mintAddr, priv: a.mintPriv, pkh: a.mintPkh } };
    ok(`controller advanced: R ${a.R}->${a.Rp}, shareTotal ${a.S0}->${a.S1} (state mutate+read across hop, primitive a)`);
  }
}

console.log('\n== TEST 2: second addLiquidity (state accumulates across hops) ==');
{
  const dR = 220_000;
  const a = buildAddLiquidity({ dR });
  const res = broadcast(a.tx.serialize(true));
  if (!res.ok) bad(`2nd addLiquidity REJECTED: ${res.error}`);
  else {
    mine();
    const out2 = JSON.parse(rcli('gettxout', res.txid, '2'));
    const minted = Math.round(out2.value * 1e8);
    if (minted === a.expectedDS) ok(`2nd addLiquidity ACCEPTED; minted dS=${minted} at R=${a.R},S0=${a.S0}`);
    else bad(`minted ${minted}, expected ${a.expectedDS}`);
    global.G = { txid: res.txid, controller: { vout: 0, value: a.Rp, shareTotal: a.S1 }, anchor: { vout: 1, value: DUST },
      lastMint: global.G.lastMint };
  }
}

console.log('\n== TEST 3: over-mint (mint extra shares beyond dS) MUST REJECT ==');
{
  const a = buildAddLiquidity({ dR: 100_000, extraMintSats: 7_777 }); // mintedDelta = dS + 7777 != dS
  const res = broadcast(a.tx.serialize(true));
  if (res.ok) { bad(`over-mint ACCEPTED (txid ${res.txid}) — DELTA-PIN BROKEN`); mine(); }
  else ok(`over-mint REJECTED (${res.error.split('\n')[0].slice(0, 70)})`);
}

console.log('\n== TEST 4: forged shareTotal (S1 != S0 + dS) MUST REJECT ==');
{
  const a = buildAddLiquidity({ dR: 100_000, S1override: global.G.controller.shareTotal + 999_999 });
  const res = broadcast(a.tx.serialize(true));
  if (res.ok) { bad(`forged shareTotal ACCEPTED (txid ${res.txid})`); mine(); }
  else ok(`forged shareTotal REJECTED (${res.error.split('\n')[0].slice(0, 70)})`);
}

console.log('\n== TEST 5: keyless mint WITHOUT the controller co-spent MUST REJECT (primitive c gate) ==');
{
  // spend ONLY the anchor via vaultMove + funding; try to mint shares with no controller present.
  const G = global.G;
  const fund = pickCoin(60_000 + FEE + DUST);
  const fundPriv = PrivateKey.fromWIF(rcli('dumpprivkey', fund.address));
  const fundSats = Math.round(fund.amount * 1e8);
  const a2 = rcli('getnewaddress');
  const mintLock = buildStatefulOutput(addressPkh(a2), lpCode);
  const tx = new Transaction();
  tx.from({ txId: G.txid, outputIndex: G.anchor.vout, script: toHex(anchorLock), satoshis: G.anchor.value }); // in0 anchor
  tx.from({ txId: fund.txid, outputIndex: fund.vout, script: fund.scriptPubKey, satoshis: fundSats });        // in1 funding
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(anchorLock), satoshis: G.anchor.value }));  // out0 anchor'
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(mintLock), satoshis: 50_000 }));            // out1 minted (illicit)
  tx.to(rcli('getnewaddress'), fundSats - 50_000 - FEE);
  tx.inputs[0].setScript(Script.fromBuffer(Buffer.from([LP_VAULTMOVE])));   // vaultMove, no controller co-spent
  signP2PKH(tx, 1, fundPriv, fund.scriptPubKey, fundSats);
  const res = broadcast(tx.serialize(true));
  if (res.ok) { bad(`uncontrolled mint ACCEPTED (txid ${res.txid}) — MINT NOT GATED`); mine(); }
  else ok(`uncontrolled mint REJECTED (${res.error.split('\n')[0].slice(0, 70)})`);
}

console.log('\n== TEST 6: plain LP-holder transfer with NO controller co-spent MUST ACCEPT (no static taint) ==');
{
  const h = global.G.lastMint; // the 50,000-share holder minted in TEST 1
  const utxo = JSON.parse(rcli('gettxout', h.txid, String(h.vout)));
  if (!utxo) { bad('holder UTXO already spent — cannot run transfer regression'); }
  else {
    const sats = Math.round(utxo.value * 1e8);
    const destAddr = rcli('getnewaddress');
    const destLock = buildStatefulOutput(addressPkh(destAddr), lpCode);
    const holderLockHex = toHex(buildStatefulOutput(h.pkh, lpCode));
    // fee comes from a separate P2PKH funding input so the LP value (50,000) is conserved exactly
    const fund = pickCoin(FEE + DUST);
    const fundPriv = PrivateKey.fromWIF(rcli('dumpprivkey', fund.address));
    const fundSats = Math.round(fund.amount * 1e8);
    const tx = new Transaction();
    tx.from({ txId: h.txid, outputIndex: h.vout, script: holderLockHex, satoshis: sats });                 // in0 holder (LP)
    tx.from({ txId: fund.txid, outputIndex: fund.vout, script: fund.scriptPubKey, satoshis: fundSats });   // in1 fee funding
    tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(destLock), satoshis: sats }));          // out0 new holder (LP conserved)
    tx.to(rcli('getnewaddress'), fundSats - FEE);                                                           // out1 change
    const senderPk = h.priv.toPublicKey().toBuffer();
    const sig = covenantSig(tx, 0, h.priv, holderLockHex, sats);
    tx.inputs[0].setScript(buildSelectorScriptSig([senderPk, sig], LP_TRANSFER));  // transfer: (senderPk, s), selector OP_0
    signP2PKH(tx, 1, fundPriv, fund.scriptPubKey, fundSats);
    const res = broadcast(tx.serialize(true));
    if (!res.ok) bad(`plain transfer REJECTED: ${res.error.split('\n')[0].slice(0, 70)} — STATIC TAINT PRESENT`);
    else { mine(); ok(`plain LP transfer ACCEPTED with NO $poolRef co-spent (refType gate is runtime-only, no taint)`); }
  }
}

console.log('\n== TEST 7: free-mint (deposit so small dS rounds to 0) MUST REJECT ==');
{
  // dR=1 with S0<R -> floor(dR*S0/R)=0 -> require(dS>0) rejects (cannot mint shares for ~free)
  const a = buildAddLiquidity({ dR: 1, dSoverride: 0, S1override: global.G.controller.shareTotal });
  const res = broadcast(a.tx.serialize(true));
  if (res.ok) { bad(`free-mint ACCEPTED (txid ${res.txid})`); mine(); }
  else ok(`free-mint REJECTED (${res.error.split('\n')[0].slice(0, 70)})`);
}

console.log(`\n${'='.repeat(60)}\nRPL-LP PHASE-0 SPIKE: PASS=${pass} FAIL=${fail}`);
console.log('Primitives proven: (a) stateful controller mutate+read across hops;');
console.log('                   (b) refValueSum delta pinned == dS (over-mint & free-mint rejected);');
console.log('                   (c) mint gated on controller singleton; plain transfer needs no controller.');
console.log('Plus: dS = dR*S0/R arithmetic correct on-chain at a non-unit value-per-share.');
process.exit(fail ? 1 : 0);
