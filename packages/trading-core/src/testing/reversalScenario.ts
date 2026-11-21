/**
 * 転換で決済 (REVERSAL_EXIT) のテスト用の合成データと、台本どおりの値動きを返す feed (オフライン)。
 * 1m 足。エントリー前は 100 の横ばい (H 本)、エントリーした足 (添字 H) から post の終値を続ける。
 */
import { syntheticInstrument } from "../backtest/synthetic";
import type { Candle, Clock, Instrument, MarketDataFeed, Quote, Signal, Strategy, StrategyContext, Timeframe } from "../core/types";

export const M = 60_000;
export const T0 = Date.UTC(2026, 0, 5);
/** エントリー前の足の本数 (= エントリーした足の添字) */
export const H = 60;
export const SYM = "SYN/USDT";
export const INST: Instrument = syntheticInstrument({ symbol: SYM, takerFeeRate: 0.0005, makerFeeRate: 0.0002, tickSize: 0, lotSize: 0.0001, minQty: 0.0001 });

/** 足 k の開始時刻 */
export const barTs = (k: number) => T0 + k * M;

/** 終値の列から 1m 足を作る (始値 = 前の終値、高値・安値 = 始値と終値の大きい方・小さい方 ± 0.05) */
export function barsFrom(closes: number[]): Candle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { ts: barTs(i), open: o, high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05, close: c, volume: 100 };
  });
}

/** エントリー前の横ばい + post + tail */
export const scenarioBars = (post: number[], tail: number[] = []) => barsFrom([...Array<number>(H).fill(100), ...post, ...tail]);

/**
 * 買い・含み益で転換: 上昇 → 押し (r7 の安値 102.55 が押し安値、r10 で確定) → 高値更新 (r10 の高値 104.45) →
 * r12 の終値 102.4 が押し安値割れ。利確 106 の手前・建値 100 より上
 */
export const LONG_PROFIT = [100, 101, 102, 103, 103.5, 103.8, 103.2, 102.6, 103.4, 104.0, 104.4, 103.6, 102.4];
/** LONG_PROFIT の押し安値 (r7 の安値) と、割った足 (r12) */
export const LONG_PROFIT_LEVEL = 102.55;
export const LONG_PROFIT_BREAK = 12;
/**
 * 買い・含み損で転換: 少し上げて押し (r5 の安値 99.55 が押し安値、r8 で確定) → r10 の終値 99.4 が押し安値割れ。
 * 建値 100 より下・損切り 97 より上
 */
export const LONG_LOSS = [100, 100.6, 101.0, 101.2, 100.5, 99.6, 100.2, 100.5, 100.8, 100.1, 99.4];
export const LONG_LOSS_LEVEL = 99.55;
export const LONG_LOSS_BREAK = 10;

/**
 * 台本どおりの値動きを返す feed。足の開始から 30 秒未満の気配は始値 (= 前の足の終値)、それ以降は終値。
 * 足は now までに始まったもの (形成中の足も最終の値で返すが、hub が確定足だけを戦略へ渡す)
 */
export class ScriptedFeed implements MarketDataFeed {
  readonly venue = "paper";
  constructor(private readonly bars: Candle[], private readonly clock: Clock, private readonly inst: Instrument = INST) {}
  async listInstruments(): Promise<Instrument[]> {
    return [{ ...this.inst }];
  }
  async fetchCandles(_symbol: string, tf: Timeframe, limit: number): Promise<Candle[]> {
    if (tf !== "1m") throw new Error("1m only");
    const now = this.clock.now();
    return this.bars.filter((b) => b.ts <= now).slice(-limit).map((b) => ({ ...b }));
  }
  async fetchQuote(): Promise<Quote> {
    const now = this.clock.now();
    const i = Math.max(0, Math.min(this.bars.length - 1, Math.floor((now - T0) / M)));
    const b = this.bars[i];
    const mid = now - b.ts < 30_000 ? b.open : b.close;
    return { ts: now, bid: mid * (1 - 1e-5), ask: mid * (1 + 1e-5), last: mid };
  }
}

export interface ProbeOptions {
  id?: string;
  direction?: "long" | "short";
  stopLoss?: number;
  takeProfit?: number;
  /** 保有中、この時刻以降の評価で flat (決済シグナル) を返す */
  flatFrom?: number;
  /** この時刻の評価でだけエントリーする (省略時は最初の評価) */
  at?: number;
}

/** 1 回だけエントリーのシグナルを出す戦略 (1m・全レジーム)。最大保有 120 分 (読みの期限も 120 分) */
export function probe(o: ProbeOptions = {}): Strategy {
  const id = o.id ?? "rev_probe";
  const dir = o.direction ?? "long";
  let fired = false;
  return {
    id, horizon: "scalp", assetClasses: ["crypto"], regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    primaryTimeframe: "1m", timeframes: ["1m"], warmup: 1, defaultParams: {}, paramBounds: {},
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.position) {
        if (o.flatFrom !== undefined && ctx.market.now >= o.flatFrom) {
          return { ...base(id), direction: "flat", stopLoss: 0, reason: "probe exit" };
        }
        return null;
      }
      if (fired || (o.at !== undefined && ctx.market.now !== o.at)) return null;
      fired = true;
      return {
        ...base(id), direction: dir, stopLoss: o.stopLoss ?? (dir === "long" ? 97 : 103), takeProfit: o.takeProfit ?? (dir === "long" ? 106 : 94),
      };
    },
  };
}

const base = (id: string): Signal => ({
  strategyId: id, horizon: "scalp", symbol: SYM, direction: "long", confidence: 0.8, expectedEdgeBps: 500, entry: { type: "market" },
  stopLoss: 97, maxHoldMs: 120 * M, reason: "probe", features: {},
});
