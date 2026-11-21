/**
 * paper での空売りの再現 (PAPER_SIMULATE_SHORT)。合成データ・偽のブローカー・MemoryStore のみ (完全オフライン)。
 * - paper: 現物の暗号資産 (allowShort=false) の売りシグナルが約定し、借入コストが手数料に計上される
 * - live: 同じ銘柄の売りは戦略・RiskManager で拒否 (発注しない)。simulatedShort が付いていても無視する
 * - meme / DEX は対象外。PAPER_SIMULATE_SHORT=false なら従来どおり
 * - 腕のキーが方向別 (…|short)、パラメータ調整から除外、report / ダッシュボードの集計で分ける
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/appConfig";
import { canShort, isSimulatedShort, simulatedShortEligible, withSimulatedShort } from "../src/core/short";
import type {
  Clock, Instrument, IntelBias, MarketView, RegimeFeatures, Signal, Strategy, StrategyContext, TradeRecord,
} from "../src/core/types";
import { buildReportText } from "../src/cli";
import { tradesPayload } from "../src/dashboard/server";
import { emptyBrief } from "../src/engine/context";
import { renderSideTable, summarizeBySide } from "../src/engine/report";
import { buildRuntime } from "../src/engine/setup";
import { PaperBroker } from "../src/execution/paper";
import type { BrokerSet } from "../src/execution/router";
import { buildBaselinePlan, mergeAiPlan } from "../src/intel/planner";
import { armKey, armKeyOf, armStateKey, StrategyAllocator } from "../src/learning/allocator";
import { summarizeShadowTrades } from "../src/learning/shadow";
import { learnableTrades } from "../src/learning/tuner";
import { mulberry32, SyntheticFeed } from "../src/market/feeds/synthetic";
import { DEFAULT_RISK } from "../src/appConfig";
import { RiskManager } from "../src/risk/manager";
import { MemoryStore } from "../src/storage/memory";
import { buildEntrySignal } from "../src/strategies/common";
import { FakeLiveBroker } from "./helpers/fakeLiveBroker";

const MIN = 60_000;
const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 5);
const LABELS = ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"] as const;

const spot: Instrument = {
  symbol: "BTC/JPY", venue: "ccxt:bitbank", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "JPY",
  tickSize: 1, lotSize: 0.0001, minQty: 0.0001, takerFeeRate: 0.001, makerFeeRate: 0.001, allowShort: false,
};
const simSpot: Instrument = { ...spot, simulatedShort: true };
const meme: Instrument = { ...spot, symbol: "PEPE/JPY", assetClass: "meme" };
const dexCrypto: Instrument = { ...spot, symbol: "X/SOL", venue: "dex:solana" };
/** 取引所で空売りできる銘柄 (allowShort=true) の例 */
const shortable: Instrument = {
  symbol: "XRP/JPY", venue: "paper", assetClass: "crypto", baseCurrency: "XRP", quoteCurrency: "JPY", tickSize: 0.001, lotSize: 1, minQty: 1,
  takerFeeRate: 0, makerFeeRate: 0, allowShort: true, contractSize: 1,
};

const mkClock = (t = START): Clock & { t: number } => ({ t, now() { return this.t; } });

