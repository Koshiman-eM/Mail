import { describe, expect, it } from "vitest";
import { PaperBroker } from "../src/execution/paper";
import type { Instrument, OrderRequest, Quote } from "../src/core/types";

const btc: Instrument = { symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "USDT", tickSize: 0.01, lotSize: 0.001, minQty: 0.001, takerFeeRate: 0.001, makerFeeRate: 0.0005, allowShort: false };
/** 取引所で空売りできる銘柄 (allowShort=true) の例 */
const xrpjpy: Instrument = { symbol: "XRP/JPY", venue: "paper", assetClass: "crypto", baseCurrency: "XRP", quoteCurrency: "JPY", tickSize: 0.001, lotSize: 1, minQty: 1, takerFeeRate: 0, makerFeeRate: 0, allowShort: true, contractSize: 1 };
/** USD 建ての銘柄の例 */
const solusd: Instrument = { symbol: "SOL/USD", venue: "paper", assetClass: "crypto", baseCurrency: "SOL", quoteCurrency: "USD", tickSize: 0.01, lotSize: 1, minQty: 1, takerFeeRate: 0, makerFeeRate: 0, allowShort: true };

const q = (bid: number, ask: number): Quote => ({ ts: 1, bid, ask });
let n = 0;
const order = (o: Partial<OrderRequest> & Pick<OrderRequest, "symbol" | "side" | "qty">): OrderRequest => ({ clientId: `c${++n}`, type: "market", strategyId: "t", ...o });

function mk(extra: Partial<ConstructorParameters<typeof PaperBroker>[0]> = {}) {
  const b = new PaperBroker({ instruments: [btc, xrpjpy, solusd], baseCurrency: "USDT", initialEquity: 10_000, slippageBps: 0, ...extra });
  b.onQuote("BTC/USDT", q(100, 101));
  return b;
}

