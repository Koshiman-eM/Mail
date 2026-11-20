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
  | "maxExposureCrypto" | "maxExposureMeme" | "maxExposureFx" | "maxExposureStock"
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
  maxExposureFx: { env: "MAX_EXPOSURE_FX", kind: "ratio", min: 0, max: 1, def: 0.6, label: "FX の上限" },
  maxExposureStock: { env: "MAX_EXPOSURE_STOCK", kind: "ratio", min: 0, max: 1, def: 0.6, label: "株式の上限" },
  maxOpenPositions: { env: "MAX_OPEN_POSITIONS", kind: "count", min: 1, max: 100, def: 8, label: "最大保有数" },
  maxOrdersPerMinute: { env: "MAX_ORDERS_PER_MINUTE", kind: "count", min: 1, max: 1000, def: 30, label: "1 分あたりの発注数" },
};

/** 画面・CLI に出す順 */
export const RISK_SETTING_KEYS: readonly RiskSettingKey[] = [
  "riskPerTrade", "maxDailyLoss", "maxDrawdown", "maxPositionPct",
  "maxExposureCrypto", "maxExposureMeme", "maxExposureFx", "maxExposureStock",
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

/** 観測専用 (発注せず仮想トレードだけ記録する) 戦略の既定値 */
export const DEFAULT_OBSERVE_ONLY_STRATEGIES = "scalp_rebound";

/**
 * 相場構造 (ダウ理論) のフィルターを掛ける戦略の既定値 (トレンド・ブレイク系だけ)。
 * 逆張り (scalp_vwap_revert, short_rsi_revert)・板 (scalp_obi)・下降中の反発買い (scalp_rebound) は、
 * 目線と逆向きに入ること自体が設計なので対象外 (src/structure/settings.ts)
 */
export const DEFAULT_STRUCTURE_STRATEGIES =
  "scalp_momentum_burst,scalp_micro,short_ema_trend,short_breakout,mid_trend_follow,long_momentum,meme_momentum";

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
  /** 使う取引先 (カンマ区切り): synthetic, ccxt, gmo, oanda, alpaca, dex */
  VENUES: str("synthetic"),
  /** 監視銘柄 (カンマ区切り、"venue|symbol|assetClass")。空なら既定のデモ銘柄 */
  WATCHLIST: str(),
  BASE_CURRENCY: str("JPY"),
  PAPER_INITIAL_EQUITY: num(1_000_000),
  /**
   * paper で、取引所では空売りできない現物の暗号資産 (allowShort=false。meme・DEX は対象外) の空売りを再現して学習する (既定 true)。
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

  // 暗号資産取引所 (ccxt)
  CCXT_EXCHANGE: str("bitbank"),
  CCXT_API_KEY: str(),
  CCXT_SECRET: str(),
  CCXT_PASSWORD: str(),
  // GMOコイン (取引所 レバレッジ取引)。キーは live の発注と `gmo check` の非公開 API (読み取り) だけに使う
  GMO_API_KEY: str(),
  GMO_API_SECRET: str(),
  /** 使うレバレッジ銘柄 (GMO の表記、カンマ区切り)。WATCHLIST に gmo の銘柄があればそちらを優先 */
  GMO_SYMBOLS: str("BTC_JPY,ETH_JPY,XRP_JPY"),
  /**
   * 建玉の持ち越し手数料 (レバレッジ手数料) の日率 (0〜0.01)。既定 0.0004 (0.04%/日、要確認)。
   * paper で、日本時間 6:00 をまたいで保有した回数 × 建玉代金 × 日率を手数料に計上する
   */
  GMO_LEVERAGE_FEE_DAILY: num(0.0004).refine((x) => x >= 0 && x <= 0.01, {
    message: "GMO_LEVERAGE_FEE_DAILY は 0 以上 0.01 以下の日率で指定してください (0.04%/日なら 0.0004)",
  }),
  /**
   * GMO の建玉の合計 (絶対値の口座通貨換算) の上限 (評価額の倍率、0.1〜2)。既定 1 (レバレッジを掛けない)。
   * 超える新規エントリーは RiskManager が拒否する (GMO 自体は 2 倍まで建てられる)
   */
  GMO_MAX_EFFECTIVE_LEVERAGE: num(1).refine((x) => x >= 0.1 && x <= 2, {
    message: "GMO_MAX_EFFECTIVE_LEVERAGE は 0.1 以上 2 以下で指定してください (評価額の何倍まで建てるか)",
  }),
  /**
   * レバレッジ銘柄の足が取れないとき、現物銘柄 (BTC など) の足に切り替えてよいか (既定 false)。
   * paper では常に許可 (警告と監査ログ gmo.spot_candles を残す)。live ではこれが true のときだけ許可し、false なら例外
   */
  GMO_ALLOW_SPOT_CANDLES: bool("GMO_ALLOW_SPOT_CANDLES", false),
  // FX (OANDA v20)
  OANDA_API_TOKEN: str(),
  OANDA_ACCOUNT_ID: str(),
  OANDA_ENV: str("practice"),
  // 株式 (Alpaca)
  ALPACA_KEY_ID: str(),
  ALPACA_SECRET_KEY: str(),
  ALPACA_PAPER: str("true"),
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
  MAX_EXPOSURE_FX: riskEnv("maxExposureFx"),
  MAX_EXPOSURE_STOCK: riskEnv("maxExposureStock"),
  MEME_MIN_LIQUIDITY_USD: num(250_000),
  /**
   * 観測専用の戦略 id (カンマ区切り)。評価とシグナルの生成は通常どおり行うが、新規エントリーは発注せず
   * 仮想トレード (reason "observe_only") としてだけ記録する。既定は scalp_rebound。空文字なら観測専用なし
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
   * 有効なら、時間軸が中期・長期 (mid / long) の戦略は新規エントリーを発注せず仮想トレード (hold_limit) としてだけ記録し、
   * ほかの戦略はシグナルの最大保有時間をこの分数までに縮める (保有中の建玉は変えない)
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
  /** DexScreener のトレンドから条件を満たすミームを自動で監視に追加する (既定 false) */
  AUTO_MEME_WATCH: z
    .string()
    .optional()
    .transform((v) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase())),
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
    fx: env.MAX_EXPOSURE_FX,
    stock: env.MAX_EXPOSURE_STOCK,
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
