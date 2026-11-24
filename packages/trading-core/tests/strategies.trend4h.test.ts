/**
 * trend_4h (中期・トレンドフォロー 4 時間足) と、決済を自分で管理する戦略 (Strategy.managesOwnExit) の扱い。
 * すべて合成データ (オフライン)。
 * - エントリー: 終値 > 直前 20 本の高値の最高値 かつ EMA50 が上向き かつ 終値 > EMA50
 * - 決済: シャンデリア (エントリー後の終値の最高値 − 3 ATR)・チャネル (直前 10 本の安値割れ)。確定足だけ (エントリー前の足では決済しない)
 * - managesOwnExit: 建値ストップ・転換で決済・読みの管理・最大保有の上限を掛けない (バックテスト・PositionManager・仮想トレード)。
 *   当初の損切りは掛ける
 */
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest/engine";
import { syntheticInstrument } from "../src/backtest/synthetic";
import { TIMEFRAME_MS, type Candle, type EntryContext, type Instrument, type PositionView, type Quote, type RegimeFeatures, type StrategyContext, type TradeRecord } from "../src/core/types";
import { DEFAULT_BREAKEVEN_SETTINGS } from "../src/engine/breakeven";
import { PositionManager } from "../src/engine/positions";
import { DEFAULT_REVERSAL_SETTINGS, type ReversalSettings } from "../src/engine/reversalExit";
import { hubTimeframesFor } from "../src/engine/runtime";
import { isHoldLimitedHorizon, isHoldLimitedStrategy } from "../src/engine/tempo";
import { DEFAULT_THESIS_SETTINGS } from "../src/engine/thesis";
import { PaperBroker } from "../src/execution/paper";
import { atr, closesOf, ema } from "../src/indicators/series";
import { TradeJournal } from "../src/learning/journal";
import { ShadowTracker } from "../src/learning/shadow";
import { MemoryStore } from "../src/storage/memory";
import { DEFAULT_STRUCTURE_TARGETS } from "../src/structure/settings";
import { strategyLabel } from "../src/strategies/labels";
import { getStrategy, managesOwnExit } from "../src/strategies/registry";
import { trend4h, trendWarmupBars } from "../src/strategies/trend";
import { barTs, H, INST as RINST, LONG_PROFIT, M, probe, scenarioBars } from "./helpers/reversalScenario";

const H4 = TIMEFRAME_MS["4h"];
const T0 = Date.UTC(2026, 0, 1);

/** 終値の列から 4 時間足 (始値 = 前の終値、高値・安値 = 始値と終値の大きい方・小さい方 ± wick) */
function bars4h(closes: number[], wick = 0.3): Candle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { ts: T0 + i * H4, open: o, high: Math.max(o, c) + wick, low: Math.min(o, c) - wick, close: c, volume: 1000 };
  });
}

/** 緩やかな上昇 (1 本 +0.1) が n 本。チャネルの上抜けは起きない (終値 < 直前の高値の最高値) */
const upCloses = (n = 120) => Array.from({ length: n }, (_, k) => 100 + 0.1 * k);
/** 上昇 + 最後に上抜けの足 (+3) */
const breakoutCloses = () => {
  const u = upCloses();
  return [...u, u.at(-1)! + 3];
};

const REGIME: RegimeFeatures = { label: "trend_up", trend: 0.5, trendStrength: 30, volatility: 0.02, volatilityPercentile: 0.5, spreadBps: 1 };

function ctxOf(c: Candle[], o: { position?: PositionView; params?: Record<string, number>; inst?: Partial<Instrument>; regime?: Partial<RegimeFeatures> } = {}): StrategyContext {
  const last = c[c.length - 1];
  const now = last.ts + H4; // 末尾の足は確定済み
  return {
    market: {
      instrument: syntheticInstrument({ tickSize: 0, ...o.inst }),
      now,
      quote: { ts: now, bid: last.close * (1 - 1e-5), ask: last.close * (1 + 1e-5), last: last.close },
      candles: { "4h": c },
    },
    regime: { ...REGIME, ...o.regime },
    ...(o.position ? { position: o.position } : {}),
    params: { ...trend4h.defaultParams, ...o.params },
    mode: "paper",
  };
}

const longPos = (openedAt: number, avgPrice: number, stop: number): PositionView => ({
  symbol: "SYN/USDT", qty: 1, avgPrice, openedAt, strategyId: "trend_4h", stopLoss: stop, highWater: avgPrice, lowWater: avgPrice,
});

