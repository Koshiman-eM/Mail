/**
 * Jupiter の監視銘柄: 固定の銘柄 (JUPITER_TOKENS) の解決と、ミームコインの自動探索 (JUPITER_DISCOVERY)。
 *
 * - 固定の銘柄: mint のアドレスか symbol (既定の一覧 MAJOR_TOKENS・DEFAULT_MEME_TOKENS の symbol、それ以外は tokens/v2/search で引く)。
 *   SOL・JUP (主要銘柄) は資産クラス crypto、それ以外は meme。decimals・流動性は tokens/v2/search から (取れなければ既定の銘柄だけ既知の decimals)。
 * - 自動探索 (JUPITER_DISCOVERY_MINUTES ごと): toptrending/1h と toporganicscore/1h → screenTokens (JUPITER_DISCOVERY_* の設定。
 *   空ならモジュールの既定値) → mergeWatchlist (期限 JUPITER_DISCOVERY_TTL_HOURS、保有中・保留中の注文のある銘柄は外さない)。
 *   追加・削除は実行中の hub・feed・PaperBroker に反映し (onAdd / onRemove)、kv `jupiter:watch:<mode>` に保存、監査ログ
 *   `jupiter.watch_add` / `jupiter.watch_remove` (外した理由と、選別に落ちていればその理由)・`jupiter.discovery` (不合格の理由の集計)。
 * - 自動追加した銘柄が後で選別に落ちたら (監査の変化・流動性の低下など)、新規エントリーを止める (feed.setEntryBlock)。
 *   保有中の建玉は通常どおり管理・決済する。再び合格すれば止めるのをやめる。監査ログ `jupiter.watch_screen_failed` / `jupiter.watch_screen_ok`。
 * - 起動時は kv の一覧から期限内の自動追加の銘柄 (と、期限切れでも保有中の銘柄) を戻す。
 */
import { redactedErrMsg } from "../core/http";
import type { Logger } from "../core/logger";
import type { Env } from "../core/config";
import type { AssetClass, Instrument, Store, TradingMode } from "../core/types";
import type { JupiterClient } from "../market/jupiter/client";
import {
  DEFAULT_DISCOVERY_SETTINGS, DEFAULT_MEME_TOKENS, DEFAULT_WATCH_TTL_MS, MAJOR_TOKENS, mergeWatchlist, rejectionsFor, screenTokens, USDC_MINT,
  type DiscoverySettings, type Rejection, type WatchEntry,
} from "../market/jupiter/discovery";
import { isSolanaAddress } from "../market/jupiter/parse";
import { fetchTokenCategory, searchTokens, type JupiterToken } from "../market/jupiter/tokens";
import type { JupiterFeed, JupiterTokenSpec } from "../market/feeds/jupiter";

export const jupiterWatchKey = (mode: TradingMode) => `jupiter:watch:${mode}`;

/** 主要銘柄 (資産クラス crypto)。USDC はクオートなので監視しない */
const MAJOR_MINTS = new Set(MAJOR_TOKENS.filter((t) => t.mint !== USDC_MINT).map((t) => t.mint));

/** 既定の銘柄の decimals (tokens/v2/search が取れないときだけ使う。要確認: jupiter check) */
const KNOWN_DECIMALS: Readonly<Record<string, number>> = {
  So11111111111111111111111111111111111111112: 9, // SOL
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 6, // JUP
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5, // BONK
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 6, // WIF
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": 9, // POPCAT
  MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5: 5, // MEW
};

export interface JupiterSettings {
  apiKey?: string;
  ratePerSec?: number;
  pollMs: number;
  geckoCallsPerMin: number;
  tokens: string[];
  discovery: boolean;
  discoveryEveryMs: number;
  ttlMs: number;
  maxAuto: number;
  screen: DiscoverySettings;
  networkFeeUsd: number;
  quoteSizeUsd: number;
  minNotionalUsd: number;
}

