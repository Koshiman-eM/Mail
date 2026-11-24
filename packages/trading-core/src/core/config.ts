import { z } from "zod";
import { ASSET_CLASS_PROFILES, ASSET_CLASSES, classKeySuffix, enabledAssetClasses, setEnabledAssetClasses, type AssetClass } from "./assetClasses";
import { DEFAULT_SHORT_BORROW_RATE_DAILY, MAX_SHORT_BORROW_RATE_DAILY } from "./short";
import type { RiskLimits } from "./types";

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
export type BaseRiskSettingKey = "riskPerTrade" | "maxDailyLoss" | "maxDrawdown" | "maxPositionPct" | "maxOpenPositions" | "maxOrdersPerMinute";
/** 資産クラスのエクスポージャー上限の項目 (maxExposureCrypto / maxExposureMeme / maxExposureFx / maxExposureStock) */
export type ExposureSettingKey = `maxExposure${Capitalize<AssetClass>}`;
export type RiskSettingKey = BaseRiskSettingKey | ExposureSettingKey;

/** 資産クラスの上限の項目名 (crypto → maxExposureCrypto。kv risk:limits:<mode> の values のキー) */
export const exposureSettingKey = (c: AssetClass): ExposureSettingKey => `maxExposure${classKeySuffix(c)}` as ExposureSettingKey;
/** 資産クラスの上限の環境変数名 (crypto → MAX_EXPOSURE_CRYPTO) */
export const exposureEnvKey = (c: AssetClass): string => `MAX_EXPOSURE_${c.toUpperCase()}`;
/** 表示名 (暗号資産の上限 / FX の上限)。英字で終わる名前は空白を挟む */
const exposureLabel = (c: AssetClass) => {
  const l = ASSET_CLASS_PROFILES[c].label;
  return /[A-Za-z0-9]$/.test(l) ? `${l} の上限` : `${l}の上限`;
};

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

/**
 * 全項目の定義 (資産クラスの上限は語彙の全クラスぶん。既定値はプロファイルの exposurePresets.standard)。
 * アプリが使う項目は riskSettingKeys() (使うクラスの上限だけ)
 */
export const RISK_SETTING_SPECS: Readonly<Record<RiskSettingKey, RiskSettingSpec>> = {
  riskPerTrade: { env: "RISK_PER_TRADE", kind: "ratio", min: 0, max: 0.05, def: 0.005, label: "1 トレードのリスク" },
  maxDailyLoss: { env: "MAX_DAILY_LOSS", kind: "ratio", min: 0, max: 0.2, def: 0.03, label: "日次損失の上限" },
  maxDrawdown: { env: "MAX_DRAWDOWN", kind: "ratio", min: 0, max: 0.5, def: 0.15, label: "最大ドローダウン" },
  maxPositionPct: { env: "MAX_POSITION_PCT", kind: "ratio", min: 0, max: 1, def: 0.2, label: "1 銘柄の上限" },
  ...(Object.fromEntries(
    ASSET_CLASSES.map((c) => [
      exposureSettingKey(c),
      { env: exposureEnvKey(c), kind: "ratio", min: 0, max: 1, def: ASSET_CLASS_PROFILES[c].exposurePresets.standard, label: exposureLabel(c) },
    ]),
  ) as Record<ExposureSettingKey, RiskSettingSpec>),
  maxOpenPositions: { env: "MAX_OPEN_POSITIONS", kind: "count", min: 1, max: 100, def: 8, label: "最大保有数" },
  maxOrdersPerMinute: { env: "MAX_ORDERS_PER_MINUTE", kind: "count", min: 1, max: 1000, def: 30, label: "1 分あたりの発注数" },
};

