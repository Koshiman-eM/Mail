/**
 * live 経路の安全性 (受付のみ・状態不明・一部約定・kill switch・口座照会の失敗・外部での決済・paper との分離)。
 * 実口座アダプターは生成せず、Broker を実装した偽のブローカーを brokerSet に注入する。
 */
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/core/config";
import type { Candle, Clock, Instrument, MarketDataFeed, Quote, Signal, Strategy, StrategyContext, Timeframe } from "../src/core/types";
import { buildRuntime, type RuntimeOptions } from "../src/engine/setup";
import type { BrokerSet } from "../src/execution/router";
import { TradeJournal } from "../src/learning/journal";
import { mulberry32, SyntheticFeed } from "../src/market/feeds/synthetic";
import { RiskManager } from "../src/risk/manager";
import { MemoryStore } from "../src/storage/memory";
import { FakeLiveBroker } from "./helpers/fakeLiveBroker";

const MIN = 60_000;
const START = Date.UTC(2026, 0, 5);
const SYM = "BTC/USDT";

const mkClock = (t = START): Clock & { t: number } => ({ t, now() { return this.t; } });

/** 保有していなければ常にロング (損切り 2%)。保有中は何もしない */
function alwaysLong(): Strategy {
  return {
    id: "always_long",
    horizon: "scalp",
    assetClasses: ["crypto"],
    regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    primaryTimeframe: "1m",
    timeframes: ["1m", "1h"],
    warmup: 1,
    defaultParams: { stopAtr: 1 },
    paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.position) return null;
      const px = ctx.market.quote.ask;
      return {
        strategyId: "always_long", horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: "long", confidence: 0.8,
        expectedEdgeBps: 200, entry: { type: "market" }, stopLoss: px * 0.98, maxHoldMs: 60 * MIN, reason: "test", features: { x: 1 },
      };
    },
  };
}

/** 合成フィードの気配を銘柄ごとに上書き・失敗させられる feed */
class ControlledFeed implements MarketDataFeed {
  readonly venue = "paper";
  readonly override = new Map<string, { bid: number; ask: number }>();
  readonly failQuote = new Set<string>();
  constructor(private readonly inner: SyntheticFeed, private readonly clock: Clock) {}
  listInstruments(): Promise<Instrument[]> {
    return this.inner.listInstruments();
  }
  fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    return this.inner.fetchCandles(symbol, tf, limit, since);
  }
  async fetchQuote(symbol: string): Promise<Quote> {
    if (this.failQuote.has(symbol)) throw new Error("quote unavailable (fake)");
    const o = this.override.get(symbol);
    return o ? { ts: this.clock.now(), ...o } : this.inner.fetchQuote(symbol);
  }
}

async function liveRuntime(o: { store?: MemoryStore; broker?: FakeLiveBroker; engine?: RuntimeOptions["engine"] } = {}) {
  const clock = mkClock();
  const store = o.store ?? new MemoryStore();
  const feed = new ControlledFeed(new SyntheticFeed({ clock, seed: 3, historyMs: 2 * 86_400_000 }), clock);
  const instruments = (await feed.listInstruments()).filter((i) => i.symbol === SYM);
  const broker = o.broker ?? new FakeLiveBroker("paper");
  const brokerSet: BrokerSet = {
    mode: "live",
    brokers: new Map([[broker.venue, broker]]),
    brokerFor(symbol) {
      if (symbol !== SYM) throw new Error(`未知の銘柄: ${symbol}`);
      return broker;
    },
  };
  const rt = await buildRuntime(loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "USD" }), {
    clock, store, intelSources: [], ai: null, rng: mulberry32(7), strategies: [alwaysLong()], markets: [{ feed, instruments }], brokerSet,
    engine: { liveAccountCacheMs: 0, ...(o.engine ?? {}) },
  });
  broker.quoteOf = (s) => rt.hub.latestQuote(s);
  const tick = async (dt = 5_000) => {
    clock.t += dt;
    return rt.engine.tick(clock.t);
  };
  return { rt, clock, store, feed, broker, tick };
}

/** 現在値の下で損切りに当たる気配に固定する */
function hitStop(feed: ControlledFeed, stop: number) {
  feed.override.set(SYM, { bid: stop * 0.97, ask: stop * 0.97 + 1 });
}

function skipCounts(store: MemoryStore): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of store.listAudit({ type: "engine.skip_summary" })) {
    for (const [k, v] of Object.entries((a.data as { reasons: Record<string, { count: number }> }).reasons)) out[k] = (out[k] ?? 0) + v.count;
  }
  return out;
}

