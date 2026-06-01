/**
 * v3 paired-UTXO transaction builder. Encapsulates the validated regtest harnesses
 * (tools/regtest/{genesis,trade-buy}.cjs) as a typed SDK. Produces raw tx hex to
 * broadcast via any Radiant node / Electrum.
 *
 * Pool layout (canonical, enforced by the contract):
 *   input[0]/output[0] = controller (RXD reserve R, carries singleton $poolRef)
 *   input[1]/output[1] = token reserve (bare, value T = real coloured tokens, $tokenRef)
 *   trade()/release() are PERMISSIONLESS: the covenant scriptSig is just the function
 *   selector (OP_0 = trade, OP_1 = release); only funding/holder inputs need signatures.
 */
import Radiant from '@radiant-core/radiantjs';
import { buildPoolScripts, buildStatefulOutput, encodeRef, RESERVE_MARKER, PoolArtifacts, Hex } from './contracts.js';
import { quoteBuy, quoteSell, verifyAccept, Quote } from './math.js';

const R = Radiant as any;
const { Transaction, Script, PrivateKey, crypto, Address, Opcode } = R;
const SIGHASH = crypto.Signature.SIGHASH_ALL | crypto.Signature.SIGHASH_FORKID;
const FLAGS = Script.Interpreter.SCRIPT_ENABLE_SIGHASH_FORKID | Script.Interpreter.SCRIPT_VERIFY_STRICTENC;

export interface Utxo { txid: Hex; vout: number; satoshis: number; scriptPubKey: Hex; }
export interface KeyedUtxo extends Utxo { wif: string; }

export interface PoolState {
  controller: { txid: Hex; vout: number; satoshis: number };
  reserve: { txid: Hex; vout: number; satoshis: number };
  poolRef: Buffer;
  tokenRef: Buffer;
  ownerPkh: Buffer;
  controllerCode: Buffer;
  tokenCode: Buffer;
}

function pkhOf(addr: string): Buffer { return Buffer.from(Address.fromString(addr).hashBuffer); }
function p2pkhScript(addr: string): Buffer { return Buffer.from(Script.fromAddress(addr).toBuffer()); }

/** Sign a P2PKH input i in-place: scriptSig = push(sig+hashtype) push(pubkey). */
function signP2PKH(tx: any, i: number, wif: string, scriptHex: Hex, satoshis: number): void {
  const key = PrivateKey.fromWIF(wif);
  const sig = Transaction.Sighash.sign(tx, key, SIGHASH, i, Script.fromHex(scriptHex), new crypto.BN(satoshis), FLAGS);
  const ss = new Script();
  ss.add(Buffer.concat([sig.toDER(), Buffer.from([SIGHASH])]));
  ss.add(Buffer.from(key.toPublicKey().toBuffer()));
  tx.inputs[i].setScript(ss);
}

export interface GenesisParams {
  art: PoolArtifacts;
  fundingA: KeyedUtxo;      // its outpoint becomes $poolRef (singleton on the controller)
  fundingB: KeyedUtxo;      // its outpoint becomes $tokenRef (on the token reserves)
  ownerPkh: Buffer;         // owner for the controller withdraw path
  rxdReserve: number;       // R: initial RXD reserve (controller value)
  tokenReserve: number;     // T: initial token reserve (reserve UTXO value)
  userAllocation?: { pkh: Buffer; amount: number }; // optional initial holder allocation
  changeAddress: string;
  feeSats: number;
}

export interface GenesisResult { hex: Hex; pool: PoolState; outputs: { controller: 0; reserve: 1 }; }

