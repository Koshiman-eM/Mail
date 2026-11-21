import { describe, expect, it, vi } from "vitest";
import { SyntheticFeed } from "../src/market/feeds/synthetic";
import { MarketHub } from "../src/market/hub";
import { aggregateCandles } from "../src/market/candles";
import type { Clock, MarketDataFeed } from "../src/core/types";

const T0 = Date.parse("2025-03-01T00:00:00Z");
const mkClock = (): Clock & { t: number } => ({ t: T0, now() { return this.t; } });

describe("synthetic feed", () => {
  it("同じ seed なら同じ価格列、足が整合する", async () => {
    const c1 = mkClock(), c2 = mkClock();
    const a = new SyntheticFeed({ seed: 7, clock: c1, historyMs: 86_400_000 });
    const b = new SyntheticFeed({ seed: 7, clock: c2, historyMs: 86_400_000 });
    expect(await a.fetchQuote("BTC/USDT")).toEqual(await b.fetchQuote("BTC/USDT"));
    const ca = await a.fetchCandles("BTC/USDT", "1m", 120);
    expect(ca.length).toBe(120);
    for (const c of ca) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
    }
    // 1h 足は 1m 足の集約と一致 (確定足)
    const m1 = await a.fetchCandles("BTC/USDT", "1m", 600);
    const h1 = (await a.fetchCandles("BTC/USDT", "1h", 3)).slice(0, 2);
    const agg = aggregateCandles(m1, 3_600_000).filter((x) => h1.some((y) => y.ts === x.ts));
    for (const h of agg) {
      const ref = h1.find((y) => y.ts === h.ts)!;
      expect(ref.close).toBeCloseTo(h.close, 6);
      expect(ref.open).toBeCloseTo(h.open, 6);
    }
  });
  it("既定銘柄・板・約定", async () => {
    const f = new SyntheticFeed({ clock: mkClock(), historyMs: 3_600_000 });
    const list = await f.listInstruments();
    expect(list.map((i) => i.assetClass)).toEqual(["crypto", "crypto", "crypto", "fx", "stock"]);
    const q = await f.fetchQuote("USD/JPY");
    expect(q.ask).toBeGreaterThan(q.bid);
    const ob = await f.fetchOrderBook("PEPE/USDT", 5);
    expect(ob.bids).toHaveLength(5);
    expect(ob.bids[0][0]).toBeLessThan(ob.asks[0][0]);
    expect((await f.fetchPrints("ETH/USDT", 20)).length).toBe(20);
  });
});

describe("MarketHub", () => {
  it("履歴取得・ポーリング・確定足のみの view", async () => {
    const clock = mkClock();
    const feed = new SyntheticFeed({ clock, historyMs: 6 * 3_600_000 });
    const hub = new MarketHub({ feeds: [feed], clock, historyLimit: 100, timeframes: ["1m", "5m", "1h"] });
    const insts = await hub.listInstruments();
    hub.watch(insts.find((i) => i.symbol === "BTC/USDT")!);
    clock.t = T0 + 30_000;
    await hub.poll();
    const v = hub.getView("BTC/USDT", clock.t)!;
    expect(v.quote.bid).toBeGreaterThan(0);
    expect(v.book).toBeDefined();
    expect(v.prints!.length).toBeGreaterThan(0);
    const m1 = v.candles["1m"]!;
    expect(m1.length).toBeGreaterThan(50);
    expect(m1[m1.length - 1].ts + 60_000).toBeLessThanOrEqual(clock.t);
    expect(m1.every((c, i) => i === 0 || c.ts > m1[i - 1].ts)).toBe(true);
    clock.t += 120_000;
    await hub.poll();
    const m1b = hub.getView("BTC/USDT", clock.t)!.candles["1m"]!;
    expect(m1b.length).toBeGreaterThan(m1.length - 1);
    expect(hub.getView("NONE", clock.t)).toBeUndefined();
  });

  it("足が取れない feed は quote から組み立て、上位足は 1m から集約", async () => {
    let t = T0;
    const clock: Clock = { now: () => t };
    const feed: MarketDataFeed = {
      venue: "x",
      listInstruments: async () => [],
      fetchCandles: async (_s, tf) => { if (tf === "1m") throw new Error("no"); throw new Error("no"); },
      fetchQuote: async () => ({ ts: t, bid: 99 + (t - T0) / 1000, ask: 101 + (t - T0) / 1000 }),
    };
    const hub = new MarketHub({ feeds: [feed], clock, timeframes: ["1m", "5m"] });
    hub.watch({ symbol: "A/B", venue: "x", assetClass: "crypto", baseCurrency: "A", quoteCurrency: "B", tickSize: 1, lotSize: 1, minQty: 1, takerFeeRate: 0, makerFeeRate: 0, allowShort: false });
    for (let i = 0; i < 4; i++) { await hub.poll(); t += 30_000; }
    const v = hub.getView("A/B", t)!;
    expect(v.candles["1m"]!.length).toBe(2); // t=120s 時点で 0〜60s, 60〜120s が確定
    expect(v.candles["1m"]![0].open).toBe(100);
  });

  it("レート制限: 同一 feed への呼び出し間隔を空ける", async () => {
    const sleeps: number[] = [];
    const feed = new SyntheticFeed({ clock: mkClock(), historyMs: 3_600_000 });
    const hub = new MarketHub({ feeds: [feed], clock: mkClock(), timeframes: ["1m"], minIntervalMs: { paper: 1000 }, sleep: async (ms) => { sleeps.push(ms); } });
    hub.watch((await feed.listInstruments())[0]);
    await hub.poll();
    expect(sleeps.length).toBeGreaterThan(2);
    expect(sleeps.every((s) => s > 0 && s <= 1000 * sleeps.length)).toBe(true);
  });

  it("feed 失敗は握りつぶして lastError に残す", async () => {
    const feed: MarketDataFeed = { venue: "x", listInstruments: async () => [], fetchCandles: async () => [], fetchQuote: vi.fn(async () => { throw new Error("boom"); }) };
    const hub = new MarketHub({ feeds: [feed], timeframes: ["1m"] });
    hub.watch({ symbol: "A/B", venue: "x", assetClass: "crypto", baseCurrency: "A", quoteCurrency: "B", tickSize: 1, lotSize: 1, minQty: 1, takerFeeRate: 0, makerFeeRate: 0, allowShort: false });
    await hub.poll();
    expect(hub.lastError("A/B")).toBe("boom");
  });
});
