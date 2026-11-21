/**
 * 指値 (maker) のエントリーと利確の板置き (エンジンの統合)。
 * paper は PaperBroker、live の経路は Broker を実装した偽のブローカー (FakeLiveBroker) を注入する。実在の取引所へは送信しない。
 */
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/appConfig";
import type { Candle, Clock, Instrument, MarketDataFeed, Quote, ShadowTradeRecord, Signal, Strategy, StrategyContext, Timeframe } from "../src/core/types";
import { readLimitStats } from "../src/engine/orders";
import { buildRuntime } from "../src/engine/setup";
import type { BrokerSet } from "../src/execution/router";
import { mulberry32, SyntheticFeed } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";
import { scalpMicro } from "../src/strategies/scalpMicro";
import { FakeLiveBroker } from "./helpers/fakeLiveBroker";

const MIN = 60_000;
const START = Date.UTC(2026, 0, 5);
const SYM = "BTC/USDT";

const mkClock = (t = START): Clock & { t: number } => ({ t, now() { return this.t; } });

/** 保有していなければ state.dir の方向にシグナル (損切り 2%・利確 tpPct)。保有中は何もしない */
function testStrategy(state: { dir: "long" | "short"; tpPct?: number }, opts: Partial<Strategy> = {}): Strategy {
  return {
    id: "lim_test",
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
      const long = state.dir === "long";
      const px = long ? ctx.market.quote.ask : ctx.market.quote.bid;
      const tp = state.tpPct ?? 0.01;
      return {
        strategyId: "lim_test", horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: state.dir, confidence: 0.8, expectedEdgeBps: 300,
        entry: { type: "market" }, stopLoss: long ? px * 0.98 : px * 1.02, takeProfit: long ? px * (1 + tp) : px * (1 - tp), maxHoldMs: 60 * MIN,
        reason: "test", features: { x: 1 },
      };
    },
    ...opts,
  };
}

class ControlledFeed implements MarketDataFeed {
  readonly venue = "paper";
  readonly override = new Map<string, { bid: number; ask: number }>();
  readonly failQuote = new Set<string>();
  /** 気配の時刻をこの分だけ古くする */
  readonly quoteAgeMs = new Map<string, number>();
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
    const q = o ? { ts: this.clock.now(), ...o } : await this.inner.fetchQuote(symbol);
    return { ...q, ts: q.ts - (this.quoteAgeMs.get(symbol) ?? 0) };
  }
}

async function runtime(
  o: {
    env?: Record<string, string>;
    store?: MemoryStore;
    strategy?: Strategy;
    strategies?: Strategy[];
    /** live の経路 (偽のブローカー) */
    live?: FakeLiveBroker;
    /** paper のまま発注先だけ偽のブローカーにする (paper 専用の利確の指値で、取消・照会の失敗を再現する) */
    paperFake?: FakeLiveBroker;
    clock?: Clock & { t: number };
  } = {},
) {
  const clock = o.clock ?? mkClock();
  const store = o.store ?? new MemoryStore();
  const feed = new ControlledFeed(new SyntheticFeed({ clock, seed: 3, historyMs: 2 * 86_400_000 }), clock);
  const instruments = [(await feed.listInstruments()).find((i) => i.symbol === SYM)!];
  const state = { dir: "long" as "long" | "short", tpPct: 0.01 };
  const fake = o.live ?? o.paperFake;
  const brokerSet: BrokerSet | undefined = fake
    ? {
        mode: o.live ? "live" : "paper",
        brokers: new Map([[fake.venue, fake]]),
        brokerFor(symbol) {
          if (symbol !== SYM) throw new Error(`未知の銘柄: ${symbol}`);
          return fake;
        },
      }
    : undefined;
  const config = loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "USD", ...(o.env ?? {}) });
  const rt = await buildRuntime(config, {
    clock, store, intelSources: [], ai: null, rng: mulberry32(7), strategies: o.strategies ?? [o.strategy ?? testStrategy(state)], markets: [{ feed, instruments }],
    ...(brokerSet ? { brokerSet } : {}),
    engine: { liveAccountCacheMs: 0 },
  });
  if (fake) fake.quoteOf = (s) => rt.hub.latestQuote(s);
  const tick = async (dt = 5_000) => {
    clock.t += dt;
    return rt.engine.tick(clock.t);
  };
  /** 指値のエントリーが置かれるまで進める */
  const untilLimit = async (max = 40) => {
    for (let k = 0; k < max && !rt.engine.positions.pendingLimitEntry(SYM); k++) await tick();
    const p = rt.engine.positions.pendingLimitEntry(SYM);
    if (!p) throw new Error("指値のエントリーが置かれませんでした");
    return p;
  };
  const quote = () => rt.hub.latestQuote(SYM)!;
  return { rt, clock, store, feed, state, tick, untilLimit, quote, config };
}

