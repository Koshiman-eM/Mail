/**
 * エンジン統合: エントリー頻度の目標 (テンポ, TARGET_ENTRIES_PER_HOUR) と最大保有 (MAX_HOLD_MINUTES)。
 * 合成データ・PaperBroker、live の経路は偽のブローカー (FakeLiveBroker)。実在の取引所へは送信しない (オフライン)。
 */
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/core/config";
import type {
  Candle, Clock, Horizon, Instrument, MarketDataFeed, Quote, RegimeLabel, Signal, Strategy, StrategyContext, Timeframe, TradeRecord,
} from "../src/core/types";
import { buildRuntime } from "../src/engine/setup";
import { formatSimulationReport, runSimulation } from "../src/engine/simulate";
import type { BrokerSet } from "../src/execution/router";
import { armKey, armStateKey, type ArmState } from "../src/learning/allocator";
import type { EntryParams } from "../src/risk/manager";
import { mulberry32, SyntheticFeed } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";
import { FakeLiveBroker } from "./helpers/fakeLiveBroker";

const MIN = 60_000;
const START = Date.UTC(2026, 0, 5);
const SYM = "BTC/USDT";
const LABELS: RegimeLabel[] = ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"];

/** 戦略が受け取ったテンポ (新規エントリーの評価と保有中の評価を分けて記録する) */
interface Seen {
  entry: { tempo?: number; tempoExplore?: boolean; hasTempo: boolean; hasExplore: boolean; now: number }[];
  owner: { hasTempo: boolean; hasExplore: boolean }[];
}

interface ProbeOpts {
  id?: string;
  horizon?: Horizon;
  /** 損切り・利確 (エントリー価格比) */
  pct?: number;
  /** シグナルの最大保有 (分。0 = 時間切れなし) */
  holdMin?: number;
  /** 期待値 (bps) とコスト控除後か */
  edge?: number;
  edgeIsNet?: boolean;
  /** この時刻より前はシグナルを出さない */
  from?: number;
  entryOrder?: "market" | "limit";
}

/** BTC/USDT にだけ、建玉が無ければ買いのシグナルを出す戦略。受け取った ctx.tempo / ctx.tempoExplore を記録する */
function probe(seen: Seen, o: ProbeOpts = {}): Strategy {
  const id = o.id ?? "tempo_probe";
  const horizon = o.horizon ?? "scalp";
  const pct = o.pct ?? 0.05;
  return {
    id, horizon, assetClasses: ["crypto"], regimes: [...LABELS], primaryTimeframe: "1m", timeframes: ["1m", "1h"],
    warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    ...(o.entryOrder ? { entryOrder: o.entryOrder } : {}),
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.market.instrument.symbol !== SYM) return null;
      if (ctx.position) {
        seen.owner.push({ hasTempo: "tempo" in ctx, hasExplore: "tempoExplore" in ctx });
        return null;
      }
      seen.entry.push({ tempo: ctx.tempo, tempoExplore: ctx.tempoExplore, hasTempo: "tempo" in ctx, hasExplore: "tempoExplore" in ctx, now: ctx.market.now });
      if (o.from !== undefined && ctx.market.now < o.from) return null;
      const px = ctx.market.quote.ask;
      return {
        strategyId: id, horizon, symbol: SYM, direction: "long", confidence: 0.8, expectedEdgeBps: o.edge ?? 500,
        ...(o.edgeIsNet ? { edgeIsNet: true } : {}),
        entry: { type: "market" }, stopLoss: px * (1 - pct), takeProfit: px * (1 + pct), maxHoldMs: (o.holdMin ?? 120) * MIN,
        reason: `test ${id}`, features: { x: 1 },
      };
    },
  };
}

const newSeen = (): Seen => ({ entry: [], owner: [] });

