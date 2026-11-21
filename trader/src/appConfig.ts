/**
 * trader (暗号資産のボット) の設定: コアの設定 (src/core/config.ts の defineAppConfig) に、このアプリの環境変数
 * (取引先 VENUES・監視銘柄 WATCHLIST・ccxt・Jupiter・GeckoTerminal・CryptoPanic) を足す。
 * 使う資産クラスは crypto・meme。実弾の二重ロック・リスク上限などのコアの環境変数はここで定義しない (再定義すると例外)。
 */
import { defineAppConfig, envHelpers, type AppConfig as CoreAppConfig, type CoreEnv } from "./core/config";

export * from "./core/config";

const { bool, checkedNum, optRanged, ranged, str } = envHelpers;

const TRADER_SHAPE = {
  /**
   * 使う取引先 (カンマ区切り): jupiter (既定。Solana の DEX アグリゲーター)、synthetic、ccxt。いずれも相場の取得と paper 用
   * (live の発注先は未対応。TRADING_MODE=live では起動しない)。ccxt・synthetic は paper・バックテスト用に残す。
   * 廃止した gmo / oanda / alpaca / dex は起動時に警告して無視する (src/engine/setup.ts の parseVenues)
   */
  VENUES: str("jupiter"),
  /** 監視銘柄 (カンマ区切り、"venue|symbol|assetClass")。空なら既定のデモ銘柄 */
  WATCHLIST: str(),
  // 暗号資産取引所 (ccxt。相場の取得と paper 用で、発注はしない)
  CCXT_EXCHANGE: str("bitbank"),
  // Jupiter (Solana。src/market/jupiter/・src/market/feeds/jupiter.ts。相場の取得と paper 用で、スワップは実行しない)
  /** API キー (任意)。あればキーありの既定の上限 (1 回/秒) で呼ぶ。表示・ログには出さない */
  JUPITER_API_KEY: str(),
  /** 1 秒あたりの呼び出しの上限 (空 = キーなし 0.5 / キーあり 1)。プランに合わせて変える */
  JUPITER_RPS: optRanged("JUPITER_RPS", 0.05, 50),
  /**
   * 価格 (Price V3) の取得間隔 (ミリ秒、1000〜15000、既定 2500)。監視中の全 mint を 50 件ずつ一括で取る。
   * API の上限 (JUPITER_RPS。キーなし 0.5 回/秒) の 80% を超える間隔は自動で伸ばす (キーなしの 1 回なら 2500 が下限)。
   * 上限はエンジンの気配の古さの上限 (30 秒) の半分 (それより長いと取得の合間に気配が古くなり、新規エントリーが止まる)
   */
  JUPITER_POLL_MS: checkedNum(
    "JUPITER_POLL_MS", 2_500, (x) => Number.isInteger(x) && x >= 1_000 && x <= 15_000,
    "1000 以上 15000 以下のミリ秒の整数で指定してください (気配の古さの上限 30 秒の半分以下。それより長いと取得の合間に気配が古くなり新規エントリーが止まります)",
  ),
  /** GeckoTerminal (過去の足・出来高) の 1 分あたりの呼び出しの上限 (1〜30、既定 10) */
  GECKO_CALLS_PER_MIN: ranged("GECKO_CALLS_PER_MIN", 10, 1, 30),
  /**
   * 固定の監視銘柄 (カンマ区切り。mint のアドレスか symbol。symbol は tokens/v2/search で mint を引く)。
   * SOL・JUP は資産クラス crypto、それ以外は meme。既定 SOL,JUP,BONK,WIF,POPCAT,MEW
   */
  JUPITER_TOKENS: str("SOL,JUP,BONK,WIF,POPCAT,MEW"),
  /** ミームコインの自動探索 (toptrending / toporganicscore の 1h → 選別 → 監視銘柄に期限つきで追加。既定 true) */
  JUPITER_DISCOVERY: bool("JUPITER_DISCOVERY", true),
  /** 自動探索の間隔 (分、5〜1440、既定 20) */
  JUPITER_DISCOVERY_MINUTES: ranged("JUPITER_DISCOVERY_MINUTES", 20, 5, 1440),
  /** 自動追加した銘柄の期限 (最後に選別に合格してから。時間、1〜168、既定 6) */
  JUPITER_DISCOVERY_TTL_HOURS: ranged("JUPITER_DISCOVERY_TTL_HOURS", 6, 1, 168),
  /** 自動追加の最大件数 (0〜50。空 = 選別の既定 10) */
  JUPITER_DISCOVERY_MAX_TOKENS: optRanged("JUPITER_DISCOVERY_MAX_TOKENS", 0, 50, true),
  /** 選別: 最低の流動性 (USD。空 = 既定 250000) */
  JUPITER_DISCOVERY_MIN_LIQUIDITY_USD: optRanged("JUPITER_DISCOVERY_MIN_LIQUIDITY_USD", 0, 1e12),
  /** 選別: 最低の保有者数 (空 = 既定 2000) */
  JUPITER_DISCOVERY_MIN_HOLDERS: optRanged("JUPITER_DISCOVERY_MIN_HOLDERS", 0, 1e9, true),
  /** 選別: 最初のプールができてからの最低の日数 (空 = 既定 3) */
  JUPITER_DISCOVERY_MIN_AGE_DAYS: optRanged("JUPITER_DISCOVERY_MIN_AGE_DAYS", 0, 3650),
  /** 選別: 最低の organicScore (0〜100。空 = 既定 60) */
  JUPITER_DISCOVERY_MIN_ORGANIC_SCORE: optRanged("JUPITER_DISCOVERY_MIN_ORGANIC_SCORE", 0, 100),
  /** 選別: 上位保有者の比率の上限 (%、0〜100。空 = 既定 35) */
  JUPITER_DISCOVERY_MAX_TOP_HOLDERS_PCT: optRanged("JUPITER_DISCOVERY_MAX_TOP_HOLDERS_PCT", 0, 100),
  /** 選別: 検証済み (isVerified) だけ (既定 false) */
  JUPITER_DISCOVERY_VERIFIED_ONLY: bool("JUPITER_DISCOVERY_VERIFIED_ONLY", false),
  /** 1 回の取引 (スワップ) ごとの Solana のネットワーク手数料 (USD、0〜5、既定 0.02)。paper の約定とコストの見積もりに入れる */
  JUPITER_NETWORK_FEE_USD: ranged("JUPITER_NETWORK_FEE_USD", 0.02, 0, 5),
  /** 気配 (仮の買い・売り気配) とコストの見積もりに使う代表的な約定代金 (USD、1〜100000、既定 50) */
  JUPITER_QUOTE_SIZE_USD: ranged("JUPITER_QUOTE_SIZE_USD", 50, 1, 100_000),
  /** 最小の約定代金 (USD、0〜100000、既定 5) */
  JUPITER_MIN_NOTIONAL_USD: ranged("JUPITER_MIN_NOTIONAL_USD", 5, 0, 100_000),
  // 情報収集 (暗号資産のニュース)
  CRYPTOPANIC_TOKEN: str(),
};

