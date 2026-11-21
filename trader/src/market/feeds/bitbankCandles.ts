/**
 * ccxt の bitbank 用のローソク足取得。
 *
 * bitbank の公開 API はローソク足を「ファイル単位」で返す (`/{pair}/candlestick/{type}/{YYYYMMDD | YYYY}`)。
 * - 1min / 5min / 15min / 30min / 1hour: YYYYMMDD (1 日分のファイル)
 * - 4hour / 8hour / 12hour / 1day / 1week / 1month: YYYY (1 年分のファイル)
 * ccxt の bitbank.fetchOHLCV は since (未指定なら now - 足の長さ×limit) の日付のファイルを 1 つだけ取り、
 * しかも常に YYYYMMDD 形式で送るため、そのままでは履歴が欠ける (1h×300 本でも 13 日前の 1 日分だけ等)。
 * ここでは ccxt の params (`request` を `extend(request, params)` している) で yyyymmdd を上書きし、
 * 必要な日付 / 年のファイルを複数取得して ts で重複除去・昇順にまとめる。
 *
 * ファイルの日付境界が UTC か JST かは確定していない
 * (ccxt のソース中の応答例は 5min ファイルの先頭が 00:00 UTC で UTC 境界を示唆するが、公式仕様には明記がない)。
 * そのため「時刻 t を含みうるファイル」は UTC 日付と JST 日付 (t + 9h の UTC 日付) の両方を候補にし、
 * 隣接ファイルを取って ts で重複除去する。どちらの境界でも結果は同じになる。
 * 取得したデータから境界が証明できたら (後述 detect)、以後は余分な隣接ファイルを取らない。
 */
import type { Candle, Timeframe } from "../../core/types";
import { TIMEFRAME_MS } from "../../core/types";
import { collectFileCandles, DAY, fileKeyOf, JST_OFFSET, maxFilesFor, utcDayStart, utcYear, type FileKind } from "../fileCandles";

/** bitbank が提供する時間足とファイルの単位 (公式仕様: 1min〜1hour は YYYYMMDD、4hour 以上は YYYY) */
export const BITBANK_FILE_KIND: Partial<Record<Timeframe, FileKind>> = {
  "1m": "day", "5m": "day", "15m": "day", "1h": "day",
  "4h": "year", "1d": "year", "1w": "year",
};

/**
 * 1 回の fetchCandles で取得するファイル数の上限。
 * - 日次ファイル: hub の初回履歴 300 本で最も多く要るのは 1h (300h = 12.5 日 → 13 ファイル + 境界の隣接 1〜2)。
 *   20 あれば 1h×300 本を 1 回で満たし、bitbank の rateLimit (ccxt 既定 100ms) でも 2 秒程度で終わる。
 *   それより長い範囲 (バックテストの 1000 本ページ等) は呼び出し側のページングで続きを取る。
 * - 年次ファイル: 1w×300 本 (約 5.8 年) でも 7 ファイル + 境界 1 で足りるので 10。
 */
export const BITBANK_MAX_FILES: Record<FileKind, number> = { day: 20, year: 10 };

/** 日付境界の判定結果 (未確定なら undefined) */
export type BitbankBoundary = "utc" | "jst";

export interface BitbankOhlcvSource {
  fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<number[][]>;
}

export interface BitbankFetchContext {
  exchange: BitbankOhlcvSource;
  now: number;
  /** 既に判定済みの境界 (kind ごと) */
  boundary: Partial<Record<FileKind, BitbankBoundary>>;
}

/**
 * 存在しない日付 (未来日・上場前・データなし) を表すエラーか。
 * - bitbank は {"success":0,"data":{"code":10000}} ("URL does not exist") を返し、ccxt は ExchangeError にして本文を message に含める。
 * - 本文が JSON でない 404 は ccxt の handleHttpStatusCode が "GET <url> 404 Not Found ..." の message で投げる。
 * それ以外 (タイムアウト・接続失敗・5xx・429 等) は false (= 呼び出し元へ throw する)。
 */
export function isBitbankNoDataError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (/"code"\s*:\s*"?10000"?/.test(msg)) return true;
  if (/(^|\s)404(\s|$)/.test(msg)) return true;
  return false;
}

