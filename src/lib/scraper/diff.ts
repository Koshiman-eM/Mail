import { D } from "../decimal";
import type { PriceTier } from "../profit/types";

export interface SnapshotLike {
  priceTiers: PriceTier[];
  moq: number;
  inStock: boolean;
}

export interface ChangeEvent {
  kind: "PRICE_CHANGE" | "STOCK_CHANGE";
  severity: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  body: string;
}

const lowestPrice = (tiers: PriceTier[]) =>
  tiers.reduce((min, t) => (min === null || new D(t.unitPrice).lt(min) ? new D(t.unitPrice) : min), null as InstanceType<typeof D> | null);

/**
 * 前回スナップショットとの差分から通知イベントを生成する。
 * thresholdPercent 以上の価格変動、在庫切れ/復活、MOQ 変更を検知。
 */
export function diffSnapshots(prev: SnapshotLike | null, next: SnapshotLike, productTitle: string, thresholdPercent = 3): ChangeEvent[] {
  if (!prev) return [];
  const events: ChangeEvent[] = [];

  const a = lowestPrice(prev.priceTiers);
  const b = lowestPrice(next.priceTiers);
  if (a && b && !a.isZero()) {
    const change = b.sub(a).div(a).mul(100);
    if (change.abs().gte(thresholdPercent)) {
      const up = change.isPositive();
      events.push({
        kind: "PRICE_CHANGE",
        severity: up && change.gte(10) ? "CRITICAL" : up ? "WARNING" : "INFO",
        title: `${productTitle}: 価格が${up ? "上昇" : "下落"} (${change.toFixed(1)}%)`,
        body: `最安段階単価 ${a.toString()} → ${b.toString()}`,
      });
    }
  }

  if (prev.inStock !== next.inStock) {
    events.push({
      kind: "STOCK_CHANGE",
      severity: next.inStock ? "INFO" : "CRITICAL",
      title: `${productTitle}: ${next.inStock ? "在庫が復活しました" : "在庫切れになりました"}`,
      body: "",
    });
  }

  if (prev.moq !== next.moq) {
    events.push({
      kind: "PRICE_CHANGE",
      severity: next.moq > prev.moq ? "WARNING" : "INFO",
      title: `${productTitle}: MOQ が変更されました`,
      body: `${prev.moq} → ${next.moq}`,
    });
  }
  return events;
}