const audits = (store: MemoryStore, type: string) => store.listAudit({ type }).map((a) => a.data as Record<string, unknown>);
const shadowOpen = (store: MemoryStore, mode: "paper" | "live" = "paper") =>
  (store.kvGet<{ reason: string; entryTs: number }[]>(`shadow:open:${mode}`) ?? []) as Pick<ShadowTradeRecord, "reason" | "entryTs">[];
function skipCounts(store: MemoryStore): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of store.listAudit({ type: "engine.skip_summary" })) {
    for (const [k, v] of Object.entries((a.data as { reasons: Record<string, { count: number }> }).reasons)) out[k] = (out[k] ?? 0) + v.count;
  }
  return out;
}

describe("指値のエントリー (paper)", () => {
  it("買いは最良の買い気配に post-only で置き、売り気配が指値を下回ったら maker で約定して建玉になる (LIMIT_TAKE_PROFIT=true なら利確の指値も置く)", async () => {
    const { rt, store, feed, tick, untilLimit } = await runtime({ env: { LIMIT_TAKE_PROFIT: "true" } });
    const pl = await untilLimit();
    const q0 = rt.hub.latestQuote(SYM)!;
    expect(pl.limit!.price).toBeLessThanOrEqual(q0.bid);
    expect(pl.limit!.postOnly).toBe(true);
    const paper = rt.brokerSet.paper!;
    expect(paper.openOrders()).toHaveLength(1);
    expect(rt.engine.positions.list()).toHaveLength(0);
    const L = pl.limit!.price;
    // 売り気配が指値ちょうど (触れただけ) では約定しない
    feed.override.set(SYM, { bid: L - 5, ask: L });
    await tick();
    expect(rt.engine.positions.list()).toHaveLength(0);
    // 下回ったら約定
    feed.override.set(SYM, { bid: L - 5, ask: L - 0.5 });
    await tick();
    const pos = rt.engine.positions.list();
    expect(pos).toHaveLength(1);
    expect(pos[0].entryPrice).toBe(L);
    expect(pos[0].entryOrderType).toBe("limit");
    expect(rt.engine.positions.pendingOrders()).toHaveLength(0);
    // 利確の指値 (reduceOnly) を板に置いた
    const tps = rt.engine.positions.restingTakeProfits();
    expect(tps).toHaveLength(1);
    expect(tps[0].price).toBe(pos[0].takeProfit);
    expect(paper.openOrders()).toEqual([expect.objectContaining({ side: "sell", limitPrice: Number(pos[0].takeProfit!.toFixed(2)) })]);
    const st = readLimitStats(store, "paper");
    expect(st).toMatchObject({ entryPlaced: 1, entryFilled: 1, tpPlaced: 1 });
    expect(audits(store, "engine.entry")[0]).toMatchObject({ orderType: "limit", limitPrice: L });
    // status にも出る
    const s = await rt.engine.status();
    expect(s.limitOrders?.restingTakeProfits).toHaveLength(1);
    expect(s.limitOrders?.stats.entryFilled).toBe(1);
  }, 30_000);

  it("期限内に約定しなければ取り消して見送り、仮想トレード (limit_unfilled) をシグナル時点で記録する", async () => {
    const { rt, store, feed, tick, untilLimit, clock } = await runtime({ env: { LIMIT_ENTRY_TIMEOUT_MS: "20000" } });
    const pl = await untilLimit();
    const L = pl.limit!.price;
    feed.override.set(SYM, { bid: L + 1, ask: L + 2 });
    for (let k = 0; k < 5; k++) await tick();
    expect(clock.t).toBeGreaterThanOrEqual(pl.limit!.expiresAt);
    expect(rt.engine.positions.pendingLimitEntry(SYM)?.clientId).not.toBe(pl.clientId);
    expect(rt.brokerSet.paper!.openOrders().filter((o) => o.clientId === pl.clientId)).toHaveLength(0);
    const un = audits(store, "engine.limit_unfilled");
    expect(un[0]).toMatchObject({ clientId: pl.clientId, cause: "expired" });
    expect(readLimitStats(store, "paper")).toMatchObject({ entryExpired: 1, entryFilled: 0 });
    const sh = shadowOpen(store).filter((x) => x.reason === "limit_unfilled");
    expect(sh).toHaveLength(1);
    expect(sh[0].entryTs).toBe(pl.createdAt);
    expect(rt.engine.positions.list()).toHaveLength(0);
  }, 30_000);

  it("待っている間に戦略が逆方向のシグナルを出したら取り消す (仮想トレードは記録しない)", async () => {
    const { rt, store, feed, tick, untilLimit, state } = await runtime();
    const pl = await untilLimit();
    feed.override.set(SYM, { bid: pl.limit!.price + 1, ask: pl.limit!.price + 2 });
    state.dir = "short";
    for (let k = 0; k < 13 && rt.engine.positions.pendingLimitEntry(SYM)?.clientId === pl.clientId; k++) await tick();
    expect(audits(store, "engine.limit_unfilled")[0]).toMatchObject({ clientId: pl.clientId, cause: "opposite_signal" });
    expect(readLimitStats(store, "paper").entryCanceled).toEqual({ opposite_signal: 1 });
    expect(shadowOpen(store).filter((x) => x.reason === "limit_unfilled")).toHaveLength(0);
    expect(rt.engine.positions.list()).toHaveLength(0);
  }, 30_000);

  it("気配が損切り価格を越えたら取り消す", async () => {
    const { rt, store, feed, tick, untilLimit } = await runtime();
    const pl = await untilLimit();
    // 損切りより下の買い気配 (売り気配は指値より上 = 約定しない異常な気配で、損切りの越えだけを試す)
    feed.override.set(SYM, { bid: pl.limit!.stopLoss * 0.999, ask: pl.limit!.price + 1 });
    await tick();
    expect(audits(store, "engine.limit_unfilled")[0]).toMatchObject({ clientId: pl.clientId, cause: "stop_crossed" });
    expect(rt.engine.positions.list()).toHaveLength(0);
  }, 30_000);

  it("停止 (kill switch) で取り消す", async () => {
    const { rt, store, feed, tick, untilLimit, clock } = await runtime();
    const pl = await untilLimit();
    feed.override.set(SYM, { bid: pl.limit!.price + 1, ask: pl.limit!.price + 2 });
    rt.risk.trip("テスト停止", clock.t);
    await tick();
    expect(audits(store, "engine.limit_unfilled")[0]).toMatchObject({ clientId: pl.clientId, cause: "halted" });
    expect(rt.brokerSet.paper!.openOrders()).toHaveLength(0);
    expect(rt.engine.positions.pendingOrders()).toHaveLength(0);
    for (let k = 0; k < 15; k++) await tick();
    expect(rt.engine.positions.pendingOrders()).toHaveLength(0);
  }, 30_000);

  it("再起動をまたいでも、待っている指値を照会して約定を反映できる", async () => {
    const store = new MemoryStore();
    const clock = mkClock();
    const a = await runtime({ store, clock });
    const pl = await a.untilLimit();
    await a.rt.engine.stop();
    const b = await runtime({ store, clock });
    expect(b.rt.engine.positions.pendingLimitEntry(SYM)?.clientId).toBe(pl.clientId);
    b.feed.override.set(SYM, { bid: pl.limit!.price - 5, ask: pl.limit!.price - 0.5 });
    await b.tick();
    const pos = b.rt.engine.positions.list();
    expect(pos).toHaveLength(1);
    expect(pos[0].entryPrice).toBe(pl.limit!.price);
    expect(pos[0].entryOrderType).toBe("limit");
  }, 30_000);
});

