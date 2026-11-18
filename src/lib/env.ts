/**
 * 環境変数アクセスの集約。シークレットは必ずここ経由で取得し、コードに埋め込まない。
 * Next.js は .env.local を自動で読み込む。ワーカー (tsx) では dotenv 相当として
 * `node --env-file=.env.local` を使用する。
 */
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const env = {
  get nodeEnv() {
    return process.env.NODE_ENV ?? "development";
  },
  get redisUrl() {
    return process.env.REDIS_URL;
  },
  get anthropicApiKey() {
    return process.env.ANTHROPIC_API_KEY || undefined;
  },
  get anthropicModel() {
    return process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  },
  get supplierAdapter() {
    return (process.env.SUPPLIER_ADAPTER || "mock").toLowerCase();
  },
  get fxDefaultBufferPercent() {
    return num(process.env.FX_DEFAULT_BUFFER_PERCENT, 3);
  },
  get scrapeConcurrency() {
    return num(process.env.SCRAPE_CONCURRENCY, 2);
  },
  get scrapeMaxAttempts() {
    return num(process.env.SCRAPE_MAX_ATTEMPTS, 5);
  },
  get scrapeBackoffBaseMs() {
    return num(process.env.SCRAPE_BACKOFF_BASE_MS, 30_000);
  },
  get scrapeJitterMaxMs() {
    return num(process.env.SCRAPE_JITTER_MAX_MS, 15_000);
  },
  /** 全商品の利益を自動再計算する間隔 (為替変動の反映)。既定 6 時間 */
  get profitRecalcIntervalMs() {
    return num(process.env.PROFIT_RECALC_INTERVAL_MS, 6 * 60 * 60 * 1000);
  },
  get scraperStorageStatePath() {
    return process.env.SCRAPER_STORAGE_STATE_PATH || undefined;
  },
};