describe("canShort / 対象銘柄", () => {
  it("simulatedShort は paper のときだけ効く。live・バックテスト・mode 不明では allowShort だけ", () => {
    expect(canShort(simSpot, "paper")).toBe(true);
    expect(canShort(simSpot, "live")).toBe(false);
    expect(canShort(simSpot, "backtest")).toBe(false);
    expect(canShort(simSpot, undefined)).toBe(false);
    expect(canShort(spot, "paper")).toBe(false); // 印が無ければ paper でも不可
    expect(canShort(shortable, "live")).toBe(true);
    expect(isSimulatedShort(simSpot, "paper", "short")).toBe(true);
    expect(isSimulatedShort(simSpot, "paper", "long")).toBe(false);
    expect(isSimulatedShort(shortable, "paper", "short")).toBe(false); // 取引所で空売りできる銘柄は再現ではない
  });

  it("meme と DEX は対象外 (印が付いていても空売りしない)", () => {
    expect(simulatedShortEligible(meme)).toBe(false);
    expect(simulatedShortEligible(dexCrypto)).toBe(false);
    expect(canShort({ ...meme, simulatedShort: true }, "paper")).toBe(false);
    expect(canShort({ ...dexCrypto, simulatedShort: true }, "paper")).toBe(false);
  });

  it("withSimulatedShort は paper かつ有効のときだけ印を付け、allowShort は書き換えない", () => {
    const p = withSimulatedShort(spot, { mode: "paper", enabled: true });
    expect(p).toMatchObject({ simulatedShort: true, allowShort: false });
    expect(spot.simulatedShort).toBeUndefined(); // 元は書き換えない
    expect(withSimulatedShort(spot, { mode: "live", enabled: true }).simulatedShort).toBeUndefined();
    expect(withSimulatedShort(spot, { mode: "paper", enabled: false }).simulatedShort).toBeUndefined();
    expect(withSimulatedShort(meme, { mode: "paper", enabled: true }).simulatedShort).toBeUndefined();
    expect(withSimulatedShort(shortable, { mode: "paper", enabled: true })).toBe(shortable);
  });
});

describe("設定", () => {
  it("既定は PAPER_SIMULATE_SHORT=true、借入コスト 0.04%/日", () => {
    const c = loadConfig({});
    expect(c.env.PAPER_SIMULATE_SHORT).toBe(true);
    expect(c.env.PAPER_SHORT_BORROW_RATE_DAILY).toBe(0.0004);
  });
  it("false / 0 / off で無効。日率は 0〜0.01 に限る。不正な値は起動を止める", () => {
    expect(loadConfig({ PAPER_SIMULATE_SHORT: "false" }).env.PAPER_SIMULATE_SHORT).toBe(false);
    expect(loadConfig({ PAPER_SIMULATE_SHORT: "0" }).env.PAPER_SIMULATE_SHORT).toBe(false);
    expect(loadConfig({ PAPER_SIMULATE_SHORT: "OFF" }).env.PAPER_SIMULATE_SHORT).toBe(false);
    expect(() => loadConfig({ PAPER_SIMULATE_SHORT: "maybe" })).toThrow(/PAPER_SIMULATE_SHORT/);
    expect(loadConfig({ PAPER_SHORT_BORROW_RATE_DAILY: "0" }).env.PAPER_SHORT_BORROW_RATE_DAILY).toBe(0);
    expect(loadConfig({ PAPER_SHORT_BORROW_RATE_DAILY: "0.01" }).env.PAPER_SHORT_BORROW_RATE_DAILY).toBe(0.01);
    expect(() => loadConfig({ PAPER_SHORT_BORROW_RATE_DAILY: "0.04" })).toThrow(/PAPER_SHORT_BORROW_RATE_DAILY/);
    expect(() => loadConfig({ PAPER_SHORT_BORROW_RATE_DAILY: "-0.001" })).toThrow(/PAPER_SHORT_BORROW_RATE_DAILY/);
  });
});

