import { Queue, Worker } from "bullmq";
import { env } from "../lib/env";
import { recalcAll } from "../lib/profit/autoService";
import { redisConnection } from "../lib/scraper/queue";

const QUEUE = "profit-recalc";

/** 定期的に全商品の利益を再計算し、為替の変動を反映する */
export async function startProfitWorker() {
  const queue = new Queue(QUEUE, { connection: redisConnection() });
  await queue.upsertJobScheduler("fx-refresh", { every: env.profitRecalcIntervalMs }, { name: "recalc-all", opts: { removeOnComplete: 50, removeOnFail: 50 } });
  const worker = new Worker(QUEUE, async () => recalcAll("fx.refresh"), { connection: redisConnection(), concurrency: 1 });
  worker.on("completed", (_job, r) => console.log("[profit] recalculated", r));
  worker.on("failed", (_job, err) => console.warn("[profit] recalc failed:", err.message));
  return { queue, worker };
}
