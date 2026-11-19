import { describe, expect, it } from "vitest";
import type { Candle, Instrument, MarketDataFeed, Quote } from "../src/core/types";
import { MarketHub } from "../src/market/hub";

const inst = (symbol: string, venue: string): Instrument => ({
  symbol, venue, assetClass: "crypto", baseCurrency: "X", quoteCurrency: "USD", tickSize: 0.01, lotSize: 0.001, minQty: 0.001,
  takerFeeRate: 0.001, makerFeeRate: 0.001, allowShort: false,
});

/** quote を呼ぶたびに gate が開くまで待つ feed */
class GatedFeed implements MarketDataFeed {
  quoteCalls = 0;
  private release?: () => void;
  blocked = false;
  constructor(readonly venue: string, private readonly price: number) {}
  async listInstruments(): Promise<Instrument[]> {
    return [];
  }
  async fetchCandles(): Promise<Candle[]> {
    return [];
  }
  async fetchQuote(): Promise<Quote> {
    this.quoteCalls++;
    if (this.blocked) await new Promise<void>((r) => (this.release = r));
    return { ts: Date.now(), bid: this.price, ask: this.price + 0.01 };
  }
  open(): void {
    this.blocked = false;
    this.release?.();
  }
}

describe("MarketHub.poll", () => {
  it("venue ごとに並列で取得し、時間上限を超えた venue は次回へ持ち越す (二重に取得しない)", async () => {
    const slow = new GatedFeed("slow", 10);
    const fast = new GatedFeed("fast", 20);
    const hub = new MarketHub({ feeds: [slow, fast], timeframes: ["1m"], withBook: false });
    hub.watch(inst("S/USD", "slow"), slow);
    hub.watch(inst("F/USD", "fast"), fast);
    slow.blocked = true;
    const t0 = Date.now();
    const r1 = await hub.poll({ timeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r1.timedOut).toEqual(["slow"]);
    expect(hub.latestQuote("F/USD")?.bid).toBe(20);
    expect(hub.latestQuote("S/USD")).toBeUndefined();
    // 取得中の venue は再度呼ばない
    const r2 = await hub.poll({ timeoutMs: 20 });
    expect(r2.timedOut).toEqual(["slow"]);
    expect(slow.quoteCalls).toBe(1);
    expect(fast.quoteCalls).toBe(2);
    slow.open();
    const r3 = await hub.poll({ timeoutMs: 1_000 });
    expect(r3.timedOut).toEqual([]);
    expect(hub.latestQuote("S/USD")?.bid).toBe(10);
  });

  it("失敗した銘柄は lastError を持ち、成功すれば消える", async () => {
    const feed = new GatedFeed("v", 5);
    const hub = new MarketHub({ feeds: [feed], timeframes: ["1m"], withBook: false });
    hub.watch(inst("A/USD", "v"), feed);
    await hub.poll();
    expect(hub.lastError("A/USD")).toBeUndefined();
    feed.fetchQuote = async () => {
      throw new Error("down");
    };
    await hub.poll();
    expect(hub.lastError("A/USD")).toBe("down");
    expect(hub.latestQuote("A/USD")?.bid).toBe(5); // 直近の気配は残る (決済判定に使う)
  });
});
