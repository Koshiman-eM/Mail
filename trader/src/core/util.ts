/** 小さな共通の補助関数 (純粋関数・待機) */
import type { Quote } from "./types";

/** lo〜hi に収める。NaN はそのまま NaN を返す (Math.min / Math.max と同じ) */
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** lo〜hi に収める。非有限 (NaN・±Infinity) は 0 */
export const clampOrZero = (x: number, lo: number, hi: number): number => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : 0);

/** 気配の仲値 ((bid + ask) / 2。気配の妥当性は確かめない) */
export const quoteMid = (q: Quote): number => (q.bid + q.ask) / 2;

/** UTC の日付 (YYYY-MM-DD) */
export const isoDayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/** 既定の待機 (setTimeout)。テストでは注入した sleep に差し替える */
export const defaultSleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