async function setup(strategies: Strategy[], env: Record<string, string>, store = new MemoryStore()) {
  const clock: Clock & { t: number } = { t: START, now() { return this.t; } };
  let rngCalls = 0;
  const base = mulberry32(7);
  const rng = () => { rngCalls++; return base(); };
  const rt = await buildRuntime(
    loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY", OBSERVE_ONLY_STRATEGIES: "", ...env }),
    { clock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, rng, strategies },
  );
  const riskParams: EntryParams[] = [];
  const orig = rt.risk.evaluateEntry.bind(rt.risk);
  rt.risk.evaluateEntry = ((p: EntryParams) => { riskParams.push(p); return orig(p); }) as typeof rt.risk.evaluateEntry;
  const run = async (from: number, to: number, step = 15_000) => {
    let entries = 0;
    for (let now = from; now <= to; now += step) {
      clock.t = now;
      entries += (await rt.engine.tick(now)).entries;
    }
    return entries;
  };
  return { rt, store, clock, run, riskParams, rngCalls: () => rngCalls };
}

const entryAudits = (store: MemoryStore) => store.listAudit({ type: "engine.entry" }).map((a) => a.data as Record<string, unknown>);
const shadowReasons = (rt: Awaited<ReturnType<typeof setup>>["rt"], store: MemoryStore) => [
  ...rt.engine.shadow!.list().map((o) => o.reason),
  ...store.listShadowTrades().map((t) => t.reason),
];

