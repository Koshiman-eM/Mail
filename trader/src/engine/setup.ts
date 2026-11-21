/** 設定 (VENUES / WATCHLIST) から実行に必要な部品一式を組み立てる */
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { TRADER_ASSET_CLASSES, type AppConfig } from "../appConfig";
import { ASSET_CLASSES as ALL_ASSET_CLASSES } from "../core/assetClasses";
import { createLogger, type Logger } from "../core/logger";
import { systemClock, type AssetClass, type Clock, type Instrument, type MarketDataFeed, type Store, type Timeframe, type TradingMode } from "../core/types";
import { createBrokers, LIVE_UNSUPPORTED_MESSAGE } from "../execution/router";
import { createJupiterFillPricer } from "../execution/jupiterFill";
import type { PaperSnapshot } from "../execution/paper";
import { TradeJournal } from "../learning/journal";
import { JupiterFeed, JUPITER_VENUE, type JupiterTokenSpec } from "../market/feeds/jupiter";
import { JupiterClient } from "../market/jupiter/client";
import { GeckoTerminalClient } from "../market/jupiter/gecko";
import { JupiterSwapQuoteProvider } from "../market/jupiter/quote";
import { createDefaultSources } from "../intel/defaultSources";
import { CcxtFeed } from "../market/feeds/ccxt";
import { SyntheticFeed } from "../market/feeds/synthetic";
import { createStore } from "../storage";
import { PAPER_SNAPSHOT_KEY, type PeriodicTask, type TradingEngine } from "./engine";
import { FX_RATE_REFRESH_MS, UsdJpyRateSource } from "./fxRate";
import { JupiterWatchManager, jupiterSettingsFromEnv, resolveFixedTokens, type JupiterSettings } from "./jupiterWatch";
import { ClosedCandleCacheFeed } from "./feedCache";
import { FORECAST_ASSET_CLASS_COUNT } from "../learning/forecast";
import { assembleRuntime, type AssembleOptions, type Runtime as CoreRuntime } from "./runtime";

/** hub の時間足 (コアの src/engine/runtime.ts。従来の import 先のために再輸出) */
export { hubTimeframesFor } from "./runtime";

/** WATCHLIST で使える資産クラス (このアプリが使うクラス: crypto・meme) */
const ASSET_CLASSES: readonly AssetClass[] = TRADER_ASSET_CLASSES;
/** このアプリで使わない (廃止した) 資産クラス (FX・株式)。WATCHLIST に残っていても起動を止めず、警告してその銘柄を無視する */
const REMOVED_ASSET_CLASSES: readonly string[] = ALL_ASSET_CLASSES.filter((c) => !TRADER_ASSET_CLASSES.includes(c));
export const KNOWN_VENUES = ["jupiter", "synthetic", "ccxt"] as const;
/**
 * 廃止した取引先 (GMOコイン・OANDA・Alpaca・DEX)。VENUES / WATCHLIST に残っていても起動を止めず、警告して無視する
 * (古い .env のままサーバーを再起動しても落ちないように)
 */
const REMOVED_VENUES = ["gmo", "oanda", "alpaca", "dex"] as const;
/** ccxt で WATCHLIST が空のときに探す既定銘柄 (存在するものを最大 3 つ) */
export const DEFAULT_CCXT_SYMBOLS = ["BTC/JPY", "ETH/JPY", "BTC/USDT", "ETH/USDT", "SOL/USDT", "DOGE/USDT"];
/** 合成フィードの履歴 (上位足の 4h 足 (pullback_15m・構造フィルターの MTF) が十分に揃う長さ) */
export const DEFAULT_SYNTHETIC_HISTORY_MS = 15 * 86_400_000;

export interface WatchEntry {
  /** synthetic / ccxt / ccxt:<id> (jupiter の銘柄は WATCHLIST ではなく JUPITER_TOKENS と自動探索) */
  venue: string;
  symbol: string;
  assetClass?: AssetClass;
}

/**
 * WATCHLIST ("venue|symbol|assetClass" のカンマ区切り) を解析する。
 * 廃止した資産クラス (fx / stock) の銘柄は warn に知らせて除く (起動は止めない)。それ以外の未知のクラスは書き間違いとして起動を止める
 */
