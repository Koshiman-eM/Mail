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
  /**
   * 商品ページの取得方法: "http" (通常の HTTP 取得。軽量で無料サーバーでも動く) / "playwright" (ヘッドレスブラウザ)。
   * 未設定時は Redis ワーカー・定期ジョブでは playwright、Web アプリ内の即時取得では http を使う。
   */
  get scraperMode(): "http" | "playwright" | undefined {
    const v = (process.env.SCRAPER_MODE || "").toLowerCase();
    return v === "http" || v === "playwright" ? v : undefined;
  },
  /** Web Push (VAPID)。未設定ならアプリが鍵を自動生成して DB (AppSecret) に保存する */
  get vapidPublicKey() {
    return process.env.VAPID_PUBLIC_KEY || undefined;
  },
  get vapidPrivateKey() {
    return process.env.VAPID_PRIVATE_KEY || undefined;
  },
  get vapidSubject() {
    return process.env.VAPID_SUBJECT || "mailto:admin@example.invalid";
  },
  /** 公開 URL (通知のリンク等に使用。例: https://sedori.onrender.com) */
  get appUrl() {
    return process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || undefined;
  },
  get scraperStorageStatePath() {
    return process.env.SCRAPER_STORAGE_STATE_PATH || undefined;
  },
  /**
   * 楽天市場 商品検索 API (2026 年の新 API: openapi.rakuten.co.jp)。applicationId と accessKey、登録したサイト URL の Referer が必要。
   * エンドポイント・パラメーター名は公開情報からの推測で未検証のため、RAKUTEN_ITEM_SEARCH_URL で上書きできる。
   */
  get rakutenApplicationId() {
    return process.env.RAKUTEN_APPLICATION_ID?.trim() || undefined;
  },
  get rakutenAccessKey() {
    return process.env.RAKUTEN_ACCESS_KEY?.trim() || undefined;
  },
  /** 楽天 API に送る Referer (Rakuten Developers に登録したサイト URL)。未設定なら APP_URL / RENDER_EXTERNAL_URL */
  get rakutenReferer() {
    return process.env.RAKUTEN_REFERER?.trim() || process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || undefined;
  },
  get rakutenItemSearchUrl() {
    return process.env.RAKUTEN_ITEM_SEARCH_URL?.trim() || undefined;
  },
  /** accessKey の渡し方: param (クエリ) / header (Authorization: Bearer) / both (既定: 両方) */
  get rakutenAccessKeyMode(): "param" | "header" | "both" {
    const v = (process.env.RAKUTEN_ACCESS_KEY_MODE || "").toLowerCase();
    return v === "param" || v === "header" ? v : "both";
  },
  /** 定期ジョブで自動探索に使える時間 (分)。既定 8 分 */
  get discoveryBudgetMinutes() {
    const raw = process.env.JOBS_DISCOVERY_BUDGET_MIN;
    const n = Number(raw);
    return raw && raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : 8;
  },
};