describe("PaperBroker: 空売りの再現", () => {
  const quote = (bid: number, ask: number, ts = START) => ({ ts, bid, ask });
  const mk = (insts: Instrument[], clock: Clock, rate?: number) =>
    new PaperBroker({ instruments: insts, baseCurrency: "JPY", initialEquity: 1_000_000, slippageBps: 0, clock, ...(rate !== undefined ? { shortBorrowRateDaily: rate } : {}) });

  it("売りで負の建玉を持ち、建玉代金を余力から拘束し、買い戻しで借入コスト (建玉代金 × 日率 × 日数) を手数料に計上する", async () => {
    const clock = mkClock();
    const b = mk([simSpot], clock, 0.0004);
    b.onQuote("BTC/JPY", quote(10_000_000, 10_000_000));
    const r1 = await b.placeOrder({ clientId: "s1", symbol: "BTC/JPY", side: "sell", type: "market", qty: "0.01", strategyId: "t" });
    expect(r1.status).toBe("filled");
    expect(r1.fills[0].fee).toBe("100"); // 10,000,000 × 0.01 × 0.001
    expect(await b.getPositions()).toEqual([{ symbol: "BTC/JPY", qty: "-0.01", avgPrice: 10_000_000 }]);
    const bal = await b.getBalance();
    expect(Number(bal.equity)).toBe(1_000_000 - 100);
    expect(Number(bal.available)).toBe(1_000_000 - 100 - 100_000); // 建玉代金 10 万円を拘束 (crypto はレバレッジ 1)

    // 2 日後に 2% 下で買い戻す
    clock.t = START + 2 * DAY;
    b.onQuote("BTC/JPY", quote(9_800_000, 9_800_000, clock.t));
    // 決済前の評価額には未払いの借入コスト (100,000 × 0.0004 × 2 = 80) を負債として含める
    expect(Number((await b.getBalance()).equity)).toBeCloseTo(1_000_000 - 100 + 2_000 - 80, 6);
    const r2 = await b.placeOrder({ clientId: "s2", symbol: "BTC/JPY", side: "buy", type: "market", qty: "0.01", strategyId: "t", reduceOnly: true });
    expect(r2.status).toBe("filled");
    // 手数料 = 9,800,000 × 0.01 × 0.001 (98) + 借入コスト 80
    expect(Number(r2.fills[0].fee)).toBeCloseTo(98 + 80, 9);
    expect(await b.getPositions()).toEqual([]);
    const m = b.markToMarket();
    expect(m.realized).toBe(2_000);
    expect(m.cash).toBeCloseTo(1_000_000 - 100 + 2_000 - 98 - 80, 9);
  });

  it("一部の買い戻しは数量で按分し、残りはスナップショットをまたいで持ち越す", async () => {
    const clock = mkClock();
    const b = mk([simSpot], clock, 0.001);
    b.onQuote("BTC/JPY", quote(1_000_000, 1_000_000));
    await b.placeOrder({ clientId: "a", symbol: "BTC/JPY", side: "sell", type: "market", qty: "0.1", strategyId: "t" });
    clock.t = START + DAY;
    b.onQuote("BTC/JPY", quote(1_000_000, 1_000_000, clock.t));
    const half = await b.placeOrder({ clientId: "b", symbol: "BTC/JPY", side: "buy", type: "market", qty: "0.05", strategyId: "t", reduceOnly: true });
    // 借入 100,000 × 0.001 × 1 日 = 100 のうち半分 50 + 売買手数料 50
    expect(Number(half.fills[0].fee)).toBeCloseTo(50 + 50, 9);
    const snap = b.snapshot();
    expect(snap.positions[0]).toMatchObject({ qty: "-0.05", borrowAccrued: "50", borrowFrom: START + DAY });
    const b2 = mk([simSpot], clock, 0.001);
    b2.restore(JSON.parse(JSON.stringify(snap)));
    clock.t = START + 2 * DAY;
    b2.onQuote("BTC/JPY", quote(1_000_000, 1_000_000, clock.t));
    const rest = await b2.placeOrder({ clientId: "c", symbol: "BTC/JPY", side: "buy", type: "market", qty: "0.05", strategyId: "t", reduceOnly: true });
    // 持ち越し 50 + 50,000 × 0.001 × 1 日 = 50 → 100、売買手数料 50
    expect(Number(rest.fills[0].fee)).toBeCloseTo(100 + 50, 9);
  });

  it("印の無い現物・meme の空売りは従来どおり拒否、取引所で空売りできる銘柄の売りは借入コストなし (従来の会計)", async () => {
    const clock = mkClock();
    const b = mk([spot, { ...meme, simulatedShort: true }, shortable], clock, 0.01);
    b.onQuote("BTC/JPY", quote(100, 100));
    b.onQuote("PEPE/JPY", quote(100, 100));
    b.onQuote("XRP/JPY", quote(150, 150));
    expect((await b.placeOrder({ clientId: "x", symbol: "BTC/JPY", side: "sell", type: "market", qty: "1", strategyId: "t" })).status).toBe("rejected");
    expect((await b.placeOrder({ clientId: "y", symbol: "PEPE/JPY", side: "sell", type: "market", qty: "1", strategyId: "t" })).status).toBe("rejected");
    expect((await b.placeOrder({ clientId: "z", symbol: "XRP/JPY", side: "sell", type: "market", qty: "100", strategyId: "t" })).status).toBe("filled");
    clock.t = START + 10 * DAY;
    const close = await b.placeOrder({ clientId: "w", symbol: "XRP/JPY", side: "buy", type: "market", qty: "100", strategyId: "t" });
    expect(close.fills[0].fee).toBe("0");
    expect(b.snapshot().positions).toEqual([]);
  });
});

