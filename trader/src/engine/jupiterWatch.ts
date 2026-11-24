/**
 * Jupiter の監視銘柄: 固定の銘柄 (JUPITER_TOKENS) の解決と、ミームコインの自動探索 (JUPITER_DISCOVERY)。
 *
 * - 固定の銘柄: mint のアドレスか symbol (既定の一覧 MAJOR_TOKENS・DEFAULT_MEME_TOKENS の symbol、それ以外は tokens/v2/search で引く)。
 *   主要銘柄 (MAJOR_TOKENS: SOL・JUP・cbBTC・WBTC・WETH・JTO・PYTH・RAY) は資産クラス crypto、それ以外は meme。decimals・流動性は tokens/v2/search から (取れなければ既定の銘柄だけ既知の decimals)。
 * - 自動探索 (JUPITER_DISCOVERY_MINUTES ごと): toptrending/1h と toporganicscore/1h → screenTokens (JUPITER_DISCOVERY_* の設定。
 *   空ならモジュールの既定値) → mergeWatchlist (期限 JUPITER_DISCOVERY_TTL_HOURS、保有中・保留中の注文のある銘柄は外さない)。
 *   追加・削除は実行中の hub・feed・PaperBroker に反映し (onAdd / onRemove)、kv `jupiter:watch:<mode>` に保存、監査ログ
 *   `jupiter.watch_add` / `jupiter.watch_remove` (外した理由と、選別に落ちていればその理由)・`jupiter.discovery` (不合格の理由の集計)。
 * - 主要銘柄の名前 (BTC・ETH・SOL・JUP・USDC・USDT・cbBTC・WBTC・WETH・JTO・PYTH・RAY。先頭の "$" を除き大文字で完全一致) を名乗る
 *   別の mint のトークンは「なりすまし」(impersonation) として自動追加しない。監視中のものは下の screen_failed で新規を止める (起動時も)。
 * - 自動追加した銘柄が後で選別に落ちたら (監査の変化・流動性の低下・なりすまし)、新規エントリーを止める (feed.setEntryBlock)。
 *   保有中の建玉は通常どおり管理・決済する。再び合格すれば止めるのをやめる。監査ログ `jupiter.watch_screen_failed` / `jupiter.watch_screen_ok`。
 * - 起動時は kv の一覧から期限内の自動追加の銘柄 (と、期限切れでも保有中の銘柄) を戻す。
 */
import { redactedErrMsg } from "../core/http";
import type { Logger } from "../core/logger";
import type { Env } from "../appConfig";
import type { AssetClass, Instrument, Store, TradingMode } from "../core/types";
import type { JupiterClient } from "../market/jupiter/client";
import {
  DEFAULT_DISCOVERY_SETTINGS, DEFAULT_MAJOR_WATCH_SYMBOLS, DEFAULT_MEME_TOKENS, DEFAULT_WATCH_TTL_MS, impersonationRejection, MAJOR_TOKENS, mergeWatchlist,
  rejectionsFor, screenTokens, USDC_MINT, type DiscoverySettings, type Rejection, type WatchEntry,
} from "../market/jupiter/discovery";
import { isSolanaAddress } from "../market/jupiter/parse";
import { effectivePricePollMs } from "../market/jupiter/price";
import { JUPITER_KEYED_RPS, JUPITER_KEYLESS_RPS } from "../market/jupiter/client";
import { fetchTokenCategory, searchTokens, type JupiterToken } from "../market/jupiter/tokens";
import type { JupiterFeed, JupiterTokenSpec } from "../market/feeds/jupiter";

export const jupiterWatchKey = (mode: TradingMode) => `jupiter:watch:${mode}`;

/** 主要銘柄 (資産クラス crypto: SOL・JUP・cbBTC・WBTC・WETH・JTO・PYTH・RAY など)。USDC はクオートなので監視しない */
const MAJOR_MINTS = new Set(MAJOR_TOKENS.filter((t) => t.mint !== USDC_MINT).map((t) => t.mint));

/** 既定の銘柄の decimals (tokens/v2/search が取れないときだけ使う。要確認: jupiter check) */
const KNOWN_DECIMALS: Readonly<Record<string, number>> = {
  So11111111111111111111111111111111111111112: 9, // SOL
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 6, // JUP
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5, // BONK
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 6, // WIF
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": 9, // POPCAT
  MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5: 5, // MEW
  // 2026-11 に足した主要銘柄 (要確認: jupiter check で mint と合わせて確かめる。通常は tokens/v2/search の値を使う)
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: 8, // cbBTC (要確認)
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": 8, // WBTC (Wormhole。要確認)
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": 8, // WETH (Wormhole。要確認)
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: 9, // JTO (要確認)
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: 6, // PYTH (要確認)
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": 6, // RAY (要確認)
};

