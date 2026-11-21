/**
 * GeckoTerminal (https://api.geckoterminal.com/api/v2) の読み取り専用クライアント。Jupiter に OHLCV が無いので過去の足はここから取る。
 *
 * 仕様の出典は公式資料の記述 (この環境からは接続できず未確認。要確認):
 * - 足: `GET /networks/solana/pools/{pool}/ohlcv/{minute|hour|day}?aggregate=..&before_timestamp=<秒>&limit<=1000&currency=usd&token=base`
 *   aggregate は minute が 1/5/15、hour が 1/4/12、day が 1。応答は `data.attributes.ohlcv_list = [[秒, o, h, l, c, v], ...]` で新しい順。
 *   取引の無い時間の足は含まれない想定 (空白は埋めない。埋めるなら candles.ts の fillGaps)。形成中の足も含みうる (他の feed と同じく返す。
 *   確定足の選別は呼び出し側 = MarketHub)。
 * - トークンのプール: `GET /networks/solana/tokens/{mint}/pools` → `data[].attributes { address, reserve_in_usd, name }`、
 *   `data[].relationships.base_token.data.id = "solana_<mint>"`。そのトークンが base のプールのうち reserve_in_usd が最大のものを使う。
 * - ヘッダー `Accept: application/json;version=20230302`。
 * - 無料枠の上限は不明 (1 分あたり 5〜30 回の記述がある) ので、既定は 1 分あたり 10 回のトークンバケット (設定可能)。
 *   プールの検索結果は 6 時間 (見つからなければ 30 分) キャッシュし、足は確定足をキャッシュして新しい足だけ取り直す。
 * - 足の時刻はミリ秒・昇順にそろえて Candle (src/core/types.ts) で返す。読めない行は捨てて件数を数える。
 * - ページング: before_timestamp に前のページの最古の足の時刻 (秒) を入れてさかのぼる。境界の足が重複しても ts で除く
 *   (before_timestamp が含む・含まないのどちらでも壊れない)。
 */
import { HttpError } from "../../core/http";
import { TIMEFRAME_MS, type Candle, type Timeframe } from "../../core/types";
import { buildQuery, limitedGetJson, TokenBucket, type HttpJsonClientOptions } from "./client";
import { isRecord, JupiterShapeError, toFiniteNumber, toStr } from "./parse";

export const GECKO_BASE_URL = "https://api.geckoterminal.com/api/v2";
export const GECKO_ACCEPT = "application/json;version=20230302";
export const GECKO_DEFAULT_CALLS_PER_MINUTE = 10;
export const GECKO_MAX_LIMIT = 1000;
export const GECKO_POOL_CACHE_TTL_MS = 6 * 3_600_000;
export const GECKO_POOL_NEGATIVE_TTL_MS = 30 * 60_000;

export type GeckoPeriod = "minute" | "hour" | "day";

/** 時間足 → GeckoTerminal の period / aggregate (1s・1w は無い) */
export const GECKO_TIMEFRAMES: Partial<Record<Timeframe, { period: GeckoPeriod; aggregate: number }>> = {
  "1m": { period: "minute", aggregate: 1 },
  "5m": { period: "minute", aggregate: 5 },
  "15m": { period: "minute", aggregate: 15 },
  "1h": { period: "hour", aggregate: 1 },
  "4h": { period: "hour", aggregate: 4 },
  "1d": { period: "day", aggregate: 1 },
};

export interface GeckoPool {
  address: string;
  name?: string;
  reserveUsd?: number;
  /** base のトークンの mint (relationships から。無ければ undefined) */
  baseMint?: string;
  quoteMint?: string;
  dex?: string;
  createdAt?: number;
}

export interface OhlcvParseResult {
  /** 昇順・ms・ts の重複なし */
  candles: Candle[];
  /** 読めなかった行の数 */
  invalidRows: number;
}

