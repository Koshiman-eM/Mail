import { describe, expect, it } from "vitest";
import type { Instrument, OrderRequest, Quote } from "../src/core/types";
import { PaperBroker, type PaperSnapshot } from "../src/execution/paper";

const btc: Instrument = { symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "USDT", tickSize: 0.01, lotSize: 0.001, minQty: 0.001, takerFeeRate: 0, makerFeeRate: 0, allowShort: false };
const bonk: Instrument = { symbol: "BONK/SOL", venue: "dex:solana", assetClass: "meme", baseCurrency: "BONK", quoteCurrency: "SOL", tickSize: 1e-9, lotSize: 1, minQty: 1, takerFeeRate: 0, makerFeeRate: 0, allowShort: false };
/** USD 建ての銘柄の例 */
const solusd: Instrument = { symbol: "SOL/USD", venue: "paper", assetClass: "crypto", baseCurrency: "SOL", quoteCurrency: "USD", tickSize: 0.01, lotSize: 1, minQty: 1, takerFeeRate: 0, makerFeeRate: 0, allowShort: true };
const q = (bid: number, ask: number): Quote => ({ ts: 1, bid, ask });
let n = 0;
const order = (o: Partial<OrderRequest> & Pick<OrderRequest, "symbol" | "side" | "qty">): OrderRequest => ({ clientId: `r${++n}`, type: "market", strategyId: "t", ...o });

describe("PaperBroker: スナップショットと未知の銘柄 (M1)", () => {
  it("スナップショットに銘柄定義を保存し、restore 先で未登録なら自動登録する", async () => {
    const a = new PaperBroker({ instruments: [btc, bonk], baseCurrency: "USDT", initialEquity: 10_000, slippageBps: 0, toAccount: (c) => (c === "SOL" ? 200 : 1) });
    a.onQuote("BONK/SOL", q(0.0001, 0.0001));
    await a.placeOrder(order({ symbol: "BONK/SOL", side: "buy", qty: "100000" }));
    const snap = JSON.parse(JSON.stringify(a.snapshot())) as PaperSnapshot;
    expect(snap.instruments?.map((i) => i.symbol)).toEqual(["BONK/SOL"]);
    expect(snap.fxRates).toEqual({ SOL: "200" });

    // 再起動後: BONK/SOL を登録していない (自動追加のミーム銘柄など)
    const b = new PaperBroker({ instruments: [btc], baseCurrency: "USDT", initialEquity: 1, slippageBps: 0, toAccount: (c) => (c === "SOL" ? 200 : 1) });
    b.restore(snap);
    expect(() => b.markToMarket()).not.toThrow();
    b.onQuote("BONK/SOL", q(0.00012, 0.00012));
    // 含み益 100000 * 0.00002 SOL * 200 = 400
    expect(b.markToMarket().unrealized).toBeCloseTo(400, 6);
    const close = await b.placeOrder(order({ symbol: "BONK/SOL", side: "sell", qty: "100000", reduceOnly: true }));
    expect(close.status).toBe("filled");
    expect(await b.getPositions()).toEqual([]);
  });

  it("定義の無い古いスナップショット: 例外にせず、その銘柄は平均単価で評価する", async () => {
    const old: PaperSnapshot = {
      version: 1, cash: "5000", realizedPnl: "0", seq: 3,
      positions: [{ symbol: "GHOST/SOL", qty: "10", avg: "2", openedAt: 1 }],
      resting: [], results: {}, quotes: { "GHOST/SOL": q(3, 3) },
    };
    const b = new PaperBroker({ instruments: [btc], baseCurrency: "USDT", initialEquity: 1, slippageBps: 0 });
    expect(() => b.restore(old)).not.toThrow();
    // 毎ティックの評価で例外にならない (含み損益 0 = 平均単価で評価)
    for (let i = 0; i < 3; i++) expect(b.markToMarket()).toMatchObject({ equity: 5000, unrealized: 0 });
    expect(b.onQuote("GHOST/SOL", q(4, 4))).toEqual([]);
    expect((await b.getBalance()).equity).toBe("5000");
    expect(await b.getPositions()).toEqual([{ symbol: "GHOST/SOL", qty: "10", avgPrice: 2 }]);
    // 後から定義を登録すれば通常どおり評価できる
    b.addInstrument({ ...btc, symbol: "GHOST/SOL", baseCurrency: "GHOST", quoteCurrency: "USDT" });
    expect(b.markToMarket().unrealized).toBeCloseTo(20, 8);
  });

  it("現在の登録はスナップショットの定義より優先する", () => {
    const a = new PaperBroker({ instruments: [btc], baseCurrency: "USDT", initialEquity: 1000, slippageBps: 0 });
    a.onQuote("BTC/USDT", q(100, 100));
    return a.placeOrder(order({ symbol: "BTC/USDT", side: "buy", qty: "1" })).then(() => {
      const snap = a.snapshot();
      snap.instruments = [{ ...btc, contractSize: 1000 }];
      const b = new PaperBroker({ instruments: [btc], baseCurrency: "USDT", initialEquity: 1, slippageBps: 0 });
      b.restore(snap);
      b.onQuote("BTC/USDT", q(110, 110));
      expect(b.markToMarket().unrealized).toBeCloseTo(10, 8);
    });
  });
});