describe("trend_4h: 登録と既定値", () => {
  it("中期・crypto だけ・4 時間足・全レジーム・managesOwnExit。構造フィルターの対象外。表示名", () => {
    expect(getStrategy("trend_4h")).toBe(trend4h);
    expect(trend4h).toMatchObject({ horizon: "mid", assetClasses: ["crypto"], primaryTimeframe: "4h", timeframes: ["4h"], managesOwnExit: true });
    expect([...trend4h.regimes].sort()).toEqual(["high_vol", "low_liquidity", "range", "trend_down", "trend_up"]);
    expect(trend4h.defaultParams).toMatchObject({ stopAtr: 2.5, trailAtr: 3, maxHoldBars: 180, channelBars: 20, exitBars: 10, trendEma: 50, slopeBars: 6 });
    expect(trend4h.paramBounds).toMatchObject({ stopAtr: [1.5, 5], trailAtr: [1.5, 6], maxHoldBars: [30, 360], channelBars: [10, 60] });
    expect(trend4h.defaultParams.tpAtr).toBeUndefined();
    expect(trend4h.warmup).toBe(trendWarmupBars(20, 50, 6));
    expect(trend4h.warmup).toBeGreaterThanOrEqual(Math.max(20, 50 + 6) + 20);
    expect(DEFAULT_STRUCTURE_TARGETS).not.toContain("trend_4h");
    expect(strategyLabel("trend_4h")).toBe("中期・トレンドフォロー (4 時間足)");
    expect(managesOwnExit("trend_4h")).toBe(true);
    expect(managesOwnExit("short_breakout")).toBe(false);
    // 未知・廃止した id は従来どおり (false)
    expect(managesOwnExit("mid_trend_follow")).toBe(false);
    expect(managesOwnExit("nope")).toBe(false);
    expect(managesOwnExit(undefined)).toBe(false);
  });

  it("最大保有 (MAX_HOLD_MINUTES) の観測専用 (hold_limit) にしない (時間軸は mid でも)", () => {
    expect(isHoldLimitedHorizon(trend4h.horizon)).toBe(true);
    expect(isHoldLimitedStrategy(trend4h)).toBe(false);
    expect(isHoldLimitedStrategy({ horizon: "mid" })).toBe(true);
    expect(isHoldLimitedStrategy({ horizon: "short" })).toBe(false);
  });

  it("hub の時間足: 4h を取り、転換で決済の時間足 (1h) は要らない", () => {
    const tfs = hubTimeframesFor([{ assetClass: "crypto" }], [trend4h], { ...DEFAULT_REVERSAL_SETTINGS });
    expect(tfs).toEqual(["1m", "4h"]);
  });
});