/** "solana_<mint>" → "<mint>" */
function stripNetwork(id: string | undefined, network: string): string | undefined {
  if (!id) return undefined;
  const pre = `${network}_`;
  return id.startsWith(pre) ? id.slice(pre.length) : id;
}

const relId = (rel: unknown, key: string): string | undefined => {
  if (!isRecord(rel)) return undefined;
  const r = rel[key];
  if (!isRecord(r) || !isRecord(r.data)) return undefined;
  return toStr(r.data.id);
};

/** プールの一覧の応答を読む (純粋関数)。data が配列でなければ JupiterShapeError。address の無い要素は捨てる */
export function parseGeckoPools(raw: unknown, network = "solana"): GeckoPool[] {
  if (!isRecord(raw) || !Array.isArray(raw.data)) throw new JupiterShapeError("gecko /tokens/{mint}/pools", ["data: 配列ではありません"]);
  const out: GeckoPool[] = [];
  for (const item of raw.data) {
    if (!isRecord(item)) continue;
    const a = isRecord(item.attributes) ? item.attributes : {};
    const address = toStr(a.address) ?? stripNetwork(toStr(item.id), network);
    if (!address) continue;
    const p: GeckoPool = { address };
    const name = toStr(a.name);
    const reserve = toFiniteNumber(a.reserve_in_usd);
    const base = stripNetwork(relId(item.relationships, "base_token"), network);
    const quote = stripNetwork(relId(item.relationships, "quote_token"), network);
    const dex = relId(item.relationships, "dex");
    const created = typeof a.pool_created_at === "string" ? Date.parse(a.pool_created_at) : NaN;
    if (name) p.name = name;
    if (reserve !== undefined && reserve >= 0) p.reserveUsd = reserve;
    if (base) p.baseMint = base;
    if (quote) p.quoteMint = quote;
    if (dex) p.dex = dex;
    if (Number.isFinite(created)) p.createdAt = created;
    out.push(p);
  }
  return out;
}

/**
 * そのトークンが base のプールのうち reserve が最大のもの。
 * allowUnknownBase なら base が分からない (relationships の無い) プールも候補にする (既定 false: 反転した価格を使わないため)
 */
export function pickBestPool(pools: readonly GeckoPool[], mint: string, o: { allowUnknownBase?: boolean } = {}): GeckoPool | undefined {
  const cands = pools.filter((p) => p.baseMint === mint || (o.allowUnknownBase === true && p.baseMint === undefined));
  let best: GeckoPool | undefined;
  for (const p of cands) {
    const r = p.reserveUsd ?? -1;
    if (!best || r > (best.reserveUsd ?? -1)) best = p;
  }
  return best;
}

/** OHLCV の応答を読む (純粋関数)。ohlcv_list が配列でなければ JupiterShapeError。行は [秒, o, h, l, c, v] (文字列の数値も可) */
export function parseGeckoOhlcv(raw: unknown): OhlcvParseResult {
  const data = isRecord(raw) ? raw.data : undefined;
  const attrs = isRecord(data) ? data.attributes : undefined;
  const list = isRecord(attrs) ? attrs.ohlcv_list : undefined;
  if (!Array.isArray(list)) throw new JupiterShapeError("gecko /pools/{pool}/ohlcv", ["data.attributes.ohlcv_list: 配列ではありません"]);
  const byTs = new Map<number, Candle>();
  let invalidRows = 0;
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) {
      invalidRows++;
      continue;
    }
    const [t, o, h, l, c] = row.slice(0, 5).map(toFiniteNumber);
    const v = toFiniteNumber(row[5]);
    if (t === undefined || o === undefined || h === undefined || l === undefined || c === undefined || t <= 0) {
      invalidRows++;
      continue;
    }
    if (!(o > 0 && h > 0 && l > 0 && c > 0) || h < l || h < Math.max(o, c) * (1 - 1e-9) || l > Math.min(o, c) * (1 + 1e-9)) {
      invalidRows++;
      continue;
    }
    const ts = t < 1e11 ? Math.round(t * 1000) : Math.round(t);
    byTs.set(ts, { ts, open: o, high: h, low: l, close: c, volume: v !== undefined && v >= 0 ? v : 0 });
  }
  return { candles: [...byTs.values()].sort((a, b) => a.ts - b.ts), invalidRows };
}

