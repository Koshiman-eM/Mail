/**
 * live 経路の安全性 (受付のみ・状態不明・一部約定・kill switch・口座照会の失敗・外部での決済・paper との分離)。
 * 実口座アダプターは生成せず、Broker を実装した偽のブローカーを brokerSet に注入する。
 */
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/core/config";
import type { Candle, Clock, Instrument, MarketDataFeed, Quote, Signal, Strategy, StrategyContext, Timeframe } from "../src/core/types";
import { requestOrderResolve } from "../src/cli";
import { buildRuntime, type RuntimeOptions } from "../src/engine/setup";
import { requestResolve } from "../src/engine/orders";
import type { BrokerSet } from "../src/execution/router";
import { TradeJournal } from "../src/learning/journal";
import { mulberry32, SyntheticFeed } from "../src/market/feeds/synthetic";
import { RiskManager } from "../src/risk/manager";
import { peekResumeRequest, requestResume } from "../src/risk/resumeRequest";
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

/** 合成フィードの気配を銘柄ごとに上書き・失敗・遅延させられる feed */
class ControlledFeed implements MarketDataFeed {
  readonly venue = "paper";
  readonly override = new Map<string, { bid: number; ask: number }>();
  readonly failQuote = new Set<string>();
  /** 気配の時刻をこの分だけ古くする */
  readonly quoteAgeMs = new Map<string, number>();
  /** 気配の取得を遅らせる (ms, 実時間) */
  quoteDelayMs = 0;
  constructor(private readonly inner: SyntheticFeed, private readonly clock: Clock) {}
  listInstruments(): Promise<Instrument[]> {
    return this.inner.listInstruments();
  }
  fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    return this.inner.fetchCandles(symbol, tf, limit, since);
  }
  async fetchQuote(symbol: string): Promise<Quote> {
    if (this.quoteDelayMs > 0) await new Promise((r) => setTimeout(r, this.quoteDelayMs));
    if (this.failQuote.has(symbol)) throw new Error("quote unavailable (fake)");
    const o = this.override.get(symbol);
    const q = o ? { ts: this.clock.now(), ...o } : await this.inner.fetchQuote(symbol);
    return { ...q, ts: q.ts - (this.quoteAgeMs.get(symbol) ?? 0) };
  }
}

async function liveRuntime(
  o: {
    store?: MemoryStore;
    broker?: FakeLiveBroker;
    /** 銘柄ごとの発注先 (省略した銘柄は broker) */
    brokers?: Record<string, FakeLiveBroker>;
    symbols?: string[];
    env?: Record<string, string>;
    engine?: RuntimeOptions["engine"];
  } = {},
) {
  const clock = mkClock();
  const store = o.store ?? new MemoryStore();
  const feed = new ControlledFeed(new SyntheticFeed({ clock, seed: 3, historyMs: 2 * 86_400_000 }), clock);
  const symbols = o.symbols ?? [SYM];
  const all = await feed.listInstruments();
  const instruments = symbols.map((s) => all.find((i) => i.symbol === s)!);
  const broker = o.broker ?? new FakeLiveBroker("paper");
  const brokerOf = (s: string) => o.brokers?.[s] ?? broker;
  const unique = [...new Set(symbols.map(brokerOf))];
  const brokerSet: BrokerSet = {
    mode: "live",
    brokers: new Map(unique.map((b) => [b.venue, b])),
    brokerFor(symbol) {
      if (!symbols.includes(symbol)) throw new Error(`未知の銘柄: ${symbol}`);
      return brokerOf(symbol);
    },
  };
  const config = loadConfig({ NODE_ENV: "test", LIMIT_ENTRY: "false", LIMIT_TAKE_PROFIT: "false", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "USD", ...(o.env ?? {}) });
  const rt = await buildRuntime(config, {
    clock, store, intelSources: [], ai: null, rng: mulberry32(7), strategies: [alwaysLong()], markets: [{ feed, instruments }], brokerSet,
    engine: { liveAccountCacheMs: 0, ...(o.engine ?? {}) },
  });
  for (const b of unique) b.quoteOf = (s) => rt.hub.latestQuote(s);
  const tick = async (dt = 5_000) => {
    clock.t += dt;
    return rt.engine.tick(clock.t);
  };
  return { rt, clock, store, feed, broker, tick, config };
}