/**
 * JUPITER_TOKENS の既定: 主要銘柄 (crypto: SOL・JUP・cbBTC・WBTC・WETH・JTO・PYTH・RAY) と既定のミームコイン (meme)。
 * src/appConfig.ts の既定と同じ値 (試験で一致を確かめる)
 */
export const DEFAULT_JUPITER_TOKENS = [...DEFAULT_MAJOR_WATCH_SYMBOLS, ...DEFAULT_MEME_TOKENS.map((t) => t.symbol)].join(",");

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
    pollMs: pick(env.JUPITER_POLL_MS, 2_500),
    geckoCallsPerMin: pick(env.GECKO_CALLS_PER_MIN, 10),
    tokens: (env.JUPITER_TOKENS ?? DEFAULT_JUPITER_TOKENS).split(",").map((x) => x.trim()).filter(Boolean),
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
  const rps = s.ratePerSec ?? (s.apiKey ? JUPITER_KEYED_RPS : JUPITER_KEYLESS_RPS);
  // 上限から決まる下限 (50 銘柄まで = 1 回の呼び出し) より短く指定していたら、実際の間隔を併記する
  const eff = effectivePricePollMs(s.pollMs, rps, 1);
  const poll = eff > s.pollMs ? `${eff / 1000} 秒ごと (指定 ${s.pollMs / 1000} 秒は上限を超えるため伸ばします。51 銘柄以上は呼び出しが増えるのでさらに伸びます)` : `${s.pollMs / 1000} 秒ごと`;
  return [
    `Jupiter: API キー ${s.apiKey ? "あり (表示しません)" : "なし"} / 上限 ${rps} 回/秒 / 価格の取得 ${poll} / GeckoTerminal ${s.geckoCallsPerMin} 回/分`,
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
  // 既定の一覧の symbol (と主要銘柄の別名: BTC → cbBTC、ETH → WETH。先に書いた方)。主要銘柄の名前は検索に回さない
  // (検索の上位がなりすましのトークンでありうるため)
  const known = new Map<string, string>();
  for (const t of [...MAJOR_TOKENS, ...DEFAULT_MEME_TOKENS]) {
    for (const name of [t.symbol, ...(t.aliases ?? [])]) if (!known.has(name.toUpperCase())) known.set(name.toUpperCase(), t.mint);
  }
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
    // 主要銘柄は既定の一覧の symbol を使う (API の表示名 (例 WETH の "ETH") に左右されずシンボルを安定させる)。それ以外は従来どおり API が先
    const major = MAJOR_TOKENS.find((k) => k.mint === mint)?.symbol;
    const symbol = major ?? t?.symbol ?? DEFAULT_MEME_TOKENS.find((k) => k.mint === mint)?.symbol;
    if (decimals === undefined || !symbol) {
      warn("decimals・symbol が分からない銘柄を外します", { mint });
      continue;
    }
    out.push({ mint, symbol, decimals, assetClass: assetClassOf(mint), ...(t?.liquidity !== undefined ? { liquidityUsd: t.liquidity } : {}), source: "fixed" });
  }
  return out;
}

/**
 * kv に保存する一覧の 1 件。WatchEntry に次を足す:
 * - decimals: 再起動で銘柄定義を作り直すため
 * - instSymbol: 使った統一シンボル (`X/USDC` か、重なったときの `X-<mint 先頭 4 文字>/USDC`)。再起動で同じシンボルを使う
 *   (保有中の建玉のシンボル → mint の対応を変えない)
 * - screenBlock: 最後の選別で落ちた (新規エントリーを止めている) なら理由の種類と文言。再起動後も止め続ける
 */
export type StoredWatchEntry = WatchEntry & { decimals?: number; instSymbol?: string; screenBlock?: { codes: string[]; reason: string } };

export interface PersistedWatch {
  updatedAt: number;
  entries: StoredWatchEntry[];
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
  private entries: StoredWatchEntry[] = [];
  private running = false;
  private lastRunAt?: number;

  constructor(private readonly d: JupiterWatchDeps) {}

  /** 固定の銘柄の mint */
  private fixedMints(): Set<string> {
    return new Set(this.d.fixed.map((f) => f.mint));
  }

