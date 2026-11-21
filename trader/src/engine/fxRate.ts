/**
 * USD→JPY の日次のレート (キー不要の frankfurter.app。欧州中央銀行の参照レート、営業日に 1 回更新)。
 *
 * - `GET https://api.frankfurter.app/latest?from=USD&to=JPY` → `{ amount, base, date: "YYYY-MM-DD", rates: { JPY: number } }`。
 * - 1 時間ごとに取り直し (engine の定期の処理)、最後に取れた値を kv `fx:usdjpy` に保存する (再起動直後もその値を使う)。
 * - 換算 (src/engine/fx.ts) には "USD/JPY" の気配として渡す (bid = ask = レート、ts = 最後に取れた時刻)。
 *   1 度も取れていなければ気配を返さず、fx.ts は従来どおり概算表 (1 USD = 150 JPY、source "fallback") を使う。
 * - paper はこのレートで換算する (気配の古さでは止めない。paper の新規エントリーは fxApproxReason を見ない)。
 *   live は従来どおり fxApproxReason が概算表・古い気配 (5 分超) を拒否する。日次のレートは live の「新しい気配」には当たらないので、
 *   live (Jupiter の実弾) では別のレートの取得元が要る (いまは live の発注先が無い)。
 * - fetch は注入できる (テストはフィクスチャ。完全オフライン)。
 */
import { fetchWithRetry, redactedErrMsg } from "../core/http";
import type { Quote, Store } from "../core/types";

const FRANKFURTER_USDJPY_URL = "https://api.frankfurter.app/latest?from=USD&to=JPY";
export const FX_USDJPY_KV_KEY = "fx:usdjpy";
export const FX_RATE_REFRESH_MS = 3_600_000;
/** 換算に渡すシンボル (fx.ts は USD/JPY を直接の気配として読む) */
const FX_RATE_SYMBOL = "USD/JPY";

export interface FxDailyRate {
  /** 1 USD あたりの JPY */
  rate: number;
  /** レートの日付 (応答の date) */
  date: string;
  /** 取得した時刻 (ミリ秒) */
  fetchedAt: number;
}

/** 応答を読む (純粋関数)。形が違えば例外 */
export function parseFrankfurter(raw: unknown): { rate: number; date: string } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const rates = o?.rates && typeof o.rates === "object" ? (o.rates as Record<string, unknown>) : undefined;
  const rate = typeof rates?.JPY === "number" ? rates.JPY : typeof rates?.JPY === "string" ? Number(rates.JPY) : NaN;
  if (!(Number.isFinite(rate) && rate > 10 && rate < 10_000)) throw new Error(`frankfurter: rates.JPY が不正です (${String(rates?.JPY)})`);
  const date = typeof o?.date === "string" ? o.date : "";
  return { rate, date };
}

export interface UsdJpyRateSourceOptions {
  store?: Pick<Store, "kvGet" | "kvSet">;
  fetchImpl?: typeof fetch;
  now?: () => number;
  url?: string;
  /** 取り直しの間隔 (既定 1 時間) */
  refreshMs?: number;
  timeoutMs?: number;
  /** 再試行の待ち (テストは即時) */
  sleep?: (ms: number) => Promise<void>;
  onWarn?: (msg: string, data?: Record<string, unknown>) => void;
}

export class UsdJpyRateSource {
  private last?: FxDailyRate;
  private lastAttemptAt?: number;
  private lastError?: string;
  private inflight?: Promise<FxDailyRate | undefined>;
  private readonly now: () => number;
  readonly refreshMs: number;

  constructor(private readonly o: UsdJpyRateSourceOptions = {}) {
    this.now = o.now ?? Date.now;
    this.refreshMs = o.refreshMs ?? FX_RATE_REFRESH_MS;
    const saved = o.store?.kvGet<FxDailyRate>(FX_USDJPY_KV_KEY);
    if (saved && Number.isFinite(saved.rate) && saved.rate > 0 && Number.isFinite(saved.fetchedAt)) this.last = { ...saved };
  }

  /** 最後に取れたレート (無ければ undefined = 概算表) */
  current(): FxDailyRate | undefined {
    return this.last ? { ...this.last } : undefined;
  }

  status(): { rate?: number; date?: string; fetchedAt?: number; lastError?: string } {
    return { ...(this.last ?? {}), ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  /** 換算用の気配 (USD/JPY のときだけ) */
  quote(symbol: string): Quote | undefined {
    if (symbol !== FX_RATE_SYMBOL || !this.last) return undefined;
    const r = this.last.rate;
    return { ts: this.last.fetchedAt, bid: r, ask: r, last: r };
  }

  /** 前回の試行から refreshMs 以上経っていれば (force なら常に) 取り直す。失敗しても例外にしない (最後の値を使い続ける) */
  async refresh(force = false): Promise<FxDailyRate | undefined> {
    const t = this.now();
    if (!force && this.lastAttemptAt !== undefined && t - this.lastAttemptAt < this.refreshMs) return this.current();
    if (this.inflight) return this.inflight;
    this.lastAttemptAt = t;
    const p = (async () => {
      try {
        const res = await fetchWithRetry(this.o.url ?? FRANKFURTER_USDJPY_URL, {
          method: "GET",
          headers: { accept: "application/json" },
          retries: 2,
          timeoutMs: this.o.timeoutMs ?? 10_000,
          ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
          ...(this.o.sleep ? { sleep: this.o.sleep } : {}),
        });
        const { rate, date } = parseFrankfurter(JSON.parse(await res.text()));
        this.last = { rate, date, fetchedAt: this.now() };
        this.lastError = undefined;
        this.o.store?.kvSet(FX_USDJPY_KV_KEY, this.last);
        return this.current();
      } catch (e) {
        this.lastError = redactedErrMsg(e);
        this.o.onWarn?.("USD/JPY のレートを取得できません (最後の値か概算表 1 USD = 150 JPY で換算を続けます)", { error: this.lastError });
        return this.current();
      } finally {
        this.inflight = undefined;
      }
    })();
    this.inflight = p;
    return p;
  }
}