describe("trend_4h: エントリー", () => {
  it("上抜け + EMA 上向き + 終値 > EMA → 買い。損切り = 価格 − 2.5 ATR、利確なし、汎用のトレーリングなし、最大保有 180 本", () => {
    const c = bars4h(breakoutCloses());
    const s = trend4h.evaluate(ctxOf(c))!;
    expect(s).not.toBeNull();
    expect(s.direction).toBe("long");
    const a = atr(c, 14).at(-1)!;
    const price = c.at(-1)!.close * (1 + 1e-5);
    expect(s.stopLoss).toBeCloseTo(price - 2.5 * a, 9);
    expect(s.takeProfit).toBeUndefined();
    expect(s.trailingStopPct).toBeUndefined();
    expect(s.maxHoldMs).toBe(180 * H4);
    expect(s.confidence).toBeGreaterThan(0.5);
    expect(s.confidence).toBeLessThanOrEqual(1);
    // 期待値 = 目安 (トレーリング幅 3 ATR) / 価格 × 確信度 (標準の buildEntrySignal)
    expect(s.expectedEdgeBps).toBeCloseTo(((3 * a) / price) * 1e4 * s.confidence, 6);
    expect(s.features.emaSlopeAtr).toBeGreaterThan(0);
  });

  it("上抜けが無ければ出さない", () => {
    expect(trend4h.evaluate(ctxOf(bars4h(upCloses())))).toBeNull();
  });

  it("EMA が下向きなら上抜けでも出さない (終値 > EMA でも)", () => {
    // 長い下げ → 底でもみ合い → 大きく上抜け (EMA50 より上で引けるが、EMA50 はまだ 6 本前より低い)
    const closes = [
      ...Array.from({ length: 100 }, (_, k) => 160 - 0.5 * k),
      ...Array.from({ length: 22 }, (_, k) => 110 + (k % 2 ? 0.2 : -0.2)),
    ];
    closes.push(118);
    const c = bars4h(closes);
    const s = trend4h.evaluate(ctxOf(c, { params: { trendEma: 50 } }));
    expect(s).toBeNull();
    // 前提の確認: 終値 > EMA50 だが EMA50 は 6 本前より低い (傾きの条件だけで見送った)
    const e = ema(closesOf(c), 50);
    expect(c.at(-1)!.close).toBeGreaterThan(e.at(-1)!);
    expect(e.at(-1)!).toBeLessThan(e[e.length - 7]);
    const ok = trend4h.evaluate(ctxOf(c, { params: { slopeBars: 2, trendEma: 20 } }));
    expect(ok?.direction).toBe("long");
  });

  it("足が足りなければ出さない (warmup)", () => {
    const c = bars4h(breakoutCloses()).slice(-50);
    expect(trend4h.evaluate(ctxOf(c))).toBeNull();
  });

  it("低流動性のレジームでは入らない", () => {
    expect(trend4h.evaluate(ctxOf(bars4h(breakoutCloses()), { regime: { label: "low_liquidity" } }))).toBeNull();
  });

  it("売りは鏡像。空売りできない銘柄 (Jupiter など allowShort=false・再現なし) では出さない", () => {
    const closes = [...upCloses().map((x) => 200 - x)];
    closes.push(closes.at(-1)! - 3);
    const c = bars4h(closes);
    const s = trend4h.evaluate(ctxOf(c))!;
    expect(s.direction).toBe("short");
    expect(s.stopLoss).toBeGreaterThan(c.at(-1)!.close);
    expect(trend4h.evaluate(ctxOf(c, { inst: { allowShort: false, venue: "jupiter" } }))).toBeNull();
  });
});

describe("trend_4h: 決済 (確定足の終値)", () => {
  // 上抜けの足 (添字 120) の次の足 (121) の始値でエントリー → 10 本上げてから 1 本 1.0 ずつ下げる
  const base = breakoutCloses();
  const entryIdx = base.length; // 121
  const openedAt = T0 + entryIdx * H4;
  const peakPath = Array.from({ length: 10 }, (_, k) => base.at(-1)! + 1 + k);
  const down = Array.from({ length: 25 }, (_, k) => peakPath.at(-1)! - 1 - k);
  const all = bars4h([...base, ...peakPath, ...down]);
  const pos = longPos(openedAt, base.at(-1)!, base.at(-1)! - 5);

  it("シャンデリア: エントリー後の終値の最高値 − 3 ATR を終値が割った最初の足で flat", () => {
    let fired = -1;
    for (let k = entryIdx; k < all.length; k++) {
      const s = trend4h.evaluate(ctxOf(all.slice(0, k + 1), { position: pos }));
      if (s) {
        fired = k;
        expect(s.direction).toBe("flat");
        expect(s.reason).toMatch(/シャンデリア/);
        break;
      }
    }
    // 期待: 独立に計算した最初の足
    const a = atr(all, 14);
    let want = -1;
    let hc = -Infinity;
    for (let k = entryIdx; k < all.length; k++) {
      hc = Math.max(hc, all[k].close);
      if (all[k].close < hc - 3 * a[k]) {
        want = k;
        break;
      }
    }
    expect(want).toBeGreaterThan(entryIdx + 10);
    expect(fired).toBe(want);
  });

  it("チャネル: 直前 10 本の安値の最安値を終値が割ったら flat (シャンデリアを無効にして確かめる)", () => {
    let fired = -1;
    for (let k = entryIdx; k < all.length; k++) {
      const s = trend4h.evaluate(ctxOf(all.slice(0, k + 1), { position: pos, params: { trailAtr: 0 } }));
      if (s) {
        fired = k;
        expect(s.reason).toMatch(/直近 10 本の安値/);
        break;
      }
    }
    let want = -1;
    for (let k = entryIdx; k < all.length; k++) {
      const lo = Math.min(...all.slice(k - 10, k).map((b) => b.low));
      if (all[k].close < lo) {
        want = k;
        break;
      }
    }
    expect(want).toBeGreaterThan(0);
    expect(fired).toBe(want);
  });

  it("先読みなし: エントリー後に確定した足が無ければ (エントリー前の足が暴落でも) 決済しない", () => {
    // 最後の足は暴落だが、エントリーはその足が閉じた後 (= 次の足の始値)
    const c = bars4h([...upCloses(), 80]);
    const after = longPos(c.at(-1)!.ts + H4, 80, 70);
    expect(trend4h.evaluate(ctxOf(c, { position: after }))).toBeNull();
    // エントリーした足が閉じたら判定する
    const c2 = bars4h([...upCloses(), 80, 60]);
    expect(trend4h.evaluate(ctxOf(c2, { position: after }))?.direction).toBe("flat");
  });

  it("先読みなし: 上抜けの足が閉じる前の足だけでは出さず、バックテストは上抜けの足の次の足の始値でエントリーする", () => {
    const c = bars4h([...breakoutCloses(), ...Array.from({ length: 5 }, () => 113)]);
    expect(trend4h.evaluate(ctxOf(c.slice(0, 120)))).toBeNull();
    const r = runBacktest({ strategy: trend4h, instrument: syntheticInstrument({ tickSize: 0 }), candles: c, baseTimeframe: "4h", spreadBps: 2, slippageBps: 1 });
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.trades[0].entryTs).toBe(c[121].ts);
  });
});