describe("PaperBroker: 換算できない通貨 (NaN を 1 とみなさない)", () => {
  it("レート不明の銘柄は新規発注を拒否し、評価は最後に分かったレートを使う。決済は受け付ける", async () => {
    let usd = NaN;
    const b = new PaperBroker({ instruments: [solusd], baseCurrency: "JPY", initialEquity: 1_000_000, slippageBps: 0, toAccount: (c) => (c === "USD" ? usd : NaN) });
    b.onQuote("SOL/USD", q(100, 100));
    const r = await b.placeOrder(order({ symbol: "SOL/USD", side: "buy", qty: "10" }));
    expect(r).toMatchObject({ status: "rejected", reason: expect.stringMatching(/為替レートが不明/) });

    usd = 150;
    expect((await b.placeOrder(order({ symbol: "SOL/USD", side: "buy", qty: "10" }))).status).toBe("filled");
    b.onQuote("SOL/USD", q(110, 110));
    const known = b.markToMarket().equity;
    expect(known).toBeCloseTo(1_000_000 + 10 * 10 * 150, 6);

    // レートが取れなくなった: 評価は最後のレート (150) のまま、新規は拒否、決済は受け付ける
    usd = NaN;
    expect(b.markToMarket().equity).toBeCloseTo(known, 6);
    expect((await b.placeOrder(order({ symbol: "SOL/USD", side: "buy", qty: "1" }))).status).toBe("rejected");
    const close = await b.placeOrder(order({ symbol: "SOL/USD", side: "sell", qty: "10", reduceOnly: true }));
    expect(close.status).toBe("filled");
    expect(b.markToMarket().equity).toBeCloseTo(1_015_000, 6);
  });

  it("一度もレートが分からない建玉 (復元直後など) は評価から除外し、例外にしない", () => {
    const b = new PaperBroker({ instruments: [solusd], baseCurrency: "JPY", initialEquity: 1, slippageBps: 0, toAccount: () => NaN });
    b.restore({
      version: 1, cash: "1000", realizedPnl: "0", seq: 1, positions: [{ symbol: "SOL/USD", qty: "1", avg: "100", openedAt: 1 }],
      resting: [], results: {}, quotes: { "SOL/USD": q(120, 120) },
    });
    expect(b.markToMarket()).toMatchObject({ equity: 1000, unrealized: 0 });
  });

  it("getOrder は Broker 契約どおり async。clientId、無ければ orderId で引く", async () => {
    const b = new PaperBroker({ instruments: [btc], baseCurrency: "USDT", initialEquity: 1000, slippageBps: 0 });
    b.onQuote("BTC/USDT", q(100, 100));
    const r = await b.placeOrder(order({ symbol: "BTC/USDT", side: "buy", qty: "1" }));
    expect(await b.getOrder(r.clientId, "BTC/USDT")).toBe(r);
    expect(await b.getOrder("unknown", "BTC/USDT", r.orderId)).toBe(r);
    expect(await b.getOrder("unknown", "BTC/USDT")).toBeUndefined();
  });
});

describe("PaperBroker: 廃止した GMOコイン・FX の古いスナップショット", () => {
  const DAY = 86_400_000;
  /** 更新前の GMO のレバレッジ銘柄 (持ち越し手数料の日率つき) と FX の銘柄の定義 */
  const gmoBtc = { symbol: "BTC/JPY", venue: "gmo", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "JPY", tickSize: 1, lotSize: 0.01, minQty: 0.01, takerFeeRate: 0, makerFeeRate: 0, allowShort: true, meta: { holdingFeeDaily: 0.0004 } } as Instrument;
  const fxUsdJpy = { symbol: "USD/JPY", venue: "paper", assetClass: "fx", baseCurrency: "USD", quoteCurrency: "JPY", tickSize: 0.001, lotSize: 1, minQty: 1, takerFeeRate: 0, makerFeeRate: 0, allowShort: true, contractSize: 1 } as unknown as Instrument;
  const old = (): PaperSnapshot => ({
    version: 1, cash: "1000000", realizedPnl: "0", seq: 3,
    positions: [
      // GMO の持ち越し手数料で起点 (borrowFrom) と積んだ分 (borrowAccrued = 400 円) が付いた買いの建玉
      { symbol: "BTC/JPY", qty: "0.1", avg: "10000000", openedAt: 0, borrowFrom: DAY, borrowAccrued: "400" },
      { symbol: "USD/JPY", qty: "100", avg: "150", openedAt: 0 },
    ],
    resting: [], results: {}, quotes: { "BTC/JPY": q(10_000_000, 10_000_000), "USD/JPY": q(151, 151) },
    instruments: [gmoBtc, fxUsdJpy],
  });

  it("例外にせず復元・評価できる。買いの建玉には積んだ分だけを負債にし、新たな保有コストは積まない (決済時に払う)", async () => {
    const clock = { now: () => 10 * DAY };
    const b = new PaperBroker({ instruments: [], baseCurrency: "JPY", initialEquity: 1, slippageBps: 0, clock });
    b.restore(old());
    // 評価額 = 現金 + 含み損益 (BTC 0 − 積んだ 400、USD/JPY +100)。10 日たっても 400 のまま
    expect(b.markToMarket().equity).toBeCloseTo(1_000_000 - 400 + 100, 6);
    // 未知の資産クラス (fx) もレバレッジ 1 倍とみなす (例外にしない)。証拠金 = 1,000,000 + 15,100 > 評価額なので余力 0
    expect(Number((await b.getBalance()).available)).toBe(0);
    const close = await b.placeOrder(order({ symbol: "BTC/JPY", side: "sell", qty: "0.1", reduceOnly: true }));
    expect(close.status).toBe("filled");
    expect(close.fills[0].fee).toBe("400");
  });
});
