import { describe, expect, it } from "vitest";
import type { Candle, EntryContext, Instrument, IntelBias, Quote, Strategy, TradeRecord } from "../src/core/types";
import { runBacktest } from "../src/backtest/engine";
import { syntheticInstrument } from "../src/backtest/synthetic";
import { PositionManager } from "../src/engine/positions";
import { PaperBroker } from "../src/execution/paper";
import { attributeTrade } from "../src/learning/attribution";
import { openKvKey, TradeJournal, type OpenTrade, type OpenTradeInput } from "../src/learning/journal";
import { MemoryStore } from "../src/storage/memory";

/**
 * 仲値基準の wrong_direction の判定 (エントリーのコストを方向の誤りと数えない)。
 * 基準: ロング、仲値 100 で約定 100.30 (片道 30bps のコスト)、損切り 99.4、仲値は 100.20 まで上がってから損切り。
 */
const ctx = (over: Partial<EntryContext> = {}): EntryContext => ({
  regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
  confidence: 0.6,
  expectedEdgeBps: 50,
  costBps: 60,
  params: {},
  features: {},
  riskMultiplier: 1,
  reason: "test",
  ...over,
});

const intel = (sentiment: number): IntelBias => ({
  asset: "MEME", sentiment, confidence: 1, eventRisk: 0, sourceIds: ["i1"], sourceContrib: { src_a: sentiment },
});

function lossTrade(over: Partial<TradeRecord> = {}, c: Partial<EntryContext> = {}): TradeRecord {
  const entryPrice = 100.3;
  const exitPrice = 99.35;
  const fees = 0.02;
  const grossPnl = exitPrice - entryPrice;
  const netPnl = grossPnl - fees;
  return {
    id: "m1", mode: "paper", symbol: "MEME/USDC", venue: "paper", assetClass: "meme", strategyId: "s1", horizon: "scalp",
    direction: "long", qty: 1, entryTs: 1_000, entryPrice, intendedEntryPrice: 100.3, exitTs: 2_000, exitPrice, intendedExitPrice: 99.4,
    initialStop: 99.4, grossPnl, fees, netPnl, returnPct: netPnl / entryPrice, rMultiple: netPnl / (entryPrice - 99.4),
    // 約定価格比: 仲値の最高値 100.20 は約定 100.30 を越えないので MFE 0
    mfePct: 0, maePct: (entryPrice - 99.35) / entryPrice,
    exitReason: "stop", entryContext: ctx(c),
    ...over,
  };
}

const codes = (t: TradeRecord) => attributeTrade(t).causes.map((c) => c.code).sort();