const definition = defineAppConfig({ assetClasses: ["crypto", "meme"], shape: TRADER_SHAPE });

/** trader が使う資産クラス (crypto・meme) */
export const TRADER_ASSET_CLASSES = definition.assetClasses;
/** trader の環境変数 (コア + アプリ) */
export type Env = CoreEnv & { [K in keyof typeof TRADER_SHAPE]: ReturnType<(typeof TRADER_SHAPE)[K]["parse"]> };
export type AppConfig = CoreAppConfig<Env>;

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  return definition.loadConfig(source) as AppConfig;
}


/**
 * 廃止した環境変数 (読まない)。.env に残っていても起動は止めず、status と run の起動時に知らせるだけ。
 * GMO_*: GMOコインの取引先 (廃止)。MAX_EXPOSURE_FX / MAX_EXPOSURE_STOCK: FX・株式の資産クラス (このアプリでは使わない)
 */
const REMOVED_ENV_PREFIXES = ["GMO_"] as const;
const REMOVED_ENV_KEYS: readonly string[] = definition.unusedClassEnvKeys;

/** 値の入った廃止した環境変数があれば警告文を返す (値は表示しない) */
export function removedEnvWarnings(source: Record<string, string | undefined>): string[] {
  const keys = Object.keys(source)
    .filter((k) => (source[k] ?? "").trim() !== "")
    .filter((k) => REMOVED_ENV_PREFIXES.some((p) => k.startsWith(p)) || REMOVED_ENV_KEYS.includes(k))
    .sort();
  return keys.length ? [`.env の ${keys.join(", ")} は廃止した設定のため読みません (GMOコイン・FX・株式は廃止。.env から外してください)`] : [];
}
