import type { OrderBook, Quote, TradePrint } from "../core/types";

/**
 * 板・約定の特徴量 (純粋関数)。スキャルピング戦略で使う。
 */

/**
 * 板不均衡: 上位 depth 段の (買い数量 - 売り数量) / 合計。-1 (売り優勢) 〜 1 (買い優勢)。
 * 板が空なら 0。
 */
export function orderBookImbalance(book: OrderBook, depth = 5): number {
  const d = Math.max(1, Math.round(depth));
  let b = 0;
  let a = 0;
  for (let i = 0; i < Math.min(d, book.bids.length); i++) b += book.bids[i][1];
  for (let i = 0; i < Math.min(d, book.asks.length); i++) a += book.asks[i][1];
  const t = b + a;
  return t > 0 ? (b - a) / t : 0;
}

/**
 * マイクロプライス: 最良気配の数量で重み付けした中値。
 * (bid × askSize + ask × bidSize) / (bidSize + askSize)。買い板が厚いほど ask 寄りになる。
 * 片側が空なら NaN。
 */
export function microprice(book: OrderBook): number {
  if (book.bids.length === 0 || book.asks.length === 0) return NaN;
  const [bid, bs] = book.bids[0];
  const [ask, as] = book.asks[0];
  const t = bs + as;
  if (!(t > 0)) return (bid + ask) / 2;
  return (bid * as + ask * bs) / t;
}

/** 中値 (片側が無効なら NaN) */
export function midPrice(q: Pick<Quote, "bid" | "ask">): number {
  return q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : NaN;
}

/** スプレッド (bps, 中値比)。気配が無効なら NaN */
export function spreadBps(q: Pick<Quote, "bid" | "ask">): number {
  const m = midPrice(q);
  if (!(m > 0)) return NaN;
  return ((q.ask - q.bid) / m) * 1e4;
}

/**
 * 約定フロー不均衡: (now - windowMs, now] の約定について (買い主導量 - 売り主導量) / 合計。
 * -1〜1。該当なしなら 0。
 */
export function tradeFlowImbalance(prints: readonly TradePrint[], windowMs: number, now: number): number {
  const from = now - windowMs;
  let buy = 0;
  let sell = 0;
  for (const p of prints) {
    if (p.ts <= from || p.ts > now) continue;
    if (p.side === "buy") buy += p.size;
    else sell += p.size;
  }
  const t = buy + sell;
  return t > 0 ? (buy - sell) / t : 0;
}