describe("attributeTrade: 仲値基準の wrong_direction", () => {
  it("(a) 仲値が 20bps 有利に動いた後に損切り (コスト 30bps): 従来は wrong_direction、仲値基準では fee_drag", () => {
    const old = lossTrade({}, { intel: intel(0.8) });
    expect(codes(old)).toContain("wrong_direction");
    expect(codes(old)).toContain("intel_misled");

    const t = lossTrade({ entryMid: 100, mfeMidPct: 0.002, maeMidPct: 0.006 }, { intel: intel(0.8) });
    const a = attributeTrade(t);
    const cs = a.causes.map((c) => c.code);
    expect(cs).not.toContain("wrong_direction");
    // 方向は合っていたので情報バイアスの誤りでもない
    expect(cs).not.toContain("intel_misled");
    expect(cs).toContain("fee_drag");
    const ev = a.causes.find((c) => c.code === "fee_drag")!.evidence;
    expect(ev).toContain("仲値は有利に 0.20% 動いたが");
    expect(ev).toContain("スプレッド・価格影響 0.30%");
    expect(cs.filter((c) => c === "fee_drag")).toHaveLength(1);
  });

  it("(a') 手数料の fee_drag が既にあれば同じ要因を重ねず根拠を足す", () => {
    // グロス損失に対して手数料が大きい (手数料 > 0.5 × |グロス|)
    const t = lossTrade({ fees: 0.6, netPnl: 99.35 - 100.3 - 0.6, entryMid: 100, mfeMidPct: 0.002 });
    const a = attributeTrade(t);
    const fee = a.causes.filter((c) => c.code === "fee_drag");
    expect(fee).toHaveLength(1);
    expect(fee[0].evidence).toContain("手数料");
    expect(fee[0].evidence).toContain("仲値は有利に");
    expect(a.causes.map((c) => c.code)).not.toContain("wrong_direction");
  });

  it("(b) 仲値が一度も上がらなかった損失は wrong_direction (情報バイアスの誤りも従来どおり)", () => {
    const t = lossTrade({ entryMid: 100, mfeMidPct: 0, maeMidPct: 0.006 }, { intel: intel(0.8) });
    const a = attributeTrade(t);
    const cs = a.causes.map((c) => c.code);
    expect(cs).toContain("wrong_direction");
    expect(cs).toContain("intel_misled");
    expect(a.causes.find((c) => c.code === "wrong_direction")!.evidence).toContain("仲値の最大の有利な動き 0.00%");
    // 基準未満の小さな動き (0.10% < 0.25 × 0.6%) も wrong_direction
    expect(codes(lossTrade({ entryMid: 100, mfeMidPct: 0.001 }))).toContain("wrong_direction");
  });

  it("(c) 仲値の記録が無い古い取引は従来と同じ結果", () => {
    const t = lossTrade({}, { intel: intel(0.8) });
    const a = attributeTrade(t);
    expect(a).toMatchObject({ tradeId: "m1", outcome: "loss", createdAt: 2_000 });
    const wd = a.causes.find((c) => c.code === "wrong_direction")!;
    expect(wd.evidence).toBe("最大含み益 0.00% (基準 0.22% 未満)、最大含み損 0.95% — 一度も有利に動かなかった");
    expect(a.causes.map((c) => c.code)).toEqual(["wrong_direction", "intel_misled"]);
    // 片方だけある (entryMid のみ・mfeMidPct のみ) 場合も従来どおり
    expect(attributeTrade(lossTrade({ entryMid: 100 }, { intel: intel(0.8) }))).toEqual(a);
    expect(attributeTrade(lossTrade({ mfeMidPct: 0.002 }, { intel: intel(0.8) }))).toEqual(a);
  });

  it("勝ちの取引には影響しない", () => {
    const t = lossTrade({ exitPrice: 101, grossPnl: 0.7, netPnl: 0.68, returnPct: 0.0068, rMultiple: 0.75, exitReason: "take_profit", mfePct: 0.007, entryMid: 100, mfeMidPct: 0.01 });
    expect(codes(t)).not.toContain("wrong_direction");
    expect(codes(t)).not.toContain("fee_drag");
  });
});

const jctx = ctx({ costBps: 60 });
function openInput(over: Partial<OpenTradeInput> = {}): OpenTradeInput {
  return {
    mode: "paper", symbol: "MEME/USDC", venue: "paper", assetClass: "meme", strategyId: "s1", horizon: "scalp", direction: "long",
    qty: 2, entryTs: 1_000, entryPrice: 100.3, intendedEntryPrice: 100.3, initialStop: 99.4, entryContext: jctx, entryMid: 100,
    ...over,
  };
}

