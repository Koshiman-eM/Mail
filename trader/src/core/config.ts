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
  RISK_PER_TRADE: ratio("RISK_PER_TRADE", 0.005, 0.05),
  MAX_DAILY_LOSS: ratio("MAX_DAILY_LOSS", 0.03, 0.2),
  MAX_DRAWDOWN: ratio("MAX_DRAWDOWN", 0.15, 0.5),
  MAX_OPEN_POSITIONS: count("MAX_OPEN_POSITIONS", 8, 100),
  MAX_POSITION_PCT: ratio("MAX_POSITION_PCT", 0.2, 1),
  MAX_ORDERS_PER_MINUTE: count("MAX_ORDERS_PER_MINUTE", 30, 1000),
  MIN_EDGE_TO_COST: num(2),
  MAX_EXPOSURE_CRYPTO: ratio("MAX_EXPOSURE_CRYPTO", 0.6, 1),
  MAX_EXPOSURE_MEME: ratio("MAX_EXPOSURE_MEME", 0.05, 1),
  MAX_EXPOSURE_FX: ratio("MAX_EXPOSURE_FX", 0.6, 1),
  MAX_EXPOSURE_STOCK: ratio("MAX_EXPOSURE_STOCK", 0.6, 1),
  MEME_MIN_LIQUIDITY_USD: num(250_000),

  // ループ間隔
  SCALP_LOOP_MS: num(5_000),
  INTEL_LOOP_MS: num(900_000),
  LEARN_LOOP_MS: num(3_600_000),
  DASHBOARD_PORT: num(8787),
  /** ダッシュボードの bind 先 (既定はローカルのみ) */
  DASHBOARD_HOST: str("127.0.0.1"),
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