describe("RiskManager: 空売りの可否は mode で判定する", () => {
  const sig = (stopLoss: number): Signal => ({
    strategyId: "t", horizon: "scalp", symbol: "BTC/JPY", direction: "short", confidence: 0.8, expectedEdgeBps: 500,
    entry: { type: "market" }, stopLoss, maxHoldMs: 60_000, reason: "t", features: {},
  });
  const params = (inst: Instrument) => ({
    signal: sig(10_100), instrument: inst, quote: { ts: START, bid: 9_999, ask: 10_000 }, equity: 1_000_000, available: 1_000_000,
    positions: [], riskMultiplier: 1, now: START,
  });
  it("paper では再現する銘柄の空売りを受け付け、ストップは上側。live では同じ銘柄 (印付きでも) を拒否", () => {
    const paper = new RiskManager(DEFAULT_RISK, new MemoryStore(), { mode: "paper" }).evaluateEntry(params(simSpot));
    expect(paper.ok).toBe(true);
    const live = new RiskManager(DEFAULT_RISK, new MemoryStore(), { mode: "live" }).evaluateEntry(params(simSpot));
    expect(live).toMatchObject({ ok: false, reason: expect.stringContaining("空売り不可") });
    // 下側のストップは不正として拒否 (空売りのストップは上側)
    const bad = new RiskManager(DEFAULT_RISK, new MemoryStore(), { mode: "paper" }).evaluateEntry({ ...params(simSpot), signal: sig(9_900) });
    expect(bad.ok).toBe(false);
    // 印の無い現物は paper でも拒否
    expect(new RiskManager(DEFAULT_RISK, new MemoryStore(), { mode: "paper" }).evaluateEntry(params(spot)).ok).toBe(false);
  });
});

