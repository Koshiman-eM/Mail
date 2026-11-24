// 環境変数からの設定読み込み
import { dirname, join, resolve } from "node:path";

export interface Config {
  dbPath: string;
  profilePath: string;
  screenshotDir: string;
  /** 送信間隔の下限・上限 (秒)。この範囲でランダムに待つ */
  minIntervalSec: number;
  maxIntervalSec: number;
  /** 1 日あたりの送信上限 */
  dailyLimit: number;
  headless: boolean;
  /** Chromium のパスを明示したい場合 (Arm 環境でシステムの chromium を使うなど) */
  chromiumPath?: string;
  /** ページ操作のタイムアウト (ms) */
  navigationTimeoutMs: number;
  /** USD/USDT/USDC → 円の換算レート (SWEEP_USDJPY)。未設定なら換算しない */
  usdJpy: number | null;
  /**
   * ブラウザ操作・収集のプロセス間ロックファイル (SWEEP_LOCK_PATH)。
   * 既定は DB と同じディレクトリの browser.lock。null ならロックしない (テスト用)
   */
  lockPath: string | null;
  /** 日次上限の「1 日」の境界に使うタイムゾーン (SWEEP_TIMEZONE、既定 Asia/Tokyo) */
  timeZone: string;
}

function num(v: string | undefined, def: number): number {
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function positiveOrNull(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function validTimeZone(v: string | undefined): string {
  const tz = v?.trim() || "Asia/Tokyo";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new Error(`SWEEP_TIMEZONE が不正です: ${tz}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dbPath = resolve(env.SWEEP_DB ?? "./data/sweep.db");
  const minIntervalSec = num(env.SWEEP_MIN_INTERVAL_SEC, 60);
  const maxIntervalSec = Math.max(minIntervalSec, num(env.SWEEP_MAX_INTERVAL_SEC, 180));
  return {
    dbPath,
    profilePath: resolve(env.SWEEP_PROFILE ?? "./profile.json"),
    screenshotDir: resolve(env.SWEEP_SCREENSHOT_DIR ?? "./data/screenshots"),
    minIntervalSec,
    maxIntervalSec,
    dailyLimit: Math.floor(num(env.SWEEP_DAILY_LIMIT, 30)),
    headless: env.SWEEP_HEADLESS !== "0" && env.SWEEP_HEADLESS !== "false",
    chromiumPath: env.SWEEP_CHROMIUM_PATH || undefined,
    navigationTimeoutMs: num(env.SWEEP_NAV_TIMEOUT_MS, 30_000),
    usdJpy: positiveOrNull(env.SWEEP_USDJPY),
    lockPath: env.SWEEP_LOCK_PATH ? resolve(env.SWEEP_LOCK_PATH) : join(dirname(dbPath), "browser.lock"),
    timeZone: validTimeZone(env.SWEEP_TIMEZONE),
  };
}
