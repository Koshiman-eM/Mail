/**
 * 読みの管理 (THESIS_*) のバックテストと、実運用 (PositionManager + PaperBroker) との一致。
 * バックテストは足の終値で判定して次の足の始値で決済し、延長後の保護ストップは次の足から効く (先読みしない)。
 * 同じ値動きを、運用側には各足の終値の気配として渡し、決済理由・答え合わせの結果が同じになることを確かめる。
 */
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest/engine";
import { syntheticInstrument } from "../src/backtest/synthetic";
import type { Candle, EntryContext, Instrument, Quote, Signal, Strategy, StrategyContext, TradeRecord } from "../src/core/types";
import { PaperBroker } from "../src/execution/paper";
import { PositionManager } from "../src/engine/positions";
import { DEFAULT_THESIS_SETTINGS, THESIS_DISABLED, type ThesisSettings } from "../src/engine/thesis";
import { TradeJournal } from "../src/learning/journal";
import { MemoryStore } from "../src/storage/memory";

const M = 60_000;
const T0 = Date.UTC(2024, 0, 1);
const closeOf = (i: number) => T0 + (i + 1) * M;
const ON: ThesisSettings = { ...DEFAULT_THESIS_SETTINGS };
const SPREAD_BPS = 2;
const HS = SPREAD_BPS / 2 / 1e4;
const COSTS = { spreadBps: SPREAD_BPS, slippageBps: 0 };
const ENTRY = 11;
const inst: Instrument = { ...syntheticInstrument({ takerFeeRate: 0.001, tickSize: 0, lotSize: 0, minQty: 0 }), makerFeeRate: 0.001 };

/** 終値の列から足を作る (始値 = 前の終値、高値・安値 = 始値と終値の大きい方・小さい方)。運用側に渡す気配 (終値) と値幅が一致する */
function candlesFrom(closes: number[]): Candle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { ts: T0 + i * M, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: 100 };
  });
}

function entrySignal(dir: "long" | "short", stopLoss: number, extra: Partial<Signal> = {}): Signal {
  return {
    strategyId: "scripted", horizon: "scalp", symbol: inst.symbol, direction: dir, confidence: 0.7, expectedEdgeBps: 100,
    entry: { type: "market" }, stopLoss, maxHoldMs: 10 * M, reason: "scripted", features: {}, ...extra,
  };
}

function scripted(sig: Signal): Strategy {
  return {
    id: "scripted", horizon: "scalp", assetClasses: ["crypto"], regimes: ["range"], primaryTimeframe: "1m", timeframes: ["1m"], warmup: 1,
    defaultParams: {}, paramBounds: {},
    evaluate: (ctx: StrategyContext) => (ctx.market.now === closeOf(ENTRY - 1) && !ctx.position ? sig : null),
  };
}

const ctx: EntryContext = {
  regime: { label: "range", trend: 0, trendStrength: 0, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: SPREAD_BPS },
  confidence: 0.7, expectedEdgeBps: 100, costBps: 22, params: {}, features: {}, riskMultiplier: 1, reason: "scripted",
};

/** 同じ値動きを運用側 (PositionManager + PaperBroker) に、各足の終値の気配として渡す */
async function runEngine(closes: number[], sig: Signal, thesis: ThesisSettings): Promise<TradeRecord | undefined> {
  const clock = { t: T0 + ENTRY * M, now() { return this.t; } };
  const store = new MemoryStore();
  const paper = new PaperBroker({ instruments: [inst], baseCurrency: "USDT", initialEquity: 1_000_000, slippageBps: 0, clock });
  const journal = new TradeJournal({ store, mode: "paper" });
  const pm = new PositionManager({ journal, brokerFor: () => paper, store, instrumentOf: () => inst, thesis });
  const quote = (mid: number, ts: number): Quote => ({ ts, bid: mid * (1 - HS), ask: mid * (1 + HS) });
  const mid0 = closes[ENTRY - 1];
  paper.onQuote(inst.symbol, quote(mid0, clock.t));
  const side = sig.direction === "long" ? "buy" : "sell";
  const r = await paper.placeOrder({ clientId: "e1", symbol: inst.symbol, side, type: "market", qty: "1", strategyId: "scripted" });
  const f = r.fills[0];
  pm.open(
    {
      mode: "paper", symbol: inst.symbol, venue: inst.venue, assetClass: "crypto", strategyId: "scripted", horizon: "scalp",
      direction: sig.direction === "long" ? "long" : "short", qty: 1, entryTs: clock.t, entryPrice: f.price, intendedEntryPrice: f.price,
      initialStop: sig.stopLoss, entryContext: ctx, entryFees: Number(f.fee),
    },
    { maxHoldMs: sig.maxHoldMs, ...(sig.expectedMs !== undefined ? { expectedMs: sig.expectedMs } : {}) },
  );
  for (let i = ENTRY; i < closes.length; i++) {
    clock.t = closeOf(i);
    const q = quote(closes[i], clock.t);
    paper.onQuote(inst.symbol, q);
    const res = await pm.onQuote(inst.symbol, q, clock.t);
    if (res.status === "closed") return res.trade;
  }
  return undefined;
}