/** ts で後勝ちにマージして昇順 (max 本まで、新しい側を残す) */
export function mergeByTs(base: readonly Candle[], incoming: readonly Candle[], max = Infinity): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of base) m.set(c.ts, c);
  for (const c of incoming) m.set(c.ts, c);
  const arr = [...m.values()].sort((a, b) => a.ts - b.ts);
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

export type OhlcvPageFetcher = (beforeSec: number | undefined, limit: number) => Promise<Candle[]>;

export interface PageBackwardOptions {
  /** 集める本数 (stopAt があればそれまで。どちらか早い方) */
  limit: number;
  /** これより前 (ミリ秒) からさかのぼる。無ければ最新から */
  before?: number;
  /** 最古の足がこの時刻 (ミリ秒) 以前になったら止める */
  stopAt?: number;
  /** 1 ページの本数 (既定 1000 = 上限) */
  pageSize?: number;
  /** ページ数の上限 (既定 5) */
  maxPages?: number;
}

export interface PageBackwardResult {
  /** 昇順・重複なし */
  candles: Candle[];
  /** 履歴の先頭に達した (空のページ・要求より短いページ・進まないページ) */
  exhausted: boolean;
  pages: number;
}

/** before_timestamp でさかのぼって集める (fetchPage は 1 ページ分を任意の順で返す) */
export async function pageCandlesBackward(fetchPage: OhlcvPageFetcher, o: PageBackwardOptions): Promise<PageBackwardResult> {
  const pageSize = Math.min(GECKO_MAX_LIMIT, Math.max(1, Math.floor(o.pageSize ?? GECKO_MAX_LIMIT)));
  const maxPages = Math.max(1, Math.floor(o.maxPages ?? 5));
  const limit = Math.max(1, Math.floor(o.limit));
  const byTs = new Map<number, Candle>();
  let beforeMs = o.before;
  let exhausted = false;
  let pages = 0;
  while (pages < maxPages) {
    const need = o.stopAt !== undefined ? pageSize : limit - byTs.size;
    if (need <= 0) break;
    // before_timestamp が境界の足を含む実装でも足りるよう 1 本多めに頼む (重複は ts で除く)
    const want = Math.min(pageSize, need + (beforeMs !== undefined ? 1 : 0));
    const page = await fetchPage(beforeMs !== undefined ? Math.floor(beforeMs / 1000) : undefined, want);
    pages++;
    const usable = beforeMs !== undefined ? page.filter((c) => c.ts < beforeMs!) : page;
    let added = 0;
    let oldest = Infinity;
    for (const c of usable) {
      if (c.ts < oldest) oldest = c.ts;
      if (!byTs.has(c.ts)) {
        byTs.set(c.ts, c);
        added++;
      }
    }
    if (added === 0) {
      exhausted = true;
      break;
    }
    if (o.stopAt !== undefined && oldest <= o.stopAt) break;
    if (o.stopAt === undefined && byTs.size >= limit) break;
    if (page.length < want) {
      exhausted = true;
      break;
    }
    beforeMs = oldest;
  }
  const candles = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  return { candles: o.stopAt === undefined && candles.length > limit ? candles.slice(candles.length - limit) : candles, exhausted, pages };
}

export interface GeckoClientOptions extends HttpJsonClientOptions {
  baseUrl?: string;
  network?: string;
  /** 1 分あたりの上限 (既定 10) */
  callsPerMinute?: number;
  /** 連続で呼べる回数 (既定 1) */
  burst?: number;
  limiter?: TokenBucket;
  poolCacheTtlMs?: number;
  poolNegativeTtlMs?: number;
  /** 足のキャッシュの本数の上限 (時間足・プールごと、既定 3000) */
  maxCachedCandles?: number;
  /** 1 回の fetchOhlcv のページ数の上限 (既定 5) */
  maxPages?: number;
}

