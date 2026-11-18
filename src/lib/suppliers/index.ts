import { env } from "../env";
import type { SupplierAdapter } from "./adapter";
import { AlibabaSupplierAdapter } from "./alibabaAdapter";
import { HandoffSupplierAdapter } from "./handoffAdapter";
import { MockSupplierAdapter } from "./mockAdapter";

export * from "./adapter";
export { MockSupplierAdapter } from "./mockAdapter";
export { HandoffSupplierAdapter } from "./handoffAdapter";
export { InvalidChatUrlError, normalizeChatUrl } from "./chatUrl";

export type SupplierAdapterKind = "mock" | "handoff" | "alibaba";

/** UI に伝える送信方式。handoff: 業者アプリで本人が送る / mock: 開発用モック / external: アプリから外部送信 */
export type SendMode = "handoff" | "mock" | "external";

/**
 * 環境変数から使用するアダプター種別を決める (純粋関数)。
 *  - NODE_ENV=test: 常に mock (外部誤送信防止)
 *  - SUPPLIER_ADAPTER=handoff: どの環境でも handoff (外部 I/O なし)
 *  - SUPPLIER_ADAPTER=alibaba: production のみ alibaba (未実装スタブ)。それ以外は mock
 *  - 既定: mock
 */
export function selectSupplierAdapterKind(supplierAdapter: string, nodeEnv: string): SupplierAdapterKind {
  if (nodeEnv === "test") return "mock";
  if (supplierAdapter === "handoff") return "handoff";
  if (supplierAdapter === "alibaba" && nodeEnv === "production") return "alibaba";
  return "mock";
}

let cached: SupplierAdapter | undefined;

/**
 * 送信アダプターを取得する。
 * 外部誤送信防止のため、実アダプターは NODE_ENV=production かつ SUPPLIER_ADAPTER=alibaba の
 * 両方を満たす場合のみ返す。SUPPLIER_ADAPTER=handoff は外部送信しない「手渡し」記録用。
 * それ以外 (テスト・開発) は常に MockSupplierAdapter。
 */
export function getSupplierAdapter(): SupplierAdapter {
  if (cached) return cached;
  const kind = selectSupplierAdapterKind(env.supplierAdapter, env.nodeEnv);
  if (kind === "alibaba") cached = new AlibabaSupplierAdapter();
  else if (kind === "handoff") cached = new HandoffSupplierAdapter();
  else {
    if (env.supplierAdapter === "alibaba" || env.supplierAdapter === "handoff") {
      console.warn(`[supplier] SUPPLIER_ADAPTER=${env.supplierAdapter} は NODE_ENV=${env.nodeEnv} では無視され、Mock を使用します`);
    }
    cached = new MockSupplierAdapter();
  }
  return cached;
}

/** アダプターから UI 向けの送信方式を求める */
export function sendModeOf(adapter: SupplierAdapter): SendMode {
  if (adapter.name === "handoff") return "handoff";
  if (adapter.isExternal) return "external";
  return "mock";
}

/** テスト用リセット */
export function __resetSupplierAdapterForTest() {
  cached = undefined;
}