function runBt(closes: number[], sig: Signal, thesis?: ThesisSettings) {
  return runBacktest({ strategy: scripted(sig), instrument: inst, candles: candlesFrom(closes), ...COSTS, closeAtEnd: false, ...(thesis ? { thesis } : {}) });
}

/** 始値 100 で入り、以後の終値を path で与える (足りない分は最後の値で埋める) */
function path(after: number[], n = 80): number[] {
  const closes = Array.from({ length: ENTRY }, () => 100);
  for (let i = 0; closes.length < n; i++) closes.push(after[Math.min(i, after.length - 1)]);
  return closes;
}

const SCENARIOS: { name: string; dir: "long" | "short"; stop: number; closes: number[]; reason: string; outcome: string; sameTs?: boolean; exitAt?: number }[] = [
  { name: "動かない → 期限で読み外れ", dir: "long", stop: 98, closes: path([100.05]), reason: "thesis_timeout", outcome: "timeout", sameTs: true },
  { name: "大きく逆行 → 途中で読み外れ", dir: "long", stop: 98, closes: path([99.5, 98.8]), reason: "thesis_failed", outcome: "failed_early", sameTs: true },
  {
    name: "利益が出て伸び続ける → 延長の上限", dir: "long", stop: 98,
    closes: path(Array.from({ length: 60 }, (_, k) => 100.5 + Math.min(k, 5) * 0.1 + k * 0.01)), reason: "thesis_cap", outcome: "extended", sameTs: true,
  },
  {
    // 期限の前に +1.5R まで伸びて期限で +0.3R: 延長して持ち続け (延長より前の高値でストップを上げない)、建値を割ってトレーリング
    name: "+1.5R まで伸びて期限で +0.3R → 延長して持つ → 建値割れでトレーリング", dir: "long", stop: 98,
    closes: path([101, 102, 103.1, 102, 101, ...Array.from({ length: 15 }, () => 100.83), 100.0]), reason: "trailing", outcome: "extended", sameTs: true,
    exitAt: ENTRY + 21,
  },
  {
    name: "利益が出て延長 → 建値まで戻る → トレーリング", dir: "long", stop: 98,
    closes: path([...Array.from({ length: 14 }, () => 101), 100.0]), reason: "trailing", outcome: "extended", sameTs: true,
  },
  { name: "売り: 動かない → 期限で読み外れ", dir: "short", stop: 102, closes: path([99.95]), reason: "thesis_timeout", outcome: "timeout", sameTs: true },
  {
    name: "売り: 利益が出て延長 → 戻る → トレーリング", dir: "short", stop: 102,
    closes: path([...Array.from({ length: 14 }, () => 99), 100.0]), reason: "trailing", outcome: "extended", sameTs: true,
  },
];

