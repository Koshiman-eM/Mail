/**
 * 建値ストップ (BREAKEVEN_TRIGGER_R。src/engine/breakeven.ts)。実在の取引所へは送信しない (PaperBroker・合成の足だけ)。
 * - 仲値がエントリーの仲値から triggerR × 当初のリスク 有利に動いたら、ストップを往復コスト込みの建値へ引き上げる
 * - 緩めない (トレーリング・読みの管理の保護ストップの方がきつければそれを使う)。決済計画に保存して再起動後も続ける
 * - 0 で無効 (従来と同一)。決済は trailing + breakevenStopExit (ParamTuner のトレーリングの根拠から除く)
 * - バックテストは終値で発動して次の足から効く。仮想トレードも同じ規則
 */
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest/engine";
import { syntheticInstrument } from "../src/backtest/synthetic";
import { coreConfig as loadCoreConfig } from "../src/testing/runtime";
import type { Candle, EntryContext, Instrument, Quote, ShadowTradeRecord, Signal, Strategy, StrategyContext, TradeRecord } from "../src/core/types";
import { PaperBroker } from "../src/execution/paper";
import {
  BREAKEVEN_DISABLED, breakevenSettingsFromEnv, breakevenStopPrice, breakevenTriggered, DEFAULT_BREAKEVEN_SETTINGS, formatBreakevenSettings,
  type BreakevenSettings,
} from "../src/engine/breakeven";
import { PositionManager, type ExitPlan } from "../src/engine/positions";
import { DEFAULT_THESIS_SETTINGS } from "../src/engine/thesis";
import { buildTradeRecord, TradeJournal } from "../src/learning/journal";
import { attributeTrade } from "../src/learning/attribution";
import { ShadowTracker, shadowOpenKey, type ShadowOpen } from "../src/learning/shadow";
import { isStrategyTrailingExit, TUNER_RULES } from "../src/learning/tuner";
import { MemoryStore } from "../src/storage/memory";
import { buildTestRuntime, testConfig } from "../src/testing/runtime";

const T0 = Date.UTC(2026, 0, 5);
const MIN = 60_000;
const SYM = "AAA/USD";
const ON: BreakevenSettings = { ...DEFAULT_BREAKEVEN_SETTINGS };

// ───────── 純粋な判定 ─────────

