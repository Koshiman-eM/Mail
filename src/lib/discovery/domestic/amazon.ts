import { DomesticProviderError, type DomesticPriceProvider } from "./types";

export const AMAZON_UNSUPPORTED_NOTE =
  "未対応: Product Advertising API 5.0 は 2026 年に廃止されました。後継の Creators API は売上実績のあるアソシエイトのみ利用でき、" +
  "リクエスト形式を確認できていないため実装していません (ネットワークへのアクセスは行いません)";

/** Amazon (未対応のスタブ)。設定済みにはならず、検索も行わない */
export function createAmazonProvider(): DomesticPriceProvider {
  return {
    id: "amazon",
    label: "Amazon",
    isConfigured: () => false,
    statusNote: () => AMAZON_UNSUPPORTED_NOTE,
    async search() {
      throw new DomesticProviderError("Amazon の価格取得には対応していません");
    },
  };
}
