import { existsSync } from "node:fs";
import { env } from "../env";

export interface FetchedPage {
  finalUrl: string;
  status: number;
  html: string;
}

export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage>;
  close(): Promise<void>;
}

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
      const page = await context.newPage();
      try {
        const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
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
