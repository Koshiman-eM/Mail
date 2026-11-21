/**
 * Jupiter Tokens V2 (トークン情報) の取得と正規化。
 *
 * エンドポイント (公式資料の記述。要確認):
 * - `GET /tokens/v2/search?query=<symbol|mint をカンマ区切りで 100 件まで>`
 * - `GET /tokens/v2/tag?query=verified|lst`
 * - `GET /tokens/v2/{toptrending|toporganicscore|toptraded}/{5m|1h|6h|24h}?limit=N` (既定 50。trending は主要銘柄を除く)
 * - `GET /tokens/v2/recent` (最近プールができたトークン)
 *
 * 応答はトークンの配列の想定 (念のため `{ tokens: [...] }` / `{ data: [...] }` も読む)。各要素は防御的に読み、
 * mint (id) が Solana のアドレスでない要素だけを invalid として報告する (他の項目が欠けていても・null でも・文字列の数値でも読む)。
 * 正規化した型は JupiterToken (欠けた項目は undefined = 不明。判定側 discovery.ts は不明を不合格に倒す)。
 * - audit の各項目は任意・null あり。isSus は true のときだけ付く想定 (無ければ undefined = 疑いの印なし)。
 * - firstPool.createdAt は ISO 8601 の文字列の想定 (秒・ミリ秒の数値も読む) → ミリ秒。
 */
import { z } from "zod";
import type { JupiterClient } from "./client";
import {
  chunk, isRecord, isSolanaAddress, JupiterShapeError, looseBool, looseMs, looseNum, looseStr, looseStrArray, toStr, uniqueNonEmpty,
} from "./parse";

export const TOKEN_CATEGORIES = ["toptrending", "toporganicscore", "toptraded"] as const;
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];
export const TOKEN_INTERVALS = ["5m", "1h", "6h", "24h"] as const;
export type TokenInterval = (typeof TOKEN_INTERVALS)[number];
export const TOKEN_TAGS = ["verified", "lst"] as const;
export type TokenTag = (typeof TOKEN_TAGS)[number];
export const SEARCH_QUERIES_PER_CALL = 100;

export interface JupiterTokenStats {
  priceChange?: number;
  holderChange?: number;
  liquidityChange?: number;
  volumeChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  buyOrganicVolume?: number;
  sellOrganicVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  numOrganicBuyers?: number;
  numNetBuyers?: number;
}

export interface JupiterTokenAudit {
  mintAuthorityDisabled?: boolean;
  freezeAuthorityDisabled?: boolean;
  /** 上位保有者の比率 (% の想定。要確認) */
  topHoldersPercentage?: number;
  devMints?: number;
  /** true のときだけ付く想定 */
  isSus?: boolean;
}

export type OrganicScoreLabel = "high" | "medium" | "low";

export interface JupiterToken {
  mint: string;
  name?: string;
  symbol?: string;
  icon?: string;
  decimals?: number;
  usdPrice?: number;
  liquidity?: number;
  mcap?: number;
  fdv?: number;
  holderCount?: number;
  /** 0〜100 */
  organicScore?: number;
  organicScoreLabel?: OrganicScoreLabel;
  isVerified?: boolean;
  tags: string[];
  audit: JupiterTokenAudit;
  firstPool?: { id?: string; createdAt?: number };
  stats: Partial<Record<TokenInterval, JupiterTokenStats>>;
  /** 応答の updatedAt (ミリ秒) */
  updatedAt?: number;
}

export interface TokenListResult {
  tokens: JupiterToken[];
  /** 読めなかった要素 (位置と理由) */
  invalid: { index: number; reason: string }[];
}

// ───────── 検証スキーマ (欠けても・不正でも例外にしない) ─────────

const statsSchema = z.looseObject({
  priceChange: looseNum,
  holderChange: looseNum,
  liquidityChange: looseNum,
  volumeChange: looseNum,
  buyVolume: looseNum,
  sellVolume: looseNum,
  buyOrganicVolume: looseNum,
  sellOrganicVolume: looseNum,
  numBuys: looseNum,
  numSells: looseNum,
  numTraders: looseNum,
  numOrganicBuyers: looseNum,
  numNetBuyers: looseNum,
});

