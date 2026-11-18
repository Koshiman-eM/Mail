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
  get geminiApiKey() {
    return process.env.GEMINI_API_KEY || undefined;
  },
  get geminiModel() {
    return process.env.GEMINI_MODEL || "gemini-2.5-flash";
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
  get scraperStorageStatePath() {
    return process.env.SCRAPER_STORAGE_STATE_PATH || undefined;
  },
  get operatorName() {
    return process.env.APP_OPERATOR_NAME || "operator";
  },
};