describe("建値ストップの判定 (純粋)", () => {
  it("設定: 既定 0.5、0 で無効、0.2〜3 以外は起動時に拒否", () => {
    expect(breakevenSettingsFromEnv({})).toEqual({ triggerR: 0.5 });
    expect(breakevenSettingsFromEnv(loadCoreConfig({}).env)).toEqual({ triggerR: 0.5 });
    expect(breakevenSettingsFromEnv(loadCoreConfig({ BREAKEVEN_TRIGGER_R: "0" }).env)).toEqual({ triggerR: 0 });
    expect(breakevenSettingsFromEnv(loadCoreConfig({ BREAKEVEN_TRIGGER_R: "0.2" }).env)).toEqual({ triggerR: 0.2 });
    expect(breakevenSettingsFromEnv(loadCoreConfig({ BREAKEVEN_TRIGGER_R: "3" }).env)).toEqual({ triggerR: 3 });
    expect(() => loadCoreConfig({ BREAKEVEN_TRIGGER_R: "0.1" })).toThrow(/BREAKEVEN_TRIGGER_R=0.1 は不正です/);
    expect(() => loadCoreConfig({ BREAKEVEN_TRIGGER_R: "3.5" })).toThrow(/BREAKEVEN_TRIGGER_R=3.5 は不正です/);
    expect(() => loadCoreConfig({ BREAKEVEN_TRIGGER_R: "-1" })).toThrow(/BREAKEVEN_TRIGGER_R/);
    expect(formatBreakevenSettings(BREAKEVEN_DISABLED)).toContain("無効");
    expect(formatBreakevenSettings(ON)).toContain("0.5R");
  });

  it("ちょうど閾値 (仲値) で発動する。手前・無効 (0)・リスク 0 は発動しない", () => {
    expect(breakevenTriggered(ON, "long", 100.2, 2, 101.2)).toBe(true);
    expect(breakevenTriggered(ON, "long", 100.2, 2, 101.19)).toBe(false);
    expect(breakevenTriggered(ON, "short", 100.2, 2, 99.2)).toBe(true);
    expect(breakevenTriggered(ON, "short", 100.2, 2, 99.21)).toBe(false);
    // 浮動小数点の誤差でちょうどの値を取りこぼさない (0.3 − 0.1 = 0.19999999999999998)
    expect(breakevenTriggered({ triggerR: 1 }, "long", 0.1, 0.2, 0.3)).toBe(true);
    expect(breakevenTriggered(BREAKEVEN_DISABLED, "long", 100, 2, 200)).toBe(false);
    expect(breakevenTriggered(undefined, "long", 100, 2, 200)).toBe(false);
    expect(breakevenTriggered(ON, "long", 100, 0, 200)).toBe(false);
  });

  it("ストップは往復コスト込みの建値 (読みの管理の建値と同じ式に 決済の手数料率 + 半スプレッドの率)", () => {
    // 買い: (建値 + エントリー手数料/単位) / (1 − 決済コスト率)
    expect(breakevenStopPrice({ direction: "long", entryPrice: 100, entryFeePerUnit: 0.15, exitFeeRate: 0.0015, halfSpreadRate: 0.0001 }))
      .toBeCloseTo(100.15 / (1 - 0.0016), 12);
    // 売り: (建値 − エントリー手数料/単位) / (1 + 決済コスト率)
    expect(breakevenStopPrice({ direction: "short", entryPrice: 100, entryFeePerUnit: 0.15, exitFeeRate: 0.0015, halfSpreadRate: 0.0001 }))
      .toBeCloseTo(99.85 / (1 + 0.0016), 12);
    // ≈ 建値 × (1 + 決済コスト率) + エントリー手数料/単位
    expect(breakevenStopPrice({ direction: "long", entryPrice: 100, entryFeePerUnit: 0.1, exitFeeRate: 0.001 })!).toBeCloseTo(100 * 1.001 + 0.1, 2);
    expect(breakevenStopPrice({ direction: "long", entryPrice: 100 })).toBe(100);
    expect(breakevenStopPrice({ direction: "long", entryPrice: 0 })).toBeUndefined();
  });
});

// ───────── PositionManager (paper) ─────────

const INST: Instrument = {
  symbol: SYM, venue: "paper", assetClass: "crypto", baseCurrency: "AAA", quoteCurrency: "USD", tickSize: 0.01, lotSize: 0.001, minQty: 0.001,
  takerFeeRate: 0.001, makerFeeRate: 0.0005, allowShort: true, fixedFeePerOrder: 0.05,
};

const ctx: EntryContext = {
  regime: { label: "trend_up", trend: 0.5, trendStrength: 30, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 2 },
  confidence: 0.7, expectedEdgeBps: 50, costBps: 22, params: { stopAtr: 1 }, features: {}, riskMultiplier: 1, reason: "test",
};

const q = (mid: number, ts: number, half = 0.01): Quote => ({ ts, bid: mid - half, ask: mid + half });

