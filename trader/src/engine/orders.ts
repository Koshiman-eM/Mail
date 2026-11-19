import type { ExitReason, OrderStatus, Side, Store, TradingMode } from "../core/types";
import type { OpenTradeInput } from "../learning/journal";
import type { ExitPlan } from "./positions";

/**
 * 保留中の注文 (受付済み・未約定、または例外で状態不明の注文)。
 * 確定 (filled / canceled / rejected) するまで journal に反映せず、同じ銘柄へ新たな注文を出さない。
 * kv `orders:pending:<mode>` に保存し、再起動後も照会を続ける。
 */

export const PENDING_ORDERS_KEY = "orders:pending";
export const pendingOrdersKey = (mode: TradingMode) => `${PENDING_ORDERS_KEY}:${mode}`;

/** submitting: 発注前に書き込んだ状態 (発注中に停止しても clientId で照会できるように) / unknown: 状態不明 */
export type PendingStatus = OrderStatus | "submitting" | "unknown";

/** エントリーの約定後に journal へ登録する内容 (数量・価格・手数料は約定から決める) */
export interface PendingEntry {
  input: Omit<OpenTradeInput, "qty" | "entryPrice" | "entryFees">;
  plan: ExitPlan;
  /** engine.entry の監査ログに載せる追加情報 */
  audit: Record<string, unknown>;
}

export interface PendingExit {
  tradeId: string;
  reason: ExitReason;
  intendedPrice: number;
}

export interface PendingOrder {
  clientId: string;
  /** 例外で発注結果が得られなかった場合は未設定 (clientId で照会する) */
  orderId?: string;
  symbol: string;
  side: Side;
  /** 発注数量 (decimal 文字列) */
  qty: string;
  kind: "entry" | "exit";
  createdAt: number;
  status: PendingStatus;
  /** 状態不明 (発注・照会の例外、見つからない、約定価格の欠落など) が連続した回数と開始時刻 */
  unknownCount: number;
  unknownSince?: number;
  lastError?: string;
  lastCheckedAt?: number;
  cancelRequestedAt?: number;
  /** kill switch を発動済み (二重に発動しない) */
  escalated?: boolean;
  entry?: PendingEntry;
  exit?: PendingExit;
}

export const isFinalStatus = (s: PendingStatus): s is "filled" | "canceled" | "rejected" =>
  s === "filled" || s === "canceled" || s === "rejected";

export class PendingOrders {
  private readonly orders = new Map<string, PendingOrder>();
  readonly key: string;

  constructor(private readonly opts: { store?: Store; mode: TradingMode }) {
    this.key = pendingOrdersKey(opts.mode);
    const saved = opts.store?.kvGet<PendingOrder[]>(this.key);
    for (const o of Array.isArray(saved) ? saved : []) {
      if (o && typeof o.clientId === "string" && typeof o.symbol === "string") this.orders.set(o.clientId, o);
    }
  }

  get mode(): TradingMode {
    return this.opts.mode;
  }

  private persist(): void {
    this.opts.store?.kvSet(this.key, [...this.orders.values()]);
  }

  list(): PendingOrder[] {
    return [...this.orders.values()].map((o) => ({ ...o }));
  }

  get(clientId: string): PendingOrder | undefined {
    const o = this.orders.get(clientId);
    return o ? { ...o } : undefined;
  }

  get size(): number {
    return this.orders.size;
  }

  /** 銘柄に保留中の注文があるか */
  hasSymbol(symbol: string): boolean {
    for (const o of this.orders.values()) if (o.symbol === symbol) return true;
    return false;
  }

  /** 追加または更新して保存する */
  upsert(o: PendingOrder): void {
    this.orders.set(o.clientId, { ...o });
    this.persist();
  }

  remove(clientId: string): void {
    if (this.orders.delete(clientId)) this.persist();
  }
}
