import { describe, expect, it, vi } from "vitest";
import { LIVE_CONFIRM_PHRASE, loadConfig } from "../src/appConfig";
import type { AssetClass, Clock, MarketDataFeed, Signal, Strategy, StrategyContext, StrategyPlan } from "../src/core/types";
import { PAPER_SNAPSHOT_KEY } from "../src/engine/engine";
import { buildRuntime, type RuntimeOptions } from "../src/engine/setup";
import { PaperBroker } from "../src/execution/paper";
import { defaultSyntheticSpecs, mulberry32, SyntheticFeed } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";
import { RESUME_REQUEST_KEY, requestResume } from "../src/risk/resumeRequest";

const MIN = 60_000;
const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 5);

const mkClock = (t = START): Clock & { t: number } => ({ t, now() { return this.t; } });
/** 既定の監視銘柄は PEPE/USDT を除く 2 銘柄 (PEPE は crypto に分類したので、crypto の試験の銘柄数を変えないため。使う試験は WATCHLIST で指定する) */
const DEFAULT_TEST_WATCHLIST = "synthetic|BTC/USDT,synthetic|ETH/USDT";
const testConfig = (env: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: "test", LIMIT_ENTRY: "false", LIMIT_TAKE_PROFIT: "false", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY",
    WATCHLIST: DEFAULT_TEST_WATCHLIST, ...env,
  });

/** 常に同じ方向のシグナルを出すテスト用戦略 (保有中は何もしない) */
function fixedStrategy(id: string, o: { classes: AssetClass[]; direction?: "long" | "short"; confidence?: number; edge?: number; stopPct?: number; flatWhenHolding?: boolean }): Strategy {
  return {
    id,
    horizon: "scalp",
    assetClasses: o.classes,
    regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    primaryTimeframe: "1m",
    timeframes: ["1m", "1h"],
    warmup: 1,
    defaultParams: { stopAtr: 1 },
    paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      const dir = o.direction ?? "long";
      if (ctx.position) {
        return o.flatWhenHolding
          ? { strategyId: id, horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: "flat", confidence: 1, expectedEdgeBps: 0, entry: { type: "market" }, stopLoss: 0, maxHoldMs: 0, reason: "flat", features: {} }
          : null;
      }
      const px = dir === "long" ? ctx.market.quote.ask : ctx.market.quote.bid;
      const stopPct = o.stopPct ?? 0.02;
      return {
        strategyId: id, horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: dir, confidence: o.confidence ?? 0.8,
        expectedEdgeBps: o.edge ?? 200, entry: { type: "market" }, stopLoss: dir === "long" ? px * (1 - stopPct) : px * (1 + stopPct),
        maxHoldMs: 30 * MIN, reason: `test ${id}`, features: { x: 1 },
      };
    },
  };
}

async function runtime(env: Record<string, string> = {}, opts: RuntimeOptions = {}) {
  const clock = (opts.clock as Clock & { t: number }) ?? mkClock();
  const store = opts.store ?? new MemoryStore();
  const rt = await buildRuntime(testConfig(env), {
    clock,
    store,
    intelSources: [],
    ai: null,
    seed: 3,
    syntheticHistoryMs: 2 * 86_400_000,
    rng: mulberry32(7),
    ...opts,
  });
  return { rt, clock: clock as Clock & { t: number }, store: rt.store as MemoryStore };
}

/** skip_summary の監査ログを集計 */
function skipCounts(store: MemoryStore): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of store.listAudit({ type: "engine.skip_summary" })) {
    for (const [k, v] of Object.entries((a.data as { reasons: Record<string, { count: number }> }).reasons)) out[k] = (out[k] ?? 0) + v.count;
  }
  return out;
}

