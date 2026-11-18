export interface FetchedPage {
  finalUrl: string;
  status: number;
  html: string;
  /** 受信サイズ上限で切り捨てた場合 true */
  truncated?: boolean;
}

export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage>;
  close(): Promise<void>;
}

export type FetcherMode = "http" | "playwright";