describe("live: 受付済み・未約定の注文 (保留中)", () => {
  it("エントリーは照会で約定してから journal に登録し、決済は約定するまで再送しない", async () => {
    const { rt, clock, store, feed, broker, tick } = await liveRuntime();
    const onClosed = vi.spyOn(rt.learning, "onTradeClosed");
    await rt.engine.tick(clock.t);
    expect(rt.engine.mode).toBe("live");
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].protectiveStop).toBeGreaterThan(0);
    // 受付のみ: まだ追跡しない・保留中
    expect(rt.engine.positions.list()).toHaveLength(0);
    expect(rt.engine.positions.hasPending(SYM)).toBe(true);
    await tick();
    expect(broker.placed).toHaveLength(1); // 再送しない

    // 取引所側で約定 → 次の照会で journal に反映
    const entryId = broker.placed[0].clientId;
    broker.fill(entryId);
    await tick();
    const pos = rt.engine.positions.get(SYM)!;
    expect(pos).toBeDefined();
    expect(pos.qty).toBeCloseTo(Number(broker.placed[0].qty), 9);
    expect(pos.mode).toBe("live");
    expect(rt.engine.positions.hasPending(SYM)).toBe(false);
    expect(store.listAudit({ type: "engine.entry" })[0].data).toMatchObject({ symbol: SYM, delayed: true });

    // 損切り: 受付のみ → 毎ティック再送しない (建玉が空売りへ積み上がらない)
    hitStop(feed, pos.initialStop);
    await tick();
    expect(broker.placed).toHaveLength(2);
    const exitReq = broker.placed[1];
    expect(exitReq).toMatchObject({ side: "sell", reduceOnly: true });
    for (let i = 0; i < 3; i++) await tick();
    expect(broker.placed).toHaveLength(2);
    expect(rt.engine.positions.get(SYM)?.qty).toBeCloseTo(pos.qty, 9);
    expect(broker.positions.get(SYM)).toBeCloseTo(pos.qty, 9);

    // 照会で約定 → journal で決済・学習へ
    broker.fill(exitReq.clientId);
    await tick();
    expect(rt.engine.positions.list()).toHaveLength(0);
    const trades = store.listTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ exitReason: "stop", mode: "live" });
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(broker.positions.get(SYM)).toBeCloseTo(0, 9);
  });

  it("発注が例外 (状態不明) なら再送せず照会を続け、不明が続いたら kill switch を発動する", async () => {
    const { rt, clock, store, broker, tick } = await liveRuntime();
    broker.placeMode = "throw";
    broker.getOrderMode = "missing";
    await rt.engine.tick(clock.t);
    expect(broker.placed).toHaveLength(1);
    expect(rt.engine.positions.hasPending(SYM)).toBe(true);
    expect(rt.risk.state().killSwitch).toBeUndefined();
    for (let i = 0; i < 3; i++) await tick();
    expect(rt.risk.state().killSwitch).toBeUndefined();
    await tick(); // 照会の不明が 4 回 + 発注時の 1 回 = 5 回
    expect(broker.placed).toHaveLength(1);
    expect(rt.risk.state().killSwitch?.reason).toMatch(/注文状態不明/);
    expect(store.listAudit({ type: "engine.order_unknown_escalated" })).toHaveLength(1);
    // kill switch 中も保留中の注文は残り、照会を続ける (新規は出さない)
    const calls = broker.getOrderCalls.length;
    await tick(MIN);
    expect(broker.placed).toHaveLength(1);
    expect(broker.getOrderCalls.length).toBeGreaterThan(calls);
    expect(rt.engine.positions.pendingOrders()[0]).toMatchObject({ symbol: SYM, kind: "entry", escalated: true });
    // 再起動しても保留中の注文は残る (mode 別のキー)
    expect(store.kvGet<unknown[]>("orders:pending:live")).toHaveLength(1);
    expect(store.kvGet("orders:pending:paper")).toBeUndefined();
  });

  it("成行が 30 秒を過ぎても約定しなければ取消してから再照会する (約定なしなら追跡しない)", async () => {
    const { rt, clock, store, broker, tick } = await liveRuntime();
    await rt.engine.tick(clock.t);
    for (let i = 0; i < 5; i++) await tick();
    expect(broker.canceled).toHaveLength(0);
    await tick(); // 30 秒経過
    expect(broker.canceled).toEqual(["fake-1"]);
    expect(rt.engine.positions.hasPending(SYM)).toBe(false);
    expect(rt.engine.positions.list()).toHaveLength(0);
    expect(store.listAudit({ type: "engine.order_cancel" })).toHaveLength(1);
    expect(store.listAudit({ type: "engine.order_rejected" })[0].data).toMatchObject({ symbol: SYM, status: "canceled" });
  });

  it("決済の一部約定: 約定分だけ記録して残りを追跡し、次のティックで残りを決済する", async () => {
    const { rt, store, feed, broker, tick } = await liveRuntime();
    broker.placeMode = "fill";
    await rt.engine.tick(START);
    const pos = rt.engine.positions.get(SYM)!;
    expect(pos).toBeDefined();
    broker.placeMode = "accept";
    hitStop(feed, pos.initialStop);
    await tick();
    const exitReq = broker.last();
    expect(exitReq.reduceOnly).toBe(true);
    // 半分だけ約定して未確定のまま
    const half = String(Number(exitReq.qty) / 2);
    broker.fill(exitReq.clientId, { qty: half, status: "partially_filled" });
    await tick();
    expect(rt.engine.positions.get(SYM)?.qty).toBeCloseTo(pos.qty, 9); // 確定まで反映しない
    // 30 秒経過 → 取消 → 一部約定で確定
    for (let i = 0; i < 8 && store.listTrades().length === 0; i++) await tick();
    expect(broker.canceled.length).toBeGreaterThanOrEqual(1);
    const trades = store.listTrades();
    expect(trades.length).toBeGreaterThanOrEqual(1);
    expect(trades[0].id).toBe(`${pos.id}#1`);
    expect(trades[0].qty).toBeCloseTo(Number(half), 9);
    expect(trades[0].exitReason).toBe("stop");
    // 残りは次のティックで決済 (同じ理由)
    broker.placeMode = "fill";
    await tick();
    expect(rt.engine.positions.list()).toHaveLength(0);
    const all = store.listTrades();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.exitReason)).toEqual(["stop", "stop"]);
    expect(all.reduce((s, t) => s + t.qty, 0)).toBeCloseTo(pos.qty, 9);
    expect(broker.positions.get(SYM)).toBeCloseTo(0, 9);
  });

  it("約定価格が不正 (0) の約定は状態不明として扱い、journal に登録しない", async () => {
    const { rt, store, broker, tick } = await liveRuntime();
    await rt.engine.tick(START);
    broker.fill(broker.placed[0].clientId, { price: 0 });
    await tick();
    expect(rt.engine.positions.list()).toHaveLength(0);
    expect(rt.engine.positions.pendingOrders()[0]).toMatchObject({ unknownCount: 1 });
    expect(store.listAudit({ type: "engine.order_unknown" })[0].data.error).toMatch(/約定価格が不正/);
  });
});

