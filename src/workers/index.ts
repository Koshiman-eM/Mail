import { PLATFORMS } from "../lib/scraper/policy";
import { closeFetcher, startScrapeWorkers } from "./scrapeWorker";
import { startProfitWorker } from "./profitWorker";

async function main() {
  const scrapers = startScrapeWorkers(PLATFORMS);
  console.log(`[worker] scrape workers started: ${PLATFORMS.join(", ")}`);
  const profit = await startProfitWorker();
  console.log("[worker] profit recalculation scheduled");

  async function shutdown() {
    console.log("[worker] shutting down...");
    await Promise.all([...scrapers.map((w) => w.close()), profit.worker.close(), profit.queue.close()]);
    await closeFetcher();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
