import { existsSync } from "node:fs";
import { env } from "../env";
import { DisallowedUrlError, createHttpFetcher } from "./httpFetcher";
import { isAllowedFetchHost, shouldAllowBrowserRequest } from "./url";
import type { FetcherMode, PageFetcher } from "./types";

export type { FetchedPage, FetcherMode, PageFetcher } from "./types";
export { createHttpFetcher } from "./httpFetcher";

/**
 * Playwright による商品ページ取得。
 * ログインセッションは手動ログインで作成した storageState (SCRAPER_STORAGE_STATE_PATH) を読み込むのみで、
 * CAPTCHA やログインの自動突破は行わない。
 */
export async function createPlaywrightFetcher(): Promise<PageFetcher> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  const storageState = env.scraperStorageStatePath && existsSync(env.scraperStorageStatePath) ? env.scraperStorageStatePath : undefined;
  const context = await browser.newContext({ storageState, locale: "en-US" });
  return {
    async fetch(url) {
      if (!isAllowedFetchHost(url)) throw new DisallowedUrlError(url);
      const page = await context.newPage();
      let blockedNavigation: string | null = null;
      await page.route("**/*", (route) => {
        const req = route.request();
        if (shouldAllowBrowserRequest(req.url(), req.resourceType())) return route.continue();
        if (req.isNavigationRequest() && req.frame() === page.mainFrame()) blockedNavigation = req.url();
        return route.abort("blockedbyclient");
      });
      try {
        let res;
        try {
          res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        } catch (e) {
          // 対応サイト外へのリダイレクトを遮断した場合は一時的なエラー (net::ERR_*) ではなく拒否として扱う
          if (blockedNavigation) throw new DisallowedUrlError(blockedNavigation, "対応サイト以外へのリダイレクトを遮断しました");
          throw e;
        }
        await page.waitForTimeout(1500);
        return { finalUrl: page.url(), status: res?.status() ?? 0, html: await page.content() };
      } finally {
        await page.close();
      }
    },
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

/**
 * 取得方法を選んで PageFetcher を作る。
 * 既定: `SCRAPER_MODE` → 未設定ならワーカー・定期ジョブは playwright (fallback 引数)。
 * Web アプリ内では Chromium が無いため httpFetcher を直接使うこと (このファイルは playwright-core を動的 import する)。
 */
export async function createFetcher(mode?: FetcherMode, fallback: FetcherMode = "playwright"): Promise<PageFetcher> {
  const m = mode ?? env.scraperMode ?? fallback;
  return m === "http" ? createHttpFetcher() : createPlaywrightFetcher();
}
