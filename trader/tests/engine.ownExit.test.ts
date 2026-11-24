/**
 * エンジン統合 (paper): 決済を自分で管理する戦略 (Strategy.managesOwnExit。trend_4h・mid_trend_follow) の建玉には
 * 建値ストップ・転換で決済・読みの管理・最大保有の上限 (MAX_HOLD_MINUTES) を掛けない。当初の損切り・RiskManager は掛ける。
 * 台本どおりの 1m 足と気配を返す feed (オフライン)。
 */
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/appConfig";
import type { Candle, Clock, Strategy } from "../src/core/types";
import { buildRuntime } from "../src/engine/setup";
import { mulberry32 } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";
import { barTs, H, INST, LONG_PROFIT, LONG_PROFIT_BREAK, probe, scenarioBars, ScriptedFeed } from "./helpers/reversalScenario";

/** LONG_PROFIT の後: 下げ続けて損切り (97) に届く */
const TAIL = [102.0, 101.5, 101.0, 100.5, 100.0, 99.0, 98.0, 97.5, 96.5, 96.0, 96.0, 96.0, 96.0, 96.0, 96.0];
const M = 60_000;

async function runtime(bars: Candle[], strategy: Strategy, env: Record<string, string> = {}) {
  const clock: Clock & { t: number } = { t: barTs(H) + 1_000, now() { return this.t; } };
  const store = new MemoryStore();
  const feed = new ScriptedFeed(bars, clock);
  const config = loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "USD", LIMIT_ENTRY: "false", ...env });
  const rt = await buildRuntime(config, {
    clock, store, intelSources: [], ai: null, rng: mulberry32(7), strategies: [strategy], markets: [{ feed, instruments: [INST] }], engine: { liveAccountCacheMs: 0 },
  });
  const tickTo = async (t: number) => {
    clock.t = t;
    return rt.engine.tick(t);
  };
  return { rt, store, tickTo };
}
type World = Awaited<ReturnType<typeof runtime>>;

async function run(w: World, from: number, to: number) {
  for (let k = from; k <= to && w.rt.engine.positions.list().length > 0; k++) await w.tickTo(barTs(k) + 1_000);
}
const close = async (w: World) => {
  await w.rt.engine.stop();
  w.rt.close();
};

/** 中期・決済を自分で管理する probe (1 回だけ買い。損切り 97・利確 106・最大保有 120 分) */
const ownProbe = (o: Parameters<typeof probe>[0] = {}): Strategy => ({ ...probe(o), horizon: "mid", managesOwnExit: true });