type JupiterEnv = Pick<
  Env,
  | "JUPITER_API_KEY" | "JUPITER_RPS" | "JUPITER_POLL_MS" | "GECKO_CALLS_PER_MIN" | "JUPITER_TOKENS" | "JUPITER_DISCOVERY" | "JUPITER_DISCOVERY_MINUTES"
  | "JUPITER_DISCOVERY_TTL_HOURS" | "JUPITER_DISCOVERY_MAX_TOKENS" | "JUPITER_DISCOVERY_MIN_LIQUIDITY_USD" | "JUPITER_DISCOVERY_MIN_HOLDERS"
  | "JUPITER_DISCOVERY_MIN_AGE_DAYS" | "JUPITER_DISCOVERY_MIN_ORGANIC_SCORE" | "JUPITER_DISCOVERY_MAX_TOP_HOLDERS_PCT" | "JUPITER_DISCOVERY_VERIFIED_ONLY"
  | "JUPITER_NETWORK_FEE_USD" | "JUPITER_QUOTE_SIZE_USD" | "JUPITER_MIN_NOTIONAL_USD"
>;

/** 環境変数から (未設定の選別の条件はモジュールの既定値 DEFAULT_DISCOVERY_SETTINGS) */
export function jupiterSettingsFromEnv(env: Partial<JupiterEnv>): JupiterSettings {
  const d = DEFAULT_DISCOVERY_SETTINGS;
  const pick = (v: number | undefined, def: number) => (v !== undefined && Number.isFinite(v) ? v : def);
  const key = env.JUPITER_API_KEY?.trim();
  return {
    ...(key ? { apiKey: key } : {}),
    ...(env.JUPITER_RPS !== undefined ? { ratePerSec: env.JUPITER_RPS } : {}),
    pollMs: pick(env.JUPITER_POLL_MS, 5_000),
    geckoCallsPerMin: pick(env.GECKO_CALLS_PER_MIN, 10),
    tokens: (env.JUPITER_TOKENS ?? "SOL,JUP,BONK,WIF,POPCAT,MEW").split(",").map((x) => x.trim()).filter(Boolean),
    discovery: env.JUPITER_DISCOVERY ?? true,
    discoveryEveryMs: pick(env.JUPITER_DISCOVERY_MINUTES, 20) * 60_000,
    ttlMs: env.JUPITER_DISCOVERY_TTL_HOURS !== undefined ? env.JUPITER_DISCOVERY_TTL_HOURS * 3_600_000 : DEFAULT_WATCH_TTL_MS,
    maxAuto: pick(env.JUPITER_DISCOVERY_MAX_TOKENS, d.maxTokens),
    screen: {
      ...d,
      minLiquidityUsd: pick(env.JUPITER_DISCOVERY_MIN_LIQUIDITY_USD, d.minLiquidityUsd),
      minHolderCount: pick(env.JUPITER_DISCOVERY_MIN_HOLDERS, d.minHolderCount),
      minAgeMs: env.JUPITER_DISCOVERY_MIN_AGE_DAYS !== undefined ? env.JUPITER_DISCOVERY_MIN_AGE_DAYS * 86_400_000 : d.minAgeMs,
      minOrganicScore: pick(env.JUPITER_DISCOVERY_MIN_ORGANIC_SCORE, d.minOrganicScore),
      maxTopHoldersPct: pick(env.JUPITER_DISCOVERY_MAX_TOP_HOLDERS_PCT, d.maxTopHoldersPct),
      verifiedOnly: env.JUPITER_DISCOVERY_VERIFIED_ONLY ?? d.verifiedOnly,
      maxTokens: pick(env.JUPITER_DISCOVERY_MAX_TOKENS, d.maxTokens),
    },
    networkFeeUsd: pick(env.JUPITER_NETWORK_FEE_USD, 0.02),
    quoteSizeUsd: pick(env.JUPITER_QUOTE_SIZE_USD, 50),
    minNotionalUsd: pick(env.JUPITER_MIN_NOTIONAL_USD, 5),
  };
}

