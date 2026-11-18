import type { Platform, Prisma } from "@prisma/client";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import { prisma } from "../lib/db/prisma";
import { env } from "../lib/env";
import { notify } from "../lib/notifications/service";
import { detectBlock } from "../lib/scraper/detect";
import { diffSnapshots } from "../lib/scraper/diff";
import { ManualReauthRequiredError } from "../lib/scraper/errors";
import { createPlaywrightFetcher, type PageFetcher } from "../lib/scraper/fetcher";
import { parseProductPage } from "../lib/scraper/parse";
import { RATE_LIMIT, queueName, type ScrapeJobData } from "../lib/scraper/policy";
import { redisConnection, scrapeQueue } from "../lib/scraper/queue";
import type { PriceTier } from "../lib/profit/types";
import { autoSimulate } from "../lib/profit/autoService";

let fetcherPromise: Promise<PageFetcher> | undefined;
const getFetcher = () => (fetcherPromise ??= createPlaywrightFetcher());

/**
 * CAPTCHA / セッション切れ検知時の処理:
 * 自動突破はせず、該当プラットフォームのキューを一時停止し、手動再認証を促す CRITICAL 通知を出す。
 * 当該ジョブは停止中のキューへ再投入し、再開後に処理されるようにする。
 */
async function pauseForReauth(platform: Platform, err: ManualReauthRequiredError, job: Job<ScrapeJobData>) {
  const q = scrapeQueue(platform);
  await q.pause();
  await prisma.scraperState.upsert({
    where: { platform },
    create: { platform, paused: true, reason: err.message, pausedAt: new Date() },
    update: { paused: true, reason: err.message, pausedAt: new Date() },
  });
  await q.add("scrape", job.data);
  await notify({
    type: "REAUTH_REQUIRED",
    severity: "CRITICAL",
    title: `${platform}: 手動での再認証が必要です`,
    body: `${err.message}\nブラウザでログイン/認証を完了し、セッションを更新してから「再開」を押してください。`,
    link: "/settings",
    meta: { platform, kind: err.kind },
  });
}

async function processJob(job: Job<ScrapeJobData>) {
  const { productId, url, platform } = job.data;
  const state = await prisma.scraperState.findUnique({ where: { platform } });
  if (state?.paused) {
    // 停止中に紛れ込んだジョブはリトライを消費させず再投入
    await scrapeQueue(platform).add("scrape", job.data);
    return { skipped: "paused" };
  }

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new UnrecoverableError(`Product ${productId} not found`);

  const fetcher = await getFetcher();
  const page = await fetcher.fetch(url);
  const block = detectBlock({ url: page.finalUrl, html: page.html, status: page.status });
  if (block) {
    const err = new ManualReauthRequiredError(block, page.finalUrl);
    await pauseForReauth(platform, err, job);
    throw new UnrecoverableError(err.message);
  }
  if (page.status >= 500) throw new Error(`HTTP ${page.status}`); // → 指数バックオフでリトライ

  const parsed = parseProductPage(page.html, platform);
  if (parsed.priceTiers.length === 0) throw new Error("価格情報を抽出できませんでした");

  const prev = await prisma.priceSnapshot.findFirst({ where: { productId }, orderBy: { capturedAt: "desc" } });
  const next = {
    priceTiers: parsed.priceTiers,
    moq: parsed.moq ?? product.moq,
    inStock: parsed.inStock,
  };

  await prisma.$transaction([
    prisma.priceSnapshot.create({
      data: {
        productId,
        currency: parsed.currency ?? product.currency,
        priceTiers: next.priceTiers as unknown as Prisma.InputJsonValue,
        moq: next.moq,
        inStock: next.inStock,
        stockQty: parsed.stockQty,
      },
    }),
    prisma.product.update({
      where: { id: productId },
      data: { priceTiers: next.priceTiers as unknown as Prisma.InputJsonValue, moq: next.moq, inStock: next.inStock },
    }),
  ]);

  const events = diffSnapshots(
    prev ? { priceTiers: prev.priceTiers as unknown as PriceTier[], moq: prev.moq, inStock: prev.inStock } : null,
    next,
    product.titleJa ?? product.title,
  );
  for (const e of events) {
    await notify({ type: e.kind, severity: e.severity, title: e.title, body: e.body, link: `/products?id=${productId}` });
  }
  // 価格・MOQ が変わったら利益を自動再計算 (変化が無ければ autoSimulate 側で保存を省略)
  const auto = await autoSimulate(productId, "price.change");
  return { events: events.length, auto: auto.status };
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