/** Build the genesis tx: mint $poolRef/$tokenRef from the two funding outpoints and deploy bare. */
export function buildGenesis(p: GenesisParams): GenesisResult {
  const poolRef = encodeRef(p.fundingA.txid, p.fundingA.vout);
  const tokenRef = encodeRef(p.fundingB.txid, p.fundingB.vout);
  const { controllerCode, tokenCode } = buildPoolScripts(p.art, poolRef, tokenRef, p.ownerPkh);

  const tx = new Transaction();
  tx.from({ txId: p.fundingA.txid, outputIndex: p.fundingA.vout, script: p.fundingA.scriptPubKey, satoshis: p.fundingA.satoshis });
  tx.from({ txId: p.fundingB.txid, outputIndex: p.fundingB.vout, script: p.fundingB.scriptPubKey, satoshis: p.fundingB.satoshis });
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(controllerCode), satoshis: p.rxdReserve })); // out0
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(buildStatefulOutput(RESERVE_MARKER, tokenCode)), satoshis: p.tokenReserve })); // out1 (stateful marker)
  if (p.userAllocation) {
    tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(buildStatefulOutput(p.userAllocation.pkh, tokenCode)), satoshis: p.userAllocation.amount }));
  }
  const totalIn = p.fundingA.satoshis + p.fundingB.satoshis;
  const outSoFar = tx.outputs.reduce((s: number, o: any) => s + o.satoshis, 0);
  tx.to(p.changeAddress, totalIn - outSoFar - p.feeSats);

  signP2PKH(tx, 0, p.fundingA.wif, p.fundingA.scriptPubKey, p.fundingA.satoshis);
  signP2PKH(tx, 1, p.fundingB.wif, p.fundingB.scriptPubKey, p.fundingB.satoshis);

  const txid = tx.id;
  const pool: PoolState = {
    controller: { txid, vout: 0, satoshis: p.rxdReserve },
    reserve: { txid, vout: 1, satoshis: p.tokenReserve },
    poolRef, tokenRef, ownerPkh: p.ownerPkh, controllerCode, tokenCode,
  };
  return { hex: tx.serialize(true), pool, outputs: { controller: 0, reserve: 1 } };
}

export interface BuyParams {
  pool: PoolState;
  rxdIn: number;            // RXD the trader adds
  traderPkh: Buffer;        // recipient of the bought tokens
  funding: KeyedUtxo;       // pays rxdIn into the pool + tx fee
  changeAddress: string;
  feeSats: number;
}
export interface TradeResult { hex: Hex; quote: Quote; newPool: PoolState; }

/** Build a BUY: trader adds rxdIn RXD, receives quote.amountOut tokens; pool recreated. */
export function buildBuy(p: BuyParams): TradeResult {
  const Rr = BigInt(p.pool.controller.satoshis), Tt = BigInt(p.pool.reserve.satoshis);
  const q = quoteBuy(Rr, Tt, BigInt(p.rxdIn));
  const acc = verifyAccept(Rr, Tt, q.rxdReserveOut, q.tokenReserveOut);
  if (!acc.ok) throw new Error(`internal: quote not accepted by verifyAccept (${acc.reason})`);

  const { controllerCode, tokenCode } = p.pool;
  const rxdOut = Number(q.rxdReserveOut), tokOut = Number(q.tokenReserveOut), toTrader = Number(q.amountOut);

  const tx = new Transaction();
  tx.from({ txId: p.pool.controller.txid, outputIndex: p.pool.controller.vout, script: '00' /*placeholder*/, satoshis: p.pool.controller.satoshis });
  tx.from({ txId: p.pool.reserve.txid, outputIndex: p.pool.reserve.vout, script: '00', satoshis: p.pool.reserve.satoshis });
  tx.from({ txId: p.funding.txid, outputIndex: p.funding.vout, script: p.funding.scriptPubKey, satoshis: p.funding.satoshis });
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(controllerCode), satoshis: rxdOut }));                                   // out0
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(buildStatefulOutput(RESERVE_MARKER, tokenCode)), satoshis: tokOut }));   // out1 (stateful marker)
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(buildStatefulOutput(p.traderPkh, tokenCode)), satoshis: toTrader }));    // out2
  const totalIn = p.pool.controller.satoshis + p.pool.reserve.satoshis + p.funding.satoshis;
  const outSoFar = tx.outputs.reduce((s: number, o: any) => s + o.satoshis, 0);
  tx.to(p.changeAddress, totalIn - outSoFar - p.feeSats);

  // covenant inputs: scriptSig is just the function selector (no signature)
  tx.inputs[0].setScript(Script.fromBuffer(Buffer.from([0x00]))); // trade  (index 0)
  tx.inputs[1].setScript(Script.fromBuffer(Buffer.from([0x51]))); // release(index 1)
  signP2PKH(tx, 2, p.funding.wif, p.funding.scriptPubKey, p.funding.satoshis);

  const txid = tx.id;
  const newPool: PoolState = {
    ...p.pool,
    controller: { txid, vout: 0, satoshis: rxdOut },
    reserve: { txid, vout: 1, satoshis: tokOut },
  };
  return { hex: tx.serialize(true), quote: q, newPool };
}

export interface SellParams {
  pool: PoolState;
  tokensIn: number;          // tokens the trader supplies (reserve grows by this)
  traderToken: KeyedUtxo;    // the trader's STATEFUL holder UTXO (state = their pkh)
  rxdOutAddress: string;     // where the trader receives RXD
  funding: KeyedUtxo;        // pays the tx fee
  changeAddress: string;
  feeSats: number;
}