describe("利確の指値 (paper)", () => {
  async function opened(env: Record<string, string> = {}) {
    const r = await runtime({ env: { LIMIT_TAKE_PROFIT: "true", ...env } });
    const pl = await r.untilLimit();
    r.feed.override.set(SYM, { bid: pl.limit!.price - 5, ask: pl.limit!.price - 0.5 });
    await r.tick();
    const p = r.rt.engine.positions.list()[0];
    if (!p) throw new Error("建玉になりませんでした");
    return { ...r, p };
  }

  it("買い気配が利確価格を越えたら指値が maker で約定し、take_profit で閉じる", async () => {
    const { rt, store, feed, tick, p } = await opened();
    const tp = p.takeProfit!;
    feed.override.set(SYM, { bid: tp + 1, ask: tp + 2 });
    await tick();
    const trades = store.listTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ exitReason: "take_profit", exitOrderType: "limit", entryOrderType: "limit" });
    expect(trades[0].exitPrice).toBeCloseTo(Number(tp.toFixed(2)), 6);
    expect(trades[0].takerFees).toBe(0);
    expect(trades[0].fees).toBeCloseTo(trades[0].makerFees!, 9);
    expect(rt.engine.positions.restingTakeProfits()).toHaveLength(0);
    expect(readLimitStats(store, "paper")).toMatchObject({ tpPlaced: 1, tpFilled: 1 });
  }, 30_000);

  it("損切り: 先に利確の指値を取り消して結果を確かめてから、残りを成行で決済する", async () => {
    const { rt, store, feed, tick, p } = await opened();
    const paper = rt.brokerSet.paper!;
    const calls: string[] = [];
    const cancel = paper.cancelOrder.bind(paper);
    const place = paper.placeOrder.bind(paper);
    const get = paper.getOrder.bind(paper);
    vi.spyOn(paper, "cancelOrder").mockImplementation(async (id, s) => {
      calls.push("cancel");
      return cancel(id, s);
    });
    vi.spyOn(paper, "getOrder").mockImplementation(async (cid, s, oid) => {
      calls.push("getOrder");
      return get(cid, s, oid);
    });
    vi.spyOn(paper, "placeOrder").mockImplementation(async (req) => {
      calls.push(`place:${req.type}${req.reduceOnly ? ":reduceOnly" : ""}`);
      return place(req);
    });
    feed.override.set(SYM, { bid: p.initialStop * 0.99, ask: p.initialStop * 0.99 + 1 });
    await tick();
    // (先頭は定期の照会。取消 → 照会で確定 → 成行の順で、取消より前に成行を送らない)
    const i = calls.indexOf("cancel");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(calls.slice(0, i).some((c) => c.startsWith("place:"))).toBe(false);
    expect(calls.slice(i, i + 3)).toEqual(["cancel", "getOrder", "place:market:reduceOnly"]);
    const trades = store.listTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe("stop");
    expect(trades[0].exitOrderType).toBe("market");
    expect(paper.openOrders()).toHaveLength(0);
    expect(await paper.getPositions()).toHaveLength(0);
    expect(rt.engine.positions.restingTakeProfits()).toHaveLength(0);
    expect(readLimitStats(store, "paper").tpCanceled).toBe(1);
  }, 30_000);

  it("既定 (LIMIT_TAKE_PROFIT 未設定 = false) なら利確の指値を置かず、従来どおりエンジン側の成行で利確する", async () => {
    const r = await runtime();
    const pl = await r.untilLimit();
    r.feed.override.set(SYM, { bid: pl.limit!.price - 5, ask: pl.limit!.price - 0.5 });
    await r.tick();
    const { rt, store, feed, tick } = r;
    const p = rt.engine.positions.list()[0];
    expect(p).toBeDefined();
    expect(rt.engine.positions.restingTakeProfits()).toHaveLength(0);
    expect(rt.brokerSet.paper!.openOrders()).toHaveLength(0);
    feed.override.set(SYM, { bid: p.takeProfit!, ask: p.takeProfit! + 1 });
    await tick();
    const t = store.listTrades()[0];
    expect(t).toMatchObject({ exitReason: "take_profit", exitOrderType: "market" });
  }, 30_000);
});

