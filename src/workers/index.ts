import { PLATFORMS } from "../lib/scraper/policy";
import { closeFetcher, startScrapeWorkers } from "./scrapeWorker";
import { startProfitWorker } from "./profitWorker";
import { flushPendingPushes } from "../lib/push/send";

async function main() {
  const scrapers = startScrapeWorkers(PLATFORMS);
  console.log(`[worker] scrape workers started: ${PLATFORMS.join(", ")}`);
  const profit = await startProfitWorker();
  console.log("[worker] profit recalculation scheduled");

  async function shutdown() {
    console.log("[worker] shutting down...");
    await Promise.all([...scrapers.map((w) => w.close()), profit.worker.close(), profit.queue.close()]);
    await closeFetcher();
    // バックグラウンドで送信中の Web Push を送り切ってから終了
    await flushPendingPushes();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
