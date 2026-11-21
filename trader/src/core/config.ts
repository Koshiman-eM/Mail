import { z } from "zod";
import { DEFAULT_SHORT_BORROW_RATE_DAILY, MAX_SHORT_BORROW_RATE_DAILY } from "./short";
import type { AssetClass, RiskLimits } from "./types";

/**
 * 環境変数からの設定読み込み。シークレットは必ず環境変数 (.env.local) 経由。
 *
 * 安全ガード: 実弾 (live) は次の 2 つが揃ったときだけ有効。
 *   TRADING_MODE=live
 *   LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY_RISK
 * それ以外は常に paper (仮想売買)。テスト (NODE_ENV=test) では常に paper。
 */
export const LIVE_CONFIRM_PHRASE = "I_UNDERSTAND_REAL_MONEY_RISK";

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : Number(v)))
    .pipe(z.number().finite());

/**
 * 割合 (評価額比) の環境変数。0 < x ≤ max に限る。
 * 単位の取り違え (0.5% のつもりで 0.5 と書く) を起動時に止めるため、範囲外は分かりやすい文言のエラーにする。
 */
const ratio = (key: string, def: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : Number(v)))
    .pipe(z.number().finite())
    .superRefine((x, ctx) => {
      if (x > 0 && x <= max) return;
      const pct = (r: number) => `${Number((r * 100).toPrecision(6))}%`;
      const hint = x > max && x / 100 > 0 && x / 100 <= max ? ` ${key}=${x} は ${pct(x)} の意味です。${x}% なら ${x / 100} と書いてください。` : "";
      ctx.addIssue({
        code: "custom",
        message:
          `${key}=${x} は範囲外です (0 より大きく ${max} 以下、つまり ${pct(max)} 以下)。` +
          (hint || ` ${key} は割合で指定します (0.5 は 50% の意味です。0.5% なら 0.005 と書いてください)。`),
      });
    });

/** 1 以上の整数 (上限つき) */
const count = (key: string, def: number, max: number) =>
  num(def).refine((x) => Number.isInteger(x) && x >= 1 && x <= max, { message: `${key} は 1 以上 ${max} 以下の整数で指定してください` });

/**
 * ダッシュボードから変更できるリスク項目の定義 (範囲・既定値・環境変数名)。
 * 環境変数の検証 (EnvSchema) とダッシュボードの上書き値の検証 (src/risk/settings.ts) の両方がこの 1 か所を参照する
 * (範囲を二重に定義しない)。ratio は 0 < x ≤ max、count は 1 ≤ x ≤ max の整数。
 */
export type RiskSettingKey =
  | "riskPerTrade" | "maxDailyLoss" | "maxDrawdown" | "maxPositionPct"
  | "maxExposureCrypto" | "maxExposureMeme"
  | "maxOpenPositions" | "maxOrdersPerMinute";

export interface RiskSettingSpec {
  env: string;
  kind: "ratio" | "count";
  /** 下限 (ratio は 0 を含まない。count は含む) */
  min: number;
  max: number;
  /** 既定値 (= プリセット「標準」) */
  def: number;
  label: string;
}

export const RISK_SETTING_SPECS: Readonly<Record<RiskSettingKey, RiskSettingSpec>> = {
  riskPerTrade: { env: "RISK_PER_TRADE", kind: "ratio", min: 0, max: 0.05, def: 0.005, label: "1 トレードのリスク" },
  maxDailyLoss: { env: "MAX_DAILY_LOSS", kind: "ratio", min: 0, max: 0.2, def: 0.03, label: "日次損失の上限" },
  maxDrawdown: { env: "MAX_DRAWDOWN", kind: "ratio", min: 0, max: 0.5, def: 0.15, label: "最大ドローダウン" },
  maxPositionPct: { env: "MAX_POSITION_PCT", kind: "ratio", min: 0, max: 1, def: 0.2, label: "1 銘柄の上限" },
  maxExposureCrypto: { env: "MAX_EXPOSURE_CRYPTO", kind: "ratio", min: 0, max: 1, def: 0.6, label: "暗号資産の上限" },
  maxExposureMeme: { env: "MAX_EXPOSURE_MEME", kind: "ratio", min: 0, max: 1, def: 0.05, label: "ミームの上限" },
  maxOpenPositions: { env: "MAX_OPEN_POSITIONS", kind: "count", min: 1, max: 100, def: 8, label: "最大保有数" },
  maxOrdersPerMinute: { env: "MAX_ORDERS_PER_MINUTE", kind: "count", min: 1, max: 1000, def: 30, label: "1 分あたりの発注数" },
};