/** 現在値の下で損切りに当たる気配に固定する */
function hitStop(feed: ControlledFeed, stop: number, symbol = SYM) {
  feed.override.set(symbol, { bid: stop * 0.97, ask: stop * 0.97 + 1 });
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

  it("発注が例外 (状態不明) なら再送せず照会を続け、不明が続いても kill switch は発動せず、新規エントリーだけを止めて建玉で確定させる", async () => {
    const { rt, clock, store, broker, tick } = await liveRuntime();
    broker.placeMode = "throw";
    broker.getOrderMode = "missing";
    await rt.engine.tick(clock.t);
    expect(broker.placed).toHaveLength(1);
    expect(rt.engine.positions.hasPending(SYM)).toBe(true);
    for (let i = 0; i < 3; i++) await tick();
    expect(store.listAudit({ type: "order.unknown_escalated" })).toHaveLength(0);
    await tick(); // 照会の不明が 4 回 + 発注時の 1 回 = 5 回
    expect(broker.placed).toHaveLength(1);
    expect(rt.risk.state().killSwitch).toBeUndefined();
    expect(store.listAudit({ type: "order.unknown_escalated" })).toHaveLength(1);
    expect(store.listAudit({ type: "engine.entries_paused" })).toHaveLength(1);
    expect(rt.engine.positions.pendingOrders()[0]).toMatchObject({ symbol: SYM, kind: "entry", escalated: true });
    expect((await rt.engine.status()).risk.entriesPaused?.orders).toEqual([broker.placed[0].clientId]);
    expect((await rt.engine.status()).pendingOrders[0]).toMatchObject({ escalated: true });
    // orderId が無いので hint (発注時刻・売買方向・数量) を渡して照会している
    expect(broker.getOrderHints.at(-1)).toEqual({ createdAt: START, side: "buy", qty: broker.placed[0].qty });
    // 再起動しても保留中の注文は残る (mode 別のキー)
    expect(store.kvGet<unknown[]>("orders:pending:live")).toHaveLength(1);
    expect(store.kvGet("orders:pending:paper")).toBeUndefined();
    // 建玉が増えていないことを 30 秒空けて 2 回確認したら「約定なし」で外し、新規エントリーを自動で再開する
    await tick(30_000);
    expect(rt.engine.positions.hasPending(SYM)).toBe(false);
    expect(rt.engine.positions.list()).toHaveLength(0);
    expect(store.listAudit({ type: "order.resolved_by_position" })[0].data).toMatchObject({ kind: "entry", result: "none" });
    expect(store.listAudit({ type: "engine.entries_resumed" })).toHaveLength(1);
    expect(store.listAudit({ type: "order.unknown_escalated" })).toHaveLength(1);
    broker.placeMode = "reject";
    await tick(MIN); // 新しい 1 分足で新規エントリー
    expect(broker.placed).toHaveLength(2);
    expect(rt.risk.state().killSwitch).toBeUndefined();
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

  it("決済の一部約定: 約定分を累計して残りを追跡し、次のティックで残りを決済する (TradeRecord と学習は 1 回だけ)", async () => {
    const { rt, store, feed, broker, tick } = await liveRuntime();
    broker.placeMode = "fill";
    await rt.engine.tick(START);
    const pos = rt.engine.positions.get(SYM)!;
    const onClosed = vi.spyOn(rt.learning, "onTradeClosed");
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
    // 30 秒経過 → 取消 → 一部約定で確定 (ポジションに累計し、TradeRecord はまだ作らない)
    for (let i = 0; i < 8 && rt.engine.positions.get(SYM)!.qty > pos.qty - 1e-12; i++) await tick();
    expect(broker.canceled.length).toBeGreaterThanOrEqual(1);
    expect(rt.engine.positions.get(SYM)!.qty).toBeCloseTo(pos.qty - Number(half), 9);
    expect(rt.engine.positions.get(SYM)!.exitedQty).toBe(half);
    expect(store.listTrades()).toHaveLength(0);
    expect(onClosed).not.toHaveBeenCalled();
    expect(store.listAudit({ type: "engine.exit" })[0].data).toMatchObject({ partial: true, tradeId: pos.id });
    // 残りは次のティックで決済 (同じ理由) → 元の数量・加重平均の決済価格で 1 件
    broker.placeMode = "fill";
    await tick();
    expect(rt.engine.positions.list()).toHaveLength(0);
    const all = store.listTrades();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: pos.id, exitReason: "stop" });
    expect(all[0].qty).toBeCloseTo(pos.qty, 9);
    expect(onClosed).toHaveBeenCalledTimes(1);
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
    expect(rt.engine.positions.list()).toHaveLength(1); // 建玉の確認はその場で待たずに次のティックへ
    const calls = broker.getPositionsCalls;
    await tick();
    expect(broker.getPositionsCalls).toBeGreaterThan(calls);
    expect(broker.placed).toHaveLength(3);
    expect(rt.engine.positions.list()).toHaveLength(1); // 1 回目は確認中
    await tick();
    expect(broker.placed).toHaveLength(3); // 再試行待ち
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
    const onClosed = vi.spyOn(rt.learning, "onTradeClosed");
    broker.positions.set(SYM, pos.qty * 0.6); // 外部で 4 割を決済済み
    hitStop(feed, pos.initialStop);
    await tick(); // 保有分 (6 割) だけ約定 → 一部決済 (累計)
    expect(store.listTrades()).toHaveLength(0);
    expect(rt.engine.positions.get(SYM)!.qty).toBeCloseTo(pos.qty * 0.4, 9);
    // 残りの決済は拒否される → 2 回の確認で manual として整理し、以後は発注しない
    for (let i = 0; i < 4; i++) await tick(10_000);
    expect(rt.engine.positions.list()).toHaveLength(0);
    const trades = store.listTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ id: pos.id, exitReason: "manual" });
    expect(trades[0].qty).toBeCloseTo(pos.qty, 9); // 元の数量で 1 件
    expect(onClosed).not.toHaveBeenCalled(); // 最後の決済が manual なので学習には渡さない
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
    // PEPE/USDT は crypto なので除く (この試験は BTC・ETH の 2 銘柄の建玉を見る)
    const paper = await buildRuntime(loadConfig({ NODE_ENV: "test", LIMIT_ENTRY: "false", LIMIT_TAKE_PROFIT: "false", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY", WATCHLIST: "synthetic|BTC/USDT,synthetic|ETH/USDT,synthetic|USD/JPY,synthetic|AAPL" }), {
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

const ETH = "ETH/USDT";
/** 実時間で少し待つ (並列処理・締め切りの試験用) */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("live: 状態不明の注文 (kill switch を発動せず、建玉・手動で確定させる)", () => {
  it("決済の発注が例外で不明が続き escalated になっても kill switch は発動しない。他の銘柄の損切りは動き、新規エントリーは止まり、建玉で確定した後にその銘柄の決済が再送される", async () => {
    // 決済の建玉照会の間隔を 60 秒に延ばして、escalated の間の振る舞いを確かめる (既定は 10 秒)
    const { rt, store, feed, broker, tick } = await liveRuntime({ symbols: [SYM, ETH], engine: { orderPolicy: { exitPositionCheckMs: 60_000 } } });
    broker.placeMode = "fill";
    await rt.engine.tick(START);
    const btc = rt.engine.positions.get(SYM)!;
    const eth = rt.engine.positions.get(ETH)!;
    expect(btc).toBeDefined();
    expect(eth).toBeDefined();
    const onClosed = vi.spyOn(rt.learning, "onTradeClosed");
    // BTC の決済だけが例外 (タイムアウト等) で状態不明。照会も失敗し続ける
    broker.throwPlaceFor.add(SYM);
    broker.throwGetOrderFor.add(SYM);
    hitStop(feed, btc.initialStop);
    await tick(); // 5 秒: 発注の例外 (不明 1 回目)
    expect(broker.last()).toMatchObject({ symbol: SYM, reduceOnly: true });
    expect(rt.engine.positions.hasPending(SYM)).toBe(true);
    await tick(); // 10 秒: 照会も失敗 → 決済は不明 2 回で escalated (建玉の 1 回目の判定)
    expect(store.listAudit({ type: "order.unknown_escalated" })).toHaveLength(1);
    expect(rt.risk.state().killSwitch).toBeUndefined();
    expect(store.listAudit({ type: "risk.kill_switch" })).toHaveLength(0);
    expect(store.listAudit({ type: "engine.kill_switch_close" })).toHaveLength(0);
    expect(rt.engine.positions.get(SYM)).toBeDefined(); // 状態が分かるまで追跡を続ける

    // 他の銘柄 (ETH) の損切りは通常どおり動く
    hitStop(feed, eth.initialStop, ETH);
    await tick(); // 15 秒
    expect(rt.engine.positions.get(ETH)).toBeUndefined();
    expect(store.listTrades().map((t) => [t.symbol, t.exitReason])).toEqual([[ETH, "stop"]]);
    expect(onClosed).toHaveBeenCalledTimes(1);

    // 新規エントリーは止まる (ETH は空いたが、新しい 1 分足でも入らない)
    feed.override.delete(ETH);
    const entries = () => broker.placed.filter((r) => !r.reduceOnly).length;
    const before = entries();
    await tick(50_000); // 65 秒 (BTC の建玉の判定はまだ 60 秒経っていない)
    expect(entries()).toBe(before);
    expect(rt.engine.positions.hasPending(SYM)).toBe(true);

    // 取引所の BTC の建玉は減っていない → 2 回目の判定で「約定なし」と確定し、同じティックで新しい clientId の決済を再送する
    broker.throwPlaceFor.delete(SYM);
    const exitsBefore = broker.placed.filter((r) => r.symbol === SYM && r.reduceOnly).length;
    await tick(10_000); // 75 秒
    expect(store.listAudit({ type: "order.resolved_by_position" })[0].data).toMatchObject({ symbol: SYM, kind: "exit", result: "none" });
    expect(store.listAudit({ type: "engine.exit_resend" })[0].data).toMatchObject({ symbol: SYM });
    expect(broker.placed.filter((r) => r.symbol === SYM && r.reduceOnly).length).toBe(exitsBefore + 1);
    expect(rt.engine.positions.hasPending(SYM)).toBe(false);
    expect(store.listAudit({ type: "engine.entries_resumed" })).toHaveLength(1);
    expect(rt.engine.positions.get(SYM)).toBeUndefined();
    expect(broker.positions.get(SYM)).toBeCloseTo(0, 9);
    expect(store.listTrades().filter((t) => t.symbol === SYM).map((t) => t.exitReason)).toEqual(["stop"]);
    expect(onClosed).toHaveBeenCalledTimes(2);
    expect(rt.risk.state().killSwitch).toBeUndefined();
    await rt.engine.stop();
    expect(skipCounts(store).order_unknown).toBeGreaterThan(0);
  });

  it("CLI の resolve 要求は動作中のエンジンの次のティックで反映される (--filled は推定扱いで学習に渡さない、--none は取消してから外す)", async () => {
    const { rt, store, feed, broker, tick, config } = await liveRuntime();
    const liveConfig = { ...config, mode: "live" as const };
    broker.getOrderMode = "throw"; // 照会できない (受付のみの注文が状態不明)
    await rt.engine.tick(START);
    const entryReq = broker.placed[0];
    expect(rt.engine.positions.hasPending(SYM)).toBe(true);
    const px = rt.hub.latestQuote(SYM)!.ask;
    // 受付のみ (状態不明 = escalated ではない) なので --force が必要
    expect(() => requestOrderResolve(liveConfig, store, { clientId: entryReq.clientId, outcome: "none" }, START + 1, "cli")).toThrow(/--force/);
    const r = requestOrderResolve(liveConfig, store, { clientId: entryReq.clientId, outcome: "filled", qty: entryReq.qty, price: px, force: true }, START + 1, "cli");
    expect(r.message).toMatch(/次のティック/);
    expect(store.kvGet<unknown[]>("orders:resolveRequests:live")).toHaveLength(1);
    await tick();
    expect(store.kvGet("orders:resolveRequests:live")).toBeUndefined();
    const pos = rt.engine.positions.get(SYM)!;
    expect(pos).toMatchObject({ qty: Number(entryReq.qty), entryPrice: px, estimated: true });
    expect(rt.engine.positions.hasPending(SYM)).toBe(false);
    expect(broker.canceled).toEqual(["fake-1"]);
    expect(store.listAudit({ type: "order.manual_resolve" })[0].data).toMatchObject({ clientId: entryReq.clientId, outcome: "filled", result: "filled", by: "cli" });
    // 決済の保留を --none で外す → 損切りが再び出る。推定を含むトレードは学習に渡さない
    const onClosed = vi.spyOn(rt.learning, "onTradeClosed");
    broker.positions.set(SYM, pos.qty);
    hitStop(feed, pos.initialStop);
    await tick();
    const exitReq = broker.last();
    expect(exitReq.reduceOnly).toBe(true);
    requestOrderResolve(liveConfig, store, { clientId: exitReq.clientId, outcome: "none", force: true }, START + 2, "cli");
    broker.placeMode = "fill";
    await tick(); // 要求を適用 (保留を外す)
    expect(store.listAudit({ type: "order.manual_resolve" })[1].data).toMatchObject({ clientId: exitReq.clientId, outcome: "none", result: "none" });
    await tick(); // 通常の管理に戻って損切り
    expect(rt.engine.positions.list()).toHaveLength(0);
    expect(store.listTrades()[0]).toMatchObject({ exitReason: "stop", estimated: true });
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("エンジンが停止中に書かれた resolve 要求は、次回の起動時に適用する", async () => {
    const store = new MemoryStore();
    const broker = new FakeLiveBroker("paper");
    broker.getOrderMode = "throw";
    const first = await liveRuntime({ store, broker });
    await first.rt.engine.tick(START);
    await first.rt.engine.stop();
    const clientId = broker.placed[0].clientId;
    requestResolve(store, "live", { id: "req-1", clientId, outcome: "none", at: START + 1, by: "cli", force: true });
    const second = await liveRuntime({ store, broker });
    expect(second.rt.engine.positions.hasPending(SYM)).toBe(true);
    await second.rt.engine.init();
    expect(second.rt.engine.positions.hasPending(SYM)).toBe(false);
    expect(store.listAudit({ type: "order.manual_resolve" })[0].data).toMatchObject({ clientId, result: "none" });
    expect(store.kvGet("orders:resolveRequests:live")).toBeUndefined();
  });
});

describe("live: 保留中のエントリーのリスク判定・venue ごとの並列処理・締め切り", () => {
  it("保留中のエントリーを建玉 (想定代金) として扱う: maxOpenPositions=1 なら 1 ティックで 1 件しか発注しない", async () => {
    const { rt, store, broker } = await liveRuntime({ symbols: [SYM, ETH], env: { MAX_OPEN_POSITIONS: "1" } });
    await rt.engine.tick(START); // 受付のみ
    expect(broker.placed).toHaveLength(1);
    const o = rt.engine.positions.pendingOrders()[0];
    const acct = await rt.engine.account(START);
    expect(acct.pendingEntries).toBe(1);
    expect(acct.positions.find((p) => p.symbol === o.symbol)).toMatchObject({ assetClass: "crypto", qty: Number(o.qty) });
    const rate = rt.fx.toAccount(rt.hub.instrument(o.symbol)!.quoteCurrency);
    expect(acct.available).toBeCloseTo(broker.equity - Number(o.qty) * o.entry!.input.intendedEntryPrice * rate, 6);
    await rt.engine.stop();
    expect(Object.keys(skipCounts(store)).some((k) => k.includes("最大保有数"))).toBe(true);
  });

  it("1 つの venue の発注が返らなくても、他の venue の損切りは同じティックで動く (venue ごとに並列)", async () => {
    const slow = new FakeLiveBroker("slow");
    const fast = new FakeLiveBroker("fast");
    slow.placeMode = "fill";
    fast.placeMode = "fill";
    const { rt, feed, clock } = await liveRuntime({ symbols: [SYM, ETH], brokers: { [SYM]: slow, [ETH]: fast } });
    await rt.engine.tick(START);
    const btc = rt.engine.positions.get(SYM)!;
    const eth = rt.engine.positions.get(ETH)!;
    let release!: () => void;
    slow.placeGate = (req) => (req.reduceOnly ? new Promise<void>((r) => (release = r)) : undefined);
    hitStop(feed, btc.initialStop);
    hitStop(feed, eth.initialStop, ETH);
    clock.t += 5_000;
    const p = rt.engine.tick(clock.t);
    for (let i = 0; i < 100 && rt.engine.positions.get(ETH); i++) await sleep(2);
    expect(rt.engine.positions.get(ETH)).toBeUndefined(); // 遅い venue (BTC) を待たずに決済
    expect(slow.placed.at(-1)).toMatchObject({ symbol: SYM, reduceOnly: true });
    expect(rt.engine.positions.get(SYM)).toBeDefined();
    expect(eth.id).toBeDefined();
    release();
    await p;
    expect(rt.engine.positions.get(SYM)).toBeUndefined();
  });

  it("決済の発注が締め切り (brokerTimeoutMs) を過ぎたら状態不明の保留として扱い、ティックを終える", async () => {
    const slow = new FakeLiveBroker("slow");
    const fast = new FakeLiveBroker("fast");
    slow.placeMode = "fill";
    fast.placeMode = "fill";
    const { rt, feed, store, tick } = await liveRuntime({ symbols: [SYM, ETH], brokers: { [SYM]: slow, [ETH]: fast }, engine: { brokerTimeoutMs: 30 } });
    await rt.engine.tick(START);
    const btc = rt.engine.positions.get(SYM)!;
    let release!: () => void;
    slow.placeGate = (req) => (req.reduceOnly ? new Promise<void>((r) => (release = r)) : undefined);
    hitStop(feed, btc.initialStop);
    await tick();
    expect(rt.engine.positions.pendingOrders()[0]).toMatchObject({ symbol: SYM, kind: "exit", status: "unknown", unknownCount: 1 });
    expect(rt.engine.positions.pendingOrders()[0].lastError).toMatch(/締め切り/);
    expect(store.listAudit({ type: "engine.exit_error" })[0].data).toMatchObject({ symbol: SYM, pending: true });
    release();
  });
});

describe("live: 再開要求・古い気配・エラー文", () => {
  it("start は自分の mode 宛ての古い再開要求だけを消す (mode の無い要求は paper 宛て)", async () => {
    const { rt, store } = await liveRuntime();
    requestResume(store, { at: 1, by: "cli", mode: "paper" });
    await rt.engine.start();
    await rt.engine.stop();
    expect(peekResumeRequest(store)).toMatchObject({ at: 1, mode: "paper" }); // 動作中の paper エンジン宛てを消さない
    requestResume(store, { at: 2, by: "cli" });
    await rt.engine.start();
    await rt.engine.stop();
    expect(peekResumeRequest(store)).toMatchObject({ at: 2 }); // mode 無し = paper 宛て
    requestResume(store, { at: 3, by: "cli", mode: "live" });
    await rt.engine.start();
    await rt.engine.stop();
    expect(peekResumeRequest(store)).toBeUndefined();

    // paper のエンジンは mode の無い古い要求を消す
    const paperStore = new MemoryStore();
    const paper = await buildRuntime(loadConfig({ NODE_ENV: "test", LIMIT_ENTRY: "false", LIMIT_TAKE_PROFIT: "false", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "USD" }), {
      clock: mkClock(), store: paperStore, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, rng: mulberry32(7), strategies: [alwaysLong()],
    });
    requestResume(paperStore, { at: 4, by: "cli", mode: "live" });
    await paper.engine.start();
    await paper.engine.stop();
    expect(peekResumeRequest(paperStore)).toMatchObject({ mode: "live" });
    requestResume(paperStore, { at: 5, by: "cli" });
    await paper.engine.start();
    await paper.engine.stop();
    expect(peekResumeRequest(paperStore)).toBeUndefined();
  });

  it("新規エントリーは 30 秒より古い気配では行わない (オプションで変更可)", async () => {
    const a = await liveRuntime();
    a.feed.quoteAgeMs.set(SYM, 40_000);
    await a.rt.engine.tick(START);
    expect(a.broker.placed).toHaveLength(0);
    await a.rt.engine.stop();
    expect(skipCounts(a.store).stale_quote).toBeGreaterThan(0);
    const b = await liveRuntime({ engine: { maxQuoteAgeMs: 60_000 } });
    b.feed.quoteAgeMs.set(SYM, 40_000);
    await b.rt.engine.tick(START);
    expect(b.broker.placed).toHaveLength(1);
  });

  it("市場データの取得が時間切れになった venue の銘柄は、そのティックの新規エントリーの対象から外す", async () => {
    const { rt, store, feed, broker, clock } = await liveRuntime({ engine: { pollTimeoutMs: 20 } });
    broker.placeMode = "reject";
    await rt.engine.tick(START);
    expect(broker.placed).toHaveLength(1);
    clock.t = START + 45_000;
    await rt.engine.tick(clock.t); // 気配を更新 (新しい 1 分足はまだ無い)
    feed.quoteDelayMs = 200;
    clock.t = START + 65_000;
    await rt.engine.tick(clock.t); // 新しい 1 分足だが、取得が時間切れ
    expect(broker.placed).toHaveLength(1);
    await sleep(300); // 裏で続いている取得を終わらせる
    feed.quoteDelayMs = 0;
    clock.t = START + 70_000;
    await rt.engine.tick(clock.t);
    expect(broker.placed).toHaveLength(2);
    await rt.engine.stop();
    expect(skipCounts(store).poll_timeout).toBeGreaterThan(0);
  });

  it("エラー文の URL・署名・キーは伏せて記録する (保留の lastError・監査ログ・ダッシュボードの pendingOrders)", async () => {
    const { rt, store, broker } = await liveRuntime();
    broker.placeMode = "throw";
    broker.placeError = "POST https://api.example.com/v1/order?apiKey=AKIA1234567890abcdefXYZ&signature=deadbeefcafe0123456789abcdef0123456789 failed";
    await rt.engine.tick(START);
    const o = rt.engine.positions.pendingOrders()[0];
    expect(o.lastError).toMatch(/signature=\*\*\*/);
    expect(o.lastError).not.toMatch(/deadbeef|AKIA1234/);
    expect(JSON.stringify(store.listAudit())).not.toMatch(/deadbeef|AKIA1234/);
    expect(JSON.stringify(store.kvGet("orders:pending:live"))).not.toMatch(/deadbeef|AKIA1234/);
    // 以前の版で伏せずに保存された lastError もダッシュボードには伏せて出す
    rt.engine.positions.pending.upsert({ ...o, lastError: "GET /order?signature=deadbeefcafe0123456789abcdef0123456789" });
    const st = await rt.engine.status();
    expect(st.pendingOrders[0].lastError).toMatch(/signature=\*\*\*/);
    expect(JSON.stringify(st.pendingOrders)).not.toMatch(/deadbeef/);
  });
});

describe("live 前の安全対策 (決済の再送・約定直後の建玉・為替・ステータス)", () => {
  it("決済の発注がタイムアウト → 約 15 秒で新しい clientId の決済を再送し、過剰決済にならない (後から届いた古い注文も reduceOnly で拒否)", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.placeMode = "fill";
    const { rt, feed, store, tick } = await liveRuntime({ broker, engine: { brokerTimeoutMs: 30 } });
    await rt.engine.tick(START);
    const pos = rt.engine.positions.get(SYM)!;
    expect(pos).toBeDefined();
    const held = broker.positions.get(SYM)!;
    let release: (() => void) | undefined;
    let gated = 0;
    // 最初の決済だけ応答が返らない (取引所にも届いていない)
    broker.placeGate = (req) => (req.reduceOnly && gated++ === 0 ? new Promise<void>((r) => (release = r)) : undefined);
    hitStop(feed, pos.initialStop);
    await tick(); // 5 秒: 発注が締め切りを過ぎる → 状態不明 1 回目
    const first = broker.last();
    expect(rt.engine.positions.pendingOrders()[0]).toMatchObject({ kind: "exit", clientId: first.clientId, unknownCount: 1 });
    await tick(); // 10 秒: 照会でも見つからない → 2 回目で escalated (建玉の 1 回目の判定)
    expect(store.listAudit({ type: "order.unknown_escalated" })).toHaveLength(1);
    await tick(); // 15 秒: 建玉の照会は 10 秒間隔
    expect(rt.engine.positions.get(SYM)).toBeDefined();
    await tick(); // 20 秒: 建玉が減っていない (2 回目) → 「約定なし」で確定し、すぐに再送 → 約定
    expect(rt.engine.positions.get(SYM)).toBeUndefined();
    const exits = broker.placed.filter((r) => r.reduceOnly);
    expect(exits).toHaveLength(2);
    expect(exits[1].clientId).not.toBe(first.clientId);
    expect(Number(exits[1].qty)).toBeCloseTo(held, 12);
    expect(broker.positions.get(SYM)).toBeCloseTo(0, 12);
    expect(store.listTrades().map((t) => t.exitReason)).toEqual(["stop"]);
    expect(store.listAudit({ type: "engine.exit_resend" })).toHaveLength(1);
    // 古い注文が後から取引所に届いても、reduceOnly (保有数量が上限) で拒否され、逆方向の建玉にならない
    release!();
    await new Promise((r) => setTimeout(r, 5));
    expect(broker.positions.get(SYM)).toBeCloseTo(0, 12);
    await tick();
    expect(rt.risk.state().killSwitch).toBeUndefined();
    await rt.engine.stop();
  });

  it("約定直後に取引所の建玉一覧へ反映されていなくても、追跡中の建玉をリスク計算に含める (一覧にある分は二重計上しない)", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.placeMode = "fill";
    broker.hidePositions.add(SYM); // 約定しても一覧に出ない (反映遅れ)
    const { rt, store } = await liveRuntime({ symbols: [SYM, ETH], broker, env: { MAX_OPEN_POSITIONS: "1" } });
    await rt.engine.tick(START);
    // SYM が約定した後、同じティックの ETH は最大保有数 1 で拒否される (一覧に無くても数える)
    expect(rt.engine.positions.list().map((p) => p.symbol)).toEqual([SYM]);
    expect(broker.placed.filter((r) => !r.reduceOnly)).toHaveLength(1);
    const p = rt.engine.positions.get(SYM)!;
    const q = rt.hub.latestQuote(SYM)!;
    const mid = (q.bid + q.ask) / 2;
    const acct = await rt.engine.account(START, true);
    expect(acct.trackedUnreported).toBe(1);
    expect(acct.positions.filter((x) => x.symbol === SYM)).toHaveLength(1);
    expect(acct.positions.find((x) => x.symbol === SYM)).toMatchObject({ assetClass: "crypto" });
    expect(acct.positions.find((x) => x.symbol === SYM)!.qty).toBeCloseTo(p.qty, 12);
    expect(acct.available).toBeCloseTo(broker.equity - p.qty * mid, 6);
    // 一覧に一部だけ出ている: 行を増やさず差分だけ足す
    broker.hidePositions.delete(SYM);
    broker.positions.set(SYM, p.qty / 2);
    const half = await rt.engine.account(START, true);
    expect(half.positions.filter((x) => x.symbol === SYM)).toHaveLength(1);
    expect(half.positions.find((x) => x.symbol === SYM)!.qty).toBeCloseTo(p.qty, 12);
    expect(half.available).toBeCloseTo(broker.equity - (p.qty / 2) * mid, 6);
    // 一覧に全量出ていれば何も足さない
    broker.positions.set(SYM, p.qty);
    const full = await rt.engine.account(START, true);
    expect(full.trackedUnreported).toBeUndefined();
    expect(full.available).toBe(broker.equity);
    expect(full.positions.filter((x) => x.symbol === SYM)).toHaveLength(1);
    await rt.engine.stop();
    expect(Object.keys(skipCounts(store)).some((k) => k.includes("最大保有数"))).toBe(true);
  });

  it("paper: 追跡中の建玉は PaperBroker の建玉と一致し、口座情報に差分を足さない (挙動は変わらない)", async () => {
    const clock = mkClock();
    const rt = await buildRuntime(loadConfig({ NODE_ENV: "test", LIMIT_ENTRY: "false", LIMIT_TAKE_PROFIT: "false", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY" }), {
      clock, store: new MemoryStore(), intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, rng: mulberry32(7),
    });
    let opened = 0;
    for (let t = START; t <= START + 3 * 3_600_000; t += 30_000) {
      clock.t = t;
      await rt.engine.tick(t);
      const acct = await rt.engine.account(t, true);
      expect(acct.trackedUnreported, new Date(t).toISOString()).toBeUndefined();
      opened = Math.max(opened, rt.engine.positions.list().length);
    }
    expect(opened).toBeGreaterThan(0);
    // paper は概算表 (USD→JPY) を使っていても従来どおりで、ステータスにも出さない
    const st = await rt.engine.status();
    expect(st.account.fxApprox).toBeUndefined();
    await rt.engine.stop();
  });

  it("live: 為替が固定の概算表 (USD/JPY の気配なし) なら新規エントリーしない。ステータスに概算レート使用中を出す", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.placeMode = "fill";
    const { rt, store } = await liveRuntime({ broker, env: { BASE_CURRENCY: "JPY" } });
    await rt.engine.tick(START);
    expect(broker.placed).toHaveLength(0);
    const st = await rt.engine.status();
    expect(st.account.fxApprox?.join(" ")).toMatch(/概算表/);
    expect(st.equity.current).toBeGreaterThan(0); // 評価額の計算は続ける
    await rt.engine.stop();
    expect(skipCounts(store).fx_approx).toBeGreaterThan(0);
  });

  it("live: USD/JPY の気配が 5 分より古ければ新規エントリーしない。新しくなればエントリーする", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.placeMode = "fill";
    const { rt, feed, tick } = await liveRuntime({ broker, symbols: [SYM, "USD/JPY"], env: { BASE_CURRENCY: "JPY" } });
    feed.quoteAgeMs.set("USD/JPY", 6 * MIN);
    await rt.engine.tick(START);
    expect(broker.placed).toHaveLength(0);
    expect((await rt.engine.status()).account.fxApprox?.join(" ")).toMatch(/古い/);
    feed.quoteAgeMs.delete("USD/JPY");
    await tick(MIN); // 新しい 1 分足
    expect(broker.placed.filter((r) => r.symbol === SYM)).toHaveLength(1);
    expect((await rt.engine.status()).account.fxApprox).toBeUndefined();
    await rt.engine.stop();
  });

  it("ステータス: tickMs と口座取得の劣化 (missing / degradedReason) を出す", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.failAccount = true;
    const { rt, tick } = await liveRuntime({ broker, engine: { tickMs: 2_000 } });
    await rt.engine.tick(START);
    let st = await rt.engine.status();
    expect(st.tickMs).toBe(2_000);
    expect(st.account).toMatchObject({ incomplete: true, missing: ["paper"] });
    await tick();
    await tick();
    st = await rt.engine.status();
    expect(st.account.degradedReason).toMatch(/連続で失敗/);
    broker.failAccount = false;
    await tick();
    st = await rt.engine.status();
    expect(st.account).toEqual({});
    await rt.engine.stop();
  });
});
