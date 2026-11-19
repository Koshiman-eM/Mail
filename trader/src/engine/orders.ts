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
  /**
   * 状態不明が続いた (不明 maxUnknownCount 回、または maxUnknownMs)。kill switch は発動せず、
   * エンジン全体の新規エントリーだけを止め (解消すれば自動で再開)、ブローカーの建玉で確定させる
   */
  escalated?: boolean;
  escalatedAt?: number;
  /** 建玉による確定のために最後に getPositions を呼んだ時刻 */
  positionCheckAt?: number;
  /** 建玉による直前の判定 (同じ判定が 2 回続いたら確定する) */
  positionObs?: { verdict: PositionVerdict; qty: string; at: number; count?: number };
  entry?: PendingEntry;
  exit?: PendingExit;
}

/** 建玉による判定: none = 約定なし / filled = 全量約定 / partial = 一部約定 */
export type PositionVerdict = "none" | "filled" | "partial";

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

  /** 状態不明が続いている (escalated) 注文 */
  escalated(): PendingOrder[] {
    return this.list().filter((o) => o.escalated);
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

// ───────── 手動での解消 (CLI `orders resolve`) ─────────

/** 別プロセスの CLI からエンジンへ保留中の注文の解消を依頼する kv キー (mode 別) */
export const RESOLVE_REQUESTS_KEY = "orders:resolveRequests";
export const resolveRequestsKey = (mode: TradingMode) => `${RESOLVE_REQUESTS_KEY}:${mode}`;

export interface ResolveRequest {
  /** 要求の ID (処理済みの要求だけを消すため) */
  id: string;
  clientId: string;
  /** none: 約定なし / filled: 数量 qty・価格 price で約定した */
  outcome: "none" | "filled";
  /** 約定数量 (decimal 文字列, outcome = filled のとき) */
  qty?: string;
  /** 約定価格 (outcome = filled のとき) */
  price?: number;
  at: number;
  by: string;
  /** 状態不明 (escalated) ではない注文の解消を強制する (CLI `--force`) */
  force?: boolean;
}

const isResolveRequest = (v: unknown): v is ResolveRequest => {
  const r = v as ResolveRequest;
  return Boolean(r) && typeof r.id === "string" && typeof r.clientId === "string" && (r.outcome === "none" || r.outcome === "filled");
};

/** 解消の要求を追加する (動作中のエンジンは次のティック、停止中なら次回の起動時に適用する) */
export function requestResolve(store: Store, mode: TradingMode, req: ResolveRequest): void {
  const cur = peekResolveRequests(store, mode).filter((r) => r.id !== req.id);
  store.kvSet<ResolveRequest[]>(resolveRequestsKey(mode), [...cur, req]);
}

/** 解消の要求を読む (消さない) */
export function peekResolveRequests(store: Store, mode: TradingMode): ResolveRequest[] {
  const v = store.kvGet<unknown>(resolveRequestsKey(mode));
  return Array.isArray(v) ? v.filter(isResolveRequest) : [];
}

/** 処理した要求だけを消す (読んだ後に追加された要求は残す) */
export function removeResolveRequests(store: Store, mode: TradingMode, ids: string[]): void {
  if (ids.length === 0) return;
  const done = new Set(ids);
  const rest = peekResolveRequests(store, mode).filter((r) => !done.has(r.id));
  store.kvSet<ResolveRequest[] | undefined>(resolveRequestsKey(mode), rest.length ? rest : undefined);
}
