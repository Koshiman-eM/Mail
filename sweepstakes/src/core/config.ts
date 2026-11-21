// 環境変数からの設定読み込み
import { resolve } from "node:path";

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
}

function num(v: string | undefined, def: number): number {
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const minIntervalSec = num(env.SWEEP_MIN_INTERVAL_SEC, 60);
  const maxIntervalSec = Math.max(minIntervalSec, num(env.SWEEP_MAX_INTERVAL_SEC, 180));
  return {
    dbPath: resolve(env.SWEEP_DB ?? "./data/sweep.db"),
    profilePath: resolve(env.SWEEP_PROFILE ?? "./profile.json"),
    screenshotDir: resolve(env.SWEEP_SCREENSHOT_DIR ?? "./data/screenshots"),
    minIntervalSec,
    maxIntervalSec,
    dailyLimit: Math.floor(num(env.SWEEP_DAILY_LIMIT, 30)),
    headless: env.SWEEP_HEADLESS !== "0" && env.SWEEP_HEADLESS !== "false",
    chromiumPath: env.SWEEP_CHROMIUM_PATH || undefined,
    navigationTimeoutMs: num(env.SWEEP_NAV_TIMEOUT_MS, 30_000),
  };
}