/** status 用の設定の表示 (キーは有無だけ) */
export function formatJupiterSettings(s: JupiterSettings): string[] {
  const sc = s.screen;
  return [
    `Jupiter: API キー ${s.apiKey ? "あり (表示しません)" : "なし"} / 上限 ${s.ratePerSec ?? (s.apiKey ? 1 : 0.5)} 回/秒 / 価格の取得 ${s.pollMs / 1000} 秒ごと / GeckoTerminal ${s.geckoCallsPerMin} 回/分`,
    `  固定の銘柄 (JUPITER_TOKENS): ${s.tokens.join(", ") || "(なし)"}`,
    `  自動探索 (JUPITER_DISCOVERY): ${s.discovery ? `有効 (${s.discoveryEveryMs / 60_000} 分ごと、期限 ${s.ttlMs / 3_600_000} 時間、最大 ${s.maxAuto} 件)` : "無効"}`,
    `  選別: 流動性 ≥ $${sc.minLiquidityUsd} / 保有者 ≥ ${sc.minHolderCount} / 上場 ≥ ${sc.minAgeMs / 86_400_000} 日 / organicScore ≥ ${sc.minOrganicScore} / 上位保有者 ≤ ${sc.maxTopHoldersPct}% / 検証済みだけ ${sc.verifiedOnly ? "はい" : "いいえ"}`,
    `  コスト: ネットワーク手数料 $${s.networkFeeUsd}/回 / 気配・見積もりの代金 $${s.quoteSizeUsd} / 最小の約定代金 $${s.minNotionalUsd} / 指値なし (成行のスワップだけ・空売りなし)`,
  ];
}

const assetClassOf = (mint: string): AssetClass => (MAJOR_MINTS.has(mint) ? "crypto" : "meme");

/**
 * JUPITER_TOKENS を mint の一覧に解決する (symbol は既定の一覧 → tokens/v2/search。見つからなければ警告して外す)。
 * decimals・流動性も tokens/v2/search から (失敗したら既定の銘柄だけ KNOWN_DECIMALS)
 */
export async function resolveFixedTokens(client: JupiterClient, items: readonly string[], warn: (m: string, d?: Record<string, unknown>) => void): Promise<JupiterTokenSpec[]> {
  const known = new Map([...MAJOR_TOKENS, ...DEFAULT_MEME_TOKENS].map((t) => [t.symbol.toUpperCase(), t.mint]));
  const mints: string[] = [];
  const unknownSymbols: string[] = [];
  for (const raw of items) {
    if (isSolanaAddress(raw)) mints.push(raw);
    else if (known.has(raw.toUpperCase())) mints.push(known.get(raw.toUpperCase())!);
    else unknownSymbols.push(raw);
  }
  const info = new Map<string, JupiterToken>();
  if (unknownSymbols.length > 0) {
    try {
      const r = await searchTokens(client, unknownSymbols);
      for (const sym of unknownSymbols) {
        // 同じ symbol が複数あれば検証済み → 流動性の大きい順
        const cands = r.tokens.filter((t) => t.symbol?.toUpperCase() === sym.toUpperCase());
        cands.sort((a, b) => Number(b.isVerified === true) - Number(a.isVerified === true) || (b.liquidity ?? 0) - (a.liquidity ?? 0));
        if (cands[0]) {
          mints.push(cands[0].mint);
          info.set(cands[0].mint, cands[0]);
        } else warn("JUPITER_TOKENS の symbol が見つからないため外します", { symbol: sym });
      }
    } catch (e) {
      warn("JUPITER_TOKENS の symbol を検索できません (その銘柄は外します)", { symbols: unknownSymbols, error: redactedErrMsg(e) });
    }
  }
  const uniq = [...new Set(mints)].filter((m) => m !== USDC_MINT);
  const missing = uniq.filter((m) => !info.has(m));
  if (missing.length > 0) {
    try {
      for (const t of (await searchTokens(client, missing)).tokens) info.set(t.mint, t);
    } catch (e) {
      warn("トークン情報 (tokens/v2/search) を取得できません。既定の銘柄は既知の decimals で続けます", { error: redactedErrMsg(e) });
    }
  }
  const out: JupiterTokenSpec[] = [];
  for (const mint of uniq) {
    const t = info.get(mint);
    const decimals = t?.decimals ?? KNOWN_DECIMALS[mint];
    const symbol = t?.symbol ?? [...MAJOR_TOKENS, ...DEFAULT_MEME_TOKENS].find((k) => k.mint === mint)?.symbol;
    if (decimals === undefined || !symbol) {
      warn("decimals・symbol が分からない銘柄を外します", { mint });
      continue;
    }
    out.push({ mint, symbol, decimals, assetClass: assetClassOf(mint), ...(t?.liquidity !== undefined ? { liquidityUsd: t.liquidity } : {}), source: "fixed" });
  }
  return out;
}

