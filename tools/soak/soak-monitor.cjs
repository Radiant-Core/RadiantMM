#!/usr/bin/env node
/*
 * soak-monitor.cjs — RadiantMM v3 pool invariant monitor for a testnet/regtest soak.
 *
 * WHAT IT DOES (read-only; never spends, never signs, never broadcasts):
 *   Follows the live pool forward from a starting controller outpoint. The pool is two co-spent
 *   UTXOs recreated at vout 0 (controller, carries $poolRef) and vout 1 (token reserve) of every
 *   trade. Each poll it: (1) finds the tx that spent the current controller outpoint, (2) treats
 *   that tx's vout 0/1 as the new pool head, (3) checks the per-hop invariants, (4) advances. It
 *   emits ONE stdout line per significant event (new trade verified, or INVARIANT VIOLATION), so
 *   it can be driven by a notifier/Monitor. Exits non-zero on the first violation.
 *
 * INVARIANTS CHECKED PER HOP (the ones observable from the tx alone):
 *   I1  code continuity   : new controller (vout0) codeScript == prior controller codeScript
 *   I2  state continuity  : new controller stateScript == prior (bare); reserve (vout1)
 *                           stateScript == prior reserve (20-zero marker)   [R1/R1b]
 *   I3  reserve code cont.: new reserve codeScript == prior reserve codeScript
 *   I4  pairing           : the trade spent controller@vout0 and reserve@vout1 of the SAME prior tx
 *   I5  constant product  : effRxdOut * tokOut >= rxdIn * tokIn, effRxdOut = rxdOut - ceilFee(|drxd|)
 *   I6  positivity/dust   : rxd>=546 both sides, tok>0 both sides
 *   I7  K-overflow bound  : R*T <= 2^53-1 on the new head
 *
 * USAGE:
 *   RADIANT_CLI=/path/radiant-cli RMM_RT=/path/datadir \
 *     node soak-monitor.cjs <controllerTxid> [<controllerVout=0>] [--poll-ms=15000] [--once]
 *   If <controllerTxid> is omitted it reads genesis_txid.txt from RMM_RT (vout 0).
 *
 *   --once   : do a single pass (one hop check if the pool moved) and exit. Good for cron.
 *   default  : loop forever, polling every --poll-ms, advancing as the pool trades.
 *
 * NOTE: ACTUALLY RUNNING A SOAK AND PROCURING THE EXTERNAL AUDIT ARE USER ACTIONS. This script is
 * tooling for the soak; it does not start a node, fund anything, or fire trades on its own.
 */
const cp = require('child_process'), fs = require('fs');

const RT = process.env.RMM_RT || '/tmp/rmm-regtest';
const CLI = process.env.RADIANT_CLI || '/Users/macbookair/CascadeProjects/Radiant-Core/build/src/radiant-cli';
const WALLET = process.env.RMM_WALLET || 'rmm';
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v === undefined ? true : v];
}));
const pos = args.filter(a => !a.startsWith('--'));
const POLL_MS = parseInt(flags['poll-ms'] || '15000', 10);
const ONCE = !!flags.once;
const MAX_K = 9007199254740991; // 2^53 - 1

