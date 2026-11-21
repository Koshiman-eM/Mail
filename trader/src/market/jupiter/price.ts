/**
 * Jupiter Price V3 (`GET /price/v3?ids=<mint,...>`) の一括取得。
 *
 * - 1 回に 50 件まで (公式資料の記述。要確認) なので 50 件ずつに分けて呼ぶ。
 * - 応答は mint をキーにしたオブジェクトで、値は `{ usdPrice, blockId?, decimals?, priceChange24h? }` の想定 (要確認)。
 *   信頼できる価格の無いトークンは応答に含まれないことがある → missing に入れる (例外にしない)。
 * - 価格が数値でない・0 以下などの要素は invalid に理由つきで入れる (例外にしない)。
 * - 応答に時刻は無い想定なので、ts は取得した時刻 (呼び出し側の now)。
 * - 一部の分割呼び出しが失敗しても他の結果は返す (failedChunks)。全部失敗したときだけ最後のエラーを投げる
 *   (feed が「何も取れていない」ことに気付けるように)。
 * - 念のため旧形式 (`{ data: { <mint>: { price } } }`) も読む。
 */
import { redactedErrMsg } from "../../core/http";
import type { JupiterClient } from "./client";
import { chunk, isRecord, JupiterShapeError, toFiniteNumber, uniqueNonEmpty } from "./parse";

export const PRICE_IDS_PER_CALL = 50;
export const PRICE_PATH = "/price/v3";

export interface JupiterPrice {
  /** USD 建ての価格 */
  usd: number;
  /** 取得した時刻 (ミリ秒) */
  ts: number;
  blockId?: number;
  decimals?: number;
  /** 24 時間の変化率 (% の想定。要確認) */
  priceChange24h?: number;
}

export interface PriceIssue {
  mint: string;
  reason: string;
}

export interface PriceParseResult {
  prices: Map<string, JupiterPrice>;
  /** 応答に含まれなかった mint (信頼できる価格が無い等) */
  missing: string[];
  /** 含まれていたが使えなかった mint と理由 */
  invalid: PriceIssue[];
}

export interface PriceBatchResult extends PriceParseResult {
  /** 失敗した分割呼び出し (エラー文は伏せ字済み) */
  failedChunks: { mints: string[]; error: string }[];
}

/** 応答本文を読む (純粋関数)。トップレベルがオブジェクトでなければ JupiterShapeError */
export function parsePriceResponse(raw: unknown, requested: readonly string[], ts: number): PriceParseResult {
  if (!isRecord(raw)) throw new JupiterShapeError(PRICE_PATH, ["(応答): オブジェクトではありません"]);
  let obj: Record<string, unknown> = raw;
  // 旧形式 { data: {...} } (要求した mint がトップに無いときだけ)
  if (isRecord(raw.data) && !requested.some((m) => m in raw)) obj = raw.data;
  const prices = new Map<string, JupiterPrice>();
  const missing: string[] = [];
  const invalid: PriceIssue[] = [];
  for (const mint of requested) {
    const v = obj[mint];
    if (v === undefined || v === null) {
      missing.push(mint);
      continue;
    }
    if (!isRecord(v)) {
      invalid.push({ mint, reason: "価格の要素がオブジェクトではありません" });
      continue;
    }
    const usd = toFiniteNumber(v.usdPrice ?? v.price);
    if (usd === undefined) {
      invalid.push({ mint, reason: "usdPrice が数値ではありません" });
      continue;
    }
    if (!(usd > 0)) {
      invalid.push({ mint, reason: `usdPrice が正の数ではありません (${usd})` });
      continue;
    }
    const p: JupiterPrice = { usd, ts };
    const blockId = toFiniteNumber(v.blockId);
    const decimals = toFiniteNumber(v.decimals);
    const ch = toFiniteNumber(v.priceChange24h);
    if (blockId !== undefined) p.blockId = blockId;
    if (decimals !== undefined && Number.isInteger(decimals) && decimals >= 0 && decimals <= 30) p.decimals = decimals;
    if (ch !== undefined) p.priceChange24h = ch;
    prices.set(mint, p);
  }
  return { prices, missing, invalid };
}

export interface FetchPricesOptions {
  /** 取得時刻 (既定 Date.now) */
  now?: () => number;
  /** 1 回の件数 (既定 50。50 を超える値は 50 にする) */
  idsPerCall?: number;
}

/** mint の一覧の価格を取得する (50 件ずつ)。重複・空文字は除く */
export async function fetchPrices(client: JupiterClient, mints: readonly string[], o: FetchPricesOptions = {}): Promise<PriceBatchResult> {
  const now = o.now ?? Date.now;
  const ids = uniqueNonEmpty(mints);
  const per = Math.min(PRICE_IDS_PER_CALL, Math.max(1, Math.floor(o.idsPerCall ?? PRICE_IDS_PER_CALL)));
  const out: PriceBatchResult = { prices: new Map(), missing: [], invalid: [], failedChunks: [] };
  const chunks = chunk(ids, per);
  let lastErr: unknown;
  for (const c of chunks) {
    try {
      const raw = await client.getJson(PRICE_PATH, { ids: c });
      const r = parsePriceResponse(raw, c, now());
      for (const [k, v] of r.prices) out.prices.set(k, v);
      out.missing.push(...r.missing);
      out.invalid.push(...r.invalid);
    } catch (e) {
      lastErr = e;
      out.failedChunks.push({ mints: c, error: redactedErrMsg(e) });
    }
  }
  if (chunks.length > 0 && out.failedChunks.length === chunks.length) {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  return out;
}