/** kv に保存する一覧 (WatchEntry に decimals を足す) */
export interface PersistedWatch {
  updatedAt: number;
  entries: (WatchEntry & { decimals?: number })[];
}

export interface JupiterWatchDeps {
  client: JupiterClient;
  feed: JupiterFeed;
  store: Pick<Store, "kvGet" | "kvSet" | "audit">;
  mode: TradingMode;
  settings: Pick<JupiterSettings, "discovery" | "ttlMs" | "maxAuto" | "screen">;
  fixed: readonly JupiterTokenSpec[];
  now: () => number;
  /** hub・PaperBroker に加える */
  onAdd: (inst: Instrument) => void;
  /** hub から外す。建玉・保留中の注文があって外せなければ false */
  onRemove: (symbol: string) => boolean;
  /** 外さない銘柄 (保有中・保留中の注文) のシンボル */
  keepSymbols: () => string[];
  log?: Pick<Logger, "warn" | "info">;
}

export interface DiscoveryResult {
  added: string[];
  removed: string[];
  rejected: number;
  screenFailed: string[];
  error?: string;
}

const reasonsText = (r: readonly Rejection[]) => r.map((x) => x.label);

export class JupiterWatchManager {
  private entries: (WatchEntry & { decimals?: number })[] = [];
  private running = false;
  private lastRunAt?: number;

  constructor(private readonly d: JupiterWatchDeps) {}

  /** 固定の銘柄の mint */
  private fixedMints(): Set<string> {
    return new Set(this.d.fixed.map((f) => f.mint));
  }

  list(): (WatchEntry & { decimals?: number })[] {
    return this.entries.map((e) => ({ ...e }));
  }

  private keepMints(): string[] {
    const syms = new Set(this.d.keepSymbols());
    return this.d.feed.mints().filter((m) => {
      const inst = this.d.feed.instrumentOf(m);
      return inst !== undefined && syms.has(inst.symbol);
    });
  }

  private persist(now: number): void {
    const v: PersistedWatch = { updatedAt: now, entries: this.entries };
    this.d.store.kvSet(jupiterWatchKey(this.d.mode), v);
  }

  /**
   * 起動時: 固定の銘柄と、kv の一覧のうち期限内 (または保有中の銘柄 keepMints) の自動追加の銘柄を加える。
   * extraKeep は保有中だが一覧に無い銘柄 (paper のスナップショットの銘柄定義から mint・decimals が分かったもの)
   */
  restore(extraKeep: readonly (JupiterTokenSpec & { symbol: string })[] = []): Instrument[] {
    const now = this.d.now();
    const out: Instrument[] = [];
    for (const f of this.d.fixed) out.push(this.d.feed.addToken(f));
    const saved = this.d.store.kvGet<PersistedWatch>(jupiterWatchKey(this.d.mode));
    const keepSyms = new Set(this.d.keepSymbols());
    const fixed = this.fixedMints();
    const restored: (WatchEntry & { decimals?: number })[] = [];
    for (const e of saved?.entries ?? []) {
      if (e.source !== "discovered" || fixed.has(e.mint) || typeof e.decimals !== "number" || !e.symbol) continue;
      const alive = (e.expiresAt ?? 0) > now;
      const sym = `${e.symbol.toUpperCase()}/USDC`;
      if (!alive && !keepSyms.has(sym) && !extraKeep.some((k) => k.mint === e.mint)) continue;
      out.push(this.d.feed.addToken({ mint: e.mint, symbol: e.symbol, decimals: e.decimals, assetClass: "meme", source: "discovered" }));
      restored.push(e);
    }
    for (const k of extraKeep) {
      if (fixed.has(k.mint) || restored.some((e) => e.mint === k.mint)) continue;
      out.push(this.d.feed.addToken(k));
      restored.push({ mint: k.mint, symbol: k.symbol, source: "discovered", decimals: k.decimals, lastSeenAt: now, addedAt: now, expiresAt: now });
    }
    this.entries = [...this.d.fixed.map((f): WatchEntry & { decimals?: number } => ({ mint: f.mint, symbol: f.symbol, source: "fixed", decimals: f.decimals })), ...restored];
    return out;
  }