describe("PaperBroker", () => {
  it("成行: 買いは ask、売りは bid、手数料は taker", async () => {
    const b = mk({ slippageBps: 10 });
    const r = await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", qty: "1" }));
    expect(r.status).toBe("filled");
    expect(r.fills[0].price).toBeCloseTo(101.1, 8);
    expect(r.fills[0].liquidity).toBe("taker");
    expect(Number(r.fills[0].fee)).toBeCloseTo(0.1011, 8);
    const s = await b.placeOrder(order({ symbol: "BTC/USDT", side: "sell", qty: "1" }));
    expect(s.fills[0].price).toBeCloseTo(99.9, 2);
    expect((await b.getPositions())).toHaveLength(0);
  });

  it("会計: 平均単価・部分決済・実現損益", async () => {
    const b = mk();
    await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", qty: "1" })); // @101
    b.onQuote("BTC/USDT", q(109, 110));
    await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", qty: "1" })); // @110
    expect((await b.getPositions())[0]).toMatchObject({ qty: "2", avgPrice: 105.5 });
    b.onQuote("BTC/USDT", q(120, 121));
    await b.placeOrder(order({ symbol: "BTC/USDT", side: "sell", qty: "0.5" })); // @120
    expect((await b.getPositions())[0]).toMatchObject({ qty: "1.5", avgPrice: 105.5 });
    const m = b.markToMarket();
    // 実現: 0.5*(120-105.5)=7.25、手数料: 0.101+0.11+0.06
    expect(m.realized).toBeCloseTo(7.25, 8);
    expect(m.equity).toBeCloseTo(10_000 + 7.25 - (0.101 + 0.11 + 0.06) + 1.5 * (120.5 - 105.5), 6);
  });

  it("ドテン (FX)", async () => {
    const b = mk({ toAccount: (c) => (c === "JPY" ? 0.01 : 1) });
    b.onQuote("XRP/JPY", q(150, 150.01));
    await b.placeOrder(order({ symbol: "XRP/JPY", side: "buy", qty: "100" }));
    b.onQuote("XRP/JPY", q(151, 151.01));
    await b.placeOrder(order({ symbol: "XRP/JPY", side: "sell", qty: "250" })); // 100 決済 + 150 ショート
    const p = (await b.getPositions())[0];
    expect(p).toMatchObject({ qty: "-150", avgPrice: 151 });
    // 実現 (151-150.01)*100 = 99 JPY → 0.99 USDT 相当
    expect(b.markToMarket().realized).toBeCloseTo(0.99, 6);
  });

  it("allowShort=false の空売りは rejected、reduceOnly は建玉でクリップ", async () => {
    const b = mk();
    const r = await b.placeOrder(order({ symbol: "BTC/USDT", side: "sell", qty: "1" }));
    expect(r.status).toBe("rejected");
    expect(r.reason).toMatch(/空売り不可/);
    const r2 = await b.placeOrder(order({ symbol: "BTC/USDT", side: "sell", qty: "1", reduceOnly: true }));
    expect(r2.status).toBe("rejected");
    await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", qty: "1" }));
    const r3 = await b.placeOrder(order({ symbol: "BTC/USDT", side: "sell", qty: "5", reduceOnly: true }));
    expect(r3.fills[0].qty).toBe("1");
  });

  it("残高不足・未知銘柄・最小数量・クオート無しは rejected", async () => {
    const b = mk();
    expect((await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", qty: "1000" }))).status).toBe("rejected");
    expect((await b.placeOrder(order({ symbol: "ZZZ", side: "buy", qty: "1" }))).status).toBe("rejected");
    expect((await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", qty: "0.0001" }))).status).toBe("rejected");
    expect((await b.placeOrder(order({ symbol: "SOL/USD", side: "buy", qty: "1" }))).reason).toMatch(/クオート/);
  });

  it("指値: 交差で即約定、非交差は板に置き onQuote で maker 約定", async () => {
    const b = mk();
    const r = await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: "1", limitPrice: 102 }));
    expect(r.status).toBe("filled");
    expect(r.fills[0]).toMatchObject({ price: 101, liquidity: "taker" });
    const r2 = await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: "1", limitPrice: 95 }));
    expect(r2.status).toBe("open");
    expect(b.openOrders()).toHaveLength(1);
    expect(b.onQuote("BTC/USDT", q(97, 98))).toHaveLength(0);
    const fills = b.onQuote("BTC/USDT", q(93, 94.5));
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ price: 95, liquidity: "maker" });
    expect(Number(fills[0].fee)).toBeCloseTo(0.0475, 6);
    expect((await b.getOrder(r2.clientId, "BTC/USDT"))!.status).toBe("filled");
    expect(b.openOrders()).toHaveLength(0);
  });

  it("指値のキャンセルと IOC", async () => {
    const b = mk();
    const r = await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: "1", limitPrice: 90 }));
    await b.cancelOrder(r.orderId, "BTC/USDT");
    expect(b.openOrders()).toHaveLength(0);
    const ioc = await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: "1", limitPrice: 90, tif: "IOC" }));
    expect(ioc.status).toBe("canceled");
  });

  it("clientId で冪等 (二重発注しない)", async () => {
    const b = mk();
    const req = order({ symbol: "BTC/USDT", side: "buy", qty: "1" });
    const a = await b.placeOrder(req);
    const c = await b.placeOrder(req);
    expect(c).toBe(a);
    expect((await b.getPositions())[0].qty).toBe("1");
  });

  it("小数の誤差が出ない (0.1 + 0.2 相当)", async () => {
    const b = new PaperBroker({ instruments: [{ ...btc, takerFeeRate: 0 }], baseCurrency: "USDT", initialEquity: 1000, slippageBps: 0 });
    b.onQuote("BTC/USDT", q(0.1, 0.1));
    await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", qty: "0.1" }));
    await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", qty: "0.2" }));
    expect((await b.getPositions())[0].qty).toBe("0.3");
  });

  it("スナップショット/復元 (JSON 経由)", async () => {
    const b = mk();
    await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", qty: "1" }));
    await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", type: "limit", qty: "1", limitPrice: 90 }));
    const snap = JSON.parse(JSON.stringify(b.snapshot()));
    const b2 = new PaperBroker({ instruments: [btc], baseCurrency: "USDT", initialEquity: 1, slippageBps: 0 });
    b2.restore(snap);
    expect(await b2.getPositions()).toEqual(await b.getPositions());
    expect(b2.markToMarket()).toEqual(b.markToMarket());
    expect(b2.openOrders()).toHaveLength(1);
    expect((await b2.getBalance()).equity).toBe((await b.getBalance()).equity);
  });

  it("口座通貨換算 (USD 建て → JPY 口座)", async () => {
    const b = new PaperBroker({ instruments: [solusd], baseCurrency: "JPY", initialEquity: 1_000_000, slippageBps: 0, toAccount: (c) => (c === "USD" ? 150 : 1) });
    b.onQuote("SOL/USD", q(100, 100));
    await b.placeOrder(order({ symbol: "SOL/USD", side: "buy", qty: "10" }));
    b.onQuote("SOL/USD", q(110, 110));
    expect(b.markToMarket().equity).toBeCloseTo(1_000_000 + 10 * 10 * 150, 4);
    const bal = await b.getBalance();
    expect(bal.currency).toBe("JPY");
    // 現物 (レバレッジ 1 倍): 使用証拠金 = 110*10*150
    expect(Number(bal.available)).toBeCloseTo(1_015_000 - 165_000, 4);
  });
});