export interface FetchOhlcvOptions {
  /** 欲しい本数 (since があれば since 以降の先頭 limit 本、無ければ末尾 limit 本) */
  limit: number;
  /** この時刻 (ミリ秒) 以降 */
  since?: number;
  /** この時刻 (ミリ秒) より前 (キャッシュを使わない) */
  before?: number;
  maxPages?: number;
}

interface OhlcvCacheEntry {
  candles: Candle[];
  /** 取得した時点の足の番号 (floor(now / 足の長さ))。同じ番号の間は新しい足が確定していない */
  bucket: number;
  exhausted: boolean;
}

export class GeckoTerminalClient {
  readonly baseUrl: string;
  readonly network: string;
  readonly limiter: TokenBucket;
  private readonly now: () => number;
  private readonly poolCache = new Map<string, { at: number; pools: GeckoPool[] }>();
  private readonly ohlcvCache = new Map<string, OhlcvCacheEntry>();

  constructor(private readonly o: GeckoClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? GECKO_BASE_URL).replace(/\/+$/, "");
    this.network = o.network ?? "solana";
    this.now = o.now ?? Date.now;
    const perMin = o.callsPerMinute ?? GECKO_DEFAULT_CALLS_PER_MINUTE;
    this.limiter =
      o.limiter ??
      new TokenBucket({ ratePerSec: perMin / 60, burst: o.burst ?? 1, now: this.now, ...(o.sleep ? { sleep: o.sleep } : {}) });
  }

  private get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    const url = `${this.baseUrl}${path}${buildQuery(query)}`;
    return limitedGetJson(url, path, { accept: GECKO_ACCEPT }, this.limiter, { baseDelayMs: 2000, ...this.o });
  }

  /** トークンのプール一覧 (キャッシュ。404 は「プールなし」として空の一覧) */
  async topPools(mint: string): Promise<GeckoPool[]> {
    const hit = this.poolCache.get(mint);
    const t = this.now();
    if (hit) {
      const ttl = hit.pools.length > 0 ? (this.o.poolCacheTtlMs ?? GECKO_POOL_CACHE_TTL_MS) : (this.o.poolNegativeTtlMs ?? GECKO_POOL_NEGATIVE_TTL_MS);
      if (t - hit.at < ttl) return hit.pools.map((p) => ({ ...p }));
    }
    let pools: GeckoPool[];
    try {
      pools = parseGeckoPools(await this.get(`/networks/${this.network}/tokens/${encodeURIComponent(mint)}/pools`), this.network);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) pools = [];
      else throw e;
    }
    this.poolCache.set(mint, { at: t, pools });
    return pools.map((p) => ({ ...p }));
  }

  /** そのトークンが base のプールのうち reserve が最大のもの (キャッシュ) */
  async bestPoolFor(mint: string, o: { allowUnknownBase?: boolean } = {}): Promise<GeckoPool | undefined> {
    return pickBestPool(await this.topPools(mint), mint, o);
  }

  /** OHLCV の 1 ページ (昇順) */
  async fetchOhlcvPage(pool: string, tf: Timeframe, o: { beforeSec?: number; limit?: number } = {}): Promise<Candle[]> {
    const spec = GECKO_TIMEFRAMES[tf];
    if (!spec) throw new Error(`GeckoTerminal は時間足 ${tf} の足を提供していません`);
    const limit = Math.min(GECKO_MAX_LIMIT, Math.max(1, Math.floor(o.limit ?? GECKO_MAX_LIMIT)));
    const raw = await this.get(`/networks/${this.network}/pools/${encodeURIComponent(pool)}/ohlcv/${spec.period}`, {
      aggregate: spec.aggregate,
      before_timestamp: o.beforeSec,
      limit,
      currency: "usd",
      token: "base",
    });
    return parseGeckoOhlcv(raw).candles;
  }

  /**
   * OHLCV を limit 本 (昇順・ms)。before が無ければ確定足をキャッシュし、新しい足が確定したときだけ最新側を取り直す
   * (since・before があってもキャッシュが範囲を持っていれば使う)
   */
  async fetchOhlcv(pool: string, tf: Timeframe, o: FetchOhlcvOptions): Promise<Candle[]> {
    const ms = TIMEFRAME_MS[tf];
    if (!GECKO_TIMEFRAMES[tf]) throw new Error(`GeckoTerminal は時間足 ${tf} の足を提供していません`);
    const limit = Math.max(1, Math.floor(o.limit));
    const maxPages = o.maxPages ?? this.o.maxPages ?? 5;
    const fetchPage: OhlcvPageFetcher = (beforeSec, n) => this.fetchOhlcvPage(pool, tf, { beforeSec, limit: n });

    if (o.before !== undefined) {
      const r = await pageCandlesBackward(fetchPage, {
        limit, before: o.before, maxPages, ...(o.since !== undefined ? { stopAt: o.since } : {}),
      });
      return o.since !== undefined ? r.candles.filter((c) => c.ts >= o.since!).slice(0, limit) : r.candles.slice(-limit);
    }

    const now = this.now();
    const key = `${pool}|${tf}`;
    const bucket = Math.floor(now / ms);
    const maxCached = this.o.maxCachedCandles ?? 3000;
    let e = this.ohlcvCache.get(key);
    const covers = (x: OhlcvCacheEntry) =>
      o.since !== undefined ? x.exhausted || (x.candles.length > 0 && x.candles[0].ts <= o.since) : x.exhausted || x.candles.length >= limit;

    if (!e || e.bucket !== bucket || !covers(e)) {
      let merged = e?.candles ?? [];
      let exhausted = e?.exhausted ?? false;
      if (merged.length > 0 && e && e.bucket !== bucket) {
        // 最新側: キャッシュの最後の足 (形成中だった足を取り直す) までさかのぼる
        const lastTs = merged[merged.length - 1].ts;
        const missing = Math.ceil((now - lastTs) / ms) + 2;
        if (missing > GECKO_MAX_LIMIT * maxPages) {
          merged = [];
          exhausted = false;
        } else {
          const r = await pageCandlesBackward(fetchPage, { limit: missing, stopAt: lastTs, maxPages, pageSize: Math.min(GECKO_MAX_LIMIT, missing) });
          merged = mergeByTs(merged, r.candles, maxCached);
        }
      }
      const enough = () => (o.since !== undefined ? merged.length > 0 && merged[0].ts <= o.since : merged.length >= limit);
      if (!exhausted && !enough()) {
        // 古い側: キャッシュの最古の足より前を足りるまで
        const before = merged.length > 0 ? merged[0].ts : undefined;
        const r = await pageCandlesBackward(fetchPage, {
          limit: Math.max(1, limit - merged.length),
          maxPages,
          ...(before !== undefined ? { before } : {}),
          ...(o.since !== undefined ? { stopAt: o.since } : {}),
        });
        merged = mergeByTs(merged, r.candles, maxCached);
        exhausted = r.exhausted;
      }
      e = { candles: merged, bucket, exhausted };
      this.ohlcvCache.set(key, e);
    }
    const arr = e.candles;
    const out = o.since !== undefined ? arr.filter((c) => c.ts >= o.since!).slice(0, limit) : arr.slice(-limit);
    return out.map((c) => ({ ...c }));
  }

  /** キャッシュを捨てる (テスト・監視から外した銘柄) */
  clearCache(): void {
    this.poolCache.clear();
    this.ohlcvCache.clear();
  }
}