  list(): StoredWatchEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  private keepMints(): string[] {
    const syms = new Set(this.d.keepSymbols());
    return this.d.feed.mints().filter((m) => {
      const inst = this.d.feed.instrumentOf(m);
      return inst !== undefined && syms.has(inst.symbol);
    });
  }

  private persist(now: number, extra: readonly StoredWatchEntry[] = []): void {
    const v: PersistedWatch = { updatedAt: now, entries: [...this.entries, ...extra] };
    this.d.store.kvSet(jupiterWatchKey(this.d.mode), v);
  }

  /**
   * 起動時: 固定の銘柄と、kv の一覧のうち期限内 (または保有中) の自動追加の銘柄を加える。
   * - 保有中の銘柄を最初に、前回と同じ統一シンボル (instSymbol。paper のスナップショットの銘柄定義の symbol も) で加える。
   *   シンボルが重なる銘柄 (同じ symbol の別の mint) があっても、保有中の建玉のシンボル → mint の対応は再起動で変わらない。
   * - 次に固定の銘柄、最後に期限内の自動追加の銘柄 (どちらも前回のシンボルが空いていればそれ)。
   * - 最後の選別で落ちていた銘柄 (screenBlock) は新規エントリーを止めたまま戻す。
   * extraKeep は保有中だが一覧に無い銘柄 (paper のスナップショットの銘柄定義から mint・decimals・symbol が分かったもの)
   */
  restore(extraKeep: readonly (JupiterTokenSpec & { instSymbol: string })[] = []): Instrument[] {
    const now = this.d.now();
    const { feed } = this.d;
    const out: Instrument[] = [];
    const saved = this.d.store.kvGet<PersistedWatch>(jupiterWatchKey(this.d.mode))?.entries ?? [];
    const savedBy = new Map(saved.map((e) => [e.mint, e]));
    const keepSyms = new Set(this.d.keepSymbols());
    const fixedBy = new Map(this.d.fixed.map((f) => [f.mint, f]));
    const specOf = (e: StoredWatchEntry): JupiterTokenSpec | undefined =>
      fixedBy.get(e.mint) ??
      (typeof e.decimals === "number" && e.symbol ? { mint: e.mint, symbol: e.symbol, decimals: e.decimals, assetClass: "meme", source: "discovered" } : undefined);
    const added = new Set<string>();
    const add = (spec: JupiterTokenSpec, forced: string | undefined) => {
      if (added.has(spec.mint)) return;
      added.add(spec.mint);
      out.push(feed.addToken(spec, forced));
    };
    // 1. 保有中の銘柄 (前回のシンボルのまま)
    for (const e of saved) {
      const spec = specOf(e);
      if (spec && e.instSymbol && keepSyms.has(e.instSymbol)) add(spec, e.instSymbol);
    }
    for (const k of extraKeep) if (keepSyms.has(k.instSymbol)) add(fixedBy.get(k.mint) ?? k, k.instSymbol);
    // 2. 固定の銘柄
    for (const f of this.d.fixed) add(f, savedBy.get(f.mint)?.instSymbol);
    // 3. 期限内の自動追加の銘柄
    const restored: StoredWatchEntry[] = [];
    for (const e of saved) {
      if (e.source !== "discovered" || fixedBy.has(e.mint)) continue;
      const spec = specOf(e);
      if (!spec) continue;
      if (!added.has(e.mint) && !((e.expiresAt ?? 0) > now)) continue;
      add(spec, e.instSymbol);
      restored.push({ ...e });
    }
    for (const k of extraKeep) {
      if (fixedBy.has(k.mint) || restored.some((e) => e.mint === k.mint) || !added.has(k.mint)) continue;
      restored.push({ mint: k.mint, symbol: k.symbol, source: "discovered", decimals: k.decimals, lastSeenAt: now, addedAt: now, expiresAt: now });
    }
    for (const e of restored) {
      // 主要銘柄の名前を名乗る別のトークン (なりすまし) は、前回の選別の結果によらず新規エントリーを止める (建玉は管理を続ける)
      const imp = impersonationRejection(e.mint, e.symbol);
      if (imp && !e.screenBlock?.codes.includes("impersonation")) {
        const codes = [...new Set([...(e.screenBlock?.codes ?? []), "impersonation"])].sort();
        e.screenBlock = { codes, reason: `選別に落ちたため新規エントリーしません: ${imp.label}` };
        this.d.store.audit({ ts: now, type: "jupiter.watch_screen_failed", data: { mint: e.mint, symbol: e.instSymbol ?? e.symbol, codes, reasons: [imp.label] } });
      }
      if (e.screenBlock) feed.setEntryBlock(e.mint, e.screenBlock.reason);
    }
    this.entries = [
      ...this.d.fixed.map((f): StoredWatchEntry => ({ mint: f.mint, symbol: f.symbol, source: "fixed", decimals: f.decimals })),
      ...restored,
    ].map((e) => this.withSymbol(e));
    // 使ったシンボルを保存する。戻さなかった (期限切れの) 前回の銘柄も kv には残す (次の探索で期限切れとして外れる)
    const kept = new Set(this.entries.map((e) => e.mint));
    this.persist(now, saved.filter((e) => e.source === "discovered" && !kept.has(e.mint)));
    return out;
  }

