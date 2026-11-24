/**
 * ミームコインの選別 (純粋関数) と、固定の監視銘柄・自動で見つけた銘柄の合成。
 *
 * - screenTokens: Jupiter のトークン情報 (JupiterToken) を設定の条件で選ぶ。不合格の銘柄にはすべての理由 (日本語) を付ける。
 *   値が不明 (応答に無い) な条件は不合格に倒す (fail-closed)。isSus は true のときだけ付く想定なので、無ければ疑いなしとみなす。
 *   主要銘柄 (SOL・USDC・JUP など、excludeMints) はミームではないので除く。主要銘柄の名前 (BTC・ETH・SOL など) を名乗る
 *   別の mint のトークンは「なりすまし」(impersonation) として除く (例: BTC/USDC と表示されるミームを 8% の損切りで取引していた)。合格は入力の順 (trending の順位) のまま maxTokens 件まで。
 * - mergeWatchlist: 固定の監視銘柄 (期限なし) と、選別で合格した銘柄 (自動追加。最後に合格してから ttlMs で期限切れ) を合わせる。
 *   保有中の銘柄 (keepMints) は期限切れでも外さない (建玉の管理を続けるため)。
 * - 既定の銘柄の mint は確信のあるものだけ。いずれも `runJupiterCheck` (check.ts) で symbol と照合すること (要確認)。
 */
import type { JupiterToken } from "./tokens";

export interface KnownToken {
  mint: string;
  symbol: string;
  /** check で symbol を照合する対象 (既定の一覧はすべて要確認) */
  verify: boolean;
  /**
   * Jupiter のトークン情報で使われうる別の symbol (例: Wormhole の WETH は "ETH" と表示されうる)。
   * check の照合でも一致とみなし、なりすましの判定 (impersonationFor) でもこの名前を守る
   */
  aliases?: readonly string[];
}

/**
 * 主要銘柄 (ミームではない。資産クラス crypto。USDC・USDT はクオート・ステーブルなので監視しない)。
 * mint は要確認 (`jupiter check` で symbol と照合する)。SOL・USDC・JUP 以外 (USDT・cbBTC・WBTC・WETH・JTO・PYTH・RAY) は
 * 2026-11 に追加した (要確認: 公式の資料・エクスプローラーでの照合は未了。check で mint ↔ symbol を確かめること)
 */