/** 画面・CLI に出す順 */
export const RISK_SETTING_KEYS: readonly RiskSettingKey[] = [
  "riskPerTrade", "maxDailyLoss", "maxDrawdown", "maxPositionPct",
  "maxExposureCrypto", "maxExposureMeme",
  "maxOpenPositions", "maxOrdersPerMinute",
];

/** 定義から環境変数の検証を作る */
const riskEnv = (k: RiskSettingKey) => {
  const s = RISK_SETTING_SPECS[k];
  return s.kind === "ratio" ? ratio(s.env, s.def, s.max) : count(s.env, s.def, s.max);
};

/**
 * 真偽値の環境変数 (1/true/yes/on と 0/false/no/off。大文字小文字は問わない)。未設定・空は def。
 * それ以外は書き間違いとして起動を止める (既定 true の項目を誤って無効にしたつもりで有効のまま動かさない)
 */
const bool = (key: string, def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const x = (v ?? "").trim().toLowerCase();
      if (x === "") return def;
      if (["1", "true", "yes", "on"].includes(x)) return true;
      if (["0", "false", "no", "off"].includes(x)) return false;
      ctx.addIssue({ code: "custom", message: `${key}=${v} は true / false で指定してください` });
      return z.NEVER;
    });

const str = (def = "") =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v.trim()));

/** カンマ区切りの id の一覧 (前後の空白・空要素・重複を除く)。未設定は def、空文字は [] */
const idList = (def: string) =>
  str(def).transform((v) => [...new Set(v.split(",").map((x) => x.trim()).filter(Boolean))]);

/**
 * 観測専用 (発注せず仮想トレードだけ記録する) 戦略の既定値。scalp_rebound (効果の測定中)。
 * 観測専用でも保有中の建玉は従来どおり管理・決済する (止めるのは新規エントリーだけ)
 */
export const DEFAULT_OBSERVE_ONLY_STRATEGIES = "scalp_rebound";

/**
 * 相場構造 (ダウ理論) のフィルターを掛ける戦略の既定値 (トレンド・ブレイク系だけ)。
 * 逆張り (scalp_vwap_revert, short_rsi_revert)・板 (scalp_obi)・下降中の反発買い (scalp_rebound) は、
 * 目線と逆向きに入ること自体が設計なので対象外 (src/structure/settings.ts)
 */
export const DEFAULT_STRUCTURE_STRATEGIES = "scalp_momentum_burst,scalp_micro,short_ema_trend,short_breakout";

/** 列挙値の環境変数 (大文字小文字は問わない)。未設定・空は def。それ以外は起動を止める */
const choice = <T extends string>(key: string, values: readonly T[], def: T) =>
  z
    .string()
    .optional()
    .transform((v, ctx): T => {
      const x = (v ?? "").trim().toLowerCase();
      if (x === "") return def;
      const hit = values.find((s) => s.toLowerCase() === x);
      if (hit) return hit;
      ctx.addIssue({ code: "custom", message: `${key}=${v} は ${values.join(" / ")} のどれかで指定してください` });
      return z.NEVER;
    });

/** 範囲つきの数値 (integer なら整数に限る) */
const ranged = (key: string, def: number, min: number, max: number, integer = false) =>
  num(def).refine((x) => x >= min && x <= max && (!integer || Number.isInteger(x)), {
    message: `${key} は ${min} 以上 ${max} 以下の${integer ? "整数" : "数値"}で指定してください`,
  });

