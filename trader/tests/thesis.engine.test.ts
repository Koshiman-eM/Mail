/**
 * エンジン統合 (paper): 読みの管理 (THESIS_*)。合成データの feed の気配だけを差し替えて、期限での延長・決済を確かめる。
 * 実在の取引所へは送信しない (オフライン)。
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config";
import type { Candle, Clock, Instrument, MarketDataFeed, Quote, Signal, Strategy, StrategyContext, Timeframe } from "../src/core/types";
import { buildRuntime } from "../src/engine/setup";
import type { BrokerSet } from "../src/execution/router";
import { TradeJournal } from "../src/learning/journal";
import { FakeLiveBroker } from "./helpers/fakeLiveBroker";
import { mulberry32, SyntheticFeed } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";

const MIN = 60_000;
const START = Date.UTC(2026, 0, 5);
const SYM = "BTC/USDT";

class ControlledFeed implements MarketDataFeed {
  readonly venue = "paper";
  mid?: number;
  constructor(private readonly inner: SyntheticFeed, private readonly clock: Clock) {}
  listInstruments(): Promise<Instrument[]> {
    return this.inner.listInstruments();
  }
  fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    return this.inner.fetchCandles(symbol, tf, limit, since);
  }
  async fetchQuote(symbol: string): Promise<Quote> {
    if (this.mid !== undefined && symbol === SYM) return { ts: this.clock.now(), bid: this.mid * (1 - 1e-5), ask: this.mid * (1 + 1e-5) };
    return this.inner.fetchQuote(symbol);
  }
}

/** BTC/USDT に 1 回だけ買いのシグナル (損切り −2%・利確 +5%・最大保有 120 分・読みの期限 50 分) */
function once(): Strategy {
  let fired = false;
  return {
    id: "thesis_probe", horizon: "scalp", assetClasses: ["crypto"], regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    primaryTimeframe: "1m", timeframes: ["1m"], warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.market.instrument.symbol !== SYM || ctx.position || fired) return null;
      fired = true;
      const px = ctx.market.quote.ask;
      return {
        strategyId: "thesis_probe", horizon: "scalp", symbol: SYM, direction: "long", confidence: 0.8, expectedEdgeBps: 500, entry: { type: "market" },
        stopLoss: px * 0.98, takeProfit: px * 1.05, maxHoldMs: 120 * MIN, expectedMs: 50 * MIN, reason: "test", features: {},
      };
    },
  };
}

async function runtime(
  env: Record<string, string>, store = new MemoryStore(), clock: Clock & { t: number } = { t: START, now() { return this.t; } }, strategy: Strategy = once(),
) {
  const feed = new ControlledFeed(new SyntheticFeed({ clock, seed: 3, historyMs: 2 * 86_400_000 }), clock);
  const instruments = [(await feed.listInstruments()).find((i) => i.symbol === SYM)!];
  const config = loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "USD", LIMIT_ENTRY: "false", MAX_HOLD_MINUTES: "10", ...env });
  const rt = await buildRuntime(config, {
    clock, store, intelSources: [], ai: null, rng: mulberry32(7), strategies: [strategy], markets: [{ feed, instruments }], engine: { liveAccountCacheMs: 0 },
  });
  const tickTo = async (t: number) => {
    clock.t = t;
    return rt.engine.tick(t);
  };
  return { rt, store, clock, feed, tickTo };
}

/** 建玉ができるまで進める (気配は建玉の後で差し替える) */
async function opened(w: Awaited<ReturnType<typeof runtime>>) {
  for (let k = 1; k <= 20 && w.rt.engine.positions.list().length === 0; k++) await w.tickTo(START + k * 5_000);
  const p = w.rt.engine.positions.list()[0];
  expect(p).toBeDefined();
  return p;
}