describe("TradingEngine 統合 (合成データ + 仮想時計 + MemoryStore)", () => {
  it("既定の戦略で仮想 8 時間: 決済・要因分析・腕の更新・評価額の記録・paper のみ", async () => {
    // 合成データの全銘柄 (BTC/ETH/PEPE。暗号資産だけ) で動かす。手数料 0 の FX・株式の合成銘柄を廃止したので、
    // 8 時間で決済が出るシード (4) にする (シード 3 では暗号資産の手数料を越える期待値のシグナルが出ない)
    const { rt, clock, store } = await runtime({ WATCHLIST: "", INTEL_LOOP_MS: String(30 * MIN), LEARN_LOOP_MS: String(HOUR) }, { seed: 4 });
    const { engine } = rt;
    expect(rt.instruments.map((i) => i.symbol)).toEqual(["BTC/USDT", "ETH/USDT", "PEPE/USDT"]);
    for (let now = START; now <= START + 8 * HOUR; now += 30_000) {
      clock.t = now;
      await engine.advance(now);
    }
    await engine.stop();

    const trades = store.listTrades();
    expect(trades.length).toBeGreaterThanOrEqual(1);
    // 全トレードに要因分析
    for (const t of trades) {
      const att = store.getAttribution(t.id);
      expect(att, t.id).toBeDefined();
      expect(att!.causes.length).toBeGreaterThan(0);
      expect(t.mode).toBe("paper");
      expect(t.entryContext.costBps).toBeGreaterThan(0);
      expect(t.intendedExitPrice).toBeGreaterThan(0);
    }
    // 腕の更新 (件数の合計 = 決済数)
    const arms = rt.learning.allocator.snapshot();
    expect(arms.length).toBeGreaterThan(0);
    expect(arms.reduce((s, a) => s + a.n, 0)).toBe(trades.length);
    // 評価額 (60 秒ごと) とスナップショット
    expect(store.listEquity().length).toBeGreaterThanOrEqual(8 * 60);
    expect(store.kvGet(PAPER_SNAPSHOT_KEY)).toBeDefined();
    // 計画・学習ループ
    expect(store.latestPlan()).toBeDefined();
    expect(store.listAudit({ type: "engine.plan" }).length).toBeGreaterThanOrEqual(8);
    expect(store.listAudit({ type: "engine.entry" }).length).toBeGreaterThanOrEqual(trades.length);
    // paper 以外の broker を作らない
    expect(rt.brokerSet.mode).toBe("paper");
    expect(rt.brokerSet.brokers.size).toBe(1);
    expect([...rt.brokerSet.brokers.values()].every((b) => b instanceof PaperBroker && b.mode === "paper")).toBe(true);
  }, 60_000);

  it("live の確認フレーズがあってもテスト中は paper (実口座アダプターを生成しない)", async () => {
    const { rt } = await runtime({ TRADING_MODE: "live", LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE, CCXT_API_KEY: "k", CCXT_SECRET: "s" });
    expect(rt.config.mode).toBe("paper");
    expect(rt.brokerSet.mode).toBe("paper");
    expect([...rt.brokerSet.brokers.values()].every((b) => b instanceof PaperBroker)).toBe(true);
  });

  it("kv の再開要求 (CLI resume) を次のティックで適用し、要求を消して audit に残す", async () => {
    const { rt, clock, store } = await runtime({}, { strategies: [fixedStrategy("noop", { classes: ["crypto"] })] });
    await rt.engine.tick(START);
    rt.risk.trip("テスト停止", START);
    expect(rt.risk.state().killSwitch).toBeDefined();
    // 要求が無ければ解除されない
    clock.t = START + 15_000;
    await rt.engine.tick(clock.t);
    expect(rt.risk.state().killSwitch).toBeDefined();
    // 別プロセスの CLI が書いた要求
    requestResume(store, { at: clock.t, by: "cli" });
    clock.t += 15_000;
    await rt.engine.tick(clock.t);
    expect(rt.risk.state().killSwitch).toBeUndefined();
    expect(store.kvGet(RESUME_REQUEST_KEY)).toBeUndefined();
    const applied = store.listAudit({ type: "engine.resume_request_applied" });
    expect(applied).toHaveLength(1);
    expect(applied[0].data).toMatchObject({ by: "cli", wasKillSwitch: true });
    expect(store.listAudit({ type: "risk.resume" })).toHaveLength(1);
    // 要求は 1 回だけ適用される (再度停止しても勝手に解除されない)
    rt.risk.trip("再停止", clock.t);
    clock.t += 15_000;
    await rt.engine.tick(clock.t);
    expect(rt.risk.state().killSwitch).toBeDefined();
  }, 60_000);

  it("kill switch が新たに発動したら全ポジションを決済し、以後は新規エントリーしない", async () => {
    const strat = fixedStrategy("always_long", { classes: ["crypto"] });
    const { rt, clock, store } = await runtime({ MAX_DRAWDOWN: "0.00001" }, { strategies: [strat] });
    const r1 = await rt.engine.tick(START);
    expect(r1.entries).toBe(2); // BTC/USDT と ETH/USDT
    expect(rt.engine.positions.list()).toHaveLength(2);
    // 手数料・スプレッド分で評価額がピークを僅かでも下回れば発動する
    let tripped = false;
    for (let i = 1; i <= 20 && !tripped; i++) {
      clock.t = START + i * 15_000;
      tripped = (await rt.engine.tick(clock.t)).killSwitchTripped;
    }
    expect(tripped).toBe(true);
    expect(rt.engine.positions.list()).toHaveLength(0);
    expect(await rt.brokerSet.paper!.getPositions()).toEqual([]);
    expect(store.listTrades().map((t) => t.exitReason)).toEqual(["kill_switch", "kill_switch"]);
    expect(store.listAudit({ type: "engine.kill_switch_close" })).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      clock.t += MIN;
      expect((await rt.engine.tick(clock.t)).entries).toBe(0);
    }
    expect(skipCounts(store).halted).toBeGreaterThan(0);
  });

  it("同じ銘柄で複数の戦略がシグナルを出したら confidence × 腕の重み × 期待値幅 が最大のもの", async () => {
    const a = fixedStrategy("strat_a", { classes: ["crypto"], confidence: 0.5, edge: 200 });
    const b = fixedStrategy("strat_b", { classes: ["crypto"], confidence: 0.9, edge: 150 });
    const c = fixedStrategy("strat_c", { classes: ["crypto"], confidence: 0.6, edge: 100 });
    const { rt, store } = await runtime({}, { strategies: [a, b, c] });
    await rt.engine.tick(START);
    const entries = store.listAudit({ type: "engine.entry" });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.data.strategyId === "strat_b")).toBe(true);
    // エントリー文脈が journal に残る
    const p = rt.engine.positions.get("BTC/USDT")!;
    expect(p.entryContext.reason).toBe("test strat_b");
    expect(p.entryContext.riskMultiplier).toBeGreaterThan(0);
    expect(p.entryContext.features).toEqual({ x: 1 });
  });

  it("保有中は持ち主の戦略の flat シグナルで決済する (signal)", async () => {
    const s = fixedStrategy("flipper", { classes: ["crypto"], flatWhenHolding: true });
    const { rt, clock, store } = await runtime({}, { strategies: [s] });
    await rt.engine.tick(START);
    expect(rt.engine.positions.list()).toHaveLength(2);
    clock.t = START + MIN; // 次の 1m 確定足で評価
    await rt.engine.tick(clock.t);
    const trades = store.listTrades();
    expect(trades).toHaveLength(2);
    expect(trades.every((t) => t.exitReason === "signal")).toBe(true);
    expect(trades.every((t) => store.getAttribution(t.id) !== undefined)).toBe(true);
  });

  it("計画で無効な戦略・方向バイアス違反・ブラックアウトは見送る", async () => {
    const s = fixedStrategy("always_long", { classes: ["crypto", "meme"], stopPct: 0.03, edge: 300 });
    // PEPE は meme (資産クラス単位のブラックアウトの対象)。BTC は方向バイアス違反、ETH は計画で無効
    const { rt, store } = await runtime({ WATCHLIST: "synthetic|BTC/USDT,synthetic|ETH/USDT,synthetic|PEPE/USDT|meme" }, { strategies: [s] });
    const plan: StrategyPlan = {
      generatedAt: START - MIN,
      validUntil: START + HOUR,
      perSymbol: {
        "BTC/USDT": { symbol: "BTC/USDT", enabledStrategies: ["always_long"], directionBias: "short", riskMultiplier: 1 },
        "ETH/USDT": { symbol: "ETH/USDT", enabledStrategies: [], directionBias: "both", riskMultiplier: 0 },
        "PEPE/USDT": { symbol: "PEPE/USDT", enabledStrategies: ["always_long"], directionBias: "both", riskMultiplier: 1 },
      },
      blackouts: [{ start: START - MIN, end: START + HOUR, assetClasses: ["meme"], reason: "AI: 取引所の障害" }],
      rationale: "test",
    };
    store.savePlan(plan);
    await rt.engine.tick(START);
    expect(store.listAudit({ type: "engine.entry" })).toHaveLength(0);
    const skips = skipCounts(store);
    expect(skips.direction_bias).toBe(1);
    expect(skips.plan_disabled).toBe(1);
    expect(skips.blackout).toBe(1);

    // 計画で許可した銘柄はエントリーし、計画の倍率 × 腕の重み (新しい腕は 1)
    const b = await runtime({}, { strategies: [s] });
    b.store.savePlan({
      ...plan,
      perSymbol: { "BTC/USDT": { ...plan.perSymbol["BTC/USDT"], directionBias: "both" }, "ETH/USDT": plan.perSymbol["ETH/USDT"] },
    });
    await b.rt.engine.tick(START);
    expect(b.store.listAudit({ type: "engine.entry" }).map((e) => e.data.symbol)).toEqual(["BTC/USDT"]);
    expect(b.rt.engine.positions.get("BTC/USDT")!.entryContext.riskMultiplier).toBe(1);
  });

  it("WATCHLIST で meme にした銘柄は 24 時間出来高 × 価格 (USD) を流動性の代理指標にしてエントリーする", async () => {
    const s = fixedStrategy("meme_long", { classes: ["meme"], stopPct: 0.03, edge: 300 });
    const { rt, store } = await runtime({ WATCHLIST: "synthetic|PEPE/USDT|meme" }, { strategies: [s] });
    const pepe = rt.hub.instrument("PEPE/USDT")!;
    expect(pepe.venue).toBe("paper");
    await rt.engine.tick(START);
    const entry = store.listAudit({ type: "engine.entry" }).find((e) => e.data.symbol === "PEPE/USDT");
    expect(entry).toBeDefined();
    const liq = entry!.data.liquidityUsd as number;
    expect(liq).toBeGreaterThan(rt.config.risk.memeMinLiquidityUsd);
    expect(liq).toBeLessThan(10_000_000);
  });

  it("流動性が不明なミーム (出来高の履歴が 1 時間未満) は見送る", async () => {
    const clock = mkClock();
    const specs = defaultSyntheticSpecs()
      .filter((x) => x.instrument.symbol === "PEPE/USDT")
      .map((x) => ({ ...x, instrument: { ...x.instrument, assetClass: "meme" as const } }));
    const feed: MarketDataFeed = new SyntheticFeed({ clock, seed: 3, specs, historyMs: 30 * MIN });
    const instruments = await feed.listInstruments();
    expect(instruments[0].assetClass).toBe("meme");
    // 1m 足だけ (30 本 = 30 分) にする (1h 足があると 1 時間ぶんの出来高として扱われる)
    const s: Strategy = { ...fixedStrategy("meme_long", { classes: ["meme"], stopPct: 0.03, edge: 300 }), timeframes: ["1m"] };
    const { rt, store } = await runtime({}, { clock, strategies: [s], markets: [{ feed, instruments }] });
    await rt.engine.tick(START);
    expect(store.listAudit({ type: "engine.entry" })).toHaveLength(0);
    expect(skipCounts(store)["risk: ミームコインの流動性が不明のため拒否"]).toBe(1);
    expect(store.listAudit({ type: "risk.reject" })[0].data.reason).toMatch(/流動性が不明/);
  });

  it("再起動: PaperBroker の snapshot と保有中ポジションを復元する", async () => {
    const s = fixedStrategy("always_long", { classes: ["crypto"] });
    const store = new MemoryStore();
    const first = await runtime({}, { strategies: [s], store });
    await first.rt.engine.tick(START);
    await first.rt.engine.stop();
    const before = await first.rt.brokerSet.paper!.getPositions();
    expect(before).toHaveLength(2);

    const second = await runtime({}, { strategies: [s], store, clock: mkClock(START + MIN) });
    await second.rt.engine.init();
    expect(await second.rt.brokerSet.paper!.getPositions()).toEqual(before);
    expect(second.rt.engine.positions.list().map((p) => p.symbol).sort()).toEqual(["BTC/USDT", "ETH/USDT"]);
    expect(store.listAudit({ type: "reconcile.external_close" })).toHaveLength(0);
    // 復元後も同じ銘柄に重ねて建てない
    const r = await second.rt.engine.tick(START + MIN);
    expect(r.entries).toBe(0);
  });

  it("情報ループ: 失敗しても取引は止めず、監査ログに残す", async () => {
    const { rt, store } = await runtime();
    const intel = rt.intel as unknown as { refresh: (now: number) => Promise<unknown> };
    intel.refresh = vi.fn(async () => {
      throw new Error("network down");
    });
    await rt.engine.tick(START);
    expect(await rt.engine.runIntel(START)).toBeUndefined();
    expect(store.listAudit({ type: "engine.intel_error" })[0].data.error).toBe("network down");
    await expect(rt.engine.tick(START + MIN)).resolves.toBeDefined();
  });

  it("status: ダッシュボード用の状態", async () => {
    const s = fixedStrategy("always_long", { classes: ["crypto"] });
    const { rt } = await runtime({}, { strategies: [s] });
    await rt.engine.tick(START);
    await rt.engine.runIntel(START);
    const st = await rt.engine.status();
    expect(st.mode).toBe("paper");
    expect(st.baseCurrency).toBe("JPY");
    expect(st.positions).toHaveLength(2);
    expect(st.positions[0].unrealizedPnlAccount).toBeDefined();
    expect(st.watched.map((w) => w.symbol)).toEqual(["BTC/USDT", "ETH/USDT"]);
    expect(st.plan?.symbols.length).toBe(2);
    expect(st.brief?.stub).toBe(true);
    expect(st.equityHistory.length).toBeGreaterThan(0);
    expect(st.risk.limits.maxDrawdown).toBe(rt.config.risk.maxDrawdown);
  });
});
