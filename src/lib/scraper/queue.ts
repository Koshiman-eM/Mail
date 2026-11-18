import type { Platform } from "@prisma/client";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../env";
import { defaultJobOptions, jitterMs, queueName, type ScrapeJobData } from "./policy";

const g = globalThis as unknown as { __scrapeConn?: IORedis; __scrapeQueues?: Map<Platform, Queue<ScrapeJobData>> };

export function redisConnection(): IORedis {
  if (!env.redisUrl) throw new Error("REDIS_URL が未設定です");
  return (g.__scrapeConn ??= new IORedis(env.redisUrl, { maxRetriesPerRequest: null }));
}

export function scrapeQueue(platform: Platform): Queue<ScrapeJobData> {
  const map = (g.__scrapeQueues ??= new Map());
  let q = map.get(platform);
  if (!q) {
    q = new Queue<ScrapeJobData>(queueName(platform), { connection: redisConnection(), defaultJobOptions: defaultJobOptions() });
    map.set(platform, q);
  }
  return q;
}

/** ジッター付きでスクレイピングジョブを投入する */
export async function enqueueScrape(data: ScrapeJobData) {
  return scrapeQueue(data.platform).add("scrape", data, { delay: jitterMs() });
}