describe("live の経路 (偽のブローカー)", () => {
  it("一部約定: 期限で取り消し、約定した数量だけで建玉を持つ (損切り・利確はシグナルどおり。保護ストップは渡す)", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.currency = "USD";
    const { rt, store, tick, untilLimit } = await runtime({ live: broker, env: { LIMIT_ENTRY_TIMEOUT_MS: "20000" } });
    const pl = await untilLimit();
    const req = broker.placed.find((r) => r.clientId === pl.clientId)!;
    expect(req.type).toBe("limit");
    expect(req.postOnly).toBeUndefined(); // 能力が無い取引先では post-only を付けない (GTC の指値)
    expect(req.tif).toBe("GTC");
    // 保護ストップは成行と同じく渡す (OANDA は stopLossOnFill = 約定で付く。GMO・ccxt・Alpaca は付けない)
    expect(req.protectiveStop).toBe(pl.limit!.stopLoss);
    const half = (Math.floor((Number(req.qty) / 2) * 1e4) / 1e4).toString();
    broker.fill(pl.clientId, { qty: half, price: pl.limit!.price, status: "partially_filled" });
    await tick();
    expect(rt.engine.positions.list()).toHaveLength(0); // 一部約定の間は保留のまま
    for (let k = 0; k < 5 && rt.engine.positions.list().length === 0; k++) await tick();
    const pos = rt.engine.positions.list();
    expect(pos).toHaveLength(1);
    expect(pos[0].qty).toBeCloseTo(Number(half), 8);
    expect(pos[0].initialStop).toBe(pl.limit!.stopLoss);
    expect(broker.canceled).toHaveLength(1);
    expect(readLimitStats(store, "live")).toMatchObject({ entryPartial: 1 });
    // live では利確の指値を置かない
    expect(rt.engine.positions.restingTakeProfits()).toHaveLength(0);
  }, 30_000);

  it("live では LIMIT_TAKE_PROFIT=true でも利確の指値を板に置かない (起動時に 1 回だけ警告・監査ログ。利確はエンジン側の成行)", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.currency = "USD";
    broker.capabilities = { postOnly: true, restingTakeProfit: true };
    const { rt, store, feed, tick } = await runtime({ live: broker, env: { LIMIT_ENTRY: "false", LIMIT_TAKE_PROFIT: "true" } });
    for (let k = 0; k < 40 && broker.placed.length === 0; k++) await tick();
    broker.fill(broker.placed[0].clientId);
    await tick();
    const p = rt.engine.positions.list()[0];
    expect(p).toBeDefined();
    for (let k = 0; k < 3; k++) await tick();
    expect(broker.placed.filter((r) => r.reduceOnly)).toHaveLength(0);
    expect(rt.engine.positions.restingTakeProfits()).toHaveLength(0);
    expect(audits(store, "limit.tp_live_ignored")).toHaveLength(1);
    expect((await rt.engine.status()).limitOrders?.limitTakeProfit).toBe(false);
    // 利確価格に届いたら成行 (reduceOnly) で決済する
    feed.override.set(SYM, { bid: p.takeProfit! + 1, ask: p.takeProfit! + 2 });
    await tick();
    const exits = broker.placed.filter((r) => r.reduceOnly);
    expect(exits).toHaveLength(1);
    expect(exits[0].type).toBe("market");
    broker.fill(exits[0].clientId);
    await tick();
    expect(store.listTrades()[0]).toMatchObject({ exitReason: "take_profit", exitOrderType: "market" });
    expect(audits(store, "limit.tp_live_ignored")).toHaveLength(1);
  }, 30_000);
});