/** アプリが使う項目 (画面・CLI に出す順)。資産クラスの上限は使うクラスだけ */
export function riskSettingKeys(classes: readonly AssetClass[] = enabledAssetClasses()): RiskSettingKey[] {
  return [
    "riskPerTrade", "maxDailyLoss", "maxDrawdown", "maxPositionPct",
    ...classes.map(exposureSettingKey),
    "maxOpenPositions", "maxOrdersPerMinute",
  ];
}

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
 * 観測専用 (発注せず仮想トレードだけ記録する) 戦略の既定値。scalp_rebound (効果の測定中) と、
 * short_ema_trend の meme だけ (上昇トレンドで急騰後の天井を買って負け続けたため。crypto は従来どおり取引する)。
 * 要素は `<戦略 id>` (全資産クラス) か `<戦略 id>:<資産クラス>` (そのクラスだけ。src/strategies/observeOnly.ts)。
 * 観測専用でも保有中の建玉は従来どおり管理・決済する (止めるのは新規エントリーだけ)
 */
export const DEFAULT_OBSERVE_ONLY_STRATEGIES = "scalp_rebound,short_ema_trend:meme";

/**
 * 相場構造 (ダウ理論) のフィルターを掛ける戦略の既定値 (トレンド・ブレイク系だけ)。
 * 逆張り (scalp_vwap_revert, short_rsi_revert)・板 (scalp_obi)・下降中の反発買い (scalp_rebound) は、
 * 目線と逆向きに入ること自体が設計なので対象外 (src/structure/settings.ts)。
 * mid_trend_follow は廃止前 (commit 299e971 より前) と同じく対象 (戻した戦略の動きと学習データの前提をそろえる)。
 * trend_4h は自前の EMA の傾きを持つので対象外
 */
export const DEFAULT_STRUCTURE_STRATEGIES = "scalp_momentum_burst,scalp_micro,short_ema_trend,short_breakout,mid_trend_follow";

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

/**
 * コアの環境変数 (全アプリ共通)。資産クラスの上限 MAX_EXPOSURE_<CLASS> は使うクラスの分だけ。
 * アプリの環境変数 (取引先・銘柄・API キーなど) は defineAppConfig の shape で足す (ここにあるキーは再定義できない)
 */