function setup(o: { breakeven?: BreakevenSettings; thesis?: boolean; store?: MemoryStore; paper?: PaperBroker; clock?: { t: number; now(): number } } = {}) {
  const clock = o.clock ?? { t: T0, now() { return this.t; } };
  const store = o.store ?? new MemoryStore();
  const paper = o.paper ?? new PaperBroker({ instruments: [INST], baseCurrency: "USD", initialEquity: 1_000_000, slippageBps: 0, clock });
  const journal = new TradeJournal({ store, mode: "paper" });
  const closed: TradeRecord[] = [];
  const pm = new PositionManager({
    journal, brokerFor: () => paper, onTradeClosed: (t) => closed.push(t), store, instrumentOf: () => INST,
    ...(o.breakeven ? { breakeven: o.breakeven } : {}),
    ...(o.thesis ? { thesis: { ...DEFAULT_THESIS_SETTINGS } } : {}),
  });
  async function open(direction: "long" | "short", price: number, stop: number, plan: ExitPlan, entryMid?: number) {
    paper.onQuote(SYM, q(price, clock.t, 0));
    const r = await paper.placeOrder({ clientId: `o-${clock.t}`, symbol: SYM, side: direction === "long" ? "buy" : "sell", type: "market", qty: "1", strategyId: "s1" });
    const f = r.fills[0];
    return pm.open(
      {
        mode: "paper", symbol: SYM, venue: "paper", assetClass: "crypto", strategyId: "s1", horizon: "scalp", direction, qty: 1, entryTs: clock.t,
        entryPrice: f.price, intendedEntryPrice: price, initialStop: stop, entryContext: ctx, entryFees: Number(f.fee),
        ...(entryMid !== undefined ? { entryMid } : {}),
      },
      plan,
    );
  }
  async function tickAt(min: number, mid: number, half = 0.01) {
    clock.t = T0 + min * MIN;
    const quote = q(mid, clock.t, half);
    paper.onQuote(SYM, quote);
    return pm.onQuote(SYM, quote, clock.t);
  }
  return { clock, store, paper, journal, pm, closed, open, tickAt };
}

/** 往復コスト込みの建値 (1 単位: 固定手数料 0.05 は 1 単位 = 約定代金 entryPrice で率換算) */
const expectedStop = (direction: "long" | "short", entryPrice: number, entryFees: number, mid: number, half = 0.01) =>
  breakevenStopPrice({ direction, entryPrice, entryFeePerUnit: entryFees, exitFeeRate: 0.001 + 0.05 / entryPrice, halfSpreadRate: half / mid })!;