function rcli(...a) {
  return cp.execFileSync(CLI, [`-datadir=${RT}`, `-rpcwallet=${WALLET}`, ...a], { encoding: 'utf8' }).trim();
}
function rpc(...a) { return JSON.parse(rcli(...a)); }
function emit(o) { process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n'); }
function fail(o) { emit({ level: 'VIOLATION', ...o }); process.exit(1); }
const sat = (btc) => Math.round(btc * 1e8);
const ceilFee = (drxd) => Math.ceil(Math.abs(drxd) * 3 / 1000); // 0.3% ceiling, matches contract intent

// Resolve the starting controller outpoint.
let ctlTxid = pos[0];
let ctlVout = pos[1] !== undefined ? parseInt(pos[1], 10) : 0;
if (!ctlTxid) {
  ctlTxid = fs.readFileSync(`${RT}/genesis_txid.txt`, 'utf8').trim();
  ctlVout = 0;
}

// Snapshot the current pool head (the controller + its paired reserve at vout 0/1 of `txid`).
function poolHead(txid) {
  const tx = rpc('getrawtransaction', txid, 'true');
  const c = tx.vout[0], r = tx.vout[1];
  if (!c || !r) fail({ reason: 'pool head missing vout 0/1', txid });
  return {
    txid,
    ctlCode: c.scriptPubKey.hex,           // includes state+code; we compare full SPK + split below
    ctlAsm: c.scriptPubKey.asm,
    resCode: r.scriptPubKey.hex,
    resAsm: r.scriptPubKey.asm,
    R: sat(c.value),
    T: sat(r.value),
  };
}

// Find the tx that spent outpoint (txid, vout). Returns the spending txid or null if still unspent.
// Uses gettxout (null => spent or never existed) + a mempool/block search via getrawtransaction is
// not directly indexable, so we rely on the wallet/txindex: scan recent blocks' txs for an input
// matching the outpoint. txindex=1 is required (the harness datadir sets it).
function findSpender(txid, vout) {
  // If still unspent, nothing to do.
  const utxo = rcli('gettxout', txid, String(vout), 'true');
  if (utxo && utxo !== '') return null; // gettxout returns non-empty JSON only when UNSPENT
  // Spent: walk back from the tip to find the spending tx (bounded scan).
  const info = rpc('getblockchaininfo');
  const tip = info.blocks;
  const LOOKBACK = parseInt(flags.lookback || '500', 10);
  for (let h = tip; h >= Math.max(0, tip - LOOKBACK); h--) {
    const bh = rcli('getblockhash', String(h));
    const blk = rpc('getblock', bh, '2'); // verbosity 2 = full txs
    for (const tx of blk.tx) {
      for (const vin of (tx.vin || [])) {
        if (vin.txid === txid && vin.vout === vout) return tx.txid;
      }
    }
  }
  // Also check mempool.
  for (const mtxid of rpc('getrawmempool')) {
    const mtx = rpc('getrawtransaction', mtxid, 'true');
    for (const vin of (mtx.vin || [])) {
      if (vin.txid === txid && vin.vout === vout) return mtx.txid;
    }
  }
  return null; // spent but not located within lookback
}

function splitStateCode(asm) {
  // Stateful SPK is <state-push> OP_STATESEPARATOR <code...>. Return [statePart, codePart].
  const i = asm.indexOf('OP_STATESEPARATOR');
  if (i < 0) return ['', asm.trim()];               // bare (no state)
  return [asm.slice(0, i).trim(), asm.slice(i + 'OP_STATESEPARATOR'.length).trim()];
}

function checkHop(prev, spendTxid) {
  const next = poolHead(spendTxid);
  const [pCtlState, pCtlCode] = splitStateCode(prev.ctlAsm);
  const [nCtlState, nCtlCode] = splitStateCode(next.ctlAsm);
  const [pResState, pResCode] = splitStateCode(prev.resAsm);
  const [nResState, nResCode] = splitStateCode(next.resAsm);

  // I1/I2: controller code+state continuity (bare both sides)
  if (nCtlCode !== pCtlCode) fail({ inv: 'I1', reason: 'controller code changed', prev: prev.txid, next: spendTxid });
  if (nCtlState !== pCtlState) fail({ inv: 'I2', reason: 'controller state changed (brick? R1b)', prev: prev.txid, next: spendTxid });
  // I2/I3: reserve code+state continuity (marker preserved)
  if (nResCode !== pResCode) fail({ inv: 'I3', reason: 'reserve code changed', prev: prev.txid, next: spendTxid });
  if (nResState !== pResState) fail({ inv: 'I2', reason: 'reserve state changed (state-hijack? R1)', prev: prev.txid, next: spendTxid });

  // I4: pairing — the spend must have taken controller@vout0 and reserve@vout1 of `prev.txid`
  const stx = rpc('getrawtransaction', spendTxid, 'true');
  const paired = (stx.vin || []).some(v => v.txid === prev.txid && v.vout === 0) &&
                 (stx.vin || []).some(v => v.txid === prev.txid && v.vout === 1);
  if (!paired) fail({ inv: 'I4', reason: 'spend did not pair controller@0 + reserve@1 of prior head', prev: prev.txid, next: spendTxid });

  // I5: constant product after fee
  const rxdIn = prev.R, tokIn = prev.T, rxdOut = next.R, tokOut = next.T;
  const fee = ceilFee(rxdOut - rxdIn);
  const effRxdOut = rxdOut - fee;
  const kIn = rxdIn * tokIn, kOut = effRxdOut * tokOut;
  if (!(effRxdOut > 0)) fail({ inv: 'I5', reason: 'effRxdOut <= 0', next: spendTxid });
  if (!(kOut >= kIn)) fail({ inv: 'I5', reason: 'K decreased', kIn, kOut, deficit: kIn - kOut, next: spendTxid });

  // I6: positivity/dust
  if (rxdIn < 546 || rxdOut < 546) fail({ inv: 'I6', reason: 'rxd below dust', rxdIn, rxdOut, next: spendTxid });
  if (tokIn <= 0 || tokOut <= 0) fail({ inv: 'I6', reason: 'token non-positive', tokIn, tokOut, next: spendTxid });

  // I7: overflow bound on the new head
  if (kOut > MAX_K) fail({ inv: 'I7', reason: 'R*T exceeds 2^53-1 (untradeable per R4)', kOut, next: spendTxid });

  emit({ level: 'OK', event: 'trade-verified', prev: prev.txid, next: spendTxid,
         R: rxdOut, T: tokOut, K: kOut, fee, kSlackVsPrior: kOut - kIn });
  return next;
}

function pass() {
  const head = poolHead(ctlTxid);
  const spender = findSpender(ctlTxid, ctlVout);
  if (!spender) { emit({ level: 'IDLE', event: 'no-new-trade', head: ctlTxid, R: head.R, T: head.T }); return false; }
  const next = checkHop(head, spender);
  ctlTxid = next.txid; ctlVout = 0;
  return true;
}

emit({ level: 'START', startHead: ctlTxid, vout: ctlVout, pollMs: POLL_MS, once: ONCE, node: CLI, datadir: RT });
if (ONCE) {
  pass();
  process.exit(0);
} else {
  const tick = () => {
    try { while (pass()) { /* drain all hops that occurred since last poll */ } }
    catch (e) { emit({ level: 'ERROR', reason: String(e && e.message || e) }); }
    setTimeout(tick, POLL_MS);
  };
  tick();
}
