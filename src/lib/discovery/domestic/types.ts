/** 国内 (日本) の販売例 1 件 */
export interface DomesticSample {
  title: string;
  /** 税込の販売価格 (円・10 進文字列) */
  priceJpy: string;
  url: string;
  shop?: string;
}

export interface DomesticSearchResult {
  items: DomesticSample[];
}

/** 国内価格の取得元 */
export interface DomesticPriceProvider {
  id: string;
  label: string;
  /** 設定済み (呼び出し可能) か */
  isConfigured(): boolean;
  /** 未設定・未対応の理由 (画面表示用) */
  statusNote(): string;
  search(keywordJa: string): Promise<DomesticSearchResult>;
}

/** 取得元のエラー (画面に出す日本語の理由付き) */
export class DomesticProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "DomesticProviderError";
  }
}