describe("建値ストップ (PositionManager・paper)", () => {
  it("買い: エントリーの仲値から ちょうど 0.5R (仲値) で発動し、往復コスト (固定手数料込み) の建値へ。次のティックで割ったら trailing + breakevenStopExit", async () => {
    const s = setup({ breakeven: ON });
    // 建値 100 (約定)、エントリーの仲値 100.2、損切り 98 → 1R = 2。発動は仲値 ≥ 101.2 (建値基準なら 101.0)
    const p = await s.open("long", 100, 98, {}, 100.2);
    expect(p.entryFees).toBeCloseTo(100 * 0.001 + 0.05, 12);
    expect((await s.tickAt(1, 101.19)).status).toBe("none");
    expect(s.pm.planOf(p.id).breakeven).toBeUndefined();
    expect(s.pm.currentStop(s.pm.get(SYM)!)).toBe(98);
    expect((await s.tickAt(2, 101.2)).status).toBe("none");
    const be = expectedStop("long", 100, p.entryFees, 101.2);
    expect(be).toBeGreaterThan(100.25);
    expect(s.pm.planOf(p.id).breakeven).toEqual({ armedAt: T0 + 2 * MIN, stop: be });
    expect(s.pm.currentStop(s.pm.get(SYM)!)).toBeCloseTo(be, 12);
    expect(s.pm.view(s.pm.get(SYM)!).stopLoss).toBeCloseTo(be, 12);
    const audit = s.store.listAudit({ type: "position.breakeven_armed" });
    expect(audit).toHaveLength(1);
    expect(audit[0].data).toMatchObject({ tradeId: p.id, symbol: SYM, entryRef: 100.2, triggerR: 0.5, stop: be });
    // さらに伸びても監査ログは 1 回だけ。ストップも変わらない
    expect((await s.tickAt(3, 101.5)).status).toBe("none");
    expect(s.store.listAudit({ type: "position.breakeven_armed" })).toHaveLength(1);
    expect(s.pm.planOf(p.id).breakeven?.stop).toBe(be);
    // 建値 (コスト込み) を割る → trailing
    const r = await s.tickAt(4, 100.2);
    expect(r.status).toBe("closed");
    expect(r.trade!.exitReason).toBe("trailing");
    expect(r.trade!.breakevenStopExit).toBe(true);
    expect(r.trade!.thesisStopExit).toBeUndefined();
    expect(r.trade!.intendedExitPrice).toBeCloseTo(be, 12);
    expect(isStrategyTrailingExit(r.trade!)).toBe(false);
  });

  it("売り: 仲値で 0.5R 下がったら発動し、ストップ = (建値 − エントリー手数料) / (1 + 決済コスト率)", async () => {
    const s = setup({ breakeven: ON });
    const p = await s.open("short", 100, 102, {});
    // entryMid が無い建玉は建値基準: 仲値 ≤ 99.0
    expect((await s.tickAt(1, 99.01)).status).toBe("none");
    expect(s.pm.planOf(p.id).breakeven).toBeUndefined();
    expect((await s.tickAt(2, 99)).status).toBe("none");
    const be = expectedStop("short", 100, p.entryFees, 99);
    expect(be).toBeLessThan(99.8);
    expect(s.pm.planOf(p.id).breakeven?.stop).toBeCloseTo(be, 12);
    const r = await s.tickAt(3, 99.8);
    expect(r.status).toBe("closed");
    expect(r.trade).toMatchObject({ exitReason: "trailing", breakevenStopExit: true });
    expect(r.trade!.intendedExitPrice).toBeCloseTo(be, 12);
  });

  it("発動した気配ではストップを判定しない (スプレッドが広くても発動そのもので決済しない)", async () => {
    const s = setup({ breakeven: ON });
    const p = await s.open("long", 100, 98, {});
    // 仲値 101、半スプレッド 0.9 → bid 100.1 < 建値ストップ。発動した気配では決済しない
    expect((await s.tickAt(1, 101, 0.9)).status).toBe("none");
    expect(s.pm.planOf(p.id).breakeven).toBeDefined();
    expect(s.pm.get(SYM)).toBeDefined();
    // 次の気配で割っていれば決済
    expect((await s.tickAt(2, 100.5, 0.5)).status).toBe("closed");
  });

  it("緩めない: 戦略のトレーリングの方がきつければそれを使い、印は付けない", async () => {
    const s = setup({ breakeven: ON });
    const p = await s.open("long", 100, 98, { trailingStopPct: 0.001 }, 100);
    expect((await s.tickAt(1, 101.2)).status).toBe("none");
    const be = s.pm.planOf(p.id).breakeven!.stop;
    const trail = 101.2 * (1 - 0.001);
    expect(trail).toBeGreaterThan(be);
    expect(s.pm.currentStop(s.pm.get(SYM)!)).toBeCloseTo(trail, 12);
    const r = await s.tickAt(2, 101);
    expect(r.status).toBe("closed");
    expect(r.trade!.exitReason).toBe("trailing");
    expect(r.trade!.intendedExitPrice).toBeCloseTo(trail, 12);
    expect(r.trade!.breakevenStopExit).toBeUndefined();
    expect(isStrategyTrailingExit(r.trade!)).toBe(true);
  });

  it("緩めない: 読みの管理の延長後の保護ストップの方がきつければそれを使い、thesisStopExit が付く", async () => {
    const s = setup({ breakeven: ON, thesis: true });
    const p = await s.open("long", 100, 98, { maxHoldMs: 10 * MIN }, 100);
    // 期限で +1.25R → 延長 (極値 bid 102.49 − 0.5R = 101.49) と建値ストップの発動が同じ気配
    expect((await s.tickAt(10, 102.5)).status).toBe("none");
    const plan = s.pm.planOf(p.id);
    expect(plan.thesis?.extendedAt).toBe(T0 + 10 * MIN);
    expect(plan.breakeven).toBeDefined();
    expect(s.pm.currentStop(s.pm.get(SYM)!)).toBeCloseTo(101.49, 9);
    const r = await s.tickAt(11, 101.3);
    expect(r.status).toBe("closed");
    expect(r.trade).toMatchObject({ exitReason: "trailing", thesisStopExit: true });
    expect(r.trade!.breakevenStopExit).toBeUndefined();
  });

  it("決済計画 (kv positions:exitPlans:paper) に保存し、再起動後も続く。設定を 0 にして再起動しても保存したストップで守る", async () => {
    const store = new MemoryStore();
    const clock = { t: T0, now() { return this.t; } };
    const paper = new PaperBroker({ instruments: [INST], baseCurrency: "USD", initialEquity: 1_000_000, slippageBps: 0, clock });
    const s = setup({ breakeven: ON, store, paper, clock });
    const p = await s.open("long", 100, 98, {}, 100);
    await s.tickAt(1, 101.5);
    const saved = store.kvGet<Record<string, ExitPlan>>("positions:exitPlans:paper")?.[p.id];
    expect(saved?.breakeven).toEqual({ armedAt: T0 + MIN, stop: expectedStop("long", 100, p.entryFees, 101.5) });
    // 古い計画 (breakeven なし) を読める建玉も同じストア上で共存する
    const s2 = setup({ breakeven: BREAKEVEN_DISABLED, store, paper, clock });
    expect(s2.pm.planOf(p.id).breakeven).toEqual(saved!.breakeven);
    expect(s2.pm.currentStop(s2.pm.get(SYM)!)).toBeCloseTo(saved!.breakeven!.stop, 12);
    const r = await s2.tickAt(2, 100.2);
    expect(r.status).toBe("closed");
    expect(r.trade).toMatchObject({ exitReason: "trailing", breakevenStopExit: true });
  });

  it("無効 (0) なら設定なしと同一 (発動しない・保存しない・監査ログなし)", async () => {
    const run = async (breakeven?: BreakevenSettings) => {
      const s = setup(breakeven ? { breakeven } : {});
      const p = await s.open("long", 100, 98, {}, 100);
      const out: string[] = [];
      for (const [m, mid] of [[1, 101.5], [2, 102], [3, 100.2], [4, 99], [5, 97.9]] as const) {
        const r = await s.tickAt(m, mid);
        out.push(`${r.status}|${r.trade?.exitReason ?? ""}|${r.trade?.intendedExitPrice ?? ""}`);
        if (r.status === "closed") break;
      }
      return { out, plan: s.pm.planOf(p.id), audit: s.store.listAudit({ type: "position.breakeven_armed" }).length, trade: s.closed[0] };
    };
    const off = await run(BREAKEVEN_DISABLED);
    const none = await run();
    expect(off.out).toEqual(none.out);
    expect(off.out.at(-1)).toBe("closed|stop|98");
    expect(off.audit).toBe(0);
    expect(off.trade.breakevenStopExit).toBeUndefined();
    // 同じ値動きで有効なら建値ストップで決済
    const on = await run(ON);
    expect(on.out.at(-1)).toMatch(/^closed\|trailing\|/);
    expect(on.trade.breakevenStopExit).toBe(true);
  });
});

