import type { Platform } from "@prisma/client";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import { env } from "../lib/env";
import { ProductNotFoundError, scrapeProduct } from "../lib/jobs/scrapeProduct";
import { createFetcher, type PageFetcher } from "../lib/scraper/fetcher";
import { RATE_LIMIT, queueName, type ScrapeJobData } from "../lib/scraper/policy";
import { redisConnection, scrapeQueue } from "../lib/scraper/queue";

/**
 * BullMQ ワーカー (REDIS_URL 設定時のみ)。取得〜保存の本体は lib/jobs/scrapeProduct (Redis なしの定期ジョブと共用)。
 * ここではジッター (投入時)・同時実行数・レート制限・指数バックオフ (BullMQ の attempts/backoff) を担う。
 */
let fetcherPromise: Promise<PageFetcher> | undefined;
const getFetcher = () => (fetcherPromise ??= createFetcher(undefined, "playwright"));

async function processJob(job: Job<ScrapeJobData>) {
  const { productId, platform } = job.data;
  let result;
  try {
    result = await scrapeProduct(productId, await getFetcher());
  } catch (e) {
    if (e instanceof ProductNotFoundError) throw new UnrecoverableError(e.message);
    throw e;
  }

  if (result.status === "blocked") {
    // DB 上の停止 (ScraperState) と再認証通知は scrapeProduct 済み。キューも止め、ジョブは再開後に処理されるよう再投入する
    const q = scrapeQueue(platform);
    await q.pause();
    await q.add("scrape", job.data);
    if (result.kind === "paused") return { skipped: "paused" }; // 停止中に紛れ込んだジョブはリトライを消費させない
    throw new UnrecoverableError(result.note);
  }
  if (result.status === "failed") {
    if (result.retryable) throw new Error(result.note); // → 指数バックオフでリトライ
    throw new UnrecoverableError(result.note);
  }
  return { events: result.events, auto: result.auto };
}

export function startScrapeWorkers(platforms: Platform[]) {
  return platforms.map((p) => {
    const w = new Worker<ScrapeJobData>(queueName(p), processJob, {
      connection: redisConnection(),
      concurrency: env.scrapeConcurrency,
      limiter: RATE_LIMIT,
    });
    w.on("failed", (job, err) => console.warn(`[scrape:${p}] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message));
    return w;
  });
}

export async function closeFetcher() {
  if (fetcherPromise) await (await fetcherPromise).close();
}