const coreStaticShape = {
  NODE_ENV: str("development"),
  TRADING_MODE: str("paper"),
  LIVE_TRADING_CONFIRM: str(),
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

  // 情報収集 (RSS。src/intel/sources/rss.ts。空ならアプリの既定のフィード)
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
  /**
   * 資産クラス meme の新規エントリーに求める流動性 (USD)。Jupiter の銘柄はトークン情報の liquidity (1 時間ごとに取り直す)、
   * WATCHLIST で |meme を付けた ccxt などの銘柄は 24 時間の出来高からの推定。RiskManager の判定 (未満・不明なら拒否)
   */
  MEME_MIN_LIQUIDITY_USD: num(250_000),
  /**
   * 観測専用の戦略 id (カンマ区切り)。評価とシグナルの生成は通常どおり行うが、新規エントリーは発注せず
   * 仮想トレード (reason "observe_only") としてだけ記録する。既定は scalp_rebound,short_ema_trend:meme。
   * `<id>:<資産クラス>` はそのクラスの銘柄だけを観測専用にする (`<id>` だけなら全クラス)。
   * 保有中の建玉は従来どおり管理・決済する。空文字なら観測専用なし。未登録 (廃止した戦略を含む) の id・使えない資産クラスの指定は
   * 起動時に警告して無視する
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

  // 建値ストップ (src/engine/breakeven.ts)
  /**
   * エントリーの仲値からの有利な仲値の動きが 当初のリスク × これ に達したら、保護ストップを往復コスト込みの建値
   * (エントリー手数料 + 決済の taker 手数料・固定手数料 + 半スプレッド) へ引き上げる (0 または 0.2〜3、既定 0.5。0 で無効)。
   * 一度引き上げたら戻さない (決済計画に保存)。決済理由は trailing (TradeRecord.breakevenStopExit)
   */
  BREAKEVEN_TRIGGER_R: checkedNum(
    "BREAKEVEN_TRIGGER_R", 0.5, (x) => x === 0 || (x >= 0.2 && x <= 3),
    "0 (無効) または 0.2 以上 3 以下の R で指定してください (この R だけ有利に動いたらストップを建値 (往復コスト込み) へ引き上げる)",
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
  SCALP_LOOP_MS: num(2_500),
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
};


/** 使うクラスの上限の環境変数 (MAX_EXPOSURE_<CLASS>) */
function exposureEnvShape(classes: readonly AssetClass[]) {
  return Object.fromEntries(classes.map((c) => [exposureEnvKey(c), riskEnv(exposureSettingKey(c))])) as Record<string, ReturnType<typeof riskEnv>>;
}

type CoreStaticShape = typeof coreStaticShape;
/** コアの設定 (全アプリ共通の環境変数を解析した値)。コアのモジュールはこれだけを読む */
export type CoreEnv = z.infer<z.ZodObject<CoreStaticShape>> & { [k: `MAX_EXPOSURE_${string}`]: number };

/** 起動の設定 (環境変数の解析結果 + 実弾の判定 + リスク上限 + AI)。E はアプリの環境変数を足した型 */
export interface AppConfig<E extends CoreEnv = CoreEnv> {
  env: E;
  mode: "paper" | "live";
  liveBlockedReason?: string;
  risk: RiskLimits;
  ai: { apiKey: string; model: string; enabled: boolean };
  /** アプリが使う資産クラス */
  assetClasses: readonly AssetClass[];
}

/**
 * 実弾 (live) の判定 (二重ロック)。TRADING_MODE=live と LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY_RISK が揃ったときだけ live。
 * テスト (NODE_ENV=test) では常に paper。この判定はコアにだけ置く (アプリで再定義しない)
 */
export function resolveMode(env: Pick<CoreEnv, "NODE_ENV" | "TRADING_MODE" | "LIVE_TRADING_CONFIRM">): {
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

/** コアの環境変数の名前 (アプリの shape・defaults で再定義できない)。資産クラスの上限は語彙の全クラスぶん */
export const CORE_ENV_KEYS: readonly string[] = [...Object.keys(coreStaticShape), ...ASSET_CLASSES.map(exposureEnvKey)];
/** 実弾の二重ロックの鍵 (アプリの defaults でも既定値を変えられない) */
const LIVE_LOCK_KEYS = ["NODE_ENV", "TRADING_MODE", "LIVE_TRADING_CONFIRM"] as const;

/** 環境変数の解析の誤りを読める文章にして例外にする */
function parseEnvOrThrow<T>(schema: z.ZodType<T>, source: Record<string, string | undefined>): T {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // 設定の誤りは JSON ではなく読める文章で出して起動を止める
    const lines = parsed.error.issues.map((i) => `${i.path.join(".") || "(設定)"}: ${i.message}`);
    throw new Error(`設定が不正です:\n  ${lines.join("\n  ")}`);
  }
  return parsed.data;
}

/** 環境変数の解析結果から起動の設定を組み立てる */
function buildAppConfig<E extends CoreEnv>(env: E, classes: readonly AssetClass[]): AppConfig<E> {
  const { mode, liveBlockedReason } = resolveMode(env);
  const exposure: Partial<Record<AssetClass, number>> = Object.fromEntries(classes.map((c) => [c, env[`MAX_EXPOSURE_${c.toUpperCase()}`]]));
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
    assetClasses: classes,
  };
}

export interface AppConfigDefinition<E extends CoreEnv> {
  /** アプリが使う資産クラス */
  assetClasses: readonly AssetClass[];
  /** 環境変数を解析して起動の設定を作る (不正なら読める文章の例外) */
  loadConfig(source?: Record<string, string | undefined>): AppConfig<E>;
  /** 既定値 (環境変数なし) のリスク上限 */
  defaultRisk: RiskLimits;
  /** ダッシュボード・CLI のリスク項目 (使うクラスの上限だけ) */
  riskSettingKeys: readonly RiskSettingKey[];
  /** 使わない資産クラスの上限の環境変数 (読まない。.env に残っていたら警告する) */
  unusedClassEnvKeys: readonly string[];
}