describe("戦略・計画", () => {
  const regime: RegimeFeatures = { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 };
  const ctx = (inst: Instrument, mode?: "paper" | "live"): StrategyContext => ({
    market: { instrument: inst, now: START, quote: { ts: START, bid: 9_999, ask: 10_000 }, candles: {} } as MarketView,
    regime, params: { stopAtr: 1, tpAtr: 2, maxHoldBars: 5 }, ...(mode ? { mode } : {}),
  });
  const entry = (c: StrategyContext) =>
    buildEntrySignal({ ctx: c, strategy: { id: "t", horizon: "scalp", primaryTimeframe: "1m" }, direction: "short", confidence: 0.7, atr: 50, lastPrice: 10_000, reason: "t", features: {} });

  it("buildEntrySignal: paper の再現銘柄だけ売りシグナルを出す (live・mode なし・meme は null)", () => {
    const s = entry(ctx(simSpot, "paper"))!;
    expect(s.direction).toBe("short");
    expect(s.stopLoss).toBeGreaterThan(10_000);
    expect(entry(ctx(simSpot, "live"))).toBeNull();
    expect(entry(ctx(simSpot))).toBeNull();
    expect(entry(ctx({ ...meme, simulatedShort: true }, "paper"))).toBeNull();
  });

  it("計画の片側バイアス short は取引所で空売りできる銘柄だけ。再現の銘柄は paper でも live と同じく both (倍率を絞るだけ)", () => {
    const bear: IntelBias = { asset: "BTC", sentiment: -0.9, confidence: 0.9, eventRisk: 0, sourceIds: [], sourceContrib: {} };
    const input = (mode: "paper" | "live") => ({
      brief: { ...emptyBrief(START), biases: { BTC: bear } }, instruments: [simSpot], regimes: {},
      strategies: [{ id: "s", horizon: "scalp" as const, assetClasses: ["crypto" as const], regimes: [...LABELS] }], lessons: [], now: START, mode,
    });
    const paper = buildBaselinePlan(input("paper")).perSymbol["BTC/JPY"];
    expect(paper.directionBias).toBe("both");
    expect(paper.notes).toContain("ショート不可");
    const live = buildBaselinePlan(input("live")).perSymbol["BTC/JPY"];
    expect(live.directionBias).toBe("both");
    expect(live.notes).toContain("ショート不可");
    const base = buildBaselinePlan({ ...input("live"), brief: emptyBrief(START) });
    const ai = { rationale: "", adjustments: [{ symbol: "BTC/JPY", enabledStrategies: ["s"], directionBias: "short" as const, riskMultiplier: 1, notes: "" }], extraBlackouts: [] };
    expect(mergeAiPlan(base, ai, [simSpot], START, "live").perSymbol["BTC/JPY"].directionBias).toBe("both");
    expect(mergeAiPlan(base, ai, [simSpot], START, "paper").perSymbol["BTC/JPY"].directionBias).toBe("both");
  });
});

/** 合成の取引記録 */
function trade(o: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: Math.random().toString(36).slice(2), mode: "paper", symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", strategyId: "s1", horizon: "scalp",
    direction: "long", qty: 1, entryTs: START, entryPrice: 100, intendedEntryPrice: 100, exitTs: START + MIN, exitPrice: 101, intendedExitPrice: 101,
    initialStop: 99, grossPnl: 1, fees: 0, netPnl: 1, returnPct: 0.01, rMultiple: 1, mfePct: 0.01, maePct: 0, exitReason: "take_profit",
    entryContext: {
      regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
      confidence: 0.5, expectedEdgeBps: 10, costBps: 2, params: {}, features: {}, riskMultiplier: 1, reason: "t",
    },
    ...o,
  };
}

describe("学習の分離", () => {
  it("腕のキー: 再現した空売りだけ …|short。買い・取引所で可能な売りは従来のキー (互換)", () => {
    expect(armKey("s1", "range", "crypto")).toBe("s1|range|crypto");
    expect(armKey("s1", "range", "crypto", true)).toBe("s1|range|crypto|short");
    expect(armKeyOf(trade())).toBe("s1|range|crypto");
    expect(armKeyOf(trade({ direction: "short", symbol: "XRP/JPY" }))).toBe("s1|range|crypto"); // 取引所で可能な売り
    expect(armKeyOf(trade({ direction: "short", assetClass: "fx" as never }))).toBe("s1|range|fx"); // 廃止したクラスの古い記録も同じキー
    expect(armKeyOf(trade({ direction: "short", simulatedShort: true }))).toBe("s1|range|crypto|short");
    const store = new MemoryStore();
    const a = new StrategyAllocator(store, {}, "paper");
    a.update(trade({ direction: "short", simulatedShort: true, rMultiple: -1, netPnl: -1 }));
    expect(store.kvGet(armStateKey("paper", "s1|range|crypto|short"))).toMatchObject({ n: 1 });
    expect(store.kvGet(armStateKey("paper", "s1|range|crypto"))).toBeUndefined();
  });

  it("パラメータ調整・振り返りの対象 (learnableTrades) から再現した空売りを除く", () => {
    const ts = [trade(), trade({ direction: "short", simulatedShort: true }), trade({ direction: "short", symbol: "XRP/JPY" }), trade({ estimated: true })];
    expect(learnableTrades(ts)).toEqual([ts[0], ts[2]]);
  });
});