describe("エンジン: テンポ (TARGET_ENTRIES_PER_HOUR)", () => {
  it("無効 (既定): 戦略にも RiskManager にも tempo を渡さない。status は無効", async () => {
    const seen = newSeen();
    const { rt, run, riskParams } = await setup([probe(seen)], { LIMIT_ENTRY: "false" });
    expect(rt.engine.tempo).toBeUndefined();
    await run(START, START + 3 * MIN);
    expect(seen.entry.length).toBeGreaterThanOrEqual(1);
    expect(seen.entry.every((e) => !e.hasTempo && !e.hasExplore)).toBe(true);
    expect(riskParams.length).toBeGreaterThanOrEqual(1);
    expect(riskParams.every((p) => !("tempo" in p) && !("tempoExplore" in p))).toBe(true);
    // 取引の印も付けない
    const pos = rt.engine.positions.list()[0];
    expect(pos.entryContext.features).toEqual({ x: 1 });
    const st = await rt.engine.status();
    expect(st.tempo).toMatchObject({ enabled: false, target: 0, capped: false, exploreAllowed: true });
    expect(st.maxHoldMinutes).toBe(0);
  });

  it("有効: 新規エントリーの評価と evaluateEntry にだけ tempo と tempoExplore (paper は true) を渡す。保有中の評価には渡さない", async () => {
    const seen = newSeen();
    const { rt, run, riskParams } = await setup([probe(seen)], { LIMIT_ENTRY: "false", TARGET_ENTRIES_PER_HOUR: "6" });
    expect(rt.engine.tempo?.targetPerHour).toBe(6);
    await run(START, START + 4 * MIN);
    expect(seen.entry.length).toBeGreaterThanOrEqual(1);
    for (const e of seen.entry) {
      expect(typeof e.tempo).toBe("number");
      expect(e.tempo).toBeGreaterThanOrEqual(0);
      expect(e.tempo).toBeLessThanOrEqual(1);
      expect(e.tempoExplore).toBe(true);
    }
    expect(seen.owner.length).toBeGreaterThanOrEqual(1);
    expect(seen.owner.every((o) => !o.hasTempo && !o.hasExplore)).toBe(true);
    expect(riskParams.length).toBeGreaterThanOrEqual(1);
    for (const p of riskParams) {
      expect(typeof p.tempo).toBe("number");
      expect(p.tempoExplore).toBe(true);
    }
    // 取引にはエントリー時のテンポを残す (探索ではないので tempoExplore は付けない)
    const pos = rt.engine.positions.list()[0];
    expect(typeof pos.entryContext.features.tempoLevel).toBe("number");
    expect(pos.entryContext.features.tempoExplore).toBeUndefined();
    const st = await rt.engine.status();
    expect(st.tempo).toMatchObject({ enabled: true, target: 6, entriesInWindow: 1, capAt: 12, capped: false, exploreAllowed: true });
  });

  it("成行の約定で recordEntry を 1 回だけ呼ぶ (エントリーの時刻で)", async () => {
    const seen = newSeen();
    const { rt, store, run, clock } = await setup([probe(seen, { entryOrder: "market" })], { TARGET_ENTRIES_PER_HOUR: "6" });
    const spy = vi.spyOn(rt.engine.tempo!, "recordEntry");
    let openedAt: number | undefined;
    for (let now = START; now <= START + 4 * MIN; now += 15_000) {
      clock.t = now;
      await rt.engine.tick(now);
      if (openedAt === undefined && rt.engine.positions.list().length) openedAt = now;
    }
    expect(entryAudits(store)).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(openedAt);
    expect(rt.engine.tempoStatus(clock.t).entriesInWindow).toBe(1);
  });

  it("上限: 直近 1 時間のエントリーが 目標 × TEMPO_CAP_MULTIPLIER に達したら tempo_cap で見送り、仮想トレードを記録する", async () => {
    const seen = newSeen();
    // 目標 1 回/時 × 1 = 1 回で上限。1 分の時間切れで決済させ、次のシグナルを出させる
    const { rt, store, run } = await setup([probe(seen, { holdMin: 1 })], { LIMIT_ENTRY: "false", TARGET_ENTRIES_PER_HOUR: "1", TEMPO_CAP_MULTIPLIER: "1" });
    await run(START, START + 6 * MIN);
    expect(entryAudits(store)).toHaveLength(1);
    expect(store.listTrades()).toHaveLength(1);
    expect(rt.engine.positions.list()).toHaveLength(0);
    expect(shadowReasons(rt, store)).toContain("tempo_cap");
    const skips = store.listAudit({ type: "engine.skip_summary" }).map((a) => (a.data.reasons as Record<string, { count: number }>)["tempo_cap"]?.count ?? 0);
    expect(skips.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
    const st = await rt.engine.status();
    expect(st.tempo).toMatchObject({ enabled: true, capped: true, capAt: 1, entriesInWindow: 1 });
  });

  it("再起動: この mode の直近 1 時間の取引のエントリー時刻から復元する (古い取引・別の mode は数えない)", async () => {
    const store = new MemoryStore();
    for (const [id, entryMin, mode] of [["a", -50, "paper"], ["b", -30, "paper"], ["c", -10, "paper"], ["old", -90, "paper"], ["lv", -20, "live"]] as const) {
      store.saveTrade(trade(id, START + entryMin * MIN, mode));
    }
    const { rt } = await setup([probe(newSeen())], { TARGET_ENTRIES_PER_HOUR: "6" }, store);
    await rt.engine.init();
    const st = rt.engine.tempoStatus(START);
    expect(st.entriesInWindow).toBe(3);
    expect(st.minutesSinceLastEntry).toBeCloseTo(10, 9);
    // 3 回 (目標 6 回) で、最後のエントリーから 10 分 → まだ 0。15 分で deficit 0.5 × wait 0.5
    expect(st.tempo).toBe(0);
    expect(rt.engine.tempoStatus(START + 5 * MIN).tempo).toBeCloseTo(0.5 * 0.5, 9);
  });

  it("探索: コスト控除後の期待値 ≤ 0 のシグナルはサイズを TEMPO_EXPLORE_SIZE 倍にし、取引に印を付ける", async () => {
    const env = { LIMIT_ENTRY: "false", TARGET_ENTRIES_PER_HOUR: "60" };
    // 目標 60 回/時 (間隔 1 分): 2 分エントリーが無ければテンポ 1 → RiskManager の下限は -1 × コスト
    const from = START + 3 * MIN;
    const ex = await setup([probe(newSeen(), { edge: -1, edgeIsNet: true, from })], env);
    await ex.run(START, START + 5 * MIN);
    const base = await setup([probe(newSeen(), { edge: 500, edgeIsNet: true, from })], env);
    await base.run(START, START + 5 * MIN);
    const exP = ex.riskParams.find((p) => p.signal.expectedEdgeBps === -1)!;
    const baseP = base.riskParams.find((p) => p.signal.expectedEdgeBps === 500)!;
    expect(exP.tempo).toBe(1);
    expect(exP.tempoExplore).toBe(true);
    expect(exP.riskMultiplier).toBeCloseTo(0.5 * baseP.riskMultiplier, 12);
    const pos = ex.rt.engine.positions.list()[0];
    expect(pos).toBeDefined();
    expect(pos.entryContext.features.tempoExplore).toBe(1);
    expect(pos.entryContext.features.tempoLevel).toBe(1);
    expect(pos.entryContext.riskMultiplier).toBeCloseTo(exP.riskMultiplier, 12);
    expect(entryAudits(ex.store)[0]).toMatchObject({ tempo: { level: 1, explore: true, exploreSize: 0.5 } });
    // 通常のシグナルには印を付けない
    expect(base.rt.engine.positions.list()[0].entryContext.features.tempoExplore).toBeUndefined();
    // 探索の印があっても、テンポが無効なら期待値 ≤ 0 は従来どおり RiskManager が拒否する
    const off = await setup([probe(newSeen(), { edge: -1, edgeIsNet: true, from })], { LIMIT_ENTRY: "false" });
    await off.run(START, START + 5 * MIN);
    expect(off.rt.engine.positions.list()).toHaveLength(0);
    expect(off.riskParams.every((p) => p.riskMultiplier === baseP.riskMultiplier)).toBe(true);
  });

  it("TEMPO_EXPLORE_SIZE で探索のサイズを変えられる", async () => {
    const env = { LIMIT_ENTRY: "false", TARGET_ENTRIES_PER_HOUR: "60" };
    const from = START + 3 * MIN;
    const ex = await setup([probe(newSeen(), { edge: -1, edgeIsNet: true, from })], { ...env, TEMPO_EXPLORE_SIZE: "0.2" });
    await ex.run(START, START + 5 * MIN);
    const base = await setup([probe(newSeen(), { edge: 500, edgeIsNet: true, from })], env);
    await base.run(START, START + 5 * MIN);
    const exP = ex.riskParams.find((p) => p.signal.expectedEdgeBps === -1)!;
    const baseP = base.riskParams.find((p) => p.signal.expectedEdgeBps === 500)!;
    expect(exP.riskMultiplier).toBeCloseTo(0.2 * baseP.riskMultiplier, 12);
  });
});

describe("エンジン: 最大保有 (MAX_HOLD_MINUTES)", () => {
  it("scalp・short はシグナルの最大保有を上限までに縮める (時間切れなし = 0 も上限にする)", async () => {
    const a = await setup([probe(newSeen(), { holdMin: 120 })], { LIMIT_ENTRY: "false", MAX_HOLD_MINUTES: "30" });
    await a.run(START, START + 2 * MIN);
    const p = a.rt.engine.positions.list()[0];
    expect(a.rt.engine.positions.planOf(p.id).maxHoldMs).toBe(30 * MIN);
    expect((await a.rt.engine.status()).maxHoldMinutes).toBe(30);
    const b = await setup([probe(newSeen(), { horizon: "short", holdMin: 0 })], { LIMIT_ENTRY: "false", MAX_HOLD_MINUTES: "30" });
    await b.run(START, START + 2 * MIN);
    const q = b.rt.engine.positions.list()[0];
    expect(b.rt.engine.positions.planOf(q.id).maxHoldMs).toBe(30 * MIN);
    // 上限より短ければそのまま
    const c = await setup([probe(newSeen(), { holdMin: 10 })], { LIMIT_ENTRY: "false", MAX_HOLD_MINUTES: "30" });
    await c.run(START, START + 2 * MIN);
    expect(c.rt.engine.positions.planOf(c.rt.engine.positions.list()[0].id).maxHoldMs).toBe(10 * MIN);
    // 無効なら従来どおり
    const d = await setup([probe(newSeen(), { holdMin: 120 })], { LIMIT_ENTRY: "false" });
    await d.run(START, START + 2 * MIN);
    expect(d.rt.engine.positions.planOf(d.rt.engine.positions.list()[0].id).maxHoldMs).toBe(120 * MIN);
  });

  it("mid / long は発注せず (RiskManager・腕の乱数に触れず)、仮想トレード hold_limit としてだけ記録する", async () => {
    for (const horizon of ["mid", "long"] as const) {
      const seen = newSeen();
      const { rt, store, run, riskParams, rngCalls } = await setup([probe(seen, { id: `p_${horizon}`, horizon })], { LIMIT_ENTRY: "false", MAX_HOLD_MINUTES: "30" });
      expect(await run(START, START + 3 * MIN)).toBe(0);
      expect(entryAudits(store)).toHaveLength(0);
      expect(riskParams).toHaveLength(0);
      expect(rngCalls()).toBe(0);
      const open = rt.engine.shadow!.list();
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ reason: "hold_limit", strategyId: `p_${horizon}`, symbol: SYM, direction: "long" });
      // 戦略のシグナルのまま記録する (保有は縮めない)
      expect(open[0].maxHoldMs).toBe(120 * MIN);
    }
    // 無効なら mid も通常どおり発注する
    const { run } = await setup([probe(newSeen(), { horizon: "mid" })], { LIMIT_ENTRY: "false" });
    expect(await run(START, START + 3 * MIN)).toBeGreaterThanOrEqual(1);
  });

  it("hold_limit の仮想トレードは observe_only と同じく腕の配分に入る (実取引の統計には入らない)", async () => {
    const { store, run } = await setup([probe(newSeen(), { id: "p_mid", horizon: "mid", pct: 0.0005 })], { LIMIT_ENTRY: "false", MAX_HOLD_MINUTES: "30" });
    await run(START, START + 10 * MIN);
    const closed = store.listShadowTrades().filter((t) => t.strategyId === "p_mid");
    expect(closed.length).toBeGreaterThanOrEqual(1);
    expect(closed.every((t) => t.reason === "hold_limit")).toBe(true);
    const states = LABELS.map((l) => store.kvGet<ArmState>(armStateKey("paper", armKey("p_mid", l, "crypto")))).filter((a): a is ArmState => !!a);
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states.reduce((s, a) => s + (a.shadowN ?? 0), 0)).toBe(closed.length);
    for (const a of states) {
      expect(a.realN ?? 0).toBe(0);
      expect(a.n).toBe(0);
      expect(a.disabled).toBe(false);
      expect(a.wN).toBeCloseTo(0.25 * (a.shadowN ?? 0), 9);
    }
  });
});