// ───────── managesOwnExit: バックテスト ─────────

const ownProbe = (o: Parameters<typeof probe>[0] = {}) => ({ ...probe(o), managesOwnExit: true as const });
const REV_ON: ReversalSettings = { ...DEFAULT_REVERSAL_SETTINGS, strategies: [] };
const COSTS = { spreadBps: 2, slippageBps: 1 };
const TAIL = [102.0, 101.5, 101.0, 100.5, 100.0, 99.0, 98.0, 97.5, 96.5, 96.0, 96.0, 96.0, 96.0, 96.0, 96.0];

describe("managesOwnExit: バックテスト", () => {
  const candles = scenarioBars(LONG_PROFIT, TAIL);
  const overlays = { reversal: REV_ON, breakeven: { ...DEFAULT_BREAKEVEN_SETTINGS }, thesis: { ...DEFAULT_THESIS_SETTINGS }, maxHoldMinutes: 5 };
  const bt = (strategy: ReturnType<typeof probe>, o: Record<string, unknown>) =>
    runBacktest({ strategy, instrument: RINST, candles, baseTimeframe: "1m", ...COSTS, ...o });

  it("通常の戦略にはそれぞれ効く (前提の確認)", () => {
    expect(bt(probe({ at: barTs(H) }), { reversal: REV_ON }).trades[0].exitReason).toBe("reversal");
    expect(bt(probe({ at: barTs(H) }), { breakeven: overlays.breakeven }).trades[0]).toMatchObject({ exitReason: "trailing", breakevenStopExit: true });
    expect(bt(probe({ at: barTs(H) }), { maxHoldMinutes: 5 }).trades[0].exitReason).toBe("time");
    expect(bt(probe({ at: barTs(H) }), { thesis: overlays.thesis }).trades[0].thesisOutcome).toBeDefined();
  });

  it("決済を自分で管理する戦略には掛けない: 全部渡しても当初の損切りで決済 (読みの管理の記録もなし)", () => {
    const r = bt(ownProbe({ at: barTs(H) }), overlays);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.exitReason).toBe("stop");
    expect(t.breakevenStopExit).toBeUndefined();
    expect(t.thesisOutcome).toBeUndefined();
    expect(t.exitTs - t.entryTs).toBeGreaterThan(5 * M);
    expect(r.stats.reversalExits).toBeUndefined();
    // 何も渡さないときと同じ取引
    const plain = bt(ownProbe({ at: barTs(H) }), {});
    expect({ ...t, id: "" }).toEqual({ ...plain.trades[0], id: "" });
  });

  it("戦略の maxHoldMs の時間切れはそのまま (time)", () => {
    const flat = scenarioBars(Array<number>(200).fill(100.5));
    const r = runBacktest({ strategy: ownProbe({ at: barTs(H) }), instrument: RINST, candles: flat, baseTimeframe: "1m", ...COSTS, ...overlays });
    expect(r.trades[0].exitReason).toBe("time");
    // probe の最大保有 120 分 (MAX_HOLD の 5 分・読みの期限ではない)
    expect(r.trades[0].exitTs - r.trades[0].entryTs).toBeGreaterThanOrEqual(120 * M);
  });

  it("trend_4h のバックテストに上乗せを渡しても転換で決済・建値ストップ・読みの管理は起きない", () => {
    // 上げ → 上抜け → さらに上げ → 下げ (シャンデリアで決済)
    const base = breakoutCloses();
    const c = bars4h([...base, ...Array.from({ length: 15 }, (_, k) => base.at(-1)! + 1 + k), ...Array.from({ length: 20 }, (_, k) => base.at(-1)! + 14 - 1.5 * k)]);
    const inst = syntheticInstrument({ tickSize: 0 });
    const a = runBacktest({ strategy: trend4h, instrument: inst, candles: c, baseTimeframe: "4h", ...COSTS, ...overlays });
    const b = runBacktest({ strategy: trend4h, instrument: inst, candles: c, baseTimeframe: "4h", ...COSTS });
    expect(a.trades.length).toBeGreaterThan(0);
    expect(a.trades.map((t) => t.exitReason)).not.toContain("reversal");
    expect(a.trades.some((t) => t.breakevenStopExit || t.thesisOutcome !== undefined)).toBe(false);
    expect(a.trades.map((t) => ({ ...t, id: "" }))).toEqual(b.trades.map((t) => ({ ...t, id: "" })));
    expect(a.trades[0].exitReason).toBe("signal");
  });
});