describe("集計の分離 (report / ダッシュボード)", () => {
  it("summarizeBySide は買い・売り・空売り (paper 再現) に分け、live で実際にできる成績を明示する", () => {
    const ts = [
      trade({ netPnl: 10, rMultiple: 1 }), trade({ netPnl: -5, rMultiple: -0.5 }),
      trade({ direction: "short", simulatedShort: true, netPnl: 7, rMultiple: 0.7 }),
      trade({ direction: "short", symbol: "XRP/JPY", netPnl: 3, rMultiple: 0.3 }),
    ];
    const rows = summarizeBySide(ts, () => 1);
    expect(rows.map((r) => [r.side, r.label, r.trades, r.netPnl])).toEqual([
      ["long", "買い", 2, 5], ["short", "売り", 1, 3], ["simulated_short", "空売り (paper 再現)", 1, 7],
    ]);
    const text = renderSideTable(rows, "JPY");
    expect(text).toContain("live で実際にできる成績");
    expect(text).toMatch(/3 件 .*\+8 JPY/);
    expect(text).toContain("live では空売りしません");
  });

  it("仮想トレードの集計にも方向別 (bySide) を出す", () => {
    const base = { mode: "paper" as const, symbol: "BTC/USDT", assetClass: "crypto" as const, strategyId: "s", horizon: "scalp" as const, regime: "range" as const, reason: "r", confidence: 1, expectedEdgeBps: 1, entryTs: 0, entryPrice: 1, entryMid: 1, entrySpread: 0, stopLoss: 1, maxHoldMs: 1, takerFeeRate: 0, slippageBps: 0, exitTs: 1, exitPrice: 1, exitReason: "time" as const, grossR: 0, costR: 0, mfeR: 0, maeR: 0 };
    const s = summarizeShadowTrades([
      { ...base, id: "1", direction: "long", netR: 1 },
      { ...base, id: "2", direction: "short", simulatedShort: true, netR: -1 },
    ]);
    expect(s.bySide!.map((g) => g.key).sort()).toEqual(["空売り (paper 再現)", "買い"]);
  });

  it("CLI のレポートとダッシュボードの取引 API が方向別に分ける", () => {
    const store = new MemoryStore();
    store.saveTrade(trade({ id: "L1", netPnl: 10 }));
    store.saveTrade(trade({ id: "S1", direction: "short", simulatedShort: true, netPnl: -4 }));
    const text = buildReportText(loadConfig({ NODE_ENV: "test", DB_PATH: "memory", BASE_CURRENCY: "USDT" }), store, START + DAY);
    expect(text).toContain("■ 方向別の成績");
    expect(text).toContain("空売り (paper 再現)");
    expect(text).toContain("live で実際にできる成績");
    expect(text).toContain("■ 戦略別の成績 (空売り (paper 再現)。live では空売りしません)");
    const p = tradesPayload({ store, baseCurrency: "USDT", toAccount: () => 1, status: () => ({}), learning: { snapshot: () => { throw new Error("unused"); } } }, 50, "paper");
    expect(p.bySide.map((r) => r.side)).toEqual(["long", "simulated_short"]);
    expect(p.trades.find((t) => t.id === "S1")).toMatchObject({ simulatedShort: true });
    expect(p.trades.find((t) => t.id === "L1")).not.toHaveProperty("simulatedShort");
  });
});

// ───────── エンジン統合 ─────────

/** 保有していなければ常に売り (損切り 2% 上・保有上限 holdMin 分)。canShort の判定は戦略を通さず RiskManager に任せる */
function alwaysShort(holdMin = 60): Strategy {
  return {
    id: "always_short", horizon: "scalp", assetClasses: ["crypto", "meme"], regimes: [...LABELS], primaryTimeframe: "1m", timeframes: ["1m", "1h"],
    warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.position) return null;
      const px = ctx.market.quote.bid;
      return {
        strategyId: "always_short", horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: "short", confidence: 0.8, expectedEdgeBps: 300,
        entry: { type: "market" }, stopLoss: px * 1.02, maxHoldMs: holdMin * MIN, reason: "test", features: { x: 1 },
      };
    },
  };
}

