import type { Candle, Timeframe } from "../core/types";
import { TIMEFRAME_MS } from "../core/types";

/**
 * 下位足 → 上位足の集約。確定足のみを返す (未確定の最終足は含めない)。
 * ライブ側・バックテスト側の両方から使う。
 *
 * - バケットは UTC 基準で区切る (1w は月曜 00:00 UTC 始まり)。
 * - バケット [start, start + 上位足幅) は `start + 上位足幅 <= now` のときだけ確定とみなす。
 *   now の既定値は「最後の入力足の終了時刻 (ts + 下位足幅)」。
 * - 入力のうち ts + 下位足幅 > now の足 (未確定の下位足) は無視する。
 * - 先頭バケットがデータ途中から始まる場合 (例: 10:07 開始で 15 分足) は欠けた足なので捨てる。
 */

/** 1970-01-05 (月曜) 00:00 UTC */
const WEEK_ANCHOR_MS = 4 * 86_400_000;

/** ts が属する上位足バケットの開始時刻 */
export function bucketStart(ts: number, tf: Timeframe): number {
  const ms = TIMEFRAME_MS[tf];
  if (tf === "1w") return Math.floor((ts - WEEK_ANCHOR_MS) / ms) * ms + WEEK_ANCHOR_MS;
  return Math.floor(ts / ms) * ms;
}

export interface ResampleOptions {
  /** 現在時刻 (これ以前に終わったバケットだけ返す)。既定: 最後の入力足の終了時刻 */
  now?: number;
  /** データ途中から始まる先頭バケットを捨てる (既定 true) */
  dropPartialFirst?: boolean;
}

/**
 * candles (昇順・from 足) を to 足へ集約する。
 * to が from より細かい、または整数倍でない場合は例外。
 */
export function resample(candles: readonly Candle[], from: Timeframe, to: Timeframe, opts: ResampleOptions = {}): Candle[] {
  const fromMs = TIMEFRAME_MS[from];
  const toMs = TIMEFRAME_MS[to];
  if (toMs < fromMs || toMs % fromMs !== 0) {
    throw new Error(`resample: ${from} から ${to} へは集約できません`);
  }
  if (candles.length === 0) return [];
  const now = opts.now ?? candles[candles.length - 1].ts + fromMs;
  const dropPartialFirst = opts.dropPartialFirst ?? true;

  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curPartial = false;
  let isFirst = true;

  for (const c of candles) {
    if (c.ts + fromMs > now) break; // 未確定の下位足 (以降も同様)
    const b = bucketStart(c.ts, to);
    if (cur === null || b !== cur.ts) {
      if (cur !== null && !curPartial) out.push(cur);
      cur = { ts: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      curPartial = isFirst && dropPartialFirst && c.ts !== b;
      isFirst = false;
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur !== null && !curPartial && cur.ts + toMs <= now) out.push(cur);
  return out;
}

/** 足が now 時点で確定しているか */
export function isClosed(c: Candle, tf: Timeframe, now: number): boolean {
  return c.ts + TIMEFRAME_MS[tf] <= now;
}

/** 確定足だけを残す (ライブで取得した足の末尾が未確定な場合の除去用) */
export function closedOnly(candles: readonly Candle[], tf: Timeframe, now: number): Candle[] {
  const ms = TIMEFRAME_MS[tf];
  let end = candles.length;
  while (end > 0 && candles[end - 1].ts + ms > now) end--;
  return candles.slice(0, end);
}
