import type { Candle, Timeframe } from "../core/types";
import { TIMEFRAME_MS } from "../core/types";

/** 足を上位時間足へ集約する (ts は tfMs の倍数に切り捨て)。入力は昇順 */
export function aggregateCandles(candles: Candle[], tfMs: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const bucket = Math.floor(c.ts / tfMs) * tfMs;
    const last = out[out.length - 1];
    if (last && last.ts === bucket) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ ts: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    }
  }
  return out;
}

/** ts をキーに足をマージ (後勝ち)。昇順で返す */
export function mergeCandles(base: Candle[], incoming: Candle[], max = 2000): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of base) map.set(c.ts, c);
  for (const c of incoming) map.set(c.ts, c);
  const arr = [...map.values()].sort((a, b) => a.ts - b.ts);
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

/** 確定足のみ (開始 + 足の長さ <= now) */
export function closedCandles(candles: Candle[], tf: Timeframe, now: number): Candle[] {
  const ms = TIMEFRAME_MS[tf];
  return candles.filter((c) => c.ts + ms <= now);
}

/** 価格スナップショットから 1 つの時間足を組み立てる */
export class CandleBuilder {
  private candles: Candle[] = [];
  constructor(
    readonly tfMs: number,
    private readonly max = 2000,
  ) {}

  push(ts: number, price: number, volume = 0): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const bucket = Math.floor(ts / this.tfMs) * this.tfMs;
    const last = this.candles[this.candles.length - 1];
    if (last && bucket < last.ts) return; // 過去データは無視
    if (last && last.ts === bucket) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      last.volume += volume;
    } else {
      this.candles.push({ ts: bucket, open: price, high: price, low: price, close: price, volume });
      if (this.candles.length > this.max) this.candles.shift();
    }
  }

  /** 未確定の足を含む全足 (昇順) */
  all(): Candle[] {
    return this.candles.map((c) => ({ ...c }));
  }
}