async function paperRuntime(env: Record<string, string> = {}, holdMin = 60) {
  const clock = mkClock();
  const store = new MemoryStore();
  const config = loadConfig({ NODE_ENV: "test", LIMIT_ENTRY: "false", LIMIT_TAKE_PROFIT: "false", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "USDT", ...env });
  const rt = await buildRuntime(config, {
    clock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * DAY, rng: mulberry32(7), strategies: [alwaysShort(holdMin)],
    engine: { forecast: { enabled: false } },
  });
  const run = async (to: number, step = 15_000) => {
    for (let now = clock.t; now <= to; now += step) {
      clock.t = now;
      await rt.engine.tick(now);
    }
  };
  return { rt, clock, store, run };
}

describe("エンジン統合 (paper)", () => {
  it("現物の暗号資産の売りシグナルが約定し、借入コストが手数料に入り、TradeRecord と腕が方向別になる。meme は対象外", async () => {
    // PEPE/USDT は WATCHLIST で meme にする (合成データの既定は crypto)
    const { rt, store, run } = await paperRuntime({
      PAPER_SHORT_BORROW_RATE_DAILY: "0.01",
      WATCHLIST: "synthetic|BTC/USDT,synthetic|ETH/USDT,synthetic|PEPE/USDT|meme",
    }, 30);
    const btc = rt.hub.instrument("BTC/USDT")!;
    expect(btc).toMatchObject({ allowShort: false, simulatedShort: true });
    expect(rt.hub.instrument("PEPE/USDT")!.simulatedShort).toBeUndefined();
    await run(START + 3 * 60 * MIN);
    const entries = store.listAudit({ type: "engine.entry" }).map((a) => a.data as { symbol: string; simulatedShort?: boolean; direction: string });
    expect(entries.some((e) => e.symbol === "BTC/USDT" && e.simulatedShort === true && e.direction === "short")).toBe(true);
    expect(entries.some((e) => e.symbol === "PEPE/USDT")).toBe(false); // meme は空売りしない
    const trades = store.listTrades().filter((t) => t.assetClass === "crypto");
    expect(trades.length).toBeGreaterThan(0);
    for (const t of trades) {
      expect(t).toMatchObject({ direction: "short", simulatedShort: true });
      const days = (t.exitTs - t.entryTs) / DAY;
      const taker = 0.001 * t.qty * (t.entryPrice + t.exitPrice);
      const borrow = t.entryPrice * t.qty * 0.01 * days;
      expect(borrow).toBeGreaterThan(0);
      expect(t.fees).toBeCloseTo(taker + borrow, 6);
      expect(t.grossPnl).toBeCloseTo((t.entryPrice - t.exitPrice) * t.qty, 6); // 売りの損益 (下がれば利益)
    }
    // 腕は …|short だけ (買いの腕は作らない)
    const arms = rt.learning.allocator.keys().filter((k) => k.startsWith("always_short|") && k.includes("|crypto"));
    expect(arms.length).toBeGreaterThan(0);
    expect(arms.every((k) => k.endsWith("|crypto|short"))).toBe(true);
    // パラメータ調整・振り返りの対象外
    expect(learnableTrades(trades)).toEqual([]);
    await rt.engine.stop();
  }, 60_000);

  it("PAPER_SIMULATE_SHORT=false なら従来どおり (現物の売りは RiskManager が拒否し、発注しない)", async () => {
    const { rt, store, run } = await paperRuntime({ PAPER_SIMULATE_SHORT: "false" });
    expect(rt.hub.instrument("BTC/USDT")!.simulatedShort).toBeUndefined();
    await run(START + 10 * MIN);
    const entries = store.listAudit({ type: "engine.entry" }).map((a) => (a.data as { symbol: string }).symbol);
    expect(entries.filter((s) => s === "BTC/USDT" || s === "ETH/USDT")).toEqual([]);
    const rejects = store.listAudit({ type: "risk.reject" }).map((a) => String((a.data as { reason: string }).reason));
    expect(rejects.some((r) => r.includes("BTC/USDT は空売り不可"))).toBe(true);
    await rt.engine.stop();
  }, 60_000);
});

