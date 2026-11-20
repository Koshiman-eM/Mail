import { describe, expect, it } from "vitest";
import { PaperBroker } from "../src/execution/paper";
import type { Instrument, OrderRequest, Quote } from "../src/core/types";

/** PaperBroker の指値: post-only の拒否・reduceOnly の指値・越えたら約定 (触れただけでは約定しない)・取消 */

const btc: Instrument = {
  symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "USDT", tickSize: 0.01, lotSize: 0.001, minQty: 0.001,
  takerFeeRate: 0.0005, makerFeeRate: -0.0001, allowShort: true,
};
const q = (bid: number, ask: number): Quote => ({ ts: 1, bid, ask });
let n = 0;
const order = (o: Partial<OrderRequest> & Pick<OrderRequest, "side" | "qty">): OrderRequest => ({ clientId: `pl${++n}`, symbol: "BTC/USDT", type: "limit", strategyId: "t", ...o });

function mk() {
  const b = new PaperBroker({ instruments: [btc], baseCurrency: "USDT", initialEquity: 100_000, slippageBps: 0 });
  b.onQuote("BTC/USDT", q(100, 101));
  return b;
}

describe("PaperBroker: 指値 (maker)", () => {
  it("能力: post-only と利確の指値の板置きに対応", () => {
    expect(mk().capabilities).toEqual({ postOnly: true, restingTakeProfit: true });
  });

  it("post-only: 置いた瞬間に約定する価格 (marketable) なら拒否、板に置く側なら受け付ける", async () => {
    const b = mk();
    const r1 = await b.placeOrder(order({ side: "buy", qty: "1", limitPrice: 101, postOnly: true }));
    expect(r1.status).toBe("rejected");
    expect(r1.reason).toMatch(/post-only/);
    const r2 = await b.placeOrder(order({ side: "sell", qty: "1", limitPrice: 100, postOnly: true }));
    expect(r2.status).toBe("rejected");
    // post-only でなければ従来どおり taker で即時約定
    const r3 = await b.placeOrder(order({ side: "buy", qty: "1", limitPrice: 101 }));
    expect(r3.status).toBe("filled");
    expect(r3.fills[0].liquidity).toBe("taker");
    const r4 = await b.placeOrder(order({ side: "buy", qty: "1", limitPrice: 100, postOnly: true }));
    expect(r4.status).toBe("open");
    expect(b.openOrders()).toHaveLength(1);
  });

  it("気配が指値に触れただけでは約定せず、越えたら指値の価格で maker 約定する (手数料は makerFeeRate)", async () => {
    const b = mk();
    const r = await b.placeOrder(order({ side: "buy", qty: "2", limitPrice: 100, postOnly: true }));
    expect(b.onQuote("BTC/USDT", q(99.5, 100))).toHaveLength(0); // 売り気配 = 指値 (触れただけ)
    expect((await b.getOrder(r.clientId))!.status).toBe("open");
    const fills = b.onQuote("BTC/USDT", q(99.4, 99.99));
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ price: 100, qty: "2", liquidity: "maker" });
    expect(Number(fills[0].fee)).toBeCloseTo(100 * 2 * -0.0001, 10); // 受け取り
    expect((await b.getOrder(r.clientId))!.status).toBe("filled");
    expect((await b.getPositions())[0]).toMatchObject({ qty: "2", avgPrice: 100 });
  });

  it("reduceOnly の指値: 建玉を上限に約定し、建玉が無くなっていれば取消 (ドテンしない)", async () => {
    const b = mk();
    await b.placeOrder({ clientId: "e1", symbol: "BTC/USDT", side: "buy", type: "market", qty: "1", strategyId: "t" }); // 1 @101
    const tp = await b.placeOrder(order({ side: "sell", qty: "3", limitPrice: 110, reduceOnly: true, postOnly: true }));
    expect(tp.status).toBe("open");
    // 板の数量は建玉で上限 (3 → 1)
    expect(b.openOrders()[0].qty).toBe("1");
    expect(b.onQuote("BTC/USDT", q(110, 110.5))).toHaveLength(0); // 買い気配 = 指値 (触れただけ)
    const fills = b.onQuote("BTC/USDT", q(110.01, 110.5));
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ price: 110, qty: "1", liquidity: "maker" });
    expect(await b.getPositions()).toHaveLength(0);

    // 建玉が先に無くなった reduceOnly の指値は、約定の判定時に取り消す
    await b.placeOrder({ clientId: "e2", symbol: "BTC/USDT", side: "buy", type: "market", qty: "1", strategyId: "t" });
    const tp2 = await b.placeOrder(order({ side: "sell", qty: "1", limitPrice: 120, reduceOnly: true }));
    await b.placeOrder({ clientId: "x2", symbol: "BTC/USDT", side: "sell", type: "market", qty: "1", reduceOnly: true, strategyId: "t" });
    expect(b.onQuote("BTC/USDT", q(121, 122))).toHaveLength(0);
    expect((await b.getOrder(tp2.clientId))!.status).toBe("canceled");
    expect(await b.getPositions()).toHaveLength(0);
  });

  it("取消: 板から外れて canceled になり、その後に越えても約定しない", async () => {
    const b = mk();
    const r = await b.placeOrder(order({ side: "buy", qty: "1", limitPrice: 100, postOnly: true }));
    await b.cancelOrder(r.orderId, "BTC/USDT");
    expect((await b.getOrder(r.clientId))!.status).toBe("canceled");
    expect(b.openOrders()).toHaveLength(0);
    expect(b.onQuote("BTC/USDT", q(90, 91))).toHaveLength(0);
    expect(await b.getPositions()).toHaveLength(0);
  });
});