// ───────── 記録・ParamTuner ─────────

describe("breakevenStopExit の記録と ParamTuner", () => {
  const base = (): TradeRecord => ({
    id: "t1", mode: "paper", symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", strategyId: "s1", horizon: "scalp", direction: "long",
    qty: 1, entryTs: T0, entryPrice: 100, intendedEntryPrice: 100, exitTs: T0 + MIN, exitPrice: 100.3, intendedExitPrice: 100.3, initialStop: 98,
    grossPnl: 0.3, fees: 0.2, netPnl: 0.1, returnPct: 0.001, rMultiple: 0.05, mfePct: 0.012, maePct: 0, exitReason: "trailing", entryContext: ctx,
    postExitMovePct: 0.02,
  });

  it("trailing のときだけ記録に付く (journal)", () => {
    const j = new TradeJournal({ mode: "paper" });
    const open = () =>
      j.open({
        mode: "paper", symbol: SYM, venue: "paper", assetClass: "crypto", strategyId: "s1", horizon: "scalp", direction: "long", qty: 1, entryTs: T0,
        entryPrice: 100, intendedEntryPrice: 100, initialStop: 98, entryContext: ctx,
      });
    const a = open();
    expect(buildTradeRecord(a, { id: a.id, exitPrice: 100.3, exitTs: T0 + MIN, exitReason: "trailing", breakevenStopExit: true }).breakevenStopExit).toBe(true);
    expect(buildTradeRecord(a, { id: a.id, exitPrice: 100.3, exitTs: T0 + MIN, exitReason: "stop", breakevenStopExit: true }).breakevenStopExit).toBeUndefined();
  });

  it("isStrategyTrailingExit と trail_loosen・exit_sooner の根拠から除く", () => {
    const strat = base();
    const be: TradeRecord = { ...base(), breakevenStopExit: true };
    expect(isStrategyTrailingExit(strat)).toBe(true);
    expect(isStrategyTrailingExit(be)).toBe(false);
    const loosen = TUNER_RULES.find((r) => r.id === "trail_loosen")!;
    expect(loosen.evidence(strat, attributeTrade(strat))).toBe(true);
    expect(loosen.evidence(be, attributeTrade(be))).toBe(false);
    const sooner = TUNER_RULES.find((r) => r.id === "exit_sooner")!;
    const lateExit = { causes: [{ code: "late_exit" as const, detail: "", weight: 1 }] } as unknown as ReturnType<typeof attributeTrade>;
    expect(sooner.evidence(strat, lateExit)).toBe(true);
    expect(sooner.evidence(be, lateExit)).toBe(false);
  });
});