describe("live: kill switch・口座照会の失敗・外部での決済", () => {
  it("kill switch 中は残っている建玉の決済を再試行する (30 秒間隔)", async () => {
    const { rt, store, feed, broker, tick } = await liveRuntime();
    broker.placeMode = "fill";
    await rt.engine.tick(START);
    expect(rt.engine.positions.list()).toHaveLength(1);
    const q = rt.hub.latestQuote(SYM)!;
    feed.override.set(SYM, { bid: q.bid, ask: q.ask });
    broker.placeMode = "reject";
    rt.risk.trip("テスト", START);
    const r = await tick();
    expect(r.killSwitchTripped).toBe(false); // 前のティックの後に作動していた
    expect(broker.placed).toHaveLength(2); // 初回の決済 (拒否)
    expect(rt.engine.positions.list()).toHaveLength(1);
    await tick();
    expect(broker.placed).toHaveLength(2); // 30 秒以内は再試行しない
    broker.placeMode = "fill";
    await tick(30_000);
    expect(broker.placed).toHaveLength(3);
    expect(rt.engine.positions.list()).toHaveLength(0);
    expect(store.listTrades().map((t) => t.exitReason)).toEqual(["kill_switch"]);
    expect(store.listAudit({ type: "engine.kill_switch_close" }).map((a) => a.data.attempt)).toEqual(["initial", "retry"]);
    // 以後は新規エントリーしない
    await tick(MIN);
    expect(broker.placed).toHaveLength(3);
  });

  it("口座照会が失敗していても損切りは動き、失敗が続けば新規エントリーを止める", async () => {
    const { rt, store, feed, broker, tick } = await liveRuntime();
    broker.placeMode = "fill";
    await rt.engine.tick(START);
    const pos = rt.engine.positions.get(SYM)!;
    broker.failAccount = true;
    hitStop(feed, pos.initialStop);
    await tick();
    expect(rt.engine.positions.list()).toHaveLength(0);
    expect(store.listTrades()[0]).toMatchObject({ exitReason: "stop" });
    // 前回値で評価するので kill switch は誤作動しない
    expect(rt.risk.state().killSwitch).toBeUndefined();
    for (let i = 0; i < 3; i++) await tick();
    expect(store.listAudit({ type: "engine.account_degraded" })).toHaveLength(1);
    const placed = broker.placed.length;
    feed.override.delete(SYM);
    await tick(MIN); // 新しい 1 分足でも入らない
    expect(broker.placed).toHaveLength(placed);
    await rt.engine.stop();
    expect(skipCounts(store).account_unavailable).toBeGreaterThan(0);
  });

  it("口座情報が一度も取れなければ停止判定を保留し (誤った kill switch を出さない)、新規エントリーもしない", async () => {
    const { rt, store, broker } = await liveRuntime();
    broker.failAccount = true;
    await rt.engine.tick(START);
    expect(broker.placed).toHaveLength(0);
    expect(rt.risk.state()).toMatchObject({ peakEquity: 0 });
    expect(rt.risk.state().killSwitch).toBeUndefined();
    expect(store.listEquity()).toHaveLength(0);
  });

  it("外部で決済された建玉は定期の突き合わせで manual として外す (学習には渡さない)", async () => {
    const { rt, clock, store, broker } = await liveRuntime();
    broker.placeMode = "fill";
    await rt.engine.tick(START);
    const pos = rt.engine.positions.get(SYM)!;
    const onClosed = vi.spyOn(rt.learning, "onTradeClosed");
    broker.placeMode = "reject"; // 外した後に新規が約定しないように
    broker.positions.delete(SYM); // 利用者が取引所で手動決済
    clock.t = START + 4 * MIN;
    await rt.engine.tick(clock.t);
    expect(rt.engine.positions.list()).toHaveLength(1); // 5 分ごと
    clock.t = START + 5 * MIN;
    await rt.engine.tick(clock.t);
    // live は 1 回の不一致では外さない (照会の一時的な欠落と区別できないため)
    expect(rt.engine.positions.list()).toHaveLength(1);
    expect(store.listAudit({ type: "reconcile.mismatch" })).toHaveLength(1);
    clock.t = START + 10 * MIN;
    await rt.engine.tick(clock.t);
    expect(rt.engine.positions.list()).toHaveLength(0);
    const trades = store.listTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ id: pos.id, exitReason: "manual" });
    expect(trades[0].exitPrice).toBeCloseTo((rt.hub.latestQuote(SYM)!.bid + rt.hub.latestQuote(SYM)!.ask) / 2, 6);
    expect(store.listAudit({ type: "reconcile.external_close" })[0].data).toMatchObject({ symbol: SYM, phase: "periodic" });
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("突き合わせで一度だけ建玉が欠けても (照会の欠落)、次に見えれば追跡を続ける", async () => {
    const { rt, clock, store, broker } = await liveRuntime();
    broker.placeMode = "fill";
    await rt.engine.tick(START);
    const qty = broker.positions.get(SYM)!;
    broker.placeMode = "reject";
    broker.positions.delete(SYM); // デリバティブの照会失敗などで一時的に返らない
    clock.t = START + 5 * MIN;
    await rt.engine.tick(clock.t);
    broker.positions.set(SYM, qty);
    clock.t = START + 10 * MIN;
    await rt.engine.tick(clock.t);
    broker.positions.delete(SYM);
    clock.t = START + 15 * MIN;
    await rt.engine.tick(clock.t); // 連続ではないので外さない
    expect(rt.engine.positions.list()).toHaveLength(1);
    expect(store.listTrades()).toHaveLength(0);
  });

  it("取引所側のストップ等で建玉が先に無くなった場合、決済の拒否を無限に繰り返さず追跡を整理する", async () => {
    const { rt, store, feed, broker, tick } = await liveRuntime();
    broker.placeMode = "fill";
    await rt.engine.tick(START);
    const pos = rt.engine.positions.get(SYM)!;
    broker.positions.delete(SYM); // 取引所側の SL が発動済み
    hitStop(feed, pos.initialStop);
    await tick();
    expect(broker.placed).toHaveLength(2);
    expect(rt.engine.positions.list()).toHaveLength(1); // 1 回目は確認中
    await tick();
    expect(broker.placed).toHaveLength(3);
    expect(rt.engine.positions.list()).toHaveLength(0);
    expect(store.listTrades()[0]).toMatchObject({ id: pos.id, exitReason: "manual" });
    expect(store.listAudit({ type: "reconcile.external_close" })[0].data).toMatchObject({ phase: "exit_rejected" });
    for (let i = 0; i < 5; i++) await tick();
    expect(broker.placed).toHaveLength(3);
  });

  it("保有数量で減らされた決済 (reduceOnly) の残りは、建玉が無いことを確認して整理する", async () => {
    const { rt, store, feed, broker, tick } = await liveRuntime();
    broker.placeMode = "fill";
    await rt.engine.tick(START);
    const pos = rt.engine.positions.get(SYM)!;
    broker.positions.set(SYM, pos.qty * 0.6); // 外部で 4 割を決済済み
    hitStop(feed, pos.initialStop);
    await tick(); // 保有分 (6 割) だけ約定 → 一部決済
    let trades = store.listTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0].qty).toBeCloseTo(pos.qty * 0.6, 9);
    expect(rt.engine.positions.get(SYM)!.qty).toBeCloseTo(pos.qty * 0.4, 9);
    // 残りの決済は拒否される → 2 回の確認で manual として整理し、以後は発注しない
    for (let i = 0; i < 4; i++) await tick(10_000);
    expect(rt.engine.positions.list()).toHaveLength(0);
    trades = store.listTrades();
    expect(trades.map((t) => t.exitReason)).toEqual(["stop", "manual"]);
    const exitsPlaced = () => broker.placed.filter((r) => r.reduceOnly).length;
    const n = exitsPlaced();
    for (let i = 0; i < 3; i++) await tick();
    expect(exitsPlaced()).toBe(n);
  });

  it("poll に失敗した銘柄は新規エントリーを評価しない", async () => {
    const { rt, store, feed, broker, tick } = await liveRuntime();
    broker.placeMode = "reject";
    await rt.engine.tick(START);
    expect(broker.placed).toHaveLength(1);
    feed.failQuote.add(SYM);
    await tick(MIN);
    await tick(MIN);
    expect(rt.hub.lastError(SYM)).toMatch(/quote unavailable/);
    expect(broker.placed).toHaveLength(1);
    await rt.engine.stop();
    expect(skipCounts(store).poll_failed).toBeGreaterThan(0);
  });
});