// ───────── 指値の約定 (paper) と live の探索 ─────────

class ControlledFeed implements MarketDataFeed {
  readonly venue = "paper";
  readonly override = new Map<string, { bid: number; ask: number }>();
  constructor(private readonly inner: SyntheticFeed, private readonly clock: Clock) {}
  listInstruments(): Promise<Instrument[]> {
    return this.inner.listInstruments();
  }
  fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    return this.inner.fetchCandles(symbol, tf, limit, since);
  }
  async fetchQuote(symbol: string): Promise<Quote> {
    const o = this.override.get(symbol);
    return o ? { ts: this.clock.now(), ...o } : this.inner.fetchQuote(symbol);
  }
}

async function single(o: { env?: Record<string, string>; strategy: Strategy; live?: FakeLiveBroker }) {
  const clock: Clock & { t: number } = { t: START, now() { return this.t; } };
  const store = new MemoryStore();
  const feed = new ControlledFeed(new SyntheticFeed({ clock, seed: 3, historyMs: 2 * 86_400_000 }), clock);
  const instruments = [(await feed.listInstruments()).find((i) => i.symbol === SYM)!];
  const live = o.live;
  const brokerSet: BrokerSet | undefined = live
    ? { mode: "live", brokers: new Map([[live.venue, live]]), brokerFor: () => live }
    : undefined;
  const config = loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "USD", ...(o.env ?? {}) });
  const rt = await buildRuntime(config, {
    clock, store, intelSources: [], ai: null, rng: mulberry32(7), strategies: [o.strategy], markets: [{ feed, instruments }],
    ...(brokerSet ? { brokerSet } : {}),
    engine: { liveAccountCacheMs: 0 },
  });
  if (live) live.quoteOf = (s) => rt.hub.latestQuote(s);
  const riskParams: EntryParams[] = [];
  const orig = rt.risk.evaluateEntry.bind(rt.risk);
  rt.risk.evaluateEntry = ((p: EntryParams) => { riskParams.push(p); return orig(p); }) as typeof rt.risk.evaluateEntry;
  const tick = async (dt = 5_000) => {
    clock.t += dt;
    return rt.engine.tick(clock.t);
  };
  return { rt, clock, store, feed, tick, riskParams };
}

