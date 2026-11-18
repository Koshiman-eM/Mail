import { createAmazonProvider } from "./amazon";
import { createRakutenProvider } from "./rakuten";
import type { DomesticPriceProvider } from "./types";

export * from "./types";
export { aggregateDomesticPrices, MULTIPACK_NOTE, type DomesticAggregate } from "./aggregate";

/** 国内価格の取得元 (優先順)。価格.com は公式 API が無く、スクレイピングもしないため対象外 */
export function defaultDomesticProviders(): DomesticPriceProvider[] {
  return [createRakutenProvider(), createAmazonProvider()];
}

export const KAKAKU_NOTE = "未対応: 価格.com は公式 API が無く、利用規約上スクレイピングも行わないため対象外です";

export interface ProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  note: string;
}

/** 設定画面・探索画面に出す取得元の状態 (環境変数から判定。キーの値は返さない) */
export function domesticProviderStatus(providers = defaultDomesticProviders()): ProviderStatus[] {
  return [
    ...providers.map((p) => ({ id: p.id, label: p.label, configured: p.isConfigured(), note: p.statusNote() })),
    { id: "kakaku", label: "価格.com", configured: false, note: KAKAKU_NOTE },
  ];
}