const auditSchema = z.looseObject({
  mintAuthorityDisabled: looseBool,
  freezeAuthorityDisabled: looseBool,
  topHoldersPercentage: looseNum,
  devMints: looseNum,
  isSus: looseBool,
});

const firstPoolSchema = z.looseObject({ id: looseStr, createdAt: looseMs });

/** オブジェクトなら schema で読み、それ以外 (null・欠け) は undefined */
const optionalObject = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .unknown()
    .transform((v) => {
      if (!isRecord(v)) return undefined;
      const r = schema.safeParse(v);
      return r.success ? (r.data as z.infer<T>) : undefined;
    })
    .optional();

const tokenSchema = z.looseObject({
  id: z.unknown().optional(),
  mint: z.unknown().optional(),
  address: z.unknown().optional(),
  name: looseStr,
  symbol: looseStr,
  icon: looseStr,
  decimals: looseNum,
  usdPrice: looseNum,
  liquidity: looseNum,
  mcap: looseNum,
  fdv: looseNum,
  holderCount: looseNum,
  organicScore: looseNum,
  organicScoreLabel: looseStr,
  isVerified: looseBool,
  tags: looseStrArray,
  audit: optionalObject(auditSchema),
  firstPool: optionalObject(firstPoolSchema),
  stats5m: optionalObject(statsSchema),
  stats1h: optionalObject(statsSchema),
  stats6h: optionalObject(statsSchema),
  stats24h: optionalObject(statsSchema),
  updatedAt: looseMs,
});

/** undefined の項目を落とす (toEqual で比べやすく、JSON に null を出さない) */
function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

const STAT_KEYS: readonly (keyof JupiterTokenStats)[] = [
  "priceChange", "holderChange", "liquidityChange", "volumeChange", "buyVolume", "sellVolume", "buyOrganicVolume", "sellOrganicVolume",
  "numBuys", "numSells", "numTraders", "numOrganicBuyers", "numNetBuyers",
];

function pickStats(s: Record<string, unknown> | undefined): JupiterTokenStats | undefined {
  if (!s) return undefined;
  const out: JupiterTokenStats = {};
  for (const k of STAT_KEYS) if (typeof s[k] === "number") out[k] = s[k] as number;
  return out;
}

const nonNeg = (n: number | undefined) => (n !== undefined && n >= 0 ? n : undefined);

/** 1 件を正規化する。mint が無い・アドレスでなければ理由の文字列を返す */
export function normalizeToken(raw: unknown): JupiterToken | string {
  if (!isRecord(raw)) return "要素がオブジェクトではありません";
  const r = tokenSchema.safeParse(raw);
  if (!r.success) return "要素を読めません";
  const t = r.data;
  const mint = toStr(t.id) ?? toStr(t.mint) ?? toStr(t.address);
  if (!mint) return "id (mint) がありません";
  if (!isSolanaAddress(mint)) return `id (mint) が Solana のアドレスではありません (${mint.slice(0, 48)})`;
  const label = t.organicScoreLabel?.toLowerCase();
  const decimals = t.decimals !== undefined && Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 30 ? t.decimals : undefined;
  const stats: Partial<Record<TokenInterval, JupiterTokenStats>> = {};
  const s5 = pickStats(t.stats5m);
  const s1 = pickStats(t.stats1h);
  const s6 = pickStats(t.stats6h);
  const s24 = pickStats(t.stats24h);
  if (s5) stats["5m"] = s5;
  if (s1) stats["1h"] = s1;
  if (s6) stats["6h"] = s6;
  if (s24) stats["24h"] = s24;
  const a = t.audit;
  const audit: JupiterTokenAudit = a
    ? compact({
        mintAuthorityDisabled: a.mintAuthorityDisabled,
        freezeAuthorityDisabled: a.freezeAuthorityDisabled,
        topHoldersPercentage: nonNeg(a.topHoldersPercentage),
        devMints: nonNeg(a.devMints),
        isSus: a.isSus,
      })
    : {};
  const fp = t.firstPool ? compact({ id: t.firstPool.id, createdAt: t.firstPool.createdAt }) : undefined;
  return compact<JupiterToken>({
    mint,
    name: t.name,
    symbol: t.symbol,
    icon: t.icon,
    decimals,
    usdPrice: t.usdPrice !== undefined && t.usdPrice > 0 ? t.usdPrice : undefined,
    liquidity: nonNeg(t.liquidity),
    mcap: nonNeg(t.mcap),
    fdv: nonNeg(t.fdv),
    holderCount: nonNeg(t.holderCount),
    organicScore: t.organicScore !== undefined && t.organicScore >= 0 && t.organicScore <= 100 ? t.organicScore : undefined,
    organicScoreLabel: label === "high" || label === "medium" || label === "low" ? label : undefined,
    isVerified: t.isVerified,
    tags: t.tags ?? [],
    audit,
    firstPool: fp && Object.keys(fp).length > 0 ? fp : undefined,
    stats,
    updatedAt: t.updatedAt,
  });
}