  /** 前回から everyMs 以上経っていれば (force なら常に) 探索する */
  async maybeRun(everyMs: number, force = false): Promise<DiscoveryResult | undefined> {
    const now = this.d.now();
    if (!force && this.lastRunAt !== undefined && now - this.lastRunAt < everyMs) return undefined;
    return this.run();
  }

  /** 探索して監視銘柄を更新する。失敗しても例外にしない (監査ログ jupiter.discovery_error) */
  async run(): Promise<DiscoveryResult | undefined> {
    if (this.running) return undefined;
    this.running = true;
    const now = this.d.now();
    this.lastRunAt = now;
    try {
      return await this.runInner(now);
    } catch (e) {
      const error = redactedErrMsg(e);
      this.d.log?.warn("Jupiter の自動探索に失敗 (監視銘柄はそのまま)", { error });
      this.d.store.audit({ ts: now, type: "jupiter.discovery_error", data: { error } });
      return { added: [], removed: [], rejected: 0, screenFailed: [], error };
    } finally {
      this.running = false;
    }
  }

  private async runInner(now: number): Promise<DiscoveryResult> {
    const { feed, settings } = this.d;
    const candidates: JupiterToken[] = [];
    if (settings.discovery) {
      const seen = new Set<string>();
      let lastErr: unknown;
      let ok = 0;
      for (const cat of ["toptrending", "toporganicscore"] as const) {
        try {
          for (const t of (await fetchTokenCategory(this.d.client, cat, "1h", 50)).tokens) {
            if (!seen.has(t.mint)) {
              seen.add(t.mint);
              candidates.push(t);
            }
          }
          ok++;
        } catch (e) {
          lastErr = e;
        }
      }
      if (ok === 0 && lastErr) throw lastErr;
    }
    const screen = { ...settings.screen, excludeMints: [...new Set([...settings.screen.excludeMints, ...this.fixedMints()])] };
    const sr = screenTokens(candidates, screen, now);
    const rejectedBy = new Map(sr.rejected.map((r) => [r.token.mint, r.reasons]));
    const infoBy = new Map(candidates.map((t) => [t.mint, t]));

    // 監視中の自動追加の銘柄を最新の情報で選別し直す (落ちたら新規エントリーを止める。建玉の管理は続ける)
    const screenFailed: string[] = [];
    for (const e of this.entries) {
      if (e.source !== "discovered") continue;
      const tok = infoBy.get(e.mint) ?? feed.tokenInfo(e.mint);
      const inst = feed.instrumentOf(e.mint);
      if (!tok || !inst) continue;
      const reasons = rejectionsFor(tok, screen, now).filter((r) => r.code !== "excluded");
      const was = feed.entryBlock(inst.symbol);
      if (reasons.length > 0) {
        const msg = `選別に落ちたため新規エントリーしません: ${reasonsText(reasons).join(" / ")}`;
        feed.setEntryBlock(e.mint, msg);
        screenFailed.push(inst.symbol);
        if (was !== msg) this.d.store.audit({ ts: now, type: "jupiter.watch_screen_failed", data: { mint: e.mint, symbol: inst.symbol, reasons: reasonsText(reasons) } });
      } else if (was) {
        feed.setEntryBlock(e.mint, undefined);
        this.d.store.audit({ ts: now, type: "jupiter.watch_screen_ok", data: { mint: e.mint, symbol: inst.symbol } });
      }
    }

    const prev = this.entries.filter((e) => e.source === "discovered");
    const merged = mergeWatchlist(this.d.fixed, prev, sr.accepted, now, { ttlMs: settings.ttlMs, maxAuto: settings.maxAuto, keepMints: this.keepMints() });
    const decimalsOf = new Map(prev.map((e) => [e.mint, e.decimals]));
    for (const t of sr.accepted) if (t.decimals !== undefined) decimalsOf.set(t.mint, t.decimals);
    for (const f of this.d.fixed) decimalsOf.set(f.mint, f.decimals);

    const added: string[] = [];
    const removed: string[] = [];
    const next: (WatchEntry & { decimals?: number })[] = [];
    for (const e of merged.entries) {
      const decimals = decimalsOf.get(e.mint);
      if (e.source === "discovered" && merged.added.includes(e.mint)) {
        const tok = infoBy.get(e.mint);
        if (decimals === undefined || !e.symbol) {
          this.d.log?.warn("decimals・symbol が分からないため自動追加しません", { mint: e.mint });
          continue;
        }
        const inst = feed.addToken({
          mint: e.mint, symbol: e.symbol, decimals, assetClass: "meme", source: "discovered",
          ...(tok?.liquidity !== undefined ? { liquidityUsd: tok.liquidity } : {}),
        });
        if (tok) feed.applyTokenInfo([tok]);
        this.d.onAdd(inst);
        added.push(inst.symbol);
        this.d.store.audit({
          ts: now,
          type: "jupiter.watch_add",
          data: {
            mint: e.mint, symbol: inst.symbol, expiresAt: e.expiresAt,
            ...(tok ? { liquidityUsd: tok.liquidity, holderCount: tok.holderCount, organicScore: tok.organicScore, topHoldersPct: tok.audit.topHoldersPercentage } : {}),
          },
        });
      } else if (e.source === "discovered") {
        // 監視中の銘柄の最新のトークン情報 (流動性) を入れる
        const tok = infoBy.get(e.mint);
        if (tok) feed.applyTokenInfo([tok]);
      }
      next.push({ ...e, ...(decimals !== undefined ? { decimals } : {}) });
    }
    for (const mint of [...merged.expired, ...merged.evicted]) {
      const inst = feed.instrumentOf(mint);
      const why = merged.expired.includes(mint) ? "expired" : "evicted";
      const reasons = rejectedBy.get(mint);
      if (inst && !this.d.onRemove(inst.symbol)) {
        // 建玉・保留中の注文がある: 外さずに残す (次回また判定する)
        const old = prev.find((p) => p.mint === mint);
        if (old) next.push(old);
        continue;
      }
      if (inst) feed.removeToken(mint);
      removed.push(inst?.symbol ?? mint);
      this.d.store.audit({
        ts: now,
        type: "jupiter.watch_remove",
        data: {
          mint, symbol: inst?.symbol, reason: why,
          detail: why === "expired" ? "期限まで選別に再合格しなかった" : "自動追加の件数の上限",
          ...(reasons ? { rejections: reasonsText(reasons) } : { rejections: ["上位の一覧 (toptrending / toporganicscore 1h) に無い"] }),
        },
      });
    }
    this.entries = next;
    this.persist(now);
    // 不合格の理由の集計 (多い順。監査ログ)
    const byCode: Record<string, number> = {};
    for (const r of sr.rejected) for (const x of r.reasons) byCode[x.code] = (byCode[x.code] ?? 0) + 1;
    this.d.store.audit({
      ts: now,
      type: "jupiter.discovery",
      data: {
        candidates: candidates.length, accepted: sr.accepted.map((t) => t.symbol ?? t.mint), added, removed, rejectedByCode: byCode,
        rejected: sr.rejected.slice(0, 20).map((r) => ({ symbol: r.token.symbol ?? r.token.mint, reasons: reasonsText(r.reasons) })),
        screenFailed,
      },
    });
    if (added.length || removed.length) this.d.log?.info("Jupiter の監視銘柄を更新しました", { added, removed });
    return { added, removed, rejected: sr.rejected.length, screenFailed };
  }
}
