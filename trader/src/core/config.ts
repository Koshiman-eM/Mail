import { z } from "zod";
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

const str = (def = "") =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v.trim()));

const EnvSchema = z.object({
  NODE_ENV: str("development"),
  TRADING_MODE: str("paper"),
  LIVE_TRADING_CONFIRM: str(),
  /** 使う取引先 (カンマ区切り): synthetic, ccxt, oanda, alpaca, dex */
  VENUES: str("synthetic"),
  /** 監視銘柄 (カンマ区切り、"venue|symbol|assetClass")。空なら既定のデモ銘柄 */
  WATCHLIST: str(),
  BASE_CURRENCY: str("JPY"),
  PAPER_INITIAL_EQUITY: num(1_000_000),
  DB_PATH: str("./data/trader.db"),

  ANTHROPIC_API_KEY: str(),
  ANTHROPIC_MODEL: str("claude-opus-5-5"),

  // 暗号資産取引所 (ccxt)
  CCXT_EXCHANGE: str("bitbank"),
  CCXT_API_KEY: str(),
  CCXT_SECRET: str(),
  CCXT_PASSWORD: str(),
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
      memeMinLiquidityUsd: env.MEME_MIN_LIQUIDITY_USD,
    },
    ai: { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL, enabled: env.ANTHROPIC_API_KEY !== "" },
  };
}

export const DEFAULT_RISK: RiskLimits = loadConfig({}).risk;
