import { env } from "../env";
import type { SupplierAdapter } from "./adapter";
import { AlibabaSupplierAdapter } from "./alibabaAdapter";
import { MockSupplierAdapter } from "./mockAdapter";

export * from "./adapter";
export { MockSupplierAdapter } from "./mockAdapter";

let cached: SupplierAdapter | undefined;

/**
 * 送信アダプターを取得する。
 * 外部誤送信防止のため、実アダプターは NODE_ENV=production かつ SUPPLIER_ADAPTER=alibaba の
 * 両方を満たす場合のみ返す。それ以外 (テスト・開発) は常に MockSupplierAdapter。
 */
export function getSupplierAdapter(): SupplierAdapter {
  if (cached) return cached;
  const wantsExternal = env.supplierAdapter === "alibaba";
  if (wantsExternal && env.nodeEnv === "production") {
    cached = new AlibabaSupplierAdapter();
  } else {
    if (wantsExternal) {
      console.warn("[supplier] SUPPLIER_ADAPTER=alibaba は production 以外では無視され、Mock を使用します");
    }
    cached = new MockSupplierAdapter();
  }
  return cached;
}

/** テスト用リセット */
export function __resetSupplierAdapterForTest() {
  cached = undefined;
}
