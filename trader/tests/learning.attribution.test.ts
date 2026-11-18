import { describe, expect, it } from "vitest";
import type { CauseCode, EntryContext, IntelBias, TradeRecord } from "../src/core/types";
import { attributeTrade, type AttributionOptions } from "../src/learning/attribution";

/**
 * 基準トレード: ロング 100 → 損切り 98 (ストップ幅 2%)、コスト 10bps (0.1%)、レジーム range。
 * 損益は qty=1 の単純計算。
 */
function mk(over: Partial<TradeRecord> = {}, ctx: Partial<EntryContext> = {}): TradeRecord {
  const entryPrice = over.entryPrice ?? 100;
  const exitPrice = over.exitPrice ?? 103;
  const direction = over.direction ?? "long";
  const dir = direction === "long" ? 1 : -1;
  const fees = over.fees ?? 0.1;
  const grossPnl = over.grossPnl ?? dir * (exitPrice - entryPrice);
  const netPnl = over.netPnl ?? grossPnl - fees;
  const initialStop = over.initialStop ?? (direction === "long" ? 98 : 102);
  return {
    id: "t1",
    mode: "paper",
    symbol: "BTC/USDT",
    venue: "paper",
    assetClass: "crypto",
    strategyId: "s1",
    horizon: "scalp",
    direction,
    qty: 1,
    entryTs: 1_000,
    entryPrice,
    intendedEntryPrice: entryPrice,
    exitTs: 2_000,
    exitPrice,
    intendedExitPrice: exitPrice,
    initialStop,
    grossPnl,
    fees,
    netPnl,
    returnPct: netPnl / entryPrice,
    rMultiple: netPnl / Math.abs(entryPrice - initialStop),
    mfePct: 0.031,
    maePct: 0.004,
    exitReason: "take_profit",
    entryContext: {
      regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
      confidence: 0.6,
      expectedEdgeBps: 50,
      costBps: 10,
      params: {},
      features: {},
      riskMultiplier: 1,
      reason: "test",
      ...ctx,
    },
    ...over,
  };
}

const intel = (over: Partial<IntelBias> = {}): IntelBias => ({
  asset: "BTC",
  sentiment: 0,
  confidence: 0,
  eventRisk: 0,
  sourceIds: [],
  sourceContrib: {},
  ...over,
});

const opts: AttributionOptions = { strategyRegimes: { s1: ["range", "trend_up"] } };
const codes = (t: TradeRecord, o: AttributionOptions = opts) => attributeTrade(t, o).causes.map((c) => c.code);
/** 計画通りの損切り: ストップ決済、MFE はストップ幅の 30% (wrong_direction でも late_exit でもない) */
const plannedStop = (over: Partial<TradeRecord> = {}, ctx: Partial<EntryContext> = {}) =>
  mk({ exitPrice: 98, exitReason: "stop", mfePct: 0.006, maePct: 0.02, ...over }, ctx);