describe("TradeJournal: 仲値基準の MFE/MAE", () => {
  it("(d) entryMid・mfeMidPct・maeMidPct は仲値から計算し、一部決済の約定価格は仲値の高値・安値に含めない", () => {
    const j = new TradeJournal();
    const p = j.open(openInput());
    expect(p).toMatchObject({ entryMid: 100, midHigh: 100, midLow: 100 });
    j.mark("MEME/USDC", 100.2, 2_000);
    j.mark("MEME/USDC", 99.8, 3_000);
    // 一部決済の約定価格 (101) は約定価格比の高値には入るが、仲値の高値には入らない
    expect(j.reduce(p.id, { qty: 1, exitPrice: 101, exitTs: 3_500, exitReason: "take_profit" }).kind).toBe("reduced");
    expect(j.get(p.id)).toMatchObject({ highWater: 101, midHigh: 100.2, midLow: 99.8 });
    j.mark("MEME/USDC", 99.5, 4_000);
    const t = j.close({ id: p.id, exitPrice: 99.3, exitTs: 5_000, exitReason: "stop" });
    expect(t.entryMid).toBe(100);
    expect(t.mfeMidPct).toBeCloseTo(0.002, 12);
    expect(t.maeMidPct).toBeCloseTo(0.005, 12); // 決済の約定 99.3 は含めない
    // 従来の約定価格比はそのまま (一部決済 101・決済 99.3 を含む)
    expect(t.mfePct).toBeCloseTo((101 - 100.3) / 100.3, 12);
    expect(t.maePct).toBeCloseTo((100.3 - 99.3) / 100.3, 12);
  });

  it("ショート: 仲値の下落が有利", () => {
    const j = new TradeJournal();
    const p = j.open(openInput({ direction: "short", entryPrice: 99.7, initialStop: 100.6 }));
    j.mark("MEME/USDC", 99.6, 2_000);
    j.mark("MEME/USDC", 100.1, 3_000);
    const t = j.close({ id: p.id, exitPrice: 100.7, exitTs: 4_000, exitReason: "stop" });
    expect(t.mfeMidPct).toBeCloseTo(0.004, 12);
    expect(t.maeMidPct).toBeCloseTo(0.001, 12);
    expect(t.mfePct).toBeCloseTo((99.7 - 99.6) / 99.7, 12);
  });

  it("entryMid が無い・不正なエントリーは仲値の項目を付けない", () => {
    const j = new TradeJournal();
    for (const entryMid of [undefined, 0, -1, Number.NaN]) {
      const p = j.open(openInput({ entryMid }));
      expect(p.entryMid).toBeUndefined();
      expect(p.midHigh).toBeUndefined();
      j.mark("MEME/USDC", 101, 2_000);
      const t = j.close({ id: p.id, exitPrice: 100, exitTs: 3_000, exitReason: "stop" });
      expect(t).not.toHaveProperty("entryMid");
      expect(t).not.toHaveProperty("mfeMidPct");
      expect(t).not.toHaveProperty("maeMidPct");
    }
  });

  it("(e) 保有中の状態 (kv journal:open:<mode>) に仲値を保存・復元する。仲値の無い古い保存状態も読める", () => {
    const store = new MemoryStore();
    const j1 = new TradeJournal({ store, mode: "paper" });
    const p = j1.open(openInput({ id: "new" }));
    j1.mark("MEME/USDC", 100.4, 2_000);
    const saved = store.kvGet<OpenTrade[]>(openKvKey("paper"))!;
    expect(saved[0]).toMatchObject({ id: "new", entryMid: 100, midHigh: 100.4, midLow: 100 });

    // 仲値の無い古い保存状態を混ぜる
    const legacy: OpenTrade = { ...openInput({ id: "old", symbol: "OLD/USDC" }), id: "old", entryFees: 0, contractSize: 1, highWater: 100.3, lowWater: 100.3, lastPrice: 100.3, lastTs: 1_000 };
    delete legacy.entryMid;
    store.kvSet(openKvKey("paper"), [...saved, legacy]);

    const j2 = new TradeJournal({ store, mode: "paper" });
    expect(j2.get(p.id)).toMatchObject({ entryMid: 100, midHigh: 100.4, midLow: 100 });
    j2.mark("MEME/USDC", 99.9, 3_000);
    const t = j2.close({ id: p.id, exitPrice: 99.3, exitTs: 4_000, exitReason: "stop" });
    expect(t.mfeMidPct).toBeCloseTo(0.004, 12);
    expect(t.maeMidPct).toBeCloseTo(0.001, 12);

    j2.mark("OLD/USDC", 101, 3_000);
    const o = j2.close({ id: "old", exitPrice: 99, exitTs: 4_000, exitReason: "stop" });
    expect(o.mfePct).toBeCloseTo((101 - 100.3) / 100.3, 12);
    expect(o).not.toHaveProperty("entryMid");
    expect(o).not.toHaveProperty("mfeMidPct");
    // 古い取引は従来の判定 (約定価格比の MFE 0.70% ≥ 基準) のまま
    expect(attributeTrade(o).causes.map((c) => c.code)).not.toContain("wrong_direction");
  });
});