describe("エンジン統合 (paper): 買いの腕と空売りの腕は独立", () => {
  it("買いの腕 (従来のキー) が止まっていても、空売りの腕が有効なら空売りはエントリーする", async () => {
    const clock = mkClock();
    const store = new MemoryStore();
    for (const label of LABELS) {
      const key = armKey("always_short", label, "crypto");
      store.kvSet(armStateKey("paper", key), {
        key, alpha: 2, beta: 30, n: 60, sumR: -60, sumR2: 60, ewmaR: -1, ewmaVarR: 0, updatedAt: START - 1,
        realN: 60, realMeanR: -1, realVarR: 0, disabled: true, recMeanR: -50, recW: 1e6, disabledAt: START - 1, disableCount: 1,
      });
    }
    const config = loadConfig({ NODE_ENV: "test", LIMIT_ENTRY: "false", LIMIT_TAKE_PROFIT: "false", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "USDT" });
    // rng 0.99: 止まった腕の探索には当たらない
    const rt = await buildRuntime(config, { clock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * DAY, rng: () => 0.99, strategies: [alwaysShort()] });
    for (let i = 0; i < 12; i++) {
      clock.t = START + i * 15_000;
      await rt.engine.tick(clock.t);
    }
    const entries = store.listAudit({ type: "engine.entry" }).map((a) => a.data as { symbol: string; simulatedShort?: boolean; armWeight: number });
    expect(entries.some((e) => e.symbol === "BTC/USDT" && e.simulatedShort === true && e.armWeight === 1)).toBe(true);
    await rt.engine.stop();
  }, 60_000);
});

describe("エンジン統合 (live): 空売りの再現は効かない", () => {
  it("live では現物の売りシグナルを拒否して発注しない (instrument に simulatedShort が付いていても)", async () => {
    const clock = mkClock();
    const store = new MemoryStore();
    const feed = new SyntheticFeed({ clock, seed: 3, historyMs: 2 * DAY });
    const all = await feed.listInstruments();
    // 誤って印の付いた銘柄を渡しても live では空売りしない
    const instruments = [{ ...all.find((i) => i.symbol === "BTC/USDT")!, simulatedShort: true }];
    const broker = new FakeLiveBroker("paper");
    broker.placeMode = "fill";
    const brokerSet: BrokerSet = { mode: "live", brokers: new Map([[broker.venue, broker]]), brokerFor: () => broker };
    const config = loadConfig({ NODE_ENV: "test", LIMIT_ENTRY: "false", LIMIT_TAKE_PROFIT: "false", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "USD" });
    const rt = await buildRuntime(config, {
      clock, store, intelSources: [], ai: null, rng: mulberry32(7), strategies: [alwaysShort()], markets: [{ feed, instruments }], brokerSet,
      engine: { liveAccountCacheMs: 0 },
    });
    broker.quoteOf = (s) => rt.hub.latestQuote(s);
    expect(rt.engine.mode).toBe("live");
    for (let i = 0; i < 20; i++) {
      clock.t = START + i * 15_000;
      await rt.engine.tick(clock.t);
    }
    expect(broker.placed).toHaveLength(0);
    expect(store.listAudit({ type: "engine.entry" })).toHaveLength(0);
    expect(store.listAudit({ type: "risk.reject" }).some((a) => String((a.data as { reason: string }).reason).includes("空売り不可"))).toBe(true);
    expect(rt.learning.allocator.keys().some((k) => k.endsWith("|short"))).toBe(false);
    await rt.engine.stop();
  }, 60_000);
});
