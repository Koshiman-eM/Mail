import type { ExitReason, OrderStatus, Quote, RegimeLabel, Side, Signal, Store, TradingMode } from "../core/types";
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
  /** 読みの管理の延長後の保護ストップでの決済 (TradeRecord.thesisStopExit。約定したこの注文の判定にだけ付く) */
  thesisStop?: boolean;
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
  /** 指値のエントリー (板に置いて約定を待つ)。無ければ成行 */
  limit?: PendingLimit;
}

/**
 * 指値のエントリーを取り消す理由。expired: 期限 / opposite_signal: 逆方向のシグナル / stop_crossed: 気配が損切り価格を越えた /
 * halted: 停止 (kill switch・日次停止) / order_unknown: 状態不明の注文がある (新規を止めている) /
 * account_unavailable: 口座情報を取得できない / market_data: 気配が古い・取得に失敗した
 * (新規エントリーを止める理由はすべて、置いてある指値も取り消す。テンポの上限は置いた指値を取り消す理由にしない)
 */
export type LimitCancelReason = "expired" | "opposite_signal" | "stop_crossed" | "halted" | "order_unknown" | "account_unavailable" | "market_data";

/**
 * 指値のエントリー (板に置いて約定を待つ注文)。
 * 期限・逆方向のシグナル・損切り価格の越え・新規を止める理由 (停止・状態不明・口座・気配) で取り消し、取消の後に照会して確定させる
 * (取消と約定が競合しても、照会の累計の約定で反映する。確定しなければ既存の状態不明の経路)。
 * 状態不明のまま建玉で判定する場合も、取消に成功して照会で板に無いと確かめるまで追跡から外さない (板に残ったまま後で約定しうるため)
 */
export interface PendingLimit {
  price: number;
  /** この時刻を過ぎても約定しなければ取り消す */
  expiresAt: number;
  postOnly?: boolean;
  /** シグナルの損切り価格 (気配が越えたら取り消す) */
  stopLoss: number;
  direction: "long" | "short";
  /** 取消を依頼した理由 (syncPending が取消 → 照会で確定させる) */
  cancelReason?: LimitCancelReason;
  /** 期限切れで見送ったときの仮想トレード (limit_unfilled) の材料。シグナル時点の気配・レジーム */
  shadow?: { signal: Signal; quote: Pick<Quote, "bid" | "ask">; regime: RegimeLabel; signalTs: number };
}

/**
 * 板に置いた利確の指値 (reduceOnly)。建玉 (trade) ごとに 1 つ。kv `orders:restingTp:<mode>` に保存し、再起動後も照会・取消を続ける。
 * PendingOrders とは別に持つ (利確の指値がある間も、損切りなどの判定を止めないため)。
 * - appliedQty / appliedFee: journal に反映済みの約定の累計 (照会の累計との差分だけを反映する)
 * - exit: 損切りなどの成行の決済のために取消中。取消・照会で確定したら残りだけを成行で送る
 *   (取消に失敗・状態不明の間は成行を送らない = 過剰決済・ドテンの防止)
 */
export interface RestingTakeProfit {
  tradeId: string;
  symbol: string;
  clientId: string;
  orderId?: string;
  side: Side;
  /** 発注数量 (decimal 文字列) */
  qty: string;
  price: number;
  createdAt: number;
  status: PendingStatus | "canceling";
  appliedQty: string;
  appliedFee: string;
  appliedNotional?: string;
  appliedMaker?: string;
  appliedTaker?: string;
  lastCheckedAt?: number;
  /** 取引所が「無い」と答えた連続回数 (同じティックの照会は 1 回と数える) */
  notFound?: number;
  /** 最後に「無い」と答えられた時刻 (別のティックで続けて答えたときだけ数える) */
  notFoundAt?: number;
  /** 決済の取消中に状態不明が続いた (新規エントリーを止める) */
  escalated?: boolean;
  unknownCount: number;
  unknownSince?: number;
  lastError?: string;
  exit?: { reason: ExitReason; intendedPrice: number; requestedAt: number; thesisStop?: boolean };
  /** 取消の依頼に成功した時刻 (失敗したら次の照会の前に再度取り消す) */
  canceledAt?: number;
}

export const RESTING_TP_KEY = "orders:restingTp";
export const restingTpKey = (mode: TradingMode) => `${RESTING_TP_KEY}:${mode}`;

export class RestingTakeProfits {
  private readonly items = new Map<string, RestingTakeProfit>();
  readonly key: string;

  constructor(private readonly opts: { store?: Store; mode: TradingMode }) {
    this.key = restingTpKey(opts.mode);
    const saved = opts.store?.kvGet<RestingTakeProfit[]>(this.key);
    for (const o of Array.isArray(saved) ? saved : []) {
      if (o && typeof o.tradeId === "string" && typeof o.clientId === "string" && typeof o.symbol === "string") this.items.set(o.tradeId, o);
    }
  }

  private persist(): void {
    this.opts.store?.kvSet(this.key, [...this.items.values()]);
  }

  list(): RestingTakeProfit[] {
    return [...this.items.values()].map((o) => ({ ...o }));
  }

  get(tradeId: string): RestingTakeProfit | undefined {
    const o = this.items.get(tradeId);
    return o ? { ...o } : undefined;
  }

  get size(): number {
    return this.items.size;
  }

  upsert(o: RestingTakeProfit): void {
    this.items.set(o.tradeId, { ...o });
    this.persist();
  }

  remove(tradeId: string): void {
    if (this.items.delete(tradeId)) this.persist();
  }
}

/** 指値の約定率の集計 (kv `orders:limitStats:<mode>`)。status / report / simulate が表示する */
export interface LimitStats {
  /** 指値のエントリー: 置いた / 全量約定 / 一部約定 (残りは取消) / 期限切れ (約定なし) / 取消 (理由別) / 拒否 (post-only など) */
  entryPlaced: number;
  entryFilled: number;
  entryPartial: number;
  entryExpired: number;
  entryCanceled: Partial<Record<Exclude<LimitCancelReason, "expired">, number>>;
  entryRejected: number;
  /** 利確の指値: 置いた / 約定 (全量) / 一部約定 / 決済のために取消 / 拒否 */
  tpPlaced: number;
  tpFilled: number;
  tpPartial: number;
  tpCanceled: number;
  tpRejected: number;
  since?: number;
}

export const LIMIT_STATS_KEY = "orders:limitStats";
export const limitStatsKey = (mode: TradingMode) => `${LIMIT_STATS_KEY}:${mode}`;

export const emptyLimitStats = (): LimitStats => ({
  entryPlaced: 0, entryFilled: 0, entryPartial: 0, entryExpired: 0, entryCanceled: {}, entryRejected: 0,
  tpPlaced: 0, tpFilled: 0, tpPartial: 0, tpCanceled: 0, tpRejected: 0,
});

/** 保存された集計を読む (無い・壊れていれば空) */
export function readLimitStats(store: Pick<Store, "kvGet">, mode: TradingMode): LimitStats {
  const v = store.kvGet<LimitStats>(limitStatsKey(mode));
  if (!v || typeof v !== "object") return emptyLimitStats();
  return { ...emptyLimitStats(), ...v, entryCanceled: { ...(v.entryCanceled ?? {}) } };
}

/** 集計に加える (保存する) */
export function bumpLimitStats(store: Pick<Store, "kvGet" | "kvSet"> | undefined, mode: TradingMode, now: number, fn: (s: LimitStats) => void): void {
  if (!store) return;
  const s = readLimitStats(store, mode);
  s.since ??= now;
  fn(s);
  store.kvSet(limitStatsKey(mode), s);
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
