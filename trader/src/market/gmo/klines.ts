/**
 * GMOコインのローソク足 (`GET /v1/klines?symbol=&interval=&date=`) を日付ファイル単位でさかのぼって集める。
 * 考え方は src/market/feeds/bitbankCandles.ts と同じ。
 *
 * - 1hour 以下は date=YYYYMMDD (1 日分)、4hour 以上は date=YYYY (1 年分)。
 * - 日の区切りは日本時間 6:00 の想定 (要確認)。UTC 0 時・JST 0 時の区切りでも壊れないよう、時刻 t を含みうるファイルは
 *   UTC 日付 (t) から JST 日付 (t + 9h) までの全部を候補にする (JST 6:00 区切りの日付 = t + 3h の UTC 日付はこの間に入る)。
 *   取得後は openTime で重複を除き、since・現在時刻で範囲を絞る。
 * - 存在しない日付 (未来・上場前) は取引所がエラー (status ≠ 0) か空の配列を返す想定 (要確認)。メンテナンス・
 *   リクエスト過多・通信・形の違いは握りつぶさずに投げる。それ以外の取引所のエラーはそのファイルを 0 本とみなし、
 *   取得したファイルが全部エラーのときは GmoNoKlinesError を投げる (呼び出し側が現物銘柄へのフォールバックを判断する)。
 * - 足は形成中のものも返す (他の feed と同じ)。戦略に渡す確定足の選別は MarketHub (closedCandles) と
 *   fetchCandlesPaged (ts + 足の長さ <= until) が行う。未来の openTime の足は捨てる。
 */
import type { Candle, Timeframe } from "../../core/types";
import { collectFileCandles, fileKeyOf, JST_OFFSET, maxFilesFor, utcDayStart, utcYear, type FileKind } from "../fileCandles";
import { GmoApiError } from "./client";

/** 時間足 → GMO の interval とファイルの単位 */
export const GMO_INTERVALS: Partial<Record<Timeframe, { interval: string; kind: FileKind }>> = {
  "1m": { interval: "1min", kind: "day" },
  "5m": { interval: "5min", kind: "day" },
  "15m": { interval: "15min", kind: "day" },
  "1h": { interval: "1hour", kind: "day" },
  "4h": { interval: "4hour", kind: "year" },
  "1d": { interval: "1day", kind: "year" },
  "1w": { interval: "1week", kind: "year" },
};

/** 1 回の fetchCandles で取得するファイル数の上限 (bitbank と同じ考え方。それより長い範囲は呼び出し側のページングで取る) */
export const GMO_MAX_FILES: Record<FileKind, number> = { day: 20, year: 10 };

/** 取得したファイルがすべて取引所のエラーだった (足が無い) */
export class GmoNoKlinesError extends Error {
  constructor(
    readonly symbol: string,
    readonly interval: string,
    readonly cause: unknown,
  ) {
    super(`GMO: ${symbol} の ${interval} のローソク足を取得できません (${cause instanceof Error ? cause.message : String(cause)})`);
    this.name = "GmoNoKlinesError";
  }
}

export type KlinesFetcher = (symbol: string, interval: string, date: string) => Promise<Candle[]>;

/** 時刻 t を含みうるファイルの範囲 (UTC 日付 〜 JST 日付。年次は年) */
function fileRange(kind: FileKind, t: number): { oldest: number; newest: number } {
  if (kind === "day") return { oldest: utcDayStart(t), newest: utcDayStart(t + JST_OFFSET) };
  return { oldest: utcYear(t), newest: utcYear(t + JST_OFFSET) };
}

/** ファイルを取らずにエラーにする取引所のエラーか (メンテナンス・リクエスト過多は投げる) */
const isNoDataError = (e: unknown) => e instanceof GmoApiError && e.kind === "other";

/**
 * GMO のローソク足を limit 本取得する。
 * - since なし: 最新のファイルから 1 つずつさかのぼり、limit 本そろうか上限ファイル数で止めて末尾 limit 本を返す。
 * - since あり: since を含みうるファイルから現在まで順に取り、ts >= since が limit 本そろうか上限で止めて先頭 limit 本を返す。
 */
export async function fetchGmoKlines(
  fetchFile: KlinesFetcher,
  symbol: string,
  tf: Timeframe,
  limit: number,
  now: number,
  since?: number,
): Promise<Candle[]> {
  const spec = GMO_INTERVALS[tf];
  if (!spec) throw new Error(`GMO は時間足 ${tf} のローソク足を提供していません`);
  const { interval, kind } = spec;
  const want = Math.max(1, Math.floor(limit));
  let fetched = 0;
  let failed = 0;
  let lastErr: unknown;

  const out = await collectFileCandles(
    {
      kind,
      want,
      maxFiles: maxFilesFor(kind, GMO_MAX_FILES, want, tf),
      newest: fileRange(kind, now).newest,
      oldestFor: (t) => fileRange(kind, t).oldest,
      take: async (v, byTs) => {
        fetched++;
        let rows: Candle[];
        try {
          rows = await fetchFile(symbol, interval, fileKeyOf(kind, v));
        } catch (e) {
          if (!isNoDataError(e)) throw e;
          failed++;
          lastErr = e;
          return;
        }
        for (const c of rows) if (c.ts <= now) byTs.set(c.ts, c);
      },
    },
    since,
  );
  if (fetched > 0 && failed === fetched) throw new GmoNoKlinesError(symbol, interval, lastErr);
  return out;
}