describe("PositionManager: エントリーの約定時の仲値", () => {
  const inst: Instrument = {
    symbol: "MEME/USDC", venue: "paper", assetClass: "meme", baseCurrency: "MEME", quoteCurrency: "USDC", tickSize: 0.0001, lotSize: 0.001, minQty: 0.001,
    takerFeeRate: 0, makerFeeRate: 0, allowShort: false,
  };
  const T0 = Date.UTC(2026, 0, 5);
  function setup(priceOf?: () => number | undefined) {
    const clock = { t: T0, now() { return this.t; } };
    const paper = new PaperBroker({ instruments: [inst], baseCurrency: "USDC", initialEquity: 1_000_000, slippageBps: 0, clock });
    const journal = new TradeJournal();
    const closed: TradeRecord[] = [];
    const pm = new PositionManager({ journal, brokerFor: () => paper, onTradeClosed: (t) => closed.push(t), ...(priceOf ? { priceOf } : {}) });
    const quote: Quote = { ts: T0, bid: 99.7, ask: 100.3 };
    paper.onQuote(inst.symbol, quote);
    const enter = (signalMid: number | undefined) =>
      pm.enter(
        { clientId: "e1", symbol: inst.symbol, side: "buy", type: "market", qty: "1", strategyId: "s1" },
        {
          input: {
            mode: "paper", symbol: inst.symbol, venue: "paper", assetClass: "meme", strategyId: "s1", horizon: "scalp", direction: "long",
            entryTs: T0, intendedEntryPrice: 100.3, initialStop: 99.4, entryContext: jctx, ...(signalMid !== undefined ? { entryMid: signalMid } : {}),
          },
          plan: {},
          audit: {},
        },
        T0,
      );
    return { pm, paper, closed, clock, enter };
  }

  it("約定を反映する時点の仲値 (priceOf) を entryMid にし、決済の TradeRecord に仲値基準の MFE が付く", async () => {
    const s = setup(() => 100);
    const r = await s.enter(99);
    expect(r.status).toBe("opened");
    if (r.status !== "opened") return;
    expect(r.position!.entryPrice).toBeCloseTo(100.3, 9);
    expect(r.position!.entryMid).toBe(100);
    // 仲値が 100.2 まで上がってから損切り
    for (const [mid, dt] of [[100.2, 1_000], [99.0, 1_000]] as const) {
      s.clock.t += dt;
      const q: Quote = { ts: s.clock.t, bid: mid - 0.3, ask: mid + 0.3 };
      s.paper.onQuote(inst.symbol, q);
      await s.pm.onQuote(inst.symbol, q, s.clock.t);
    }
    expect(s.closed).toHaveLength(1);
    const t = s.closed[0];
    expect(t.entryMid).toBe(100);
    expect(t.mfeMidPct).toBeCloseTo(0.002, 9);
    expect(t.mfePct).toBe(0);
    const cs = attributeTrade(t).causes.map((c) => c.code);
    expect(cs).not.toContain("wrong_direction");
    expect(cs).toContain("fee_drag");
  });

  it("現在値が取れなければシグナル時点の仲値、どちらも無ければ付けない", async () => {
    const a = setup(() => undefined);
    const ra = await a.enter(99.95);
    expect(ra.status === "opened" && ra.position!.entryMid).toBe(99.95);
    const b = setup();
    const rb = await b.enter(undefined);
    expect(rb.status === "opened" && rb.position!.entryMid).toBeUndefined();
  });
});

describe("runBacktest: 仲値基準の MFE/MAE (ライブと同じ判定)", () => {
  it("成行は始値 (半スプレッド・スリッページを足す前) を entryMid にし、要因分析はライブと同じく fee_drag", () => {
    const M = 60_000;
    const T0 = Date.UTC(2024, 0, 1);
    const rows: [number, number, number, number][] = Array.from({ length: 20 }, () => [100, 100.2, 99.8, 100]);
    rows[12] = [100, 100.1, 99.0, 99.2];
    const candles: Candle[] = rows.map(([o, h, l, c], i) => ({ ts: T0 + i * M, open: o, high: h, low: l, close: c, volume: 100 }));
    const strategy: Strategy = {
      id: "scripted", horizon: "scalp", assetClasses: ["crypto"], regimes: ["range"], primaryTimeframe: "1m", timeframes: ["1m"], warmup: 1,
      defaultParams: { stopAtr: 1, tpAtr: 1, trailAtr: 0, entryThreshold: 0, maxHoldBars: 10 }, paramBounds: {},
      evaluate: (c) =>
        c.market.now === T0 + 11 * M && !c.position
          ? {
              strategyId: "scripted", horizon: "scalp", symbol: "SYN/USDT", direction: "long", confidence: 0.7, expectedEdgeBps: 100,
              entry: { type: "market" }, stopLoss: 99.4, maxHoldMs: 1_000 * M, reason: "scripted", features: {},
            }
          : null,
    };
    const instrument = syntheticInstrument({ takerFeeRate: 0, tickSize: 0, lotSize: 0, minQty: 0 });
    const r = runBacktest({ strategy, instrument, candles, spreadBps: 60, slippageBps: 0 });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.exitReason).toBe("stop");
    expect(t.entryPrice).toBeCloseTo(100.3, 9);
    expect(t.entryMid).toBe(100);
    expect(t.mfePct).toBe(0);
    expect(t.mfeMidPct).toBeCloseTo(0.002, 9); // 保有中の高値 100.2
    expect(t.maeMidPct).toBeCloseTo(0.006, 9); // 想定決済価格 (損切り 99.4)。約定 (99.4 − 半スプレッド) は含めない
    const cs = attributeTrade(t).causes.map((c) => c.code);
    expect(cs).not.toContain("wrong_direction");
    expect(cs).toContain("fee_drag");
  });
});