// ───────── バックテスト ─────────

const M = 60_000;
const ENTRY = 11;
const closeOf = (i: number) => T0 + (i + 1) * M;
const binst: Instrument = { ...syntheticInstrument({ takerFeeRate: 0.001, tickSize: 0, lotSize: 0, minQty: 0 }), makerFeeRate: 0.001 };
const SPREAD_BPS = 2;
const HS = SPREAD_BPS / 2 / 1e4;

function scripted(sig: Signal): Strategy {
  return {
    id: "scripted", horizon: "scalp", assetClasses: ["crypto"], regimes: ["range"], primaryTimeframe: "1m", timeframes: ["1m"], warmup: 1,
    defaultParams: {}, paramBounds: {},
    evaluate: (c: StrategyContext) => (c.market.now === closeOf(ENTRY - 1) && !c.position ? sig : null),
  };
}
const sig = (direction: "long" | "short", stopLoss: number): Signal => ({
  strategyId: "scripted", horizon: "scalp", symbol: binst.symbol, direction, confidence: 0.7, expectedEdgeBps: 100,
  entry: { type: "market" }, stopLoss, maxHoldMs: 600 * M, reason: "scripted", features: {},
});
/** 足 (ts, 始値, 高値, 安値, 終値)。エントリー (足 ENTRY の始値 100) より前は 100 で平ら */
function bars(after: Array<[number, number, number, number]>, n = 30): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const k = i - ENTRY;
    const [o, h, l, c] = k >= 0 && k < after.length ? after[k] : k >= after.length ? [after.at(-1)![3], after.at(-1)![3], after.at(-1)![3], after.at(-1)![3]] : [100, 100, 100, 100];
    out.push({ ts: T0 + i * M, open: o, high: h, low: l, close: c, volume: 100 });
  }
  return out;
}
const bt = (candles: Candle[], s: Signal, breakeven?: BreakevenSettings) =>
  runBacktest({ strategy: scripted(s), instrument: binst, candles, spreadBps: SPREAD_BPS, slippageBps: 0, closeAtEnd: false, ...(breakeven ? { breakeven } : {}) });