// ───────── managesOwnExit: PositionManager ─────────

const SYM = "AAA/USD";
const PINST: Instrument = {
  symbol: SYM, venue: "paper", assetClass: "crypto", baseCurrency: "AAA", quoteCurrency: "USD", tickSize: 0.01, lotSize: 0.001, minQty: 0.001,
  takerFeeRate: 0.001, makerFeeRate: 0.0005, allowShort: true,
};
const ECTX: EntryContext = {
  regime: { label: "trend_up", trend: 0.5, trendStrength: 30, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 2 },
  confidence: 0.7, expectedEdgeBps: 50, costBps: 22, params: {}, features: {}, riskMultiplier: 1, reason: "test",
};
const MIN = 60_000;
const q = (mid: number, ts: number, half = 0.01): Quote => ({ ts, bid: mid - half, ask: mid + half });

function pmSetup(strategyId: string) {
  const clock = { t: T0, now() { return this.t; } };
  const store = new MemoryStore();
  const paper = new PaperBroker({ instruments: [PINST], baseCurrency: "USD", initialEquity: 1_000_000, slippageBps: 0, clock });
  const journal = new TradeJournal({ store, mode: "paper" });
  const closed: TradeRecord[] = [];
  const pm = new PositionManager({
    journal, brokerFor: () => paper, onTradeClosed: (t) => closed.push(t), store, instrumentOf: () => PINST,
    breakeven: { ...DEFAULT_BREAKEVEN_SETTINGS }, thesis: { ...DEFAULT_THESIS_SETTINGS },
    managesOwnExit: (id) => managesOwnExit(id),
  });
  async function open(price: number, stop: number, maxHoldMs: number) {
    paper.onQuote(SYM, q(price, clock.t, 0));
    const r = await paper.placeOrder({ clientId: `o-${clock.t}`, symbol: SYM, side: "buy", type: "market", qty: "1", strategyId });
    const f = r.fills[0];
    return pm.open(
      {
        mode: "paper", symbol: SYM, venue: "paper", assetClass: "crypto", strategyId, horizon: "mid", direction: "long", qty: 1, entryTs: clock.t,
        entryPrice: f.price, intendedEntryPrice: price, initialStop: stop, entryContext: ECTX, entryFees: Number(f.fee),
      },
      { maxHoldMs },
    );
  }
  async function tickAt(min: number, mid: number) {
    clock.t = T0 + min * MIN;
    const quote = q(mid, clock.t);
    paper.onQuote(SYM, quote);
    return pm.onQuote(SYM, quote, clock.t);
  }
  return { pm, store, closed, open, tickAt };
}

