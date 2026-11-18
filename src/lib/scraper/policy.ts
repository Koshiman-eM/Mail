import type { Platform } from "@prisma/client";
import { env } from "../env";

export const PLATFORMS: Platform[] = ["ALIBABA", "ALI1688", "ALIEXPRESS"];

/** プラットフォームごとにキューを分け、CAPTCHA 検知時に該当プラットフォームのみ停止できるようにする */
export const queueName = (p: Platform) => `scrape-${p.toLowerCase()}`;

export interface ScrapeJobData {
  productId: string;
  url: string;
  platform: Platform;
}

/** 指数バックオフ付きの既定ジョブ設定 */
export function defaultJobOptions() {
  return {
    attempts: env.scrapeMaxAttempts,
    backoff: { type: "exponential" as const, delay: env.scrapeBackoffBaseMs },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  };
}

/** 0〜max のランダムなジッター (ms)。アクセス時刻の機械的な規則性を避ける */
export function jitterMs(max = env.scrapeJitterMaxMs, rand: () => number = Math.random): number {
  return Math.floor(rand() * Math.max(0, max));
}

/** 1プラットフォームあたりのレート制限 (BullMQ limiter) */
export const RATE_LIMIT = { max: 6, duration: 60_000 };