describe("エンジン: テンポと指値・live", () => {
  it("指値のエントリーは置いただけでは数えず、約定して建玉になったときに 1 回だけ recordEntry する", async () => {
    const { rt, clock, feed, tick } = await single({ strategy: probe(newSeen(), { entryOrder: "limit" }), env: { TARGET_ENTRIES_PER_HOUR: "6" } });
    const spy = vi.spyOn(rt.engine.tempo!, "recordEntry");
    for (let k = 0; k < 40 && !rt.engine.positions.pendingLimitEntry(SYM); k++) await tick();
    const pl = rt.engine.positions.pendingLimitEntry(SYM);
    expect(pl).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
    const L = pl!.limit!.price;
    feed.override.set(SYM, { bid: L - 5, ask: L - 0.5 });
    await tick();
    expect(rt.engine.positions.list()).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(clock.t);
    for (let k = 0; k < 5; k++) await tick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(rt.engine.tempoStatus(clock.t).entriesInWindow).toBe(1);
  }, 30_000);

  it("live: TEMPO_ALLOW_LIVE_EXPLORE が無ければ tempoExplore は false、true なら true (戦略・RiskManager とも)", async () => {
    for (const [allow, want] of [[undefined, false], ["true", true]] as const) {
      const broker = new FakeLiveBroker("paper");
      broker.currency = "USD";
      const seen = newSeen();
      const env: Record<string, string> = { TARGET_ENTRIES_PER_HOUR: "6", LIMIT_ENTRY: "false", ...(allow ? { TEMPO_ALLOW_LIVE_EXPLORE: allow } : {}) };
      const { rt, tick, riskParams } = await single({ strategy: probe(seen), live: broker, env });
      expect(rt.engine.mode).toBe("live");
      for (let k = 0; k < 20 && riskParams.length === 0; k++) await tick();
      expect(seen.entry.length).toBeGreaterThanOrEqual(1);
      expect(seen.entry.every((e) => e.tempoExplore === want)).toBe(true);
      expect(riskParams.length).toBeGreaterThanOrEqual(1);
      expect(riskParams.every((p) => p.tempoExplore === want && typeof p.tempo === "number")).toBe(true);
      expect(rt.engine.tempoStatus().exploreAllowed).toBe(want);
    }
  }, 30_000);
});