describe("managesOwnExit: PositionManager (paper)", () => {
  it("通常の戦略: 0.5R で建値ストップが発動し、読みの期限がある (前提の確認)", async () => {
    const s = pmSetup("short_breakout");
    const p = await s.open(100, 98, 10 * MIN);
    expect(s.pm.thesisView(p, q(100, T0), T0)).toBeDefined();
    await s.tickAt(1, 101.5);
    expect(s.pm.planOf(p.id).breakeven).toBeDefined();
  });

  it("trend_4h の建玉: 建値ストップを発動せず、読みの管理を使わず、maxHold で従来の時間切れ (time)", async () => {
    const s = pmSetup("trend_4h");
    const p = await s.open(100, 98, 10 * MIN);
    expect(s.pm.ownExit(p)).toBe(true);
    expect(s.pm.thesisView(p, q(100, T0), T0)).toBeUndefined();
    expect((await s.tickAt(1, 101.5)).status).toBe("none");
    expect(s.pm.planOf(p.id).breakeven).toBeUndefined();
    expect(s.store.listAudit({ type: "position.breakeven_armed" })).toHaveLength(0);
    // 建値付近に戻っても決済しない (建値ストップが無い)
    expect((await s.tickAt(2, 100.1)).status).toBe("none");
    // 読みの期限 (10 分) で読み外れにせず、従来の時間切れ
    const r = await s.tickAt(10, 100.05);
    expect(r.status).toBe("closed");
    expect(r.trade!.exitReason).toBe("time");
    expect(r.trade!.thesisOutcome).toBeUndefined();
    expect(r.trade!.breakevenStopExit).toBeUndefined();
  });

  it("trend_4h の建玉も当初の損切りは効く", async () => {
    const s = pmSetup("trend_4h");
    await s.open(100, 98, 600 * MIN);
    const r = await s.tickAt(1, 97.9);
    expect(r.status).toBe("closed");
    expect(r.trade!.exitReason).toBe("stop");
  });
});

// ───────── managesOwnExit: 仮想トレード ─────────

describe("managesOwnExit: 仮想トレード", () => {
  const inst = { symbol: "BTC/USDT", assetClass: "crypto" as const, takerFeeRate: 0.001 };
  const tracker = () =>
    new ShadowTracker({
      store: new MemoryStore(), mode: "paper",
      options: {
        thesis: { ...DEFAULT_THESIS_SETTINGS }, breakeven: { ...DEFAULT_BREAKEVEN_SETTINGS }, reversal: REV_ON,
        managesOwnExit: (id) => managesOwnExit(id),
      },
    });
  const record = (tr: ShadowTracker, strategyId: string) =>
    tr.record({
      instrument: inst, quote: { bid: 99.9, ask: 100.1 },
      signal: { strategyId, direction: "long", confidence: 0.7, expectedEdgeBps: 300, stopLoss: 98.1, maxHoldMs: 30 * MIN, horizon: "mid" },
      regime: "trend_up", reason: "lower_score", now: T0, exitTimeframe: "1h",
    });

  it("通常の戦略は読みの期限・転換で決済の時間足・建値ストップを持つ (前提の確認)", () => {
    const tr = tracker();
    expect(record(tr, "short_breakout")).toBe(true);
    const o = tr.list()[0];
    expect(o.thesisExpectedMs).toBe(30 * MIN);
    expect(o.reversalTf).toBe("1h");
    tr.update(T0 + 2 * MIN, () => ({ bid: 100.9, ask: 101.1 }));
    expect(tr.list()[0].breakevenStop).toBeDefined();
  });

  it("trend_4h: 読みの期限・転換で決済・建値ストップなし。maxHoldMs で従来の時間切れ、損切りは効く", () => {
    const tr = tracker();
    expect(record(tr, "trend_4h")).toBe(true);
    const o = tr.list()[0];
    expect(o.thesisExpectedMs).toBeUndefined();
    expect(o.reversalTf).toBeUndefined();
    expect(tr.update(T0 + 2 * MIN, () => ({ bid: 100.9, ask: 101.1 }))).toEqual([]);
    expect(tr.list()[0].breakevenStop).toBeUndefined();
    const [t] = tr.update(T0 + 30 * MIN, () => ({ bid: 100.2, ask: 100.4 }));
    expect(t.exitReason).toBe("time");
    expect(t.thesisOutcome).toBeUndefined();
    const tr2 = tracker();
    record(tr2, "trend_4h");
    const [s] = tr2.update(T0 + MIN, () => ({ bid: 98, ask: 98.2 }));
    expect(s.exitReason).toBe("stop");
  });
});