/** ファイルを 1 つ取得。存在しない日付は 0 本 */
async function fetchFile(ctx: BitbankFetchContext, symbol: string, tf: Timeframe, key: string): Promise<Candle[]> {
  let rows: number[][];
  try {
    // since=1: ccxt は since で ts >= since の絞り込みをするので、ファイル全体を残すため最小値を渡す
    // (yyyymmdd は params で上書きされるので since の日付は使われない)。limit は渡さない (切り詰めさせない)。
    rows = await ctx.exchange.fetchOHLCV(symbol, tf, 1, undefined, { yyyymmdd: key });
  } catch (e) {
    if (isBitbankNoDataError(e)) return [];
    throw e;
  }
  return (rows ?? [])
    .map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5] ?? 0) }))
    .filter((c) => Number.isFinite(c.ts) && Number.isFinite(c.close));
}

/**
 * 取得したファイルの中身から日付境界を証明できれば返す。
 * - 日次ファイル D: JST 境界なら [D 00:00 JST, +24h) = [D-9h, D+15h)、UTC 境界なら [D, D+24h)。
 *   D より前の足があれば JST、D+15h 以降の足があれば UTC。
 * - 年次ファイル Y: 同様に Y/1/1 UTC より前の足があれば JST、Y+1/1/1 UTC - 9h 以降の足があれば UTC。
 *   1w は週の開始日が年をまたぐことがあるので判定に使わない。
 */
function detectBoundary(kind: FileKind, tf: Timeframe, key: string, rows: Candle[]): BitbankBoundary | undefined {
  if (rows.length === 0) return undefined;
  let start: number;
  let end: number;
  if (kind === "day") {
    start = Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)));
    end = start + DAY;
  } else {
    if (TIMEFRAME_MS[tf] > DAY) return undefined;
    start = Date.UTC(Number(key), 0, 1);
    end = Date.UTC(Number(key) + 1, 0, 1);
  }
  const jst = rows.some((c) => c.ts < start);
  const utc = rows.some((c) => c.ts >= end - JST_OFFSET);
  if (jst === utc) return undefined; // 証明できない (or 矛盾) なら未確定のまま
  return jst ? "jst" : "utc";
}

/** 時刻 t を含みうるファイルのうち、最も古い / 新しいもの (境界未確定なら UTC・JST 両方を候補にする) */
function fileRange(kind: FileKind, boundary: BitbankBoundary | undefined, t: number): { oldest: number; newest: number } {
  const utcVal = kind === "day" ? utcDayStart(t) : utcYear(t);
  const jstVal = kind === "day" ? utcDayStart(t + JST_OFFSET) : utcYear(t + JST_OFFSET);
  if (boundary === "utc") return { oldest: utcVal, newest: utcVal };
  if (boundary === "jst") return { oldest: jstVal, newest: jstVal };
  return { oldest: Math.min(utcVal, jstVal), newest: Math.max(utcVal, jstVal) };
}

/**
 * bitbank のローソク足を limit 本取得する。
 * - since なし: 最新のファイルから 1 つずつさかのぼり、limit 本そろうか上限ファイル数で止めて末尾 limit 本を返す。
 *   毎回更新 (limit 5 程度) は通常、当日 (年次足は今年) のファイル 1 つで終わる。
 * - since あり: since を含みうるファイルから現在まで順に取り、ts >= since が limit 本そろうか上限で止めて先頭 limit 本を返す。
 */
export async function fetchBitbankCandles(
  ctx: BitbankFetchContext,
  symbol: string,
  tf: Timeframe,
  limit: number,
  since?: number,
): Promise<Candle[]> {
  const kind = BITBANK_FILE_KIND[tf];
  if (!kind) throw new Error(`bitbank は時間足 ${tf} のローソク足を提供していません`);
  const want = Math.max(1, Math.floor(limit));
  return collectFileCandles(
    {
      kind,
      want,
      maxFiles: maxFilesFor(kind, BITBANK_MAX_FILES, want, tf),
      newest: fileRange(kind, ctx.boundary[kind], ctx.now).newest,
      oldestFor: (t) => fileRange(kind, ctx.boundary[kind], t).oldest,
      take: async (v, byTs) => {
        const key = fileKeyOf(kind, v);
        const rows = await fetchFile(ctx, symbol, tf, key);
        if (!ctx.boundary[kind]) {
          const b = detectBoundary(kind, tf, key, rows);
          if (b) ctx.boundary[kind] = b;
        }
        for (const c of rows) byTs.set(c.ts, c);
      },
    },
    since,
  );
}