/**
 * Build a SELL: trader supplies `tokensIn` tokens (spending their stateful holder via
 * transfer()), the reserve grows, the trader receives quote.amountOut RXD. Uses the
 * OP_DROP-dispatch resolution: in2 scriptSig is `push(pk) push(sig) OP_0`.
 *
 * inputs : [0] controller (OP_0 trade) [1] reserve (OP_1 release)
 *          [2] trader stateful token (transfer + sig) [3] P2PKH funding (fee)
 * outputs: [0] controller' (R') [1] reserve' (T+tokensIn, stateful) [2] trader RXD
 *          [3] token change (if any, stateful) [4] RXD change
 */
export function buildSell(p: SellParams): TradeResult {
  const Rr = BigInt(p.pool.controller.satoshis), Tt = BigInt(p.pool.reserve.satoshis);
  const q = quoteSell(Rr, Tt, BigInt(p.tokensIn));
  const acc = verifyAccept(Rr, Tt, q.rxdReserveOut, q.tokenReserveOut);
  if (!acc.ok) throw new Error(`internal: sell quote not accepted (${acc.reason})`);
  if (p.tokensIn > p.traderToken.satoshis) throw new Error('tokensIn exceeds trader token balance');

  const { controllerCode, tokenCode } = p.pool;
  const Rp = Number(q.rxdReserveOut), Tp = Number(q.tokenReserveOut), rxdToTrader = Number(q.amountOut);
  const tokenChange = p.traderToken.satoshis - p.tokensIn;

  const traderKey = PrivateKey.fromWIF(p.traderToken.wif);
  const traderPkh = Buffer.from(crypto.Hash.sha256ripemd160(traderKey.toPublicKey().toBuffer()));
  const traderLock = buildStatefulOutput(traderPkh, tokenCode); // the holder UTXO being spent

  const tx = new Transaction();
  tx.from({ txId: p.pool.controller.txid, outputIndex: p.pool.controller.vout, script: '00', satoshis: p.pool.controller.satoshis });
  tx.from({ txId: p.pool.reserve.txid, outputIndex: p.pool.reserve.vout, script: '00', satoshis: p.pool.reserve.satoshis });
  tx.from({ txId: p.traderToken.txid, outputIndex: p.traderToken.vout, script: p.traderToken.scriptPubKey, satoshis: p.traderToken.satoshis });
  tx.from({ txId: p.funding.txid, outputIndex: p.funding.vout, script: p.funding.scriptPubKey, satoshis: p.funding.satoshis });
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(controllerCode), satoshis: Rp }));                                   // out0
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(buildStatefulOutput(RESERVE_MARKER, tokenCode)), satoshis: Tp }));  // out1
  tx.to(p.rxdOutAddress, rxdToTrader);                                                                                                 // out2 trader RXD
  if (tokenChange > 0) {
    tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(buildStatefulOutput(traderPkh, tokenCode)), satoshis: tokenChange })); // out3
  }
  const totalIn = p.pool.controller.satoshis + p.pool.reserve.satoshis + p.traderToken.satoshis + p.funding.satoshis;
  const outSoFar = tx.outputs.reduce((s: number, o: any) => s + o.satoshis, 0);
  tx.to(p.changeAddress, totalIn - outSoFar - p.feeSats);

  tx.inputs[0].setScript(Script.fromBuffer(Buffer.from([0x00]))); // trade
  tx.inputs[1].setScript(Script.fromBuffer(Buffer.from([0x51]))); // release
  // in2: transfer() — push(senderPk) push(sig) OP_0; OP_DROP prologue consumes the state push
  const sig2 = Transaction.Sighash.sign(tx, traderKey, SIGHASH, 2, Script.fromBuffer(traderLock), new crypto.BN(p.traderToken.satoshis), FLAGS);
  const ss2 = new Script();
  ss2.add(Buffer.from(traderKey.toPublicKey().toBuffer()));
  ss2.add(Buffer.concat([sig2.toDER(), Buffer.from([SIGHASH])]));
  ss2.add(Opcode.OP_0);
  tx.inputs[2].setScript(ss2);
  signP2PKH(tx, 3, p.funding.wif, p.funding.scriptPubKey, p.funding.satoshis);

  const txid = tx.id;
  const newPool: PoolState = { ...p.pool, controller: { txid, vout: 0, satoshis: Rp }, reserve: { txid, vout: 1, satoshis: Tp } };
  return { hex: tx.serialize(true), quote: q, newPool };
}
