import { PLATFORMS } from "../lib/scraper/policy";
import { closeFetcher, startScrapeWorkers } from "./scrapeWorker";

const workers = startScrapeWorkers(PLATFORMS);
console.log(`[worker] scrape workers started: ${PLATFORMS.join(", ")}`);

async function shutdown() {
  console.log("[worker] shutting down...");
  await Promise.all(workers.map((w) => w.close()));
  await closeFetcher();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