describe("建値ストップ (バックテスト)", () => {
  // 買い: 始値 100 (約定 100.01)、損切り 98.01 → 1R = 2。0.5R = 終値 ≥ 101 (entryMid = 始値 100)
  it("足の終値で発動し、同じ足の安値では判定しない。次の足から効いて trailing + breakevenStopExit", () => {
    const candles = bars([
      [100, 101.2, 100, 101], // ENTRY: 終値 101 = ちょうど 0.5R → 発動 (この足の安値 100 は建値ストップより下だが判定しない)
      [101, 101.1, 100.05, 100.5], // 次の足: 安値 100.05 が建値ストップを割る → trailing
    ]);
    const r = bt(candles, sig("long", 98.01), ON);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    const entry = 100 * (1 + HS);
    const be = breakevenStopPrice({ direction: "long", entryPrice: entry, entryFeePerUnit: entry * 0.001, exitFeeRate: 0.001, halfSpreadRate: HS })!;
    expect(t.entryPrice).toBeCloseTo(entry, 12);
    expect(t).toMatchObject({ exitReason: "trailing", breakevenStopExit: true, exitTs: closeOf(ENTRY + 1) });
    expect(t.intendedExitPrice).toBeCloseTo(be, 12);
    expect(isStrategyTrailingExit(t)).toBe(false);
  });

  it("終値が閾値に届かなければ発動しない (足の中の高値では発動しない)", () => {
    const candles = bars([
      [100, 102, 100, 100.99],
      [100.99, 101.1, 100.05, 100.5],
      [100.5, 100.5, 97, 97],
    ]);
    const r = bt(candles, sig("long", 98.01), ON);
    expect(r.trades[0]).toMatchObject({ exitReason: "stop" });
    expect(r.trades[0].breakevenStopExit).toBeUndefined();
  });

  it("売りも同じ (終値 ≤ 99 で発動、次の足の高値で判定)", () => {
    const candles = bars([
      [100, 100, 98.9, 99],
      [99, 99.95, 98.8, 99.5],
    ]);
    const r = bt(candles, sig("short", 101.99), ON);
    const entry = 100 * (1 - HS);
    const be = breakevenStopPrice({ direction: "short", entryPrice: entry, entryFeePerUnit: entry * 0.001, exitFeeRate: 0.001, halfSpreadRate: HS })!;
    expect(r.trades[0]).toMatchObject({ exitReason: "trailing", breakevenStopExit: true });
    expect(r.trades[0].intendedExitPrice).toBeCloseTo(be, 12);
  });

  it("無効 (0・省略) なら従来と同一", () => {
    const candles = bars([
      [100, 101.2, 100, 101],
      [101, 101.1, 100.05, 100.5],
      [100.5, 100.5, 97, 97],
    ]);
    const a = bt(candles, sig("long", 98.01));
    const b = bt(candles, sig("long", 98.01), BREAKEVEN_DISABLED);
    expect(b.trades).toEqual(a.trades);
    expect(a.trades[0].exitReason).toBe("stop");
  });
});

// ───────── 仮想トレード ─────────

