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
import { buildPoolScripts, buildStatefulOutput, encodeRef, PoolArtifacts, Hex } from './contracts.js';
import { quoteBuy, quoteSell, verifyAccept, Quote } from './math.js';

const R = Radiant as any;
const { Transaction, Script, PrivateKey, crypto, Address } = R;
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
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(tokenCode), satoshis: p.tokenReserve }));     // out1 (bare)
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
  tx.addOutput(new Transaction.Output({ script: Script.fromBuffer(tokenCode), satoshis: tokOut }));                                        // out1
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

/**
 * SELL quote (RXD out for tokens in). The controller's trade() is symmetric so the
 * controller/reserve side is identical to a buy with rxdOut < rxdIn; the only open
 * piece is the trader spending their STATEFUL token UTXO into the reserve (the
 * state-on-stack dispatch issue tracked separately). Exposed now so callers can quote
 * sells and so the builder is ready once that spend path lands.
 */
export function quoteSellRxdOut(pool: PoolState, tokensIn: number): Quote {
  return quoteSell(BigInt(pool.controller.satoshis), BigInt(pool.reserve.satoshis), BigInt(tokensIn));
}