describe("paper と live の分離", () => {
  it("paper の追跡ポジション・リスク状態は live で読み込まず、利用者の建玉を売らない", async () => {
    const store = new MemoryStore();
    // paper で BTC / ETH を保有 (評価額 100 万 JPY 基準のリスク状態)
    const paperClock = mkClock();
    const paper = await buildRuntime(loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY" }), {
      clock: paperClock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, rng: mulberry32(7), strategies: [alwaysLong()],
    });
    await paper.engine.tick(START);
    await paper.engine.stop();
    expect(paper.engine.positions.list().map((p) => p.symbol).sort()).toEqual(["BTC/USDT", "ETH/USDT"]);
    const paperPeak = paper.risk.state().peakEquity;
    expect(paperPeak).toBeGreaterThan(900_000);

    // 同じ DB で live (評価額 1,000 USD、利用者自身の BTC 0.5)
    const broker = new FakeLiveBroker("paper");
    broker.equity = 1_000;
    broker.positions.set(SYM, 0.5);
    broker.placeMode = "fill";
    const { rt, store: s2 } = await liveRuntime({ store, broker });
    expect(s2).toBe(store);
    expect(rt.engine.positions.list()).toHaveLength(0);
    expect(rt.risk.state().peakEquity).toBe(0);
    await rt.engine.tick(START);
    expect(rt.engine.positions.list()).toHaveLength(0);
    expect(rt.risk.state().killSwitch).toBeUndefined();
    expect(rt.risk.state().peakEquity).toBe(1_000); // 初回は現在の評価額で初期化
    expect(broker.placed).toHaveLength(0); // 利用者の BTC を売らない・追跡外の建玉がある銘柄には入らない
    await rt.engine.stop();
    expect(skipCounts(store).untracked_position).toBeGreaterThan(0);
    // paper 側の状態はそのまま
    expect(new TradeJournal({ store, mode: "paper" }).list()).toHaveLength(2);
    expect(new RiskManager(paper.config.risk, store, { mode: "paper" }).state().peakEquity).toBe(paperPeak);
  });
});