/**
 * アプリの設定を定義する (アプリの起動時に 1 回。テストの共通の前処理からも読み込む)。
 * - assetClasses: 使う資産クラス (プロセス全体で 1 組。enabledAssetClasses() が返す)
 * - shape: アプリの環境変数 (取引先・銘柄・API キーなど。envHelpers で作る)。コアのキー (CORE_ENV_KEYS) を含めたら例外
 * - defaults: コアの環境変数の既定値の上書き (文字列。例 { DB_PATH: "./data/fx.db", DASHBOARD_PORT: "8788" })。
 *   実弾の二重ロックの鍵 (NODE_ENV / TRADING_MODE / LIVE_TRADING_CONFIRM) は上書きできない (例外)
 */
export function defineAppConfig<S extends z.ZodRawShape>(o: {
  assetClasses: readonly AssetClass[];
  shape: S;
  defaults?: Partial<Record<keyof CoreStaticShape, string>>;
}): AppConfigDefinition<CoreEnv & z.infer<z.ZodObject<S>>> {
  const redefined = Object.keys(o.shape).filter((k) => CORE_ENV_KEYS.includes(k));
  if (redefined.length > 0) {
    throw new Error(`アプリの設定はコアの環境変数を再定義できません: ${redefined.join(", ")} (実弾の二重ロック・リスク上限などはコアだけが読む)`);
  }
  const defaults = o.defaults ?? {};
  const badDefaults = Object.keys(defaults).filter((k) => (LIVE_LOCK_KEYS as readonly string[]).includes(k) || !(k in coreStaticShape));
  if (badDefaults.length > 0) throw new Error(`defaults で上書きできない環境変数です: ${badDefaults.join(", ")}`);
  const classes = setEnabledAssetClasses(o.assetClasses);
  const schema = z.object({ ...coreStaticShape, ...exposureEnvShape(classes), ...o.shape });
  type E = CoreEnv & z.infer<z.ZodObject<S>>;
  const loadConfig = (source: Record<string, string | undefined> = process.env): AppConfig<E> => {
    const src: Record<string, string | undefined> = { ...source };
    for (const [k, v] of Object.entries(defaults)) if (src[k] === undefined) src[k] = v;
    return buildAppConfig(parseEnvOrThrow(schema, src) as unknown as E, classes);
  };
  return {
    assetClasses: classes,
    loadConfig,
    defaultRisk: loadConfig({}).risk,
    riskSettingKeys: riskSettingKeys(classes),
    unusedClassEnvKeys: ASSET_CLASSES.filter((c) => !classes.includes(c)).map(exposureEnvKey),
  };
}

/** 既定値のリスク上限 (使うクラスの上限は RISK_SETTING_SPECS の既定値)。バックテストのサイズの既定に使う */
export function defaultRiskLimits(classes: readonly AssetClass[] = enabledAssetClasses()): RiskLimits {
  const env = parseEnvOrThrow(z.object({ ...coreStaticShape, ...exposureEnvShape(classes) }), {}) as unknown as CoreEnv;
  return buildAppConfig(env, classes).risk;
}

/** 環境変数の検証の部品 (アプリの shape もこれで作る) */
export const envHelpers = { num, ratio, count, bool, str, idList, choice, ranged, optRanged, checkedNum } as const;

/**
 * zod (コアと同じ実体)。アプリの shape は必ずこの z で作る (別の zod の実体のスキーマとコアのスキーマを合成しない)。
 * API の応答の解析だけに使うアプリの zod は、コアのスキーマと合成しない限り別の実体でもよい
 */
export { z };