export function parseWatchlist(s: string, warn?: (message: string) => void): WatchEntry[] {
  const out: WatchEntry[] = [];
  for (const raw of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [venue, symbol, cls] = raw.split("|").map((x) => x.trim());
    if (!venue || !symbol) throw new Error(`WATCHLIST の形式が不正です: "${raw}" (venue|symbol|assetClass)`);
    if (cls && REMOVED_ASSET_CLASSES.includes(cls.toLowerCase())) {
      warn?.(`WATCHLIST の "${raw}" は廃止した資産クラス (${cls}) のため無視します (使える資産クラス: ${ASSET_CLASSES.join("/")}。.env から外してください)`);
      continue;
    }
    if (cls && !ASSET_CLASSES.includes(cls as AssetClass)) throw new Error(`WATCHLIST の資産クラスが不正です: "${raw}" (${ASSET_CLASSES.join("/")})`);
    out.push({ venue: venue.toLowerCase(), symbol, ...(cls ? { assetClass: cls as AssetClass } : {}) });
  }
  return out;
}

/** 廃止した取引先 (gmo / oanda / alpaca / dex。ccxt:<id> の形も) か */
export const isRemovedVenue = (v: string) => (REMOVED_VENUES as readonly string[]).includes(v.split(":")[0]);

/**
 * VENUES を解析する (ccxt:<id> も可)。廃止した取引先 (gmo / oanda / alpaca / dex) は warn に知らせて一覧から除く (起動は止めない)。
 * それ以外の未知の値は書き間違いとして起動を止める
 */