/** 任意の範囲つきの数値 (未設定・空は undefined = 呼び出し側の既定値) */
const optRanged = (key: string, min: number, max: number, integer = false) =>
  z
    .string()
    .optional()
    .transform((v, ctx): number | undefined => {
      if (v === undefined || v.trim() === "") return undefined;
      const x = Number(v);
      if (Number.isFinite(x) && x >= min && x <= max && (!integer || Number.isInteger(x))) return x;
      ctx.addIssue({ code: "custom", message: `${key}=${v} は ${min} 以上 ${max} 以下の${integer ? "整数" : "数値"}で指定してください (空なら既定値)` });
      return z.NEVER;
    });

/**
 * 数値の環境変数 (未設定・空は def)。数値でない・ok を満たさない値は、値と message を含む文言で起動を止める
 */
const checkedNum = (key: string, def: number, ok: (x: number) => boolean, message: string) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const x = v === undefined || v.trim() === "" ? def : Number(v);
      if (Number.isFinite(x) && ok(x)) return x;
      ctx.addIssue({ code: "custom", message: `${key}=${v} は不正です。${message}` });
      return z.NEVER;
    });

const EnvSchema = z.object({
  NODE_ENV: str("development"),
  TRADING_MODE: str("paper"),
  LIVE_TRADING_CONFIRM: str(),
  /**
   * 使う取引先 (カンマ区切り): jupiter (既定。Solana の DEX アグリゲーター)、synthetic、ccxt。いずれも相場の取得と paper 用
   * (live の発注先は未対応。TRADING_MODE=live では起動しない)。ccxt・synthetic は paper・バックテスト用に残す。
   * 廃止した gmo / oanda / alpaca / dex は起動時に警告して無視する (src/engine/setup.ts の parseVenues)
   */
  VENUES: str("jupiter"),
  /** 監視銘柄 (カンマ区切り、"venue|symbol|assetClass")。空なら既定のデモ銘柄 */
  WATCHLIST: str(),
  BASE_CURRENCY: str("JPY"),
  PAPER_INITIAL_EQUITY: num(1_000_000),
  /**
   * paper で、取引所では空売りできない現物の暗号資産 (allowShort=false。meme は対象外) の空売りを再現して学習する (既定 true)。
   * live では常に無効 (src/core/short.ts の canShort)
   */
  PAPER_SIMULATE_SHORT: bool("PAPER_SIMULATE_SHORT", true),
  /**
   * paper で再現する空売りの借入コスト (建玉代金に対する日率。0〜0.01)。既定 0.0004 (0.04%/日) は
   * bitbank の信用取引の手数料・金利を想定した仮の値。実際の料率は取引所で確認すること
   */
  PAPER_SHORT_BORROW_RATE_DAILY: num(DEFAULT_SHORT_BORROW_RATE_DAILY).refine((x) => x >= 0 && x <= MAX_SHORT_BORROW_RATE_DAILY, {
    message: `PAPER_SHORT_BORROW_RATE_DAILY は 0 以上 ${MAX_SHORT_BORROW_RATE_DAILY} 以下の日率で指定してください (0.04%/日なら 0.0004)`,
  }),
  DB_PATH: str("./data/trader.db"),

  ANTHROPIC_API_KEY: str(),
  ANTHROPIC_MODEL: str("claude-opus-5-5"),

  // 暗号資産取引所 (ccxt。相場の取得と paper 用で、発注はしない)
  CCXT_EXCHANGE: str("bitbank"),
  // Jupiter (Solana。src/market/jupiter/・src/market/feeds/jupiter.ts。相場の取得と paper 用で、スワップは実行しない)
  /** API キー (任意)。あればキーありの既定の上限 (1 回/秒) で呼ぶ。表示・ログには出さない */
  JUPITER_API_KEY: str(),
  /** 1 秒あたりの呼び出しの上限 (空 = キーなし 0.5 / キーあり 1)。プランに合わせて変える */
  JUPITER_RPS: optRanged("JUPITER_RPS", 0.05, 50),
  /** 価格 (Price V3) の取得間隔 (ミリ秒、1000〜60000、既定 5000)。監視中の全 mint を 50 件ずつ一括で取る */
  JUPITER_POLL_MS: ranged("JUPITER_POLL_MS", 5_000, 1_000, 60_000, true),
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

  // 情報収集
  CRYPTOPANIC_TOKEN: str(),
  NEWS_RSS_FEEDS: str(),

  // リスク (評価額比)
  // (範囲・既定値は RISK_SETTING_SPECS。ダッシュボードの上書き値も同じ定義で検証する)
  RISK_PER_TRADE: riskEnv("riskPerTrade"),
  MAX_DAILY_LOSS: riskEnv("maxDailyLoss"),
  MAX_DRAWDOWN: riskEnv("maxDrawdown"),
  MAX_OPEN_POSITIONS: riskEnv("maxOpenPositions"),
  MAX_POSITION_PCT: riskEnv("maxPositionPct"),
  MAX_ORDERS_PER_MINUTE: riskEnv("maxOrdersPerMinute"),
  MIN_EDGE_TO_COST: num(2),
  MAX_EXPOSURE_CRYPTO: riskEnv("maxExposureCrypto"),
  MAX_EXPOSURE_MEME: riskEnv("maxExposureMeme"),
  /**
   * 資産クラス meme の新規エントリーに求める流動性 (USD)。Jupiter の銘柄はトークン情報の liquidity (1 時間ごとに取り直す)、
   * WATCHLIST で |meme を付けた ccxt などの銘柄は 24 時間の出来高からの推定。RiskManager の判定 (未満・不明なら拒否)
   */
  MEME_MIN_LIQUIDITY_USD: num(250_000),
  /**
   * 観測専用の戦略 id (カンマ区切り)。評価とシグナルの生成は通常どおり行うが、新規エントリーは発注せず
   * 仮想トレード (reason "observe_only") としてだけ記録する。既定は scalp_rebound。
   * 保有中の建玉は従来どおり管理・決済する。空文字なら観測専用なし。未登録 (廃止した戦略を含む) の id は起動時に警告して無視する
   */
  OBSERVE_ONLY_STRATEGIES: idList(DEFAULT_OBSERVE_ONLY_STRATEGIES),

  // 指値 (maker) の利用
  /**
   * 新規エントリーを指値 (買いは最良の買い気配、売りは最良の売り気配。対応する取引先では post-only) にする (既定 true)。
   * 戦略の entryOrder ("market" / "limit") が優先。期限内に約定しなければ取り消して見送る (仮想トレード limit_unfilled)
   */
  LIMIT_ENTRY: bool("LIMIT_ENTRY", true),
  /**
   * 指値のエントリーの有効期限 (ミリ秒)。未設定 (空) なら戦略の主時間足の長さを 20 秒〜15 分に収めた値
   */
  LIMIT_ENTRY_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? undefined : Number(v)))
    .refine((x) => x === undefined || (Number.isFinite(x) && x >= 1_000 && x <= 86_400_000), {
      message: "LIMIT_ENTRY_TIMEOUT_MS は 1000 以上 86400000 以下のミリ秒で指定してください (未設定なら主時間足の長さ)",
    }),
  /**
   * エントリーの約定後、シグナルの利確価格に reduceOnly の指値を板に置く (既定 false。paper 専用で、取引先が
   * restingTakeProfit に対応しているときだけ)。損切りなどで成行の決済をするときは、先に取り消して結果を確かめてから残りだけを送る。
   * live では true でも無視する (起動時に警告と監査ログ limit.tp_live_ignored。取消の失敗・照会の遅れで損切りが止まる・
   * 過剰決済になる経路を実弾に持ち込まないため。src/engine/limitOrders.ts の effectiveLimitTakeProfit)
   */
  LIMIT_TAKE_PROFIT: bool("LIMIT_TAKE_PROFIT", false),

  // エントリー頻度の目標 (テンポ) と保有時間の上限 (src/engine/tempo.ts)
  /**
   * 1 時間あたりの目標のエントリー回数 (0〜60。既定 0 = 無効)。例: 6 = おおむね 10 分に 1 回。
   * 0 より大きいとテンポのモードになり、エントリーが目標より途切れているときだけ、戦略と RiskManager の決められた条件を
   * 決められた下限まで緩める。直近 1 時間のエントリーが 目標 × TEMPO_CAP_MULTIPLIER (切り上げ) に達したら新規を止める
   */
  TARGET_ENTRIES_PER_HOUR: checkedNum(
    "TARGET_ENTRIES_PER_HOUR", 0, (x) => x >= 0 && x <= 60,
    "0 (無効) 以上 60 以下の 1 時間あたりの回数で指定してください (10 分に 1 回なら 6)",
  ),
  /**
   * 新規エントリーの最大保有時間 (分)。0 (既定) = 無効、それ以外は 5〜1440。
   * 有効なら、シグナルの最大保有時間をこの分数までに縮める (保有中の建玉は変えない)。
   * 時間軸が中期・長期 (mid / long) の戦略は新規エントリーを発注せず仮想トレード (hold_limit) としてだけ記録する
   * (いまの登録戦略に中期・長期は無いが、時間軸による規則として残している。src/engine/tempo.ts の isHoldLimitedHorizon)
   */
  MAX_HOLD_MINUTES: checkedNum(
    "MAX_HOLD_MINUTES", 0, (x) => x === 0 || (x >= 5 && x <= 1440),
    "0 (無効) か、5 以上 1440 以下の分で指定してください (30 分なら 30)",
  ),
  /**
   * テンポのモードで RiskManager の期待値幅 / コストの比 (MIN_EDGE_TO_COST) を緩める下限 (1〜10、既定 1)。
   * MIN_EDGE_TO_COST がこれより低ければ MIN_EDGE_TO_COST のまま (締めも緩めもしない)
   */
  TEMPO_MIN_EDGE_TO_COST: checkedNum(
    "TEMPO_MIN_EDGE_TO_COST", 1, (x) => x >= 1 && x <= 10,
    "1 以上 10 以下の倍率で指定してください (期待値幅 / コスト の下限)",
  ),
  /** 直近 1 時間のエントリーが 目標 × これ (切り上げ) に達したら新規エントリーを止める (1〜5、既定 2) */
  TEMPO_CAP_MULTIPLIER: checkedNum(
    "TEMPO_CAP_MULTIPLIER", 2, (x) => x >= 1 && x <= 5,
    "1 以上 5 以下の倍率で指定してください (目標の何倍で新規エントリーを止めるか)",
  ),
  /**
   * 探索のエントリー (テンポで緩めた結果、コスト控除後の期待値が 0 以下のシグナル) のサイズの倍率 (0.1〜1、既定 0.5)。
   * 探索は paper では常に、live では TEMPO_ALLOW_LIVE_EXPLORE=true のときだけ行う
   */
  TEMPO_EXPLORE_SIZE: checkedNum(
    "TEMPO_EXPLORE_SIZE", 0.5, (x) => x >= 0.1 && x <= 1,
    "0.1 以上 1 以下の倍率で指定してください (探索のエントリーのサイズ。半分なら 0.5)",
  ),
  /** live でも探索のエントリーを許可する (既定 false。paper では常に許可) */
  TEMPO_ALLOW_LIVE_EXPLORE: bool("TEMPO_ALLOW_LIVE_EXPLORE", false),

  // 読みの管理 (src/engine/thesis.ts)
  /**
   * 読みの管理を使う (既定 true)。エントリー時に「いつ頃までに利益が出る読みか」(読みの期限 = シグナルの expectedMs、
   * 無ければ最大保有。MAX_HOLD_MINUTES で丸める) を決め、期限の途中で大きく逆行したら途中で決済、期限で利益が出ていなければ決済、
   * 利益が出ていれば建値とトレーリングで守りながら 期限 × THESIS_EXTEND_MULT まで持ち続ける。
   * false なら従来どおり最大保有で時間切れ (time) にする
   */
  THESIS_EXIT: bool("THESIS_EXIT", true),
  /** 期限の時点で、手数料を引いた純 R がこれ以上なら読み当たり (延長)。未満なら読み外れで決済 (0〜2、既定 0.1) */
  THESIS_MIN_R: checkedNum("THESIS_MIN_R", 0.1, (x) => x >= 0 && x <= 2, "0 以上 2 以下の R で指定してください (期限で延長する純 R の下限)"),
  /** 期限の半分を過ぎて、値動きだけの R (手数料・スプレッドを含めない) が −これ 以下なら途中で読み外れとして決済 (0〜1、既定 0.5。0 で途中の決済なし) */
  THESIS_EARLY_CUT_R: checkedNum(
    "THESIS_EARLY_CUT_R", 0.5, (x) => x >= 0 && x <= 1,
    "0 (無効) 以上 1 以下の R で指定してください (期限の半分を過ぎてこれだけ逆行したら途中で決済)",
  ),
  /** 延長の上限 (読みの期限の何倍まで持つか。1〜20、既定 4。1 なら延長しない) */
  THESIS_EXTEND_MULT: checkedNum(
    "THESIS_EXTEND_MULT", 4, (x) => x >= 1 && x <= 20,
    "1 以上 20 以下の倍率で指定してください (読みの期限の何倍まで持ち続けるか。1 で延長なし)",
  ),
  /** 延長後のトレーリングの幅 (当初の損切り幅 = 1R の何倍。0.1〜3、既定 0.5) */
  THESIS_TRAIL_R: checkedNum(
    "THESIS_TRAIL_R", 0.5, (x) => x >= 0.1 && x <= 3,
    "0.1 以上 3 以下の R で指定してください (延長後、最も有利な価格からこれだけ戻したら決済)",
  ),

  // 転換で決済 (src/engine/reversalExit.ts)
  /**
   * 転換で決済を使う (既定 true)。保有中の建玉について、REVERSAL_EXIT_TF の時間足 (既定は戦略の主時間足の 1 つ下) でエントリー後にできた押し安値 (買い) / 戻り高値 (売り) を、
   * 確定足の終値が割ったら (越えたら) 利確・損切りの手前でも成行で決済する (決済理由 reversal)。全戦略が対象。
   * false なら従来と同一
   */
  REVERSAL_EXIT: bool("REVERSAL_EXIT", true),
  /** 転換で決済のスイングの左右の本数 (2〜10 の整数、既定 3。新規エントリーのフィルターの STRUCTURE_PIVOT_N とは別) */
  REVERSAL_EXIT_PIVOT_N: checkedNum(
    "REVERSAL_EXIT_PIVOT_N", 3, (x) => Number.isInteger(x) && x >= 2 && x <= 10,
    "2 以上 10 以下の整数で指定してください (スイングの左右の本数)",
  ),
  /** 終値が押し安値 (戻り高値) をこの ATR(14) 倍より大きく越えたら決済 (0〜1、既定 0 = 終値が越えれば十分) */
  REVERSAL_EXIT_BUFFER_ATR: checkedNum(
    "REVERSAL_EXIT_BUFFER_ATR", 0, (x) => x >= 0 && x <= 1,
    "0 以上 1 以下の ATR の倍数で指定してください (0 なら終値が押し安値・戻り高値を越えれば決済)",
  ),
  /** 転換で決済を掛ける戦略 id (カンマ区切り)。空 (既定) ならすべての戦略。未登録の id は起動時に警告する */
  REVERSAL_EXIT_STRATEGIES: idList(""),
  /**
   * 転換で決済を判定する時間足。lower (既定) = 戦略の主時間足の 1 つ下 (1m→1m, 5m→1m, 15m→5m, 1h→15m, 4h→1h, 1d→4h)、
   * same = 戦略の主時間足 (従来どおり)。lower は短い保有でも押し安値割れ・戻り高値超えを拾いやすい
   */
  REVERSAL_EXIT_TF: choice("REVERSAL_EXIT_TF", ["lower", "same"] as const, "lower"),
  /**
   * 転換で決済のフォールバック (既定 false)。true なら、エントリー後に確定したスイングが無いとき、エントリーした足の安値 (買い) /
   * 高値 (売り) を水準にする。早く発火しすぎるので既定は無効 (simulate でほとんどの取引をエントリー付近で閉じ、勝率は 5% 前後だった)
   */
  REVERSAL_EXIT_FALLBACK: bool("REVERSAL_EXIT_FALLBACK", false),

  // 相場構造 (ダウ理論) のフィルター・損切り (src/structure/)
  /** off: ラップしない (従来と同じ) / filter: 対象の戦略をラップする (既定) */
  STRUCTURE_MODE: choice("STRUCTURE_MODE", ["off", "filter"] as const, "filter"),
  /** フィルターを掛ける戦略 id (カンマ区切り)。空文字なら対象なし */
  STRUCTURE_STRATEGIES: idList(DEFAULT_STRUCTURE_STRATEGIES),
  /** スイングの左右の本数 (3〜20。一度決めたら固定して使う。最適化しない) */
  STRUCTURE_PIVOT_N: ranged("STRUCTURE_PIVOT_N", 6, 3, 20, true),
  /** ブレイクの判定 (終値 / ヒゲ) */
  STRUCTURE_BREAK_MODE: choice("STRUCTURE_BREAK_MODE", ["close", "wick"] as const, "close"),
  /** method1: 押し安値・戻り高値 / method2: HH+HL・LH+LL / both: 両方が一致したときだけ */
  STRUCTURE_BIAS_METHOD: choice("STRUCTURE_BIAS_METHOD", ["method1", "method2", "both"] as const, "method1"),
  /** purist: 押し安値割れで転換 / conservative: 高値・安値の両方の切り下げで転換 (途中は新規エントリーしない) */
  STRUCTURE_REVERSAL_MODE: choice("STRUCTURE_REVERSAL_MODE", ["purist", "conservative"] as const, "purist"),
  /** 上位足の目線とも一致を必須にする */
  STRUCTURE_USE_MTF: bool("STRUCTURE_USE_MTF", true),
  /** パーフェクトオーダー (SMA 5/20/50) の一致も必須にする */
  STRUCTURE_USE_PERFECT_ORDER: bool("STRUCTURE_USE_PERFECT_ORDER", false),
  /** existing: 戦略の損切りのまま / structure: 押し安値 − ATR × バッファ (売りは 戻り高値 + ATR × バッファ) */
  STRUCTURE_STOP_MODE: choice("STRUCTURE_STOP_MODE", ["existing", "structure"] as const, "existing"),
  /** 構造の損切りのバッファ (ATR の倍数、0〜2) */
  STRUCTURE_STOP_ATR_BUFFER: ranged("STRUCTURE_STOP_ATR_BUFFER", 0.3, 0, 2),
  /** 保有中に保有方向と逆へ目線が転換したら決済する */
  STRUCTURE_EXIT_ON_REVERSAL: bool("STRUCTURE_EXIT_ON_REVERSAL", false),
  /** conservative の転換の途中 (weakening) に入ったら決済する */
  STRUCTURE_EXIT_ON_WEAKENING: bool("STRUCTURE_EXIT_ON_WEAKENING", false),
  /** ちゃぶつきの判定: 直近 M 本で目線が R 回以上反転したら新規エントリーを止める (M は構造の窓 STRUCTURE_WINDOW_BARS = 300 以下) */
  STRUCTURE_CHOP_M: ranged("STRUCTURE_CHOP_M", 50, 5, 300, true),
  STRUCTURE_CHOP_R: ranged("STRUCTURE_CHOP_R", 3, 1, 100, true),

  // ループ間隔
  SCALP_LOOP_MS: num(5_000),
  INTEL_LOOP_MS: num(900_000),
  LEARN_LOOP_MS: num(3_600_000),
  DASHBOARD_PORT: num(8787),
  /** ダッシュボードの bind 先 (既定はローカルのみ) */
  DASHBOARD_HOST: str("127.0.0.1"),
  /**
   * ループバック以外で待ち受けるときに、ダッシュボードからの書き込み (リスク設定の変更) を許可するトークン。
   * 未設定 (または 16 文字未満) ならループバック以外からは書き込めない。ループバック待ち受けでは不要
   */
  DASHBOARD_WRITE_TOKEN: str(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env;
  mode: "paper" | "live";
  liveBlockedReason?: string;
  risk: RiskLimits;
  ai: { apiKey: string; model: string; enabled: boolean };
}

