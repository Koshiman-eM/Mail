/**
 * 定期ジョブ (1 回実行して終了)。GitHub Actions などのスケジューラーから `npm run jobs:once` で起動する。
 * Redis / BullMQ は不要。
 *   1. 停止中でないプラットフォームについて、watch=true かつ最終取得から SCRAPE_MIN_INTERVAL_HOURS (既定 6) 以上経った商品を
 *      ランダムな順序・ランダムな間隔で 1 件ずつ取得 (CAPTCHA 等を検知したらそのプラットフォームは停止して打ち切り)
 *      取得は JOBS_SCRAPE_BUDGET_MIN (既定 18 分) までで打ち切り、残りは次回に回す (ワークフローの 30 分制限内に収めるため)
 *   2. 全商品の利益を再計算 (為替の反映)。取得が想定外のエラーで止まっても必ず実行する
 * 一部の商品が失敗しても終了コードは 0。想定外のクラッシュ時のみ 1。
 *
 * オプション: --max-products N  (1 回の実行で取得する最大件数。安全のため)
 *            --skip-recalc      (利益の再計算を行わない)
 */
import { prisma } from "../lib/db/prisma";
import { env } from "../lib/env";
import { pausedPlatforms } from "../lib/jobs/pause";
import { backoffMs, formatSummary, parseJobArgs, requestDelayMs, runScheduledScrape, scrapeBudgetMinutes, selectDueProducts } from "../lib/jobs/runner";
import { scrapeProduct } from "../lib/jobs/scrapeProduct";
import { recalcAll } from "../lib/profit/autoService";
import { flushPendingPushes } from "../lib/push/send";
import { createFetcher, type PageFetcher } from "../lib/scraper/fetcher";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const minIntervalHours = () => {
  const n = Number(process.env.SCRAPE_MIN_INTERVAL_HOURS);
  return Number.isFinite(n) && n >= 0 && process.env.SCRAPE_MIN_INTERVAL_HOURS ? n : 6;
};

/** 作成したブラウザ等は途中で例外になっても main() の finally で閉じる */
const resources: { fetcher?: PageFetcher } = {};

async function scrapeDue(args: { maxProducts?: number }, deadline: number): Promise<void> {
  const paused = await pausedPlatforms();
  if (paused.size) console.log(`[jobs] 停止中のため対象外: ${[...paused].join(", ")}`);
  const products = await prisma.product.findMany({ where: { watch: true }, select: { id: true, platform: true, watch: true, lastFetchedAt: true } });
  const groups = selectDueProducts(products, { now: new Date(), minIntervalHours: minIntervalHours(), paused, maxProducts: args.maxProducts });
  const dueCount = [...groups.values()].reduce((a, g) => a + g.length, 0);
  console.log(`[jobs] 巡回対象 ${dueCount} 件 / 監視中 ${products.length} 件`);

  if (dueCount > 0) {
    const mode = env.scraperMode ?? "playwright";
    console.log(`[jobs] 取得方法: ${mode} / 取得の制限時間: ${Math.round((deadline - Date.now()) / 60_000)} 分`);
    const f = await createFetcher(mode);
    resources.fetcher = f;
    const summaries = await runScheduledScrape(groups, {
      scrape: (id) => scrapeProduct(id, f),
      sleep,
      delayMs: () => requestDelayMs(),
      backoffMs: (attempt) => backoffMs(attempt, Math.min(env.scrapeBackoffBaseMs, 60_000)),
      maxRetries: 2,
      log: (m) => console.log(m),
      shouldStop: () => Date.now() >= deadline,
    });
    console.log(formatSummary(summaries));
  } else {
    console.log(formatSummary([]));
  }
}

async function main() {
  const args = parseJobArgs(process.argv.slice(2));
  const started = Date.now();
  const deadline = started + scrapeBudgetMinutes() * 60_000;
  let scrapeError: unknown;
  try {
    try {
      await scrapeDue(args, deadline);
    } catch (e) {
      // 取得で想定外のエラーが起きても、利益の再計算と通知送信は行う (終了コードは最後に 1 にする)
      scrapeError = e;
      console.error("[jobs] 巡回中に想定外のエラー:", e);
    }

    if (!args.skipRecalc) {
      const r = await recalcAll("fx.refresh");
      console.log(`[jobs] 利益を再計算: ${r.total} 件 (OK ${r.OK}, 変化なし ${r.UNCHANGED}, 情報不足 ${r.SKIPPED}, エラー ${r.ERROR})`);
    }
    console.log(`[jobs] 完了 (${Math.round((Date.now() - started) / 1000)} 秒)`);
    if (scrapeError) throw scrapeError;
  } finally {
    await resources.fetcher?.close().catch((e) => console.warn("[jobs] fetcher close failed:", e));
    // notify() はバックグラウンドで Web Push を送るため、終了前に送信完了を待つ (最大 10 秒)
    await flushPendingPushes().catch((e) => console.warn("[jobs] push flush failed:", e));
    await prisma.$disconnect().catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0)) // 通知バスの Redis 接続等が残っていても確実に終了する
  .catch((e) => {
    console.error("[jobs] 想定外のエラー:", e);
    process.exit(1);
  });