describe("建値ストップ (仮想トレード)", () => {
  const inst = { symbol: "BTC/USDT", assetClass: "crypto" as const, takerFeeRate: 0.001 };
  const sq = (bid: number, ask: number) => ({ bid, ask });
  const record = (tr: ShadowTracker, direction: "long" | "short" = "long") =>
    tr.record({
      instrument: inst, quote: sq(99.9, 100.1),
      signal: { strategyId: "scalp_x", direction, confidence: 0.7, expectedEdgeBps: 15, stopLoss: direction === "long" ? 98.1 : 101.9, maxHoldMs: 60 * MIN, horizon: "scalp" },
      regime: "range", reason: "lower_score", now: T0,
    });
  const tracker = (breakeven: BreakevenSettings | undefined, store = new MemoryStore(), closed: ShadowTradeRecord[] = []) =>
    new ShadowTracker({ store, mode: "paper", options: breakeven ? { breakeven } : {}, onClosed: (t) => closed.push(t) });

  it("仲値 (entryMid 100 から 0.5R = +1) で発動し、往復コスト込みの建値。発動した判定では決済せず、以後の気配・足で割ったら trailing", () => {
    const store = new MemoryStore();
    const tr = tracker(ON, store);
    record(tr);
    // 1R = 100.1 − 98.1 = 2。仲値 100.99 → 発動しない
    expect(tr.update(T0 + MIN, () => sq(100.89, 101.09))).toEqual([]);
    expect(tr.list()[0].breakevenStop).toBeUndefined();
    // 仲値 101 → 発動
    expect(tr.update(T0 + 2 * MIN, () => sq(100.9, 101.1))).toEqual([]);
    const o = tr.list()[0];
    const entryFill = 100 + 0.1 + 0.0001 * 100;
    const be = breakevenStopPrice({ direction: "long", entryPrice: entryFill, entryFeePerUnit: 0.001 * entryFill, exitFeeRate: 0.001, halfSpreadRate: 0.1 / 101 })!;
    expect(o.breakevenArmedAt).toBe(T0 + 2 * MIN);
    expect(o.breakevenStop).toBeCloseTo(be, 12);
    expect(store.kvGet<ShadowOpen[]>(shadowOpenKey("paper"))?.[0].breakevenStop).toBeCloseTo(be, 12);
    // 再起動しても続く。発動より前に始まった足の安値 (99) では決済しない
    const closed: ShadowTradeRecord[] = [];
    const tr2 = tracker(ON, store, closed);
    const rangeOf = (_s: string, since: number) => (since <= T0 + MIN ? { high: 101, low: 99, lastCandleTs: T0 + MIN } : undefined);
    expect(tr2.update(T0 + 3 * MIN, () => sq(100.9, 101.1), { rangeOf })).toEqual([]);
    // 発動後の気配で建値ストップを割る → trailing
    const [r] = tr2.update(T0 + 4 * MIN, () => sq(100.2, 100.4));
    expect(r).toMatchObject({ exitReason: "trailing" });
    expect(r.exitPrice).toBeCloseTo(100.2 * (1 - 0.0001), 9);
    expect("breakevenStop" in r).toBe(false);
    expect(closed).toHaveLength(1);
  });

  it("発動した時刻以降に始まった足の安値で割れば trailing (ストップ価格 − 約定ずれ)", () => {
    const tr = tracker(ON);
    record(tr);
    tr.update(T0 + 2 * MIN, () => sq(100.9, 101.1));
    const be = tr.list()[0].breakevenStop!;
    const rangeOf = (_s: string, since: number) => (since >= T0 + 2 * MIN ? { high: 101, low: 100.1, lastCandleTs: T0 + 3 * MIN } : undefined);
    const [r] = tr.update(T0 + 4 * MIN, () => sq(100.9, 101.1), { rangeOf });
    expect(r.exitReason).toBe("trailing");
    expect(r.exitPrice).toBeCloseTo(be * (1 - 0.0001), 9);
  });

  it("無効なら従来どおり (発動しない)", () => {
    for (const s of [undefined, BREAKEVEN_DISABLED]) {
      const tr = tracker(s);
      record(tr);
      expect(tr.update(T0 + 2 * MIN, () => sq(100.9, 101.1))).toEqual([]);
      expect(tr.list()[0].breakevenStop).toBeUndefined();
      expect(tr.update(T0 + 4 * MIN, () => sq(100.2, 100.4))).toEqual([]);
    }
  });
});

// ───────── エンジンへの配線 ─────────

describe("建値ストップ (エンジンの設定)", () => {
  it("TradingEngine は BREAKEVEN_TRIGGER_R を読む (既定 0.5、0 で無効)", async () => {
    for (const [env, want] of [[{}, 0.5], [{ BREAKEVEN_TRIGGER_R: "1.5" }, 1.5], [{ BREAKEVEN_TRIGGER_R: "0" }, 0]] as const) {
      const { runtime } = await buildTestRuntime({ config: testConfig({ ...env }) });
      expect(runtime.engine.breakeven).toEqual({ triggerR: want });
      await runtime.engine.stop();
    }
  });
});