describe("バックテストの読みの管理", () => {
  it.each(SCENARIOS)("$name: バックテストと運用 (paper) で決済理由・答え合わせが一致する", async (sc) => {
    const sig = entrySignal(sc.dir, sc.stop);
    const bt = runBt(sc.closes, sig, ON);
    expect(bt.trades).toHaveLength(1);
    const b = bt.trades[0];
    const e = await runEngine(sc.closes, sig, ON);
    expect(e).toBeDefined();
    expect(b.exitReason).toBe(sc.reason);
    expect(e!.exitReason).toBe(sc.reason);
    expect(b.thesisOutcome).toBe(sc.outcome);
    expect(e!.thesisOutcome).toBe(sc.outcome);
    expect(b.entryTs).toBe(e!.entryTs);
    expect(b.entryPrice).toBeCloseTo(e!.entryPrice, 9);
    expect(b.thesisDeadlineTs).toBe(T0 + (ENTRY + 10) * M);
    expect(e!.thesisDeadlineTs).toBe(b.thesisDeadlineTs);
    if (sc.sameTs) expect(b.exitTs).toBe(e!.exitTs);
    if (sc.exitAt !== undefined) expect(b.exitTs).toBe(T0 + sc.exitAt * M);
    if (sc.reason === "trailing") {
      expect(b.thesisStopExit).toBe(true);
      expect(e!.thesisStopExit).toBe(true);
    }
    if (sc.outcome === "extended") {
      expect(b.thesisExtendedAt).toBe(e!.thesisExtendedAt);
      expect(b.thesisNetRAtDeadline).toBeCloseTo(e!.thesisNetRAtDeadline!, 6);
    }
  });

  it("延長の上限は 期限 × THESIS_EXTEND_MULT (次の足の始値で決済)", () => {
    const sc = SCENARIOS[2];
    const b = runBt(sc.closes, entrySignal("long", 98), { ...ON, extendMult: 2 }).trades[0];
    expect(b.exitReason).toBe("thesis_cap");
    expect(b.exitTs).toBe(T0 + (ENTRY + 20) * M);
  });

  it("延長後の保護ストップは延長から測り、次の足から効き、前の足までの高値で計算する (先読みしない)", () => {
    const k = ENTRY + 9; // 期限の判定に使う足 (この終値で判定し、次の足の始値で延長)
    const closes = path([101]);
    closes[k + 3] = 103;
    closes[k + 4] = 103.5;
    for (let i = k + 5; i < closes.length; i++) closes[i] = 103.4;
    const candles = candlesFrom(closes);
    // 延長より前の高値 104 (+2R) は延長後のストップに使わない (使えば 104 − 0.5R で延長した足の始値で決済してしまう)
    candles[ENTRY + 4] = { ...candles[ENTRY + 4], high: 104 };
    // 判定に使う足の安値は建値より下だが終値は上: 延長はその次の足からなので、この安値では決済しない
    candles[k] = { ...candles[k], low: 99.5 };
    // 同じ足の高値 104 ではまだストップを上げない (この足の安値 102.4 は 延長後の高値 103 − 0.5R より上なので持つ)
    candles[k + 4] = { ...candles[k + 4], high: 104, low: 102.4 };
    // 次の足で 104 − 0.5R を割る
    candles[k + 5] = { ...candles[k + 5], low: 101.9 };
    const r = runBacktest({ strategy: scripted(entrySignal("long", 98)), instrument: inst, candles, ...COSTS, closeAtEnd: false, thesis: ON });
    const t = r.trades[0];
    expect(t.thesisExtendedAt).toBe(T0 + (ENTRY + 10) * M);
    expect(t.exitReason).toBe("trailing");
    expect(t.thesisStopExit).toBe(true);
    expect(t.exitTs).toBe(T0 + (k + 6) * M);
    const risk = t.entryPrice - 98;
    // 極値は決済できる価格 (高値 × (1 − 半スプレッド))
    expect(t.intendedExitPrice).toBeCloseTo(104 * (1 - HS) - 0.5 * risk, 9);
  });

  it("途中で読み外れは値動きだけ (終値) で判定する: 損切りが近くコストで純 R が −0.5 を下回っても途中では切らない (運用と同じ)", async () => {
    // 1R ≈ 0.41 (損切り 99.6)。動かなくても往復コストで純 R ≈ −0.55
    const closes = path([100]);
    const sig = entrySignal("long", 99.6);
    const b = runBt(closes, sig, ON).trades[0];
    expect(b.exitReason).toBe("thesis_timeout");
    expect(b.exitTs).toBe(T0 + (ENTRY + 10) * M);
    const e = await runEngine(closes, sig, ON);
    expect(e?.exitReason).toBe("thesis_timeout");
    // 値動きが −0.5R を越えたら途中で切る
    const drop = path([100, 99.75]);
    expect(runBt(drop, sig, ON).trades[0].exitReason).toBe("thesis_failed");
    expect((await runEngine(drop, sig, ON))?.exitReason).toBe("thesis_failed");
  });

  it("無効・省略なら従来どおり maxHoldMs で time (同じ取引)", () => {
    const sc = SCENARIOS.find((x) => x.name === "利益が出て延長 → 建値まで戻る → トレーリング")!;
    const base = runBt(sc.closes, entrySignal("long", 98));
    const off = runBt(sc.closes, entrySignal("long", 98), THESIS_DISABLED);
    expect(base.trades[0].exitReason).toBe("time");
    expect(base.trades[0].exitTs).toBe(T0 + (ENTRY + 10) * M);
    expect(off.trades).toEqual(base.trades);
    expect(off.trades[0].thesisOutcome).toBeUndefined();
  });

  it("シグナルの expectedMs を読みの期限にし、maxHoldMinutes で丸める", () => {
    const closes = path([100.05]);
    const a = runBt(closes, entrySignal("long", 98, { maxHoldMs: 60 * M, expectedMs: 5 * M }), ON).trades[0];
    expect(a.exitReason).toBe("thesis_timeout");
    expect(a.thesisExpectedMs).toBe(5 * M);
    expect(a.exitTs).toBe(T0 + (ENTRY + 5) * M);
    const b = runBacktest({
      strategy: scripted(entrySignal("long", 98, { maxHoldMs: 60 * M, expectedMs: 30 * M })), instrument: inst, candles: candlesFrom(closes), ...COSTS,
      closeAtEnd: false, thesis: ON, maxHoldMinutes: 8,
    }).trades[0];
    expect(b.thesisExpectedMs).toBe(8 * M);
    expect(b.exitReason).toBe("thesis_timeout");
  });
});