describe("利確の指値 (paper・偽の発注先で取消・照会の失敗を再現)", () => {
  it("利確の指値の取消が失敗・状態不明の間は成行の決済を送らず、確定してから残りを送る", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.currency = "USD";
    broker.capabilities = { restingTakeProfit: true };
    const { rt, store, feed, tick } = await runtime({ paperFake: broker, env: { LIMIT_ENTRY: "false", LIMIT_TAKE_PROFIT: "true" } });
    expect(rt.engine.mode).toBe("paper");
    for (let k = 0; k < 40 && broker.placed.length === 0; k++) await tick();
    const entry = broker.placed[0];
    expect(entry.type).toBe("market");
    broker.fill(entry.clientId);
    await tick();
    const p = rt.engine.positions.list()[0];
    expect(p).toBeDefined();
    const tpReq = broker.placed.find((r) => r.reduceOnly && r.type === "limit");
    expect(tpReq).toBeDefined();
    expect(tpReq!.limitPrice).toBe(p.takeProfit);
    // 取消に失敗し、照会もできない
    broker.failCancel = true;
    broker.getOrderMode = "throw";
    feed.override.set(SYM, { bid: p.initialStop * 0.97, ask: p.initialStop * 0.97 + 1 });
    for (let k = 0; k < 4; k++) await tick();
    const marketExits = () => broker.placed.filter((r) => r.reduceOnly && r.type === "market");
    expect(marketExits()).toHaveLength(0);
    expect(rt.engine.positions.list()).toHaveLength(1);
    // 状態不明が続いたので新規エントリーを止めている
    expect((await rt.engine.status()).risk.entriesPaused).toBeDefined();
    expect(audits(store, "order.tp_unknown_escalated")).toHaveLength(1);
    // 回復: 取消できて照会で canceled を確かめたら、残りを成行で送る
    broker.failCancel = false;
    broker.getOrderMode = "normal";
    await tick();
    expect(marketExits()).toHaveLength(1);
    expect(marketExits()[0].qty).toBe(String(p.qty));
    broker.fill(marketExits()[0].clientId);
    await tick();
    const t = store.listTrades();
    expect(t).toHaveLength(1);
    expect(t[0].exitReason).toBe("stop");
    expect(rt.engine.positions.restingTakeProfits()).toHaveLength(0);
  }, 30_000);

  it("取消の照会で利確の約定が分かったら take_profit で記録し、残りだけを成行で決済する", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.currency = "USD";
    broker.capabilities = { restingTakeProfit: true };
    const { rt, store, feed, tick } = await runtime({ paperFake: broker, env: { LIMIT_ENTRY: "false", LIMIT_TAKE_PROFIT: "true" } });
    for (let k = 0; k < 40 && broker.placed.length === 0; k++) await tick();
    broker.fill(broker.placed[0].clientId);
    await tick();
    const p = rt.engine.positions.list()[0];
    const tpReq = broker.placed.find((r) => r.reduceOnly && r.type === "limit")!;
    // 利確の指値が一部約定 (照会の前に損切り)
    const part = (Math.floor((p.qty / 4) * 1e4) / 1e4).toString();
    broker.fill(tpReq.clientId, { qty: part, price: p.takeProfit!, status: "partially_filled" });
    feed.override.set(SYM, { bid: p.initialStop * 0.97, ask: p.initialStop * 0.97 + 1 });
    await tick();
    const mk = broker.placed.filter((r) => r.reduceOnly && r.type === "market");
    expect(mk).toHaveLength(1);
    expect(Number(mk[0].qty)).toBeCloseTo(p.qty - Number(part), 8);
    broker.fill(mk[0].clientId);
    await tick();
    const t = store.listTrades();
    expect(t).toHaveLength(1);
    expect(t[0].exitReason).toBe("stop");
    expect(t[0].exitOrderType).toBe("limit"); // 一部が指値の約定
    expect(t[0].qty).toBeCloseTo(p.qty, 8);
    expect(audits(store, "engine.exit").some((a) => a.reason === "take_profit" && a.partial === true)).toBe(true);
  }, 30_000);

  it("建玉が閉じても利確の指値の取消を確かめるまで記録を消さず、その間はこの銘柄に新規エントリーしない", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.currency = "USD";
    broker.capabilities = { restingTakeProfit: true };
    const { rt, store, tick, clock } = await runtime({ paperFake: broker, env: { LIMIT_ENTRY: "false", LIMIT_TAKE_PROFIT: "true" } });
    for (let k = 0; k < 40 && broker.placed.length === 0; k++) await tick();
    broker.fill(broker.placed[0].clientId);
    await tick();
    expect(rt.engine.positions.list()).toHaveLength(1);
    const tpReq = broker.placed.find((r) => r.reduceOnly && r.type === "limit")!;
    expect(tpReq).toBeDefined();
    // 外部で建玉が無くなり (突き合わせで外す)、利確の指値の取消は失敗し続ける
    broker.positions.set(SYM, 0);
    broker.failCancel = true;
    rt.engine.positions.reconcile([], clock.t);
    expect(rt.engine.positions.list()).toHaveLength(0);
    const placedBefore = broker.placed.length;
    for (let k = 0; k < 4; k++) await tick(MIN);
    // 板に残っているかもしれないので記録は消さない。この銘柄の新規も止める
    expect(rt.engine.positions.restingTakeProfits()).toHaveLength(1);
    expect(broker.placed.length).toBe(placedBefore);
    expect(skipCounts(store).orphan_tp ?? 0).toBeGreaterThan(0);
    // 取消できて照会で canceled を確かめたら消す
    broker.failCancel = false;
    await tick();
    expect(rt.engine.positions.restingTakeProfits()).toHaveLength(0);
    expect(audits(store, "engine.tp_orphan")).toHaveLength(1);
  }, 30_000);
});