function trade(id: string, entryTs: number, mode: "paper" | "live"): TradeRecord {
  return {
    id, mode, symbol: SYM, venue: "paper", assetClass: "crypto", strategyId: "tempo_probe", horizon: "scalp", direction: "long", qty: 1,
    entryTs, entryPrice: 100, intendedEntryPrice: 100, exitTs: entryTs + 5 * MIN, exitPrice: 101, intendedExitPrice: 101, initialStop: 99,
    grossPnl: 1, fees: 0.1, netPnl: 0.9, returnPct: 0.009, rMultiple: 0.9, mfePct: 0.012, maePct: 0.002, exitReason: "take_profit",
    entryContext: {
      regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
      confidence: 0.6, expectedEdgeBps: 30, costBps: 10, params: { stopAtr: 1 }, features: {}, riskMultiplier: 1, reason: "test",
    },
  };
}

describe("simulate: テンポ・最大保有の環境変数", () => {
  it("TARGET_ENTRIES_PER_HOUR / MAX_HOLD_MINUTES を反映し、1 時間あたりのエントリー数とテンポの状態を出す", async () => {
    const store = new MemoryStore();
    // 最大保有 = 時間切れ (従来) を確かめるため読みの管理は無効にする (有効時は下のテスト)
    const { report } = await runSimulation({
      hours: 2, stepMs: 30_000, seed: 2, store, env: { NODE_ENV: "test", TARGET_ENTRIES_PER_HOUR: "6", MAX_HOLD_MINUTES: "30", THESIS_EXIT: "false" },
    });
    const tp = report.tempo!;
    expect(tp.status).toMatchObject({ enabled: true, target: 6, exploreAllowed: true });
    expect(tp.maxHoldMinutes).toBe(30);
    expect(tp.entriesPerHour).toBeCloseTo(tp.entries / 2, 9);
    expect(tp.byTempo.reduce((a, r) => a + r.trades, 0)).toBe(report.trades);
    // 中期・長期は発注しない。ほかの取引は 30 分 (+ 判定の刻み) 以内に決済する
    const trades = store.listTrades();
    expect(trades.every((t) => t.horizon !== "mid" && t.horizon !== "long")).toBe(true);
    expect(trades.every((t) => t.exitTs - t.entryTs <= 30 * MIN + 30_000)).toBe(true);
    // テンポのモードの取引にはエントリー時のテンポが残る
    expect(trades.every((t) => typeof t.entryContext.features.tempoLevel === "number")).toBe(true);
    const text = formatSimulationReport(report);
    expect(text).toMatch(/エントリー頻度: \d+ 回 \(平均 [\d.]+ 回\/時 \/ 目標 6 回\/時\)/);
    expect(text).toContain("テンポ: 目標 6 回/時・直近 1 時間");
    expect(text).toContain("最大保有 30 分");
    expect(text).toContain("■ テンポの探索と通常のエントリー");
  }, 60_000);

  it("読みの管理が有効なら MAX_HOLD_MINUTES は読みの期限: 利益が出ている建玉は 期限 × THESIS_EXTEND_MULT まで持ち、答え合わせの表を出す", async () => {
    const store = new MemoryStore();
    const { report } = await runSimulation({
      hours: 3, stepMs: 30_000, seed: 2, store, env: { NODE_ENV: "test", TARGET_ENTRIES_PER_HOUR: "6", MAX_HOLD_MINUTES: "30", THESIS_EXTEND_MULT: "2" },
    });
    const trades = store.listTrades();
    expect(trades.length).toBeGreaterThan(0);
    // 上限は 30 分 × 2 (+ 判定の刻み)。読みの管理の記録が全取引に付く (期限 30 分以内)
    expect(trades.every((t) => t.exitTs - t.entryTs <= 60 * MIN + 30_000)).toBe(true);
    expect(trades.every((t) => t.thesisOutcome !== undefined && t.thesisExpectedMs! <= 30 * MIN && t.thesisDeadlineTs === t.entryTs + t.thesisExpectedMs!)).toBe(true);
    expect(trades.some((t) => t.exitReason === "time")).toBe(false);
    // 期限を過ぎて保有した取引は延長したものだけ
    expect(trades.filter((t) => t.exitTs > t.thesisDeadlineTs! + 30_000).every((t) => t.thesisOutcome === "extended")).toBe(true);
    expect(report.thesis?.settings).toMatchObject({ enabled: true, extendMult: 2 });
    expect(report.thesis!.summary.rows.reduce((a, r) => a + r.trades, 0)).toBe(trades.length);
    const text = formatSimulationReport(report);
    expect(text).toContain("■ 読みの答え合わせ (読みの管理 有効");
    expect(text).toContain("期限での的中率");
  }, 90_000);

  it("環境変数が無ければテンポ・最大保有は無効 (表示だけ)", async () => {
    const { report } = await runSimulation({ hours: 1, stepMs: 30_000, seed: 2, store: new MemoryStore(), env: { NODE_ENV: "test" } });
    expect(report.tempo!.status.enabled).toBe(false);
    expect(report.tempo!.maxHoldMinutes).toBe(0);
    expect(formatSimulationReport(report)).toContain("テンポ: 無効 (TARGET_ENTRIES_PER_HOUR=0)・最大保有 無効");
  }, 60_000);
});