describe("attributeTrade", () => {
  it("good_process: 計画通りの利益", () => {
    const a = attributeTrade(mk());
    expect(a.outcome).toBe("win");
    expect(a.tradeId).toBe("t1");
    expect(a.createdAt).toBe(2_000);
    expect(a.causes).toHaveLength(1);
    expect(a.causes[0]).toMatchObject({ code: "good_process", weight: 1 });
    expect(a.causes[0].evidence).toContain("計画通りの利益");
  });

  it("good_process: 計画通りの損切り", () => {
    const a = attributeTrade(plannedStop(), opts);
    expect(a.outcome).toBe("loss");
    expect(a.causes.map((c) => c.code)).toEqual(["good_process"]);
    expect(a.causes[0].evidence).toContain("計画通りの損切り");
  });

  it("breakeven と now", () => {
    const a = attributeTrade(mk({ exitPrice: 100, fees: 0, exitReason: "signal", mfePct: 0.001 }), { now: 42 });
    expect(a.outcome).toBe("breakeven");
    expect(a.createdAt).toBe(42);
  });

  it("fee_drag: グロスは勝ちでネットは負け", () => {
    const t = mk({ exitPrice: 100.05, exitReason: "signal", mfePct: 0.006 });
    expect(t.netPnl).toBeLessThan(0);
    const a = attributeTrade(t, opts);
    expect(a.causes.map((c) => c.code)).toEqual(["fee_drag"]);
    expect(a.causes[0].evidence).toMatch(/手数料 0\.1/);
  });

  it("fee_drag: 勝ちでも手数料がグロスの 50% 超", () => {
    const t = mk({ exitPrice: 101, fees: 0.6, mfePct: 0.011 });
    expect(codes(t)).toEqual(["fee_drag"]);
    expect(codes(mk({ exitPrice: 101, fees: 0.4, mfePct: 0.011 }))).toEqual(["good_process"]);
  });

  it("slippage: 不利方向の約定ずれがコストを大きく超える", () => {
    const t = mk({ entryPrice: 100.5, intendedEntryPrice: 100, exitPrice: 103.5 });
    const a = attributeTrade(t, opts);
    expect(a.causes.map((c) => c.code)).toContain("slippage");
    expect(a.causes.find((c) => c.code === "slippage")!.evidence).toMatch(/bps/);
    // 有利方向のずれは問題にしない
    expect(codes(mk({ entryPrice: 99.5, intendedEntryPrice: 100, exitPrice: 102.5 }))).not.toContain("slippage");
    // コスト見積り内なら問題にしない
    expect(codes(mk({ entryPrice: 100.1, intendedEntryPrice: 100, exitPrice: 103.1 }))).not.toContain("slippage");
  });

  it("stop_too_tight: 刈られた後にストップ幅以上戻った", () => {
    const a = attributeTrade(plannedStop({ postExitMovePct: 0.025 }), opts);
    expect(a.causes.map((c) => c.code)).toEqual(["stop_too_tight"]);
    expect(a.causes[0].evidence).toContain("2.50%");
    expect(codes(plannedStop({ postExitMovePct: 0.015 }))).toEqual(["good_process"]);
  });

  it("late_exit: MFE の大半を吐き出した (勝ち) / 十分な含み益から損失", () => {
    expect(codes(mk({ exitPrice: 100.5, exitReason: "trailing", mfePct: 0.03 }))).toEqual(["late_exit"]);
    expect(codes(mk({ exitPrice: 102.5, exitReason: "trailing", mfePct: 0.03 }))).toEqual(["good_process"]);
    expect(codes(plannedStop({ mfePct: 0.015 }))).toEqual(["late_exit"]);
  });

  it("early_exit: 利確後に実現リターン以上伸びた", () => {
    const t = mk({ exitPrice: 102, postExitMovePct: 0.03, mfePct: 0.02 });
    expect(codes(t)).toEqual(["early_exit"]);
    expect(codes(mk({ exitPrice: 102, postExitMovePct: 0.01, mfePct: 0.02 }))).toEqual(["good_process"]);
    // ストップ決済は対象外
    expect(codes(plannedStop({ postExitMovePct: 0.01 }))).not.toContain("early_exit");
  });

  it("wrong_direction: 一度も有利に動かない損失", () => {
    const a = attributeTrade(plannedStop({ mfePct: 0.001 }), opts);
    expect(a.causes.map((c) => c.code)).toEqual(["wrong_direction"]);
    expect(a.causes[0].evidence).toContain("0.10%");
  });

  it("regime_mismatch: 適合レジーム外 / 高ボラ (損失のみ)", () => {
    const trendDown = { regime: { ...mk().entryContext.regime, label: "trend_down" as const } };
    expect(codes(plannedStop({}, trendDown))).toEqual(["regime_mismatch"]);
    const highVol = { regime: { ...mk().entryContext.regime, label: "high_vol" as const } };
    expect(codes(plannedStop({}, highVol), {})).toEqual(["regime_mismatch"]);
    // 戦略が high_vol 向けなら問題にしない
    expect(codes(plannedStop({}, highVol), { strategyRegimes: { s1: ["high_vol"] } })).toEqual([
      "good_process",
    ]);
    // 勝ちトレードは対象外
    expect(codes(mk({}, trendDown))).toEqual(["good_process"]);
  });

  it("news_shock: イベントリスク高 / ボラの 3 倍超の逆行", () => {
    expect(codes(plannedStop({}, { intel: intel({ eventRisk: 0.8 }) }))).toEqual(["news_shock"]);
    expect(codes(plannedStop({ maePct: 0.05, exitPrice: 95 }))).toContain("news_shock");
    expect(codes(plannedStop({}, { intel: intel({ eventRisk: 0.5 }) }))).toEqual(["good_process"]);
  });

  it("intel_misled: 情報バイアスがトレード方向を強く支持していたのに方向を誤った", () => {
    const bullish = { intel: intel({ sentiment: 0.8, confidence: 0.6 }) };
    const a = attributeTrade(plannedStop({ mfePct: 0.001 }, bullish), opts);
    expect(a.causes.map((c) => c.code).sort()).toEqual(["intel_misled", "wrong_direction"]);
    // 逆向きのバイアスなら該当しない
    const bearish = { intel: intel({ sentiment: -0.8, confidence: 0.6 }) };
    expect(codes(plannedStop({ mfePct: 0.001 }, bearish))).toEqual(["wrong_direction"]);
    // ショートで弱気バイアスなら該当
    const short = plannedStop({ direction: "short", exitPrice: 102, mfePct: 0.001 }, bearish);
    expect(codes(short).sort()).toEqual(["intel_misled", "wrong_direction"]);
  });

  it("time_decay: 時間切れで値幅が小さい", () => {
    expect(codes(mk({ exitPrice: 100.3, exitReason: "time", mfePct: 0.004 }))).toEqual(["time_decay"]);
    expect(codes(mk({ exitPrice: 101.5, exitReason: "time", mfePct: 0.016 }))).toEqual(["good_process"]);
  });

  it("複数要因: 重みは合計 1 に正規化され降順、根拠は日本語で数値入り", () => {
    const t = plannedStop(
      { mfePct: 0.001, maePct: 0.05, exitPrice: 97, entryPrice: 100.5, intendedEntryPrice: 100 },
      { intel: intel({ sentiment: 0.9, confidence: 0.9, eventRisk: 0.9 }), regime: { ...mk().entryContext.regime, label: "high_vol" } },
    );
    const a = attributeTrade(t, opts);
    const cs: CauseCode[] = a.causes.map((c) => c.code);
    expect(cs).toEqual(expect.arrayContaining(["wrong_direction", "regime_mismatch", "news_shock", "intel_misled", "slippage"]));
    expect(cs).not.toContain("good_process");
    expect(a.causes.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 12);
    for (let i = 1; i < a.causes.length; i++) expect(a.causes[i - 1].weight).toBeGreaterThanOrEqual(a.causes[i].weight);
    for (const c of a.causes) {
      expect(c.weight).toBeGreaterThan(0);
      expect(c.evidence).toMatch(/\d/);
    }
  });
});