describe("live の経路 (偽のブローカー): 成行の戦略と設定", () => {
  it("成行の戦略 (scalp_micro と entryOrder: market) は LIMIT_ENTRY=true でも成行のまま", async () => {
    expect(scalpMicro.entryOrder).toBe("market");
    const broker = new FakeLiveBroker("paper");
    broker.currency = "USD";
    const state = { dir: "long" as const };
    const { tick } = await runtime({ live: broker, strategy: testStrategy(state, { entryOrder: "market" }) });
    for (let k = 0; k < 40 && broker.placed.length === 0; k++) await tick();
    expect(broker.placed[0]).toMatchObject({ type: "market" });
    expect(broker.placed[0].protectiveStop).toBeGreaterThan(0);
  }, 30_000);

  it("LIMIT_ENTRY=false・LIMIT_TAKE_PROFIT=false なら従来と同じ (成行のエントリー・保護ストップ・利確の指値なし)", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.currency = "USD";
    broker.capabilities = { postOnly: true, restingTakeProfit: true };
    broker.placeMode = "fill";
    const { rt, tick } = await runtime({ live: broker, env: { LIMIT_ENTRY: "false", LIMIT_TAKE_PROFIT: "false" } });
    for (let k = 0; k < 40 && broker.placed.length === 0; k++) await tick();
    for (let k = 0; k < 3; k++) await tick();
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0]).toMatchObject({ type: "market" });
    expect(broker.placed[0].postOnly).toBeUndefined();
    expect(broker.placed[0].protectiveStop).toBeGreaterThan(0);
    expect(rt.engine.positions.list()[0].entryOrderType).toBe("market");
    expect(rt.engine.positions.restingTakeProfits()).toHaveLength(0);
  }, 30_000);
});