describe("エンジン (paper): 決済を自分で管理する戦略", () => {
  it("建値ストップ・転換で決済・読みの管理・MAX_HOLD_MINUTES の上限を掛けず、当初の損切りで決済する。RiskManager は通す", async () => {
    // 既定: REVERSAL_EXIT=true・BREAKEVEN_TRIGGER_R=0.5・THESIS_EXIT=true。MAX_HOLD_MINUTES=5
    const w = await runtime(scenarioBars(LONG_PROFIT, TAIL), ownProbe(), { MAX_HOLD_MINUTES: "5" });
    const spy = vi.spyOn(w.rt.risk, "evaluateEntry");
    for (let s = 0; s < 8 && w.rt.engine.positions.list().length === 0; s++) await w.tickTo(barTs(H) + 1_000 + s * 5_000);
    const p = w.rt.engine.positions.list()[0];
    expect(p).toBeDefined();
    // 新規エントリーは RiskManager を通っている (hold_limit の観測専用にしない)
    expect(spy).toHaveBeenCalled();
    expect(w.rt.engine.shadow!.list().filter((x) => x.reason === "hold_limit")).toHaveLength(0);
    // 最大保有は戦略のまま (MAX_HOLD_MINUTES=5 で丸めない)
    expect(w.rt.engine.positions.planOf(p.id).maxHoldMs).toBe(120 * M);
    // 押し安値割れ (r12) の後も、建値ストップの発動 (+1.5 = 0.5R) の後も持ち続ける
    await run(w, H + 1, H + LONG_PROFIT_BREAK + 2);
    expect(w.rt.engine.positions.list()).toHaveLength(1);
    expect(w.rt.engine.positions.planOf(p.id).breakeven).toBeUndefined();
    expect(w.rt.engine.positions.thesisView(w.rt.engine.positions.list()[0], undefined, Date.now())).toBeUndefined();
    await run(w, H + LONG_PROFIT_BREAK + 3, H + LONG_PROFIT.length + TAIL.length - 1);
    const [t] = w.store.listTrades();
    expect(t).toMatchObject({ exitReason: "stop", strategyId: "rev_probe" });
    expect(t.thesisOutcome).toBeUndefined();
    expect(t.breakevenStopExit).toBeUndefined();
    expect(w.store.listAudit({ type: "position.reversal_exit" })).toHaveLength(0);
    expect(w.store.listAudit({ type: "position.breakeven_armed" })).toHaveLength(0);
    expect(w.store.listAudit({ type: "thesis.extended" })).toHaveLength(0);
    await close(w);
  }, 60_000);

  it("標準のトレーリング (シグナルの trailingStopPct。mid_trend_follow が使う) は掛かる: 上乗せが全部有効でも trailing で決済", async () => {
    // probe に 1% のトレーリングを付ける (mid_trend_follow は trailAtr × ATR の幅をシグナルに付ける。trend_4h は付けない)
    const base = ownProbe();
    const trailing: Strategy = {
      ...base,
      evaluate(ctx) {
        const s = base.evaluate(ctx);
        return s && s.direction !== "flat" ? { ...s, trailingStopPct: 0.01 } : s;
      },
    };
    const w = await runtime(scenarioBars(LONG_PROFIT, TAIL), trailing, { MAX_HOLD_MINUTES: "5" });
    for (let s = 0; s < 8 && w.rt.engine.positions.list().length === 0; s++) await w.tickTo(barTs(H) + 1_000 + s * 5_000);
    const p = w.rt.engine.positions.list()[0];
    expect(w.rt.engine.positions.planOf(p.id)).toMatchObject({ trailingStopPct: 0.01, maxHoldMs: 120 * M });
    await run(w, H + 1, H + LONG_PROFIT.length + TAIL.length - 1);
    const [t] = w.store.listTrades();
    expect(t.exitReason).toBe("trailing");
    // 高値 (104 台) から 1% 下 = 含み益で決済 (当初の損切り 97 まで持たない)
    expect(t.exitPrice).toBeGreaterThan(102.5);
    expect(t.breakevenStopExit).toBeUndefined();
    expect(t.thesisStopExit).toBeUndefined();
    expect(t.thesisOutcome).toBeUndefined();
    expect(w.store.listAudit({ type: "position.reversal_exit" })).toHaveLength(0);
    expect(w.store.listAudit({ type: "position.breakeven_armed" })).toHaveLength(0);
    await close(w);
  }, 60_000);

  it("同じ設定でも通常の戦略 (managesOwnExit なし) は従来どおり上乗せが掛かる (前提の確認)", async () => {
    const w = await runtime(scenarioBars(LONG_PROFIT, TAIL), probe(), { MAX_HOLD_MINUTES: "5" });
    for (let s = 0; s < 8 && w.rt.engine.positions.list().length === 0; s++) await w.tickTo(barTs(H) + 1_000 + s * 5_000);
    const p = w.rt.engine.positions.list()[0];
    expect(w.rt.engine.positions.planOf(p.id).maxHoldMs).toBe(5 * M);
    await run(w, H + 1, H + LONG_PROFIT.length + TAIL.length - 1);
    const [t] = w.store.listTrades();
    expect(t.exitReason).not.toBe("stop");
    await close(w);
  }, 60_000);

  it("最大保有 (maxHoldMs) の時間切れは従来どおり time (読みの期限で読み外れにしない)", async () => {
    const w = await runtime(scenarioBars(Array<number>(200).fill(100.2)), ownProbe());
    for (let s = 0; s < 8 && w.rt.engine.positions.list().length === 0; s++) await w.tickTo(barTs(H) + 1_000 + s * 5_000);
    const p = w.rt.engine.positions.list()[0];
    await run(w, H + 1, H + 125);
    const [t] = w.store.listTrades();
    expect(t.exitReason).toBe("time");
    expect(t.exitTs - p.entryTs).toBeGreaterThanOrEqual(120 * M);
    expect(t.thesisOutcome).toBeUndefined();
    await close(w);
  }, 60_000);

  it("キルスイッチ中は新規エントリーしない (リスク管理は迂回しない)", async () => {
    const w = await runtime(scenarioBars(LONG_PROFIT, TAIL), ownProbe(), { MAX_HOLD_MINUTES: "5" });
    w.rt.risk.trip("test", barTs(H));
    for (let s = 0; s < 4; s++) await w.tickTo(barTs(H) + 1_000 + s * 5_000);
    expect(w.rt.engine.positions.list()).toHaveLength(0);
    expect(w.store.listTrades()).toHaveLength(0);
    await close(w);
  }, 60_000);
});

describe("status: 決済を自分で管理する戦略の表示", () => {
  it("戦略一覧の trend_4h・mid_trend_follow に「自前の決済 (…)」を出し、ほかの戦略には出さない", async () => {
    const { strategyStatusLines, OWN_EXIT_TAG } = await import("../src/cli");
    const lines = strategyStatusLines(loadConfig({ NODE_ENV: "test", DB_PATH: "memory" }));
    expect(OWN_EXIT_TAG).toBe("自前の決済 (建値ストップ・転換で決済・読みの管理・最大保有の上限は適用しない)");
    const trend = lines.find((l) => l.includes("[trend_4h]"))!;
    expect(trend).toContain("中期・ブレイクアウト トレンド (4 時間足) [trend_4h] / 中期");
    expect(trend).toContain(OWN_EXIT_TAG);
    // 戻した mid_trend_follow も自前の決済
    const mid = lines.find((l) => l.includes("[mid_trend_follow]"))!;
    expect(mid).toContain("中期・EMA+MACD トレンド (4 時間足) [mid_trend_follow] / 中期");
    expect(mid).toContain(OWN_EXIT_TAG);
    expect(lines.filter((l) => l.includes(OWN_EXIT_TAG))).toHaveLength(2);
    expect(lines[0]).toContain("13 本");
  });
});
