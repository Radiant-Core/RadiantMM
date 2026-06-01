/* Integration smoke test: drive a genesis + buy through the v3 SDK against regtest. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildGenesis, buildBuy, buildSell, type KeyedUtxo } from '../../src/v3/builder.js';
import { verifyAccept } from '../../src/v3/math.js';
import Radiant from '@radiant-core/radiantjs';
const RadiantAny = Radiant as any;

const RT = '/tmp/rmm-regtest';
const CLI = '/Users/macbookair/CascadeProjects/Radiant-Core/build/src/radiant-cli';
const rcli = (...a: string[]) => execFileSync(CLI, [`-datadir=${RT}`, '-rpcwallet=rmm', ...a], { encoding: 'utf8' }).trim();
const art = (n: string) => JSON.parse(readFileSync(`/Users/macbookair/CascadeProjects/RadiantMM/contracts/v3/artifacts/${n}.json`, 'utf8')).asm as string;
const ARTS = { poolAsm: art('RadiantMMPool'), tokenAsm: art('RadiantMMToken') };

function coin(): KeyedUtxo {
  const u = JSON.parse(rcli('listunspent', '1', '9999999')).filter((x: any) => x.amount >= 1).sort((a: any, b: any) => b.amount - a.amount)[0];
  // use a distinct coin each call by spending none — pick the largest; mark used by tracking txid:vout
  return { txid: u.txid, vout: u.vout, satoshis: Math.round(u.amount * 1e8), scriptPubKey: u.scriptPubKey, wif: rcli('dumpprivkey', u.address) };
}
function distinctCoins(n: number): KeyedUtxo[] {
  const us = (JSON.parse(rcli('listunspent', '1', '9999999')) as any[]).filter(x => x.amount >= 1).slice(0, n);
  return us.map(u => ({ txid: u.txid, vout: u.vout, satoshis: Math.round(u.amount * 1e8), scriptPubKey: u.scriptPubKey, wif: rcli('dumpprivkey', u.address) }));
}
const pkh = (addr: string) => Buffer.from(RadiantAny.Address.fromString(addr).hashBuffer);

const [fundingA, fundingB, fundBuy] = distinctCoins(3);
const ownerPkh = pkh(rcli('getnewaddress'));

const gen = buildGenesis({
  art: ARTS, fundingA, fundingB, ownerPkh,
  rxdReserve: 1_000_000, tokenReserve: 100_000,
  changeAddress: rcli('getnewaddress'), feeSats: 6_000_000,
});
const gtxid = rcli('sendrawtransaction', gen.hex);
rcli('generatetoaddress', '1', rcli('getnewaddress'));
console.log('SDK genesis broadcast:', gtxid === gen.pool.controller.txid ? 'txid matches SDK prediction ✓' : `MISMATCH (${gtxid} vs ${gen.pool.controller.txid})`);
console.log('  pool R/T:', rcli('gettxout', gtxid, '0') ? '(live)' : '(?)', gen.pool.controller.satoshis, '/', gen.pool.reserve.satoshis);

const traderAddr = rcli('getnewaddress');
const traderPkh = pkh(traderAddr);
const buy = buildBuy({ pool: gen.pool, rxdIn: 100_000, traderPkh, funding: fundBuy, changeAddress: rcli('getnewaddress'), feeSats: 6_000_000 });
console.log('SDK buy quote:', { fee: buy.quote.fee.toString(), tokenReserveOut: buy.quote.tokenReserveOut.toString(), amountOut: buy.quote.amountOut.toString() });
const btxid = rcli('sendrawtransaction', buy.hex);
rcli('generatetoaddress', '1', rcli('getnewaddress'));
const tokensBought = Math.round(JSON.parse(rcli('gettxout', btxid, '2')).value * 1e8);
console.log('SDK buy broadcast:', btxid);
console.log('  pool after: R =', Math.round(JSON.parse(rcli('gettxout', btxid, '0')).value * 1e8),
            ' T =', Math.round(JSON.parse(rcli('gettxout', btxid, '1')).value * 1e8),
            ' traderTokens =', tokensBought);

// --- SELL: trader sells the bought tokens back via the SDK ---
const traderTokenUtxo: KeyedUtxo = {
  txid: btxid, vout: 2, satoshis: tokensBought,
  scriptPubKey: JSON.parse(rcli('gettxout', btxid, '2')).scriptPubKey.hex,
  wif: rcli('dumpprivkey', traderAddr),
};
const [fundSell] = distinctCoins(1);
const sell = buildSell({
  pool: buy.newPool, tokensIn: tokensBought, traderToken: traderTokenUtxo,
  rxdOutAddress: rcli('getnewaddress'), funding: fundSell,
  changeAddress: rcli('getnewaddress'), feeSats: 6_000_000,
});
console.log('SDK sell quote:', { fee: sell.quote.fee.toString(), tokenReserveOut: sell.quote.tokenReserveOut.toString(), rxdToTrader: sell.quote.amountOut.toString() });
const stxid = rcli('sendrawtransaction', sell.hex);
rcli('generatetoaddress', '1', rcli('getnewaddress'));
console.log('SDK sell broadcast:', stxid);
console.log('  pool after: R =', Math.round(JSON.parse(rcli('gettxout', stxid, '0')).value * 1e8),
            ' T =', Math.round(JSON.parse(rcli('gettxout', stxid, '1')).value * 1e8),
            ' traderRXD =', Math.round(JSON.parse(rcli('gettxout', stxid, '2')).value * 1e8));