describe("live: 既定の指値の設定 (LIMIT_ENTRY=true・LIMIT_TAKE_PROFIT 既定)", () => {
  it("指値のエントリー → 約定で建玉 → 損切りは成行 (reduceOnly) で決済する (利確の指値は置かない)", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.currency = "USD";
    const { rt, store, feed, tick, untilLimit } = await runtime({ live: broker });
    expect(rt.engine.mode).toBe("live");
    const pl = await untilLimit();
    const req = broker.placed.find((r) => r.clientId === pl.clientId)!;
    expect(req).toMatchObject({ type: "limit", tif: "GTC", limitPrice: pl.limit!.price, protectiveStop: pl.limit!.stopLoss });
    expect(rt.engine.positions.list()).toHaveLength(0);
    broker.fill(pl.clientId, { price: pl.limit!.price });
    await tick();
    const p = rt.engine.positions.list()[0];
    expect(p).toBeDefined();
    expect(p).toMatchObject({ entryPrice: pl.limit!.price, entryOrderType: "limit", initialStop: pl.limit!.stopLoss });
    expect(rt.engine.positions.restingTakeProfits()).toHaveLength(0);
    expect(broker.placed.filter((r) => r.reduceOnly)).toHaveLength(0);
    // 損切り
    feed.override.set(SYM, { bid: p.initialStop * 0.99, ask: p.initialStop * 0.99 + 1 });
    await tick();
    const exits = broker.placed.filter((r) => r.reduceOnly);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ type: "market", side: "sell" });
    expect(Number(exits[0].qty)).toBeCloseTo(p.qty, 8);
    broker.fill(exits[0].clientId);
    await tick();
    const t = store.listTrades({ mode: "live" });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ exitReason: "stop", entryOrderType: "limit", exitOrderType: "market" });
    expect(readLimitStats(store, "live")).toMatchObject({ entryPlaced: 1, entryFilled: 1, tpPlaced: 0 });
  }, 30_000);

  it("期限 (主時間足 = 60 秒) まで約定しなければ取り消し、仮想トレード limit_unfilled を記録する", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.currency = "USD";
    const { rt, store, feed, tick, untilLimit, clock } = await runtime({ live: broker });
    const pl = await untilLimit();
    expect(pl.limit!.expiresAt - pl.createdAt).toBe(60_000);
    feed.override.set(SYM, { bid: pl.limit!.price + 1, ask: pl.limit!.price + 2 });
    while (clock.t < pl.limit!.expiresAt + 5_000) await tick();
    const placed = broker.placed.find((r) => r.clientId === pl.clientId)!;
    expect(placed).toBeDefined();
    expect(broker.canceled.length).toBeGreaterThanOrEqual(1);
    expect(rt.engine.positions.pendingOrders().some((o) => o.clientId === pl.clientId)).toBe(false);
    expect(audits(store, "engine.limit_unfilled")[0]).toMatchObject({ clientId: pl.clientId, cause: "expired" });
    const sh = shadowOpen(store, "live").filter((x) => x.reason === "limit_unfilled");
    expect(sh).toHaveLength(1);
    expect(sh[0].entryTs).toBe(pl.createdAt);
    expect(rt.engine.positions.list()).toHaveLength(0);
    expect(readLimitStats(store, "live")).toMatchObject({ entryExpired: 1 });
  }, 30_000);
});