export const MAJOR_TOKENS: readonly KnownToken[] = [
  { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", verify: true },
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", verify: true },
  { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP", verify: true },
  // 要確認: Tether USD (Solana)
  { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCecvJdx6zM", symbol: "USDT", verify: true },
  // 要確認: Coinbase Wrapped BTC
  { mint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", symbol: "cbBTC", verify: true, aliases: ["BTC"] },
  // 要確認: Wrapped BTC (Wormhole / Portal)
  { mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", symbol: "WBTC", verify: true, aliases: ["BTC"] },
  // 要確認: Wrapped Ether (Wormhole / Portal)。Jupiter では "ETH" と表示されうる
  { mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", symbol: "WETH", verify: true, aliases: ["ETH"] },
  // 要確認: Jito
  { mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", symbol: "JTO", verify: true },
  // 要確認: Pyth Network
  { mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", symbol: "PYTH", verify: true },
  // 要確認: Raydium
  { mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", symbol: "RAY", verify: true },
];

/** 監視しない主要銘柄 (クオート・ステーブル) の symbol */
export const NON_TRADED_MAJOR_SYMBOLS: readonly string[] = ["USDC", "USDT"];

/** 既定で監視する主要銘柄 (crypto) の symbol (JUPITER_TOKENS の既定。登録順) */
export const DEFAULT_MAJOR_WATCH_SYMBOLS: readonly string[] = MAJOR_TOKENS.map((t) => t.symbol).filter((s) => !NON_TRADED_MAJOR_SYMBOLS.includes(s));

/** symbol の比較用の正規化 (先頭の "$" を除き、大文字にする。WIF は "$WIF" で登録されている) */
export function normalizeTokenSymbol(s: string): string {
  return s.trim().replace(/^[$]+/, "").toUpperCase();
}

/** 主要銘柄の名前 (symbol と aliases の正規化) → 本物の mint の集合 */
const PROTECTED_SYMBOLS: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const m = new Map<string, Set<string>>();
  for (const t of MAJOR_TOKENS) {
    for (const name of [t.symbol, ...(t.aliases ?? [])]) {
      const k = normalizeTokenSymbol(name);
      if (!m.has(k)) m.set(k, new Set());
      m.get(k)!.add(t.mint);
    }
  }
  return m;
})();

/**
 * 主要銘柄の名前を名乗る別のトークンか (なりすまし)。symbol を正規化 (先頭の "$" を除き大文字) して、主要銘柄の symbol・別名
 * (BTC・ETH・SOL・JUP・USDC・USDT・cbBTC・WBTC・WETH・JTO・PYTH・RAY) と完全に一致し、mint が本物と違えば true。
 * 前後に文字を足した名前 (例 "BTC2"・"XBTC") は対象外 (完全一致だけ。先頭の "W"・"cb" も外さない)
 */
export function isImpersonation(mint: string, symbol: string | undefined): boolean {
  if (!symbol) return false;
  const real = PROTECTED_SYMBOLS.get(normalizeTokenSymbol(symbol));
  return real !== undefined && !real.has(mint);
}

export const SOL_MINT = MAJOR_TOKENS[0].mint;
export const USDC_MINT = MAJOR_TOKENS[1].mint;

/** 既定の固定のミームコイン。mint は要確認 (check で照合する) */
export const DEFAULT_MEME_TOKENS: readonly KnownToken[] = [
  { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", verify: true },
  { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", symbol: "WIF", verify: true },
  { mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", symbol: "POPCAT", verify: true },
  { mint: "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5", symbol: "MEW", verify: true },
];

// ───────── 選別 ─────────

export interface DiscoverySettings {
  /** 最低の流動性 (USD) */
  minLiquidityUsd: number;
  /** 最低の保有者数 */
  minHolderCount: number;
  /** 最初のプールができてからの最低の経過時間 (ミリ秒) */
  minAgeMs: number;
  /** 最低の organicScore (0〜100) */
  minOrganicScore: number;
  /** ミント権限と凍結権限の両方が無効であることを求める */
  requireAuthoritiesDisabled: boolean;
  /** 上位保有者の比率の上限 (%) */
  maxTopHoldersPct: number;
  /** isSus のトークンを除く */
  rejectSus: boolean;
  /** 検証済み (isVerified) だけ */
  verifiedOnly: boolean;
  /** 合格させる最大の件数 */
  maxTokens: number;
  /** 除く mint (主要銘柄など) */
  excludeMints: readonly string[];
}

export const DEFAULT_DISCOVERY_SETTINGS: Readonly<DiscoverySettings> = {
  minLiquidityUsd: 250_000,
  minHolderCount: 2_000,
  minAgeMs: 3 * 86_400_000,
  minOrganicScore: 60,
  requireAuthoritiesDisabled: true,
  maxTopHoldersPct: 35,
  rejectSus: true,
  verifiedOnly: false,
  maxTokens: 10,
  excludeMints: MAJOR_TOKENS.map((t) => t.mint),
};

export type RejectCode =
  | "excluded" | "impersonation" | "duplicate" | "liquidity" | "holders" | "age" | "organic" | "mint_authority" | "freeze_authority"
  | "top_holders" | "sus" | "unverified" | "max_tokens";

/** 理由の種類の日本語の表示名 */
export const REJECT_CODE_LABELS: Record<RejectCode, string> = {
  excluded: "除外銘柄",
  impersonation: "主要銘柄の名前を名乗る別のトークン",
  duplicate: "重複",
  liquidity: "流動性不足",
  holders: "保有者数不足",
  age: "上場から日が浅い",
  organic: "オーガニックスコア不足",
  mint_authority: "ミント権限あり",
  freeze_authority: "凍結権限あり",
  top_holders: "上位保有者の集中",
  sus: "疑わしいトークン",
  unverified: "未検証",
  max_tokens: "件数の上限",
};

export interface Rejection {
  code: RejectCode;
  /** 日本語の説明 (値と条件つき) */
  label: string;
}

export interface ScreenResult {
  accepted: JupiterToken[];
  rejected: { token: JupiterToken; reasons: Rejection[] }[];
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const hours = (ms: number) => (ms >= 86_400_000 ? `${(ms / 86_400_000).toFixed(1)} 日` : `${(ms / 3_600_000).toFixed(1)} 時間`);

/** 1 銘柄の不合格の理由 (件数の上限・重複は除く)。空なら合格 */
export function rejectionsFor(t: JupiterToken, s: DiscoverySettings, now: number): Rejection[] {
  const out: Rejection[] = [];
  const add = (code: RejectCode, detail: string) => out.push({ code, label: `${REJECT_CODE_LABELS[code]}: ${detail}` });
  if (s.excludeMints.includes(t.mint)) add("excluded", "主要銘柄・除外の一覧にある");
  const imp = impersonationRejection(t.mint, t.symbol);
  if (imp) out.push(imp);
  if (t.liquidity === undefined) add("liquidity", "流動性が不明");
  else if (t.liquidity < s.minLiquidityUsd) add("liquidity", `${usd(t.liquidity)} < ${usd(s.minLiquidityUsd)}`);
  if (t.holderCount === undefined) add("holders", "保有者数が不明");
  else if (t.holderCount < s.minHolderCount) add("holders", `${t.holderCount} < ${s.minHolderCount}`);
  const created = t.firstPool?.createdAt;
  if (created === undefined) add("age", "最初のプールの作成時刻が不明");
  else if (now - created < s.minAgeMs) add("age", `${hours(Math.max(0, now - created))} < ${hours(s.minAgeMs)}`);
  if (t.organicScore === undefined) add("organic", "オーガニックスコアが不明");
  else if (t.organicScore < s.minOrganicScore) add("organic", `${t.organicScore.toFixed(1)} < ${s.minOrganicScore}`);
  if (s.requireAuthoritiesDisabled) {
    const m = t.audit.mintAuthorityDisabled;
    const f = t.audit.freezeAuthorityDisabled;
    if (m !== true) add("mint_authority", m === false ? "ミント権限が無効になっていない" : "ミント権限の状態が不明");
    if (f !== true) add("freeze_authority", f === false ? "凍結権限が無効になっていない" : "凍結権限の状態が不明");
  }
  const top = t.audit.topHoldersPercentage;
  if (top === undefined) add("top_holders", "上位保有者の比率が不明");
  else if (top > s.maxTopHoldersPct) add("top_holders", `${top.toFixed(1)}% > ${s.maxTopHoldersPct}%`);
  if (s.rejectSus && t.audit.isSus === true) add("sus", "Jupiter の監査で isSus");
  if (s.verifiedOnly && t.isVerified !== true) add("unverified", t.isVerified === false ? "検証済みではない" : "検証の状態が不明");
  return out;
}

/** なりすまし (isImpersonation) の不合格の理由 (なりすましでなければ undefined) */
export function impersonationRejection(mint: string, symbol: string | undefined): Rejection | undefined {
  if (!symbol || !isImpersonation(mint, symbol)) return undefined;
  return { code: "impersonation", label: `${REJECT_CODE_LABELS.impersonation}: ${symbol} (mint ${mint} は本物の ${normalizeTokenSymbol(symbol)} ではない)` };
}

/** 選別する (純粋関数)。合格は入力の順に maxTokens 件まで */
export function screenTokens(tokens: readonly JupiterToken[], settings: Partial<DiscoverySettings> = {}, now: number = Date.now()): ScreenResult {
  const s: DiscoverySettings = { ...DEFAULT_DISCOVERY_SETTINGS, ...settings };
  const max = Math.max(0, Math.floor(s.maxTokens));
  const accepted: JupiterToken[] = [];
  const rejected: ScreenResult["rejected"] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (seen.has(t.mint)) {
      rejected.push({ token: t, reasons: [{ code: "duplicate", label: `${REJECT_CODE_LABELS.duplicate}: 同じ mint が先にある` }] });
      continue;
    }
    seen.add(t.mint);
    const reasons = rejectionsFor(t, s, now);
    if (reasons.length === 0 && accepted.length >= max) reasons.push({ code: "max_tokens", label: `${REJECT_CODE_LABELS.max_tokens}: ${max} 件まで` });
    if (reasons.length > 0) rejected.push({ token: t, reasons });
    else accepted.push(t);
  }
  return { accepted, rejected };
}

// ───────── 監視銘柄の合成 ─────────

export type WatchSource = "fixed" | "discovered";

export interface WatchEntry {
  mint: string;
  symbol?: string;
  source: WatchSource;
  /** 自動追加した時刻 */
  addedAt?: number;
  /** 最後に選別で合格した時刻 */
  lastSeenAt?: number;
  /** 期限 (lastSeenAt + ttlMs)。固定の銘柄には無い */
  expiresAt?: number;
}

export interface WatchlistMergeOptions {
  /** 自動追加した銘柄の期限 (最後に合格してから。既定 6 時間) */
  ttlMs?: number;
  /** 自動追加の最大件数 (既定 10。超えたら最後に合格したのが古い順に外す) */
  maxAuto?: number;
  /** 期限切れ・上限でも外さない mint (保有中の建玉など) */
  keepMints?: readonly string[];
}

export interface WatchlistMergeResult {
  entries: WatchEntry[];
  added: string[];
  refreshed: string[];
  /** 期限切れで外した */
  expired: string[];
  /** 件数の上限で外した */
  evicted: string[];
}

export const DEFAULT_WATCH_TTL_MS = 6 * 3_600_000;

/**
 * 固定の銘柄・前回の一覧・今回合格した銘柄を合わせる (純粋関数)。
 * 並びは 固定 (指定の順) → 自動追加 (最後に合格したのが新しい順)
 */
export function mergeWatchlist(
  fixed: readonly Pick<KnownToken, "mint" | "symbol">[],
  previous: readonly WatchEntry[],
  discovered: readonly Pick<JupiterToken, "mint" | "symbol">[],
  now: number,
  o: WatchlistMergeOptions = {},
): WatchlistMergeResult {
  const ttl = Math.max(0, o.ttlMs ?? DEFAULT_WATCH_TTL_MS);
  const maxAuto = Math.max(0, Math.floor(o.maxAuto ?? 10));
  const keep = new Set(o.keepMints ?? []);
  const fixedSet = new Set(fixed.map((f) => f.mint));
  const entries: WatchEntry[] = [];
  const seenFixed = new Set<string>();
  for (const f of fixed) {
    if (seenFixed.has(f.mint)) continue;
    seenFixed.add(f.mint);
    entries.push({ mint: f.mint, symbol: f.symbol, source: "fixed" });
  }

  const auto = new Map<string, WatchEntry>();
  for (const p of previous) {
    if (p.source !== "discovered" || fixedSet.has(p.mint) || auto.has(p.mint)) continue;
    auto.set(p.mint, { ...p });
  }
  const added: string[] = [];
  const refreshed: string[] = [];
  for (const d of discovered) {
    if (fixedSet.has(d.mint)) continue;
    const cur = auto.get(d.mint);
    if (cur) {
      if (cur.lastSeenAt !== now) refreshed.push(d.mint);
      cur.lastSeenAt = now;
      cur.expiresAt = now + ttl;
      if (d.symbol) cur.symbol = d.symbol;
    } else {
      auto.set(d.mint, { mint: d.mint, ...(d.symbol ? { symbol: d.symbol } : {}), source: "discovered", addedAt: now, lastSeenAt: now, expiresAt: now + ttl });
      added.push(d.mint);
    }
  }

  const expired: string[] = [];
  const alive: WatchEntry[] = [];
  for (const e of auto.values()) {
    const exp = e.expiresAt ?? (e.lastSeenAt ?? e.addedAt ?? -Infinity) + ttl;
    if (exp <= now && !keep.has(e.mint)) expired.push(e.mint);
    else alive.push({ ...e, expiresAt: exp });
  }
  alive.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  const evicted: string[] = [];
  const kept: WatchEntry[] = [];
  let count = 0;
  for (const e of alive) {
    if (keep.has(e.mint)) kept.push(e);
    else if (count < maxAuto) {
      kept.push(e);
      count++;
    } else evicted.push(e.mint);
  }
  const addedFinal = added.filter((m) => !evicted.includes(m));
  return { entries: [...entries, ...kept], added: addedFinal, refreshed, expired, evicted };
}