  /** 使っている統一シンボルを記録する */
  private withSymbol(e: StoredWatchEntry): StoredWatchEntry {
    const sym = this.d.feed.instrumentOf(e.mint)?.symbol ?? e.instSymbol;
    return sym ? { ...e, instSymbol: sym } : { ...e };
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

    // 監視中の自動追加の銘柄を最新の情報で選別し直す (落ちたら新規エントリーを止める。建玉の管理は続ける)。
    // 止めた理由は kv に保存し (再起動後も止める)、トークン情報が無いときは前回の判定のまま止め続ける (fail-closed)。
    // 監査ログは理由の種類 (code) の組が変わったときだけ (値の変化では書かない)
    const screenFailed: string[] = [];
    for (const e of this.entries) {
      if (e.source !== "discovered") continue;
      const inst = feed.instrumentOf(e.mint);
      const tok = infoBy.get(e.mint) ?? feed.tokenInfo(e.mint);
      // 主要銘柄の名前を名乗る別のトークン (なりすまし) は、トークン情報が無くても保存した symbol で判定する
      const imp = tok ? undefined : impersonationRejection(e.mint, e.symbol);
      if (!tok && !imp) {
        if (e.screenBlock) {
          feed.setEntryBlock(e.mint, e.screenBlock.reason);
          if (inst) screenFailed.push(inst.symbol);
        }
        continue;
      }
      const reasons = tok ? rejectionsFor(tok, screen, now).filter((r) => r.code !== "excluded") : [imp!];
      // 保存した symbol (自動追加した時の名前) でもなりすましを見る (トークン情報の symbol が後で変わっても止める)
      const savedImp = tok ? impersonationRejection(e.mint, e.symbol) : undefined;
      if (savedImp && !reasons.some((r) => r.code === "impersonation")) reasons.push(savedImp);
      const symbol = inst?.symbol ?? e.instSymbol ?? e.symbol ?? e.mint;
      if (reasons.length > 0) {
        const codes = [...new Set(reasons.map((r) => r.code as string))].sort();
        const msg = `選別に落ちたため新規エントリーしません: ${reasonsText(reasons).join(" / ")}`;
        const changed = e.screenBlock?.codes.join(",") !== codes.join(",");
        e.screenBlock = { codes, reason: msg };
        feed.setEntryBlock(e.mint, msg);
        screenFailed.push(symbol);
        if (changed) this.d.store.audit({ ts: now, type: "jupiter.watch_screen_failed", data: { mint: e.mint, symbol, codes, reasons: reasonsText(reasons) } });
      } else if (e.screenBlock) {
        delete e.screenBlock;
        feed.setEntryBlock(e.mint, undefined);
        this.d.store.audit({ ts: now, type: "jupiter.watch_screen_ok", data: { mint: e.mint, symbol } });
      }
    }

    const prev = this.entries.filter((e) => e.source === "discovered");
    const merged = mergeWatchlist(this.d.fixed, prev, sr.accepted, now, { ttlMs: settings.ttlMs, maxAuto: settings.maxAuto, keepMints: this.keepMints() });
    const decimalsOf = new Map(prev.map((e) => [e.mint, e.decimals]));
    for (const t of sr.accepted) if (t.decimals !== undefined) decimalsOf.set(t.mint, t.decimals);
    for (const f of this.d.fixed) decimalsOf.set(f.mint, f.decimals);

    const added: string[] = [];
    const removed: string[] = [];
    const next: StoredWatchEntry[] = [];
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
      next.push(this.withSymbol({ ...e, ...(decimals !== undefined ? { decimals } : {}) }));
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