describe("エンジン (paper): 読みの管理", () => {
  it("MAX_HOLD_MINUTES で読みの期限 (expectedMs) を丸め、期限で利益が出ていれば延長 → 再起動後も延長のまま → 建値を割って trailing", async () => {
    const store = new MemoryStore();
    const clock: Clock & { t: number } = { t: START, now() { return this.t; } };
    // 再起動の後も同じ戦略 (1 回だけシグナルを出す) を使う
    const strategy = once();
    const a = await runtime({}, store, clock, strategy);
    const p = await opened(a);
    expect(a.rt.engine.positions.planOf(p.id)).toMatchObject({ maxHoldMs: 10 * MIN, expectedMs: 10 * MIN });
    a.feed.mid = p.entryPrice * 1.008;
    await a.tickTo(p.entryTs + 5 * MIN);
    let st = await a.rt.engine.status();
    expect(st.thesis).toMatchObject({ enabled: true, extendMult: 4 });
    expect(st.positions[0].thesis).toMatchObject({ deadlineTs: p.entryTs + 10 * MIN, state: "watching" });
    expect(st.positions[0].thesis!.remainingMin).toBeCloseTo(5, 6);
    expect(st.positions[0].thesis!.netR).toBeGreaterThan(0.1);
    await a.tickTo(p.entryTs + 10 * MIN);
    expect(a.rt.engine.positions.list()).toHaveLength(1);
    expect(a.rt.engine.positions.planOf(p.id).thesis?.extendedAt).toBe(p.entryTs + 10 * MIN);
    expect(store.listAudit({ type: "thesis.extended" })).toHaveLength(1);
    await a.rt.engine.stop();
    a.rt.close();

    // 再起動: 同じ store から作り直しても延長の状態を引き継ぐ
    const b = await runtime({}, store, clock, strategy);
    b.feed.mid = p.entryPrice * 1.008;
    await b.tickTo(p.entryTs + 20 * MIN);
    expect(b.rt.engine.positions.list()).toHaveLength(1);
    st = await b.rt.engine.status();
    expect(st.positions[0].thesis).toMatchObject({ state: "extended", capTs: p.entryTs + 40 * MIN });
    expect(st.positions[0].stop).toBeGreaterThan(p.entryPrice);
    // 建値 (手数料込み) を割る
    b.feed.mid = p.entryPrice * 0.999;
    await b.tickTo(p.entryTs + 21 * MIN);
    expect(b.rt.engine.positions.list()).toHaveLength(0);
    const [t] = store.listTrades();
    expect(t).toMatchObject({ exitReason: "trailing", thesisOutcome: "extended", thesisExpectedMs: 10 * MIN, thesisExtendedAt: p.entryTs + 10 * MIN });
    await b.rt.engine.stop();
    b.rt.close();
  }, 60_000);

  it("期限で利益が出ていなければ thesis_timeout", async () => {
    const w = await runtime({});
    const p = await opened(w);
    w.feed.mid = p.entryPrice;
    await w.tickTo(p.entryTs + 9 * MIN);
    expect(w.rt.engine.positions.list()).toHaveLength(1);
    await w.tickTo(p.entryTs + 10 * MIN);
    expect(w.rt.engine.positions.list()).toHaveLength(0);
    expect(w.store.listTrades()[0]).toMatchObject({ exitReason: "thesis_timeout", thesisOutcome: "timeout" });
    await w.rt.engine.stop();
    w.rt.close();
  }, 60_000);

  it("THESIS_EXIT=false なら従来どおり最大保有で time (利益が出ていても延長しない)", async () => {
    const w = await runtime({ THESIS_EXIT: "false" });
    const p = await opened(w);
    w.feed.mid = p.entryPrice * 1.008;
    await w.tickTo(p.entryTs + 10 * MIN);
    expect(w.rt.engine.positions.list()).toHaveLength(0);
    const [t] = w.store.listTrades();
    expect(t.exitReason).toBe("time");
    expect(t.thesisOutcome).toBeUndefined();
    expect((await w.rt.engine.status()).thesis?.enabled).toBe(false);
    await w.rt.engine.stop();
    w.rt.close();
  }, 60_000);
});

describe("エンジン (live・偽のブローカー): 読みの管理の起動時の警告", () => {
  async function liveWith(env: Record<string, string>) {
    const clock: Clock & { t: number } = { t: START, now() { return this.t; } };
    const store = new MemoryStore();
    // 以前の起動で建てた建玉 (最大保有のある決済計画つき)
    const journal = new TradeJournal({ store, mode: "live" });
    const p = journal.open({
      mode: "live", symbol: SYM, venue: "paper", assetClass: "crypto", strategyId: "s", horizon: "scalp", direction: "long", qty: 0.01,
      entryTs: START - 5 * MIN, entryPrice: 60_000, intendedEntryPrice: 60_000, initialStop: 59_000,
      entryContext: {
        regime: { label: "range", trend: 0, trendStrength: 0, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
        confidence: 0.7, expectedEdgeBps: 50, costBps: 10, params: {}, features: {}, riskMultiplier: 1, reason: "t",
      },
    });
    store.kvSet("positions:exitPlans:live", { [p.id]: { maxHoldMs: 30 * MIN } });
    const live = new FakeLiveBroker("paper");
    live.positions.set(SYM, 0.01);
    const feed = new ControlledFeed(new SyntheticFeed({ clock, seed: 3, historyMs: 2 * 86_400_000 }), clock);
    const instruments = [(await feed.listInstruments()).find((i) => i.symbol === SYM)!];
    const brokerSet: BrokerSet = { mode: "live", brokers: new Map([[live.venue, live]]), brokerFor: () => live };
    const config = loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "USD", LIMIT_ENTRY: "false", ...env });
    const rt = await buildRuntime(config, {
      clock, store, intelSources: [], ai: null, rng: mulberry32(7), strategies: [], markets: [{ feed, instruments }], brokerSet,
      engine: { liveAccountCacheMs: 0 },
    });
    live.quoteOf = (s) => rt.hub.latestQuote(s);
    await rt.engine.init();
    return { rt, store, id: p.id };
  }

  it("THESIS_EXIT が有効で決済計画つきの建玉があれば、監査ログ thesis.enabled_live に設定と建玉を残す", async () => {
    const { rt, store, id } = await liveWith({});
    const a = store.listAudit({ type: "thesis.enabled_live" });
    expect(a).toHaveLength(1);
    expect(a[0].data).toMatchObject({ settings: { enabled: true, minR: 0.1, extendMult: 4 }, positions: [{ tradeId: id, symbol: SYM }] });
    await rt.engine.stop();
    rt.close();
  }, 60_000);

  it("THESIS_EXIT=false なら警告しない", async () => {
    const { rt, store } = await liveWith({ THESIS_EXIT: "false" });
    expect(store.listAudit({ type: "thesis.enabled_live" })).toHaveLength(0);
    await rt.engine.stop();
    rt.close();
  }, 60_000);
});