export function resolveMode(env: Pick<Env, "NODE_ENV" | "TRADING_MODE" | "LIVE_TRADING_CONFIRM">): {
  mode: "paper" | "live";
  liveBlockedReason?: string;
} {
  if (env.TRADING_MODE !== "live") return { mode: "paper" };
  if (env.NODE_ENV === "test") return { mode: "paper", liveBlockedReason: "テスト中は live を使えません" };
  if (env.LIVE_TRADING_CONFIRM !== LIVE_CONFIRM_PHRASE) {
    return { mode: "paper", liveBlockedReason: `LIVE_TRADING_CONFIRM=${LIVE_CONFIRM_PHRASE} が未設定のため paper で起動します` };
  }
  return { mode: "live" };
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // 設定の誤りは JSON ではなく読める文章で出して起動を止める
    const lines = parsed.error.issues.map((i) => `${i.path.join(".") || "(設定)"}: ${i.message}`);
    throw new Error(`設定が不正です:\n  ${lines.join("\n  ")}`);
  }
  const env = parsed.data;
  const { mode, liveBlockedReason } = resolveMode(env);
  const exposure: Record<AssetClass, number> = {
    crypto: env.MAX_EXPOSURE_CRYPTO,
    meme: env.MAX_EXPOSURE_MEME,
  };
  return {
    env,
    mode,
    liveBlockedReason,
    risk: {
      riskPerTrade: env.RISK_PER_TRADE,
      maxDailyLoss: env.MAX_DAILY_LOSS,
      maxDrawdown: env.MAX_DRAWDOWN,
      maxOpenPositions: env.MAX_OPEN_POSITIONS,
      maxExposureByClass: exposure,
      maxPositionPct: env.MAX_POSITION_PCT,
      maxOrdersPerMinute: env.MAX_ORDERS_PER_MINUTE,
      minEdgeToCostRatio: env.MIN_EDGE_TO_COST,
      // テンポのモード (EntryParams.tempo あり) でだけ使う。テンポが無効なら判定に影響しない
      tempoMinEdgeToCost: env.TEMPO_MIN_EDGE_TO_COST,
      memeMinLiquidityUsd: env.MEME_MIN_LIQUIDITY_USD,
    },
    ai: { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL, enabled: env.ANTHROPIC_API_KEY !== "" },
  };
}

export const DEFAULT_RISK: RiskLimits = loadConfig({}).risk;

/**
 * 廃止した環境変数 (読まない)。.env に残っていても起動は止めず、status と run の起動時に知らせるだけ。
 * GMO_*: GMOコインの取引先 (廃止)。MAX_EXPOSURE_FX / MAX_EXPOSURE_STOCK: FX・株式の資産クラス (廃止)
 */
const REMOVED_ENV_PREFIXES = ["GMO_"] as const;
const REMOVED_ENV_KEYS = ["MAX_EXPOSURE_FX", "MAX_EXPOSURE_STOCK"] as const;

/** 値の入った廃止した環境変数があれば警告文を返す (値は表示しない) */
export function removedEnvWarnings(source: Record<string, string | undefined>): string[] {
  const keys = Object.keys(source)
    .filter((k) => (source[k] ?? "").trim() !== "")
    .filter((k) => REMOVED_ENV_PREFIXES.some((p) => k.startsWith(p)) || (REMOVED_ENV_KEYS as readonly string[]).includes(k))
    .sort();
  return keys.length ? [`.env の ${keys.join(", ")} は廃止した設定のため読みません (GMOコイン・FX・株式は廃止。.env から外してください)`] : [];
}