/** トークンの一覧の応答を読む (純粋関数)。配列 (または tokens / data の配列) でなければ JupiterShapeError */
export function parseTokenList(raw: unknown, path = "/tokens/v2"): TokenListResult {
  let arr: unknown;
  if (Array.isArray(raw)) arr = raw;
  else if (isRecord(raw) && Array.isArray(raw.tokens)) arr = raw.tokens;
  else if (isRecord(raw) && Array.isArray(raw.data)) arr = raw.data;
  if (!Array.isArray(arr)) throw new JupiterShapeError(path, ["(応答): トークンの配列ではありません"]);
  const tokens: JupiterToken[] = [];
  const invalid: TokenListResult["invalid"] = [];
  const seen = new Set<string>();
  arr.forEach((item, index) => {
    const t = normalizeToken(item);
    if (typeof t === "string") invalid.push({ index, reason: t });
    else if (!seen.has(t.mint)) {
      seen.add(t.mint);
      tokens.push(t);
    }
  });
  return { tokens, invalid };
}

// ───────── 取得 ─────────

/** symbol か mint で検索する (100 件ずつに分けて呼ぶ。結果は mint で重複を除く) */
export async function searchTokens(client: JupiterClient, queries: readonly string[]): Promise<TokenListResult> {
  const qs = uniqueNonEmpty(queries);
  const out: TokenListResult = { tokens: [], invalid: [] };
  const seen = new Set<string>();
  for (const c of chunk(qs, SEARCH_QUERIES_PER_CALL)) {
    const path = "/tokens/v2/search";
    const r = parseTokenList(await client.getJson(path, { query: c }), path);
    for (const t of r.tokens) {
      if (seen.has(t.mint)) continue;
      seen.add(t.mint);
      out.tokens.push(t);
    }
    out.invalid.push(...r.invalid);
  }
  return out;
}

/** タグ (verified / lst) のトークン */
export async function fetchTokensByTag(client: JupiterClient, tag: TokenTag): Promise<TokenListResult> {
  if (!TOKEN_TAGS.includes(tag)) throw new Error(`Jupiter: 未知のタグ ${String(tag)}`);
  const path = "/tokens/v2/tag";
  return parseTokenList(await client.getJson(path, { query: tag }), path);
}

/** 上位のトークン (trending / organic score / 取引数) */
export async function fetchTokenCategory(
  client: JupiterClient,
  category: TokenCategory,
  interval: TokenInterval,
  limit = 50,
): Promise<TokenListResult> {
  if (!TOKEN_CATEGORIES.includes(category)) throw new Error(`Jupiter: 未知のカテゴリー ${String(category)}`);
  if (!TOKEN_INTERVALS.includes(interval)) throw new Error(`Jupiter: 未知の期間 ${String(interval)}`);
  const n = Math.min(100, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 50)));
  const path = `/tokens/v2/${category}/${interval}`;
  return parseTokenList(await client.getJson(path, { limit: n }), path);
}

/** 最近プールができたトークン */
export async function fetchRecentTokens(client: JupiterClient): Promise<TokenListResult> {
  const path = "/tokens/v2/recent";
  return parseTokenList(await client.getJson(path), path);
}
