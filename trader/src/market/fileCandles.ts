/**
 * 日付ファイル単位でローソク足を返す取引所 (bitbank・GMOコイン) の共通部品。
 * どちらも 1hour 以下は YYYYMMDD (1 日分)、4hour 以上は YYYY (1 年分) のファイルで返す。
 * ファイルの日付境界・存在しない日付の扱いは取引所ごとに違うので、それぞれのモジュール
 * (src/market/feeds/bitbankCandles.ts・src/market/gmo/klines.ts) が決める。
 */
import type { Candle, Timeframe } from "../core/types";
import { TIMEFRAME_MS } from "../core/types";

const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const JST_OFFSET = 9 * HOUR;

/** ファイルの単位 (day = YYYYMMDD、year = YYYY) */
export type FileKind = "day" | "year";

const pad = (n: number) => String(n).padStart(2, "0");

/** UTC 日の 0 時 (ms) */
export const utcDayStart = (t: number) => Math.floor(t / DAY) * DAY;
export const utcYear = (t: number) => new Date(t).getUTCFullYear();
/** 時刻 t の UTC 日付 (YYYYMMDD) */
export const utcDayKey = (t: number) => {
  const d = new Date(utcDayStart(t));
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};

/** ファイルの値 (日次は UTC 日の 0 時の ms、年次は年) → 取引所に渡す日付 */
export const fileKeyOf = (kind: FileKind, v: number) => (kind === "day" ? utcDayKey(v) : String(v));
/** 隣のファイルへの値の差 */
const fileStep = (kind: FileKind) => (kind === "day" ? DAY : 1);

/** limit 本に要るファイル数の見積もり (+2 は境界の隣接ファイル分)。上限は cap[kind] */
export function maxFilesFor(kind: FileKind, cap: Record<FileKind, number>, want: number, tf: Timeframe): number {
  const period = kind === "day" ? DAY : 365 * DAY;
  return Math.min(cap[kind], Math.ceil((want * TIMEFRAME_MS[tf]) / period) + 2);
}

export interface FileCandleLoop {
  kind: FileKind;
  /** 欲しい本数 (1 以上) */
  want: number;
  /** 取るファイル数の上限 */
  maxFiles: number;
  /** 現在を含みうる最も新しいファイル */
  newest: number;
  /** since を含みうる最も古いファイル (since があるときだけ、最初のファイルを取る前に 1 回呼ぶ) */
  oldestFor(since: number): number;
  /** ファイル v を取り、足を byTs (ts → 足) に入れる */
  take(v: number, byTs: Map<number, Candle>): Promise<void>;
}

/**
 * ファイルを順に取って足を集める。
 * - since なし: 最新のファイルから 1 つずつさかのぼり、want 本そろうか上限ファイル数で止めて末尾 want 本を返す。
 * - since あり: since を含みうるファイルから現在まで順に取り、ts >= since が want 本そろうか上限で止めて先頭 want 本を返す。
 * 足は ts で重複を除き、昇順に並べる。
 */
export async function collectFileCandles(loop: FileCandleLoop, since?: number): Promise<Candle[]> {
  const { kind, want, maxFiles, newest } = loop;
  const byTs = new Map<number, Candle>();
  const sorted = () => [...byTs.values()].sort((a, b) => a.ts - b.ts);

  if (since === undefined) {
    let v = newest;
    for (let n = 0; n < maxFiles; n++, v -= fileStep(kind)) {
      await loop.take(v, byTs);
      if (byTs.size >= want) break;
    }
    return sorted().slice(-want);
  }

  let v = loop.oldestFor(since);
  for (let n = 0; n < maxFiles && v <= newest; n++, v += fileStep(kind)) {
    await loop.take(v, byTs);
    let count = 0;
    for (const ts of byTs.keys()) if (ts >= since) count++;
    if (count >= want) break;
  }
  return sorted()
    .filter((c) => c.ts >= since)
    .slice(0, want);
}

/**
 * hub の毎回更新で、同じ (銘柄, 時間足) のファイル再取得の最短間隔。
 * 1 回の取得でファイル (1 日 / 1 年分) を丸ごと返すため間引く。
 * 足の長さの 1/60 (1m → 1 秒 = 毎回、5m → 5 秒、15m → 15 秒、1h → 1 分、4h → 4 分) で上限 5 分。
 * 間の現在足は hub が気配で更新し、足の境界をまたいだら間隔に関係なく取り直す (確定足は取得値になる)。
 */
export function fileCandleRefreshIntervalMs(tf: Timeframe): number {
  return Math.min(5 * 60_000, Math.floor(TIMEFRAME_MS[tf] / 60));
}