describe("新規を止める理由で待っている指値のエントリーを取り消す", () => {
  it("気配が古いときは損切り価格の越えを判定せず、気配の古さ (market_data) で取り消す", async () => {
    const { rt, store, feed, tick, untilLimit } = await runtime();
    const pl = await untilLimit();
    // 損切りより下の買い気配だが 40 秒前の気配 (maxQuoteAgeMs 30 秒より古い)。売り気配は指値より上 (約定しない)
    feed.override.set(SYM, { bid: pl.limit!.stopLoss * 0.999, ask: pl.limit!.price + 1 });
    feed.quoteAgeMs.set(SYM, 40_000);
    await tick();
    expect(audits(store, "engine.limit_unfilled")[0]).toMatchObject({ clientId: pl.clientId, cause: "market_data" });
    expect(readLimitStats(store, "paper").entryCanceled).toEqual({ market_data: 1 });
    expect(rt.brokerSet.paper!.openOrders()).toHaveLength(0);
    expect(shadowOpen(store).filter((x) => x.reason === "limit_unfilled")).toHaveLength(0);
  }, 30_000);

  it("気配の取得に失敗した銘柄の指値を取り消す (market_data)", async () => {
    const { rt, store, feed, tick, untilLimit } = await runtime();
    const pl = await untilLimit();
    feed.failQuote.add(SYM);
    await tick();
    expect(audits(store, "engine.limit_unfilled")[0]).toMatchObject({ clientId: pl.clientId, cause: "market_data" });
    expect(rt.engine.positions.pendingOrders()).toHaveLength(0);
  }, 30_000);

  it("口座情報を取得できない (account_unavailable) 間は取り消す", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.currency = "USD";
    const { rt, store, feed, tick, untilLimit } = await runtime({ live: broker });
    const pl = await untilLimit();
    feed.override.set(SYM, { bid: pl.limit!.price + 1, ask: pl.limit!.price + 2 });
    broker.failAccount = true;
    for (let k = 0; k < 6 && !audits(store, "engine.limit_unfilled").length; k++) await tick();
    expect(audits(store, "engine.limit_unfilled")[0]).toMatchObject({ clientId: pl.clientId, cause: "account_unavailable" });
    expect(broker.canceled).toHaveLength(1);
    expect(rt.engine.positions.pendingOrders()).toHaveLength(0);
  }, 30_000);

  it("状態不明 (escalated) になった指値は order_unknown で取消を依頼し、照会できない間は追跡から外さない", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.currency = "USD";
    const { rt, store, feed, tick, untilLimit } = await runtime({ live: broker, env: { LIMIT_ENTRY_TIMEOUT_MS: "900000" } });
    const pl = await untilLimit();
    feed.override.set(SYM, { bid: pl.limit!.price + 1, ask: pl.limit!.price + 2 });
    broker.getOrderMode = "throw";
    for (let k = 0; k < 20; k++) await tick();
    const cur = rt.engine.positions.pendingOrders().find((o) => o.clientId === pl.clientId);
    // 照会できないまま: 建玉では「約定なし」でも、板に無いことを確かめられないので確定しない
    expect(cur).toBeDefined();
    expect(cur!.escalated).toBe(true);
    expect(cur!.limit!.cancelReason).toBe("order_unknown");
    expect((await rt.engine.status()).risk.entriesPaused).toBeDefined();
    expect(audits(store, "order.limit_unconfirmed").length).toBeGreaterThan(0);
    expect(audits(store, "order.resolved_by_position")).toHaveLength(0);
    // 照会が回復: 取消済み (canceled) を確かめてから外す
    broker.getOrderMode = "normal";
    await tick();
    expect(rt.engine.positions.pendingOrders().some((o) => o.clientId === pl.clientId)).toBe(false);
    expect(audits(store, "engine.limit_unfilled")[0]).toMatchObject({ clientId: pl.clientId, cause: "order_unknown" });
    expect(rt.engine.positions.escalatedOrders()).toHaveLength(0);
  }, 30_000);
});

describe("指値の取消の照会で一部約定が分かった銘柄", () => {
  it("同じティックでほかの戦略を「保有なし」として評価しない (古い pos のまま新規の判定・発注をしない)", async () => {
    const broker = new FakeLiveBroker("paper");
    broker.currency = "USD";
    const state = { dir: "long" as "long" | "short" };
    /** ほかの戦略が「保有なし」として評価されたときに、実際には建玉があった回数 */
    const probe = { hasPosition: () => false, staleEvals: 0 };
    const other: Strategy = {
      ...testStrategy({ dir: "long" }),
      id: "lim_other",
      evaluate(ctx: StrategyContext): Signal | null {
        if (ctx.position) return null;
        if (probe.hasPosition()) probe.staleEvals++;
        const px = ctx.market.quote.ask;
        return {
          strategyId: "lim_other", horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: "long", confidence: 0.8, expectedEdgeBps: 100,
          entry: { type: "market" }, stopLoss: px * 0.98, takeProfit: px * 1.01, maxHoldMs: 60 * MIN, reason: "test", features: { x: 1 },
        };
      },
    };
    const { rt, store, feed, tick, untilLimit } = await runtime({ paperFake: broker, strategies: [testStrategy(state), other] });
    probe.hasPosition = () => rt.engine.positions.list().length > 0;
    const pl = await untilLimit();
    expect(pl.entry?.input.strategyId).toBe("lim_test");
    feed.override.set(SYM, { bid: pl.limit!.price + 1, ask: pl.limit!.price + 2 });
    const req = broker.placed.find((r) => r.clientId === pl.clientId)!;
    const half = (Math.floor((Number(req.qty) / 2) * 1e4) / 1e4).toString();
    broker.fill(pl.clientId, { qty: half, price: pl.limit!.price, status: "partially_filled" });
    const rejectedBefore = shadowOpen(store).filter((x) => x.reason === "order_rejected").length;
    // 発注した戦略が逆方向のシグナル → 取消 → 照会で一部約定 → 建玉
    state.dir = "short";
    for (let k = 0; k < 13 && rt.engine.positions.list().length === 0; k++) await tick();
    const pos = rt.engine.positions.list();
    expect(pos).toHaveLength(1);
    expect(pos[0].qty).toBeCloseTo(Number(half), 8);
    expect(audits(store, "engine.entry")[0]).toMatchObject({ canceled: "opposite_signal" });
    expect(probe.staleEvals).toBe(0);
    expect(shadowOpen(store).filter((x) => x.reason === "order_rejected").length).toBe(rejectedBefore);
    expect(broker.placed.filter((r) => !r.reduceOnly)).toHaveLength(1);
  }, 30_000);
});