export function parseVenues(s: string, warn?: (message: string) => void): string[] {
  const list = [...new Set(s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const removed = list.filter(isRemovedVenue);
  for (const v of list) {
    const kind = v.split(":")[0];
    if (!isRemovedVenue(v) && !(KNOWN_VENUES as readonly string[]).includes(kind)) throw new Error(`未知の VENUES: ${v} (${KNOWN_VENUES.join(", ")})`);
  }
  if (removed.length > 0) {
    warn?.(`VENUES の ${removed.join(", ")} は廃止した取引先のため無視します (使える取引先: ${KNOWN_VENUES.join(", ")}。.env から外してください)`);
  }
  return list.filter((v) => !isRemovedVenue(v));
}

/**
 * 実際に使う取引先。parseVenues の結果が空で、廃止した取引先 (gmo など) だけが書かれていたときは、
 * 古い .env のまま paper が起動できなくならないように ccxt (CCXT_EXCHANGE、既定 bitbank) の相場で動かす (warn に知らせる)
 */
export function effectiveVenues(s: string, warn?: (message: string) => void): string[] {
  const list = parseVenues(s, warn);
  if (list.length > 0) return list;
  const removed = s.split(",").map((x) => x.trim().toLowerCase()).filter(isRemovedVenue);
  if (removed.length === 0) return list;
  warn?.(`VENUES に使える取引先が無いため ccxt (CCXT_EXCHANGE) の相場で動かします (VENUES=${removed.join(",")} は廃止。.env の VENUES を ccxt にしてください)`);
  return ["ccxt"];
}

/**
 * live の発注先 (実口座アダプター) はまだ無い (GMOコインは廃止。Jupiter の実弾は次の段階で実装予定)。
 * mode が live なら常に起動を止める (fail-closed)。ccxt・synthetic は相場の取得と paper 用で、live の発注はできない
 */
export function assertLiveSupported(mode: "paper" | "live"): void {
  if (mode === "live") throw new Error(LIVE_UNSUPPORTED_MESSAGE);
}

/** 合成データ用の DB パス (<DB_PATH のベース名>-synthetic.db)。memory / :memory: はそのまま */
export function syntheticDbPath(dbPath: string): string {
  if (dbPath === "" || dbPath === "memory" || dbPath === ":memory:") return dbPath;
  const ext = extname(dbPath);
  return join(dirname(dbPath), `${basename(dbPath, ext)}-synthetic.db`);
}

/**
 * 実際に使う DB パス。VENUES が synthetic だけなら DB_PATH の代わりに syntheticDbPath を使う
 * (合成データの学習結果・追跡ポジションを実データ用の DB に混ぜない)。
 */
export function resolveDbPath(config: Pick<AppConfig, "env">): string {
  const venues = config.env.VENUES.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const syntheticOnly = venues.length > 0 && venues.every((v) => v === "synthetic");
  return syntheticOnly ? syntheticDbPath(config.env.DB_PATH) : config.env.DB_PATH;
}

/**
 * 既定の VENUES が synthetic から jupiter に変わったことの警告。VENUES を設定していない (既定を使っている) のに、
 * DB_PATH の隣に合成データ用の DB (<ベース名>-synthetic.db) があれば、以前はそちらを使っていたので知らせる
 * (自動では移さない。VENUES=synthetic にすれば以前の DB を使う)。該当しなければ undefined
 */
export function syntheticDbSwitchWarning(
  config: Pick<AppConfig, "env">,
  rawEnv: Record<string, string | undefined>,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if ((rawEnv.VENUES ?? "").trim() !== "") return undefined;
  const db = config.env.DB_PATH;
  const syn = syntheticDbPath(db);
  if (syn === db || !exists(syn)) return undefined;
  return (
    `VENUES が未設定のため既定の jupiter で動き、DB は ${db} を使います。以前の既定 (VENUES=synthetic) は ${syn} を使っていました ` +
    `(合成データの学習・建玉はそちらに残っています。自動では移しません)。以前の DB を使うなら .env.local に VENUES=synthetic を書いてください`
  );
}

export interface RuntimeOptions extends Omit<AssembleOptions, "dbPath"> {
  /** 合成フィードのシード */
  seed?: number;
  syntheticHistoryMs?: number;
  /** テスト用: ccxt の feed 生成 */
  createCcxtFeed?: (exchangeId: string) => MarketDataFeed;
  /** feed と銘柄を直接指定する (指定時は VENUES / WATCHLIST を使わない。テスト・独自 feed 用) */
  markets?: { feed: MarketDataFeed; instruments: Instrument[] }[];
  /**
   * Jupiter (VENUES=jupiter) の部品の差し替え (テスト: fetch のモック・時計・待ち)。client / gecko を渡せばそれを使う
   * (gecko: null で GeckoTerminal なし)
   */
  jupiter?: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    client?: JupiterClient;
    gecko?: GeckoTerminalClient | null;
    /** GeckoTerminal の 1 分あたりの上限の上書き (既定 GECKO_CALLS_PER_MIN) */
    geckoCallsPerMinute?: number;
    geckoBurst?: number;
  };
  /**
   * USD/JPY の日次のレート (frankfurter.app)。null で使わない (概算表)。省略時は VENUES に jupiter があるときだけ作る
   * (fetch は opts.jupiter.fetchImpl)
   */
  fxRate?: UsdJpyRateSource | null;
}

export interface Runtime extends CoreRuntime<AppConfig> {
  venues: string[];
  /** Jupiter の部品 (VENUES に jupiter があるとき) */
  jupiter?: { feed: JupiterFeed; watch: JupiterWatchManager; client: JupiterClient; gecko?: GeckoTerminalClient; settings: JupiterSettings };
  /** USD/JPY の日次のレート */
  fxRate?: UsdJpyRateSource;
}

/**
 * 値動きの予想の LIVE の判定の Bonferroni のグループ数 (予想時間 3 × FORECAST_ASSET_CLASS_COUNT 4 = 12)。
 * trader が使う資産クラスは crypto・meme の 2 つだが、保存済みの予想の LIVE の状態はこの 12 グループ (入る z ≥ 2.638) で
 * 判定してきたので固定する (6 グループに減らすと入る z ≈ 2.39 に緩む)。変えないこと
 */
const TRADER_FORECAST_LIVE_GROUPS = 3 * FORECAST_ASSET_CLASS_COUNT;

const withClass = (inst: Instrument, cls?: AssetClass): Instrument => (cls && cls !== inst.assetClass ? { ...inst, assetClass: cls } : inst);

/**
 * VENUES と WATCHLIST から feed / instrument を用意し (synthetic・ccxt・Jupiter)、コアの assembleRuntime で
 * hub / brokers / store / risk / intel / learning / engine を組み立てる
 */
export async function buildRuntime(config: AppConfig, opts: RuntimeOptions = {}): Promise<Runtime> {
  const log = opts.logger ?? createLogger("setup");
  const env = config.env;
  const clock = opts.clock ?? systemClock;
  // live の発注先はまだ無いので、live では feed・DB に触れる前に起動を止める (fail-closed)。
  // テストで偽の live ブローカー (opts.brokerSet) を渡したときだけ live の経路を組み立てる (実口座アダプターは生成しない)
  if (config.mode === "live" && !opts.brokerSet) assertLiveSupported(config.mode);
  const venues = effectiveVenues(env.VENUES, (m) => log.warn(m));
  const watch = parseWatchlist(env.WATCHLIST, (m) => log.warn(m)).filter((w) => {
    if (!isRemovedVenue(w.venue)) return true;
    log.warn("廃止した取引先の WATCHLIST の銘柄を無視します", { venue: w.venue, symbol: w.symbol });
    return false;
  });
  if (config.mode === "live" && !opts.markets && venues.includes("synthetic")) throw new Error("synthetic は paper 専用です (live では使えません)");

  // 状態 (kv) を読む部品 (Jupiter の監視銘柄の復元・USD/JPY のレートのキャッシュ) のため、store は先に開く
  const store = opts.store ?? createStore(resolveDbPath(config));
  const tradeMode = opts.brokerSet?.mode ?? config.mode;
  let engineRef: TradingEngine | undefined;
  let jupiter: Runtime["jupiter"];

  const markets: { feed: MarketDataFeed; instruments: Instrument[] }[] = [...(opts.markets ?? [])];
  const entriesFor = (pred: (v: string) => boolean) => watch.filter((w) => pred(w.venue));

  for (const v of opts.markets ? [] : venues) {
    const kind = v.split(":")[0];
    if (kind === "synthetic") {
      const feed = new ClosedCandleCacheFeed(
        new SyntheticFeed({ seed: opts.seed ?? 42, clock, historyMs: opts.syntheticHistoryMs ?? DEFAULT_SYNTHETIC_HISTORY_MS }),
        { clock },
      );
      const list = await feed.listInstruments();
      const entries = entriesFor((x) => x === "synthetic" || x === "paper");
      const insts: Instrument[] = [];
      if (entries.length === 0) insts.push(...list);
      for (const e of entries) {
        const inst = list.find((i) => i.symbol === e.symbol);
        if (inst) insts.push(withClass(inst, e.assetClass));
        else log.warn("合成フィードに無い銘柄を無視します", { symbol: e.symbol, available: list.map((i) => i.symbol) });
      }
      markets.push({ feed, instruments: insts });
    } else if (kind === "jupiter") {
      jupiter = await setupJupiter(config, opts, store, tradeMode, clock, log, () => engineRef);
      markets.push({ feed: jupiter.feed, instruments: await jupiter.feed.listInstruments() });
    } else if (kind === "ccxt") {
      const id = v.includes(":") ? v.slice(v.indexOf(":") + 1) : env.CCXT_EXCHANGE;
      try {
        const feed = opts.createCcxtFeed?.(id) ?? CcxtFeed.create(id);
        const list = await feed.listInstruments();
        const bySym = new Map(list.map((i) => [i.symbol, i]));
        const entries = entriesFor((x) => x === "ccxt" || x === `ccxt:${id}`);
        const wanted = entries.length
          ? entries
          : DEFAULT_CCXT_SYMBOLS.filter((s) => bySym.has(s)).slice(0, 3).map((symbol) => ({ venue: v, symbol }) as WatchEntry);
        const insts: Instrument[] = [];
        for (const e of wanted) {
          const inst = bySym.get(e.symbol);
          if (inst) insts.push(withClass(inst, e.assetClass));
          else log.warn("取引所に無い銘柄を無視します", { exchange: id, symbol: e.symbol });
        }
        markets.push({ feed, instruments: insts });
      } catch (e) {
        log.warn("ccxt の初期化に失敗したためスキップします", { exchange: id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // USD→JPY: 日次のレート (frankfurter.app。1 時間ごとに取り直し、kv にキャッシュ)。取れなければ概算表
  const fxRate =
    opts.fxRate === null
      ? undefined
      : (opts.fxRate ??
        (jupiter && !opts.markets
          ? new UsdJpyRateSource({
              store,
              now: () => clock.now(),
              ...(opts.jupiter?.fetchImpl ? { fetchImpl: opts.jupiter.fetchImpl } : {}),
              ...(opts.jupiter?.sleep ? { sleep: opts.jupiter.sleep } : {}),
              onWarn: (m, d) => log.warn(m, d),
            })
          : undefined));
  const periodic: PeriodicTask[] = [];
  if (fxRate) periodic.push({ name: "fx.usdjpy", everyMs: FX_RATE_REFRESH_MS, run: () => fxRate.refresh(true) });
  if (jupiter) {
    const j = jupiter;
    // 監視中の mint の流動性 (MEME_MIN_LIQUIDITY_USD の判定) を 1 時間ごとに取り直す
    periodic.push({ name: "jupiter.tokens", everyMs: 3_600_000, run: () => j.feed.refreshTokenInfo() });
    if (j.settings.discovery) periodic.push({ name: "jupiter.discovery", everyMs: j.settings.discoveryEveryMs, run: () => j.watch.run() });
  }
  const j = jupiter;
  const { markets: _m, createCcxtFeed: _c, jupiter: _j, fxRate: _f, seed: _s, syntheticHistoryMs: _h, ...assembleOpts } = opts;
  // 値動きの予想の多重検定 (Bonferroni) のグループ数は 12 に固定する (予想時間 3 × 資産クラス 4。TRADER_FORECAST_LIVE_GROUPS)
  const engineOpts = { ...(opts.engine ?? {}), forecast: { liveGroups: TRADER_FORECAST_LIVE_GROUPS, ...(opts.engine?.forecast ?? {}) } };
  const core = await assembleRuntime(
    config,
    {
      markets,
      // live の発注先: いまは無い (createBrokers の live の分岐は常に例外。Jupiter の実弾のアダプターはここに加える)
      createLiveBrokers: ({ instruments }) => createBrokers(config, instruments),
      intelSources: createDefaultSources({ env: { NEWS_RSS_FEEDS: env.NEWS_RSS_FEEDS, CRYPTOPANIC_TOKEN: env.CRYPTOPANIC_TOKEN } }),
      // Jupiter は自動探索で後から crypto・meme の銘柄が増えるので、両方の資産クラスの時間足を取る
      ...(j ? { extraTimeframeClasses: ["crypto", "meme"] as AssetClass[], onTimeframes: (tfs: Timeframe[]) => j.feed.setTimeframes(tfs) } : {}),
      ...(fxRate ? { fallbackQuote: (s: string) => fxRate.quote(s) } : {}),
      // Jupiter: 成行は見積もり (swap/v1/quote、取れなければ代わりのモデル) の実効価格で約定し、指値は使わない
      ...(j
        ? {
            paperBroker: {
              marketOnlyVenues: [JUPITER_VENUE],
              marketPricer: createJupiterFillPricer({
                provider: new JupiterSwapQuoteProvider(j.client),
                limiter: j.client.limiter,
                tokenOf: (sym) => j.feed.tokenOf(sym),
                now: () => clock.now(),
                // 古い気配 (エンジンの maxQuoteAgeMs 超) では代わりのモデルで値付けしない (決済は次のティックで再試行)
                maxQuoteAgeMs: opts.engine?.maxQuoteAgeMs ?? 30_000,
              }),
            },
            marketExtras: {
              venues: [JUPITER_VENUE],
              liquidityUsd: (sym: string) => j.feed.liquidityUsd(sym),
              entryBlock: (sym: string) => j.feed.entryBlock(sym),
              costBpsAt: (sym: string, n: number) => j.feed.costBpsAt(sym, n),
            },
            onClose: () => j.feed.stop(),
          }
        : {}),
      // Jupiter は長い履歴を持たない (GeckoTerminal の枠では 14 日分の 1m を取れない)。検証できないので学習の変更は適用しない。
      // 合成フィードはキャッシュ層 (直近 2000 本まで) を通さず内側から取る
      validationFeed: (_inst, f) => (f instanceof JupiterFeed ? undefined : f instanceof ClosedCandleCacheFeed ? f.inner : f),
      ...(periodic.length ? { periodic } : {}),
    },
    { ...assembleOpts, clock, store, engine: engineOpts },
  );
  engineRef = core.engine;
  return {
    ...core,
    venues,
    ...(jupiter ? { jupiter } : {}),
    ...(fxRate ? { fxRate } : {}),
  };
}

/**
 * Jupiter の部品を組み立てる: 読み取り専用のクライアント (JUPITER_API_KEY・JUPITER_RPS)、GeckoTerminal (GECKO_CALLS_PER_MIN)、
 * feed、固定の銘柄 (JUPITER_TOKENS) の解決、監視銘柄の復元 (kv jupiter:watch:<mode> と paper のスナップショットの建玉の銘柄)
 */
async function setupJupiter(
  config: AppConfig,
  opts: RuntimeOptions,
  store: Store,
  mode: TradingMode,
  clock: Clock,
  log: Logger,
  engine: () => TradingEngine | undefined,
): Promise<NonNullable<Runtime["jupiter"]>> {
  const settings = jupiterSettingsFromEnv(config.env);
  const j = opts.jupiter ?? {};
  const now = () => clock.now();
  const client =
    j.client ??
    new JupiterClient({
      ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
      ...(settings.ratePerSec !== undefined ? { ratePerSec: settings.ratePerSec } : {}),
      now,
      ...(j.fetchImpl ? { fetchImpl: j.fetchImpl } : {}),
      ...(j.sleep ? { sleep: j.sleep } : {}),
    });
  const gecko =
    j.gecko === null
      ? undefined
      : (j.gecko ??
        new GeckoTerminalClient({
          callsPerMinute: j.geckoCallsPerMinute ?? settings.geckoCallsPerMin,
          ...(j.geckoBurst !== undefined ? { burst: j.geckoBurst } : {}),
          now,
          ...(j.fetchImpl ? { fetchImpl: j.fetchImpl } : {}),
          ...(j.sleep ? { sleep: j.sleep } : {}),
        }));
  const feed = new JupiterFeed({
    client,
    ...(gecko ? { gecko } : {}),
    now,
    pollMs: settings.pollMs,
    quoteSizeUsd: settings.quoteSizeUsd,
    networkFeeUsd: settings.networkFeeUsd,
    minNotionalUsd: settings.minNotionalUsd,
    historyBars: 300,
    onWarn: (m, d) => log.warn(m, d),
  });
  const fixed = await resolveFixedTokens(client, settings.tokens, (m, d) => log.warn(m, d));
  // 保有中の銘柄 (外さない)。エンジンができるまでは journal から読む
  const heldSymbols = () => engine()?.heldSymbols() ?? new TradeJournal({ store, mode }).list().map((p) => p.symbol);
  const watch = new JupiterWatchManager({
    client, feed, store, mode, settings, fixed, now,
    onAdd: (inst) => void engine()?.watchInstrument(inst, feed),
    onRemove: (sym) => engine()?.unwatchInstrument(sym) ?? true,
    keepSymbols: heldSymbols,
    log,
  });
  // paper のスナップショットに残る Jupiter の建玉の銘柄定義 (mint・decimals) から、一覧に無い保有中の銘柄も戻す
  const held = new Set(heldSymbols());
  const snap = mode === "paper" ? store.kvGet<PaperSnapshot>(PAPER_SNAPSHOT_KEY) : undefined;
  const extraKeep: (JupiterTokenSpec & { instSymbol: string })[] = [];
  for (const i of snap?.instruments ?? []) {
    if (i.venue !== JUPITER_VENUE || !held.has(i.symbol)) continue;
    const mint = i.meta?.mint;
    const decimals = Number(i.meta?.decimals);
    if (typeof mint !== "string" || !Number.isInteger(decimals)) continue;
    // スナップショットの統一シンボル (i.symbol) をそのまま使う (保有中の建玉のシンボル → mint の対応を変えない)
    extraKeep.push({ mint, symbol: i.baseCurrency.split("-")[0], decimals, assetClass: i.assetClass, source: "discovered", instSymbol: i.symbol });
  }
  const insts = watch.restore(extraKeep);
  log.info("Jupiter の監視銘柄", { symbols: insts.map((i) => `${i.symbol} (${i.assetClass})`), apiKey: client.hasApiKey ? "あり" : "なし", gecko: gecko ? "あり" : "なし" });
  return { feed, watch, client, ...(gecko ? { gecko } : {}), settings };
}
