import type { Quote } from "../core/types";

/**
 * 通貨換算 (クオート通貨 → 口座通貨)。
 * 監視中の為替ペア (例: USD/JPY) の気配があればその仲値、無ければ下の概算表を使う。
 * USDT / USDC は USD と同一視する。
 */

/**
 * 1 USD あたりの各通貨 (概算のフォールバック)。気配が取れないときの目安で、精度は保証しない。
 * 値は 2026 年時点のおおよその水準。暗号資産は変動が大きいので載せない (気配が無ければ換算不能)。
 */
export const FALLBACK_PER_USD: Record<string, number> = {
  USD: 1,
  JPY: 150,
  EUR: 0.92,
  GBP: 0.79,
  AUD: 1.52,
  CAD: 1.37,
  CHF: 0.88,
  NZD: 1.66,
  CNY: 7.2,
  HKD: 7.8,
  SGD: 1.35,
  KRW: 1380,
};

const USD_ALIASES = ["USD", "USDT", "USDC"];

/** 通貨コードの正規化 (USDT/USDC → USD) */
export function normalizeCurrency(ccy: string): string {
  const c = ccy.trim().toUpperCase();
  return USD_ALIASES.includes(c) ? "USD" : c;
}

const aliasesOf = (c: string): string[] => (c === "USD" ? USD_ALIASES : [c]);

export interface FxConverterOptions {
  /** 口座通貨 */
  baseCurrency: string;
  /** 統一シンボル ("USD/JPY" など) の最新気配 */
  getQuote: (symbol: string) => Quote | undefined;
  /** フォールバック表の上書き (1 USD あたり) */
  fallbackPerUsd?: Record<string, number>;
}

/** 換算の内訳 (live の新規エントリーの可否・ダッシュボードの「概算レート使用中」に使う) */
export interface FxRateInfo {
  /** 1 単位の from が to でいくらか。換算できなければ NaN */
  rate: number;
  /** identity: 同じ通貨 / quote: 監視中の気配だけ / fallback: 概算表を使った / none: 換算できない */
  source: "identity" | "quote" | "fallback" | "none";
  /** 使った気配のうち最も古いものの時刻 (気配を使っていなければ undefined) */
  oldestQuoteTs?: number;
  /** 概算表を使った通貨 */
  fallbackCurrencies?: string[];
}

export interface FxConverter {
  readonly baseCurrency: string;
  /** 1 単位の ccy が口座通貨でいくらか。換算できなければ NaN */
  toAccount(ccy: string): number;
  /** 1 単位の ccy が USD でいくらか。換算できなければ NaN */
  toUsd(ccy: string): number;
  /** 1 単位の from が to でいくらか。換算できなければ NaN */
  rate(from: string, to: string): number;
  /** rate と同じ値に、気配・概算表のどちらを使ったか (と気配の時刻) を添える */
  rateInfo?(from: string, to: string): FxRateInfo;
}

const midOf = (q: Quote | undefined): number | undefined => {
  if (!q) return undefined;
  if (q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  return q.last !== undefined && q.last > 0 ? q.last : undefined;
};

export function createFxConverter(o: FxConverterOptions): FxConverter {
  const fallback = { ...FALLBACK_PER_USD, ...(o.fallbackPerUsd ?? {}) };
  const base = normalizeCurrency(o.baseCurrency);

  /** 監視中のペア (from/to または to/from) の仲値から 1 from = ? to (と気配の時刻) */
  const fromQuotes = (from: string, to: string): { v: number; ts: number } | undefined => {
    for (const a of aliasesOf(from)) {
      for (const b of aliasesOf(to)) {
        const dq = o.getQuote(`${a}/${b}`);
        const direct = midOf(dq);
        if (direct !== undefined) return { v: direct, ts: dq!.ts };
        const iq = o.getQuote(`${b}/${a}`);
        const inverse = midOf(iq);
        if (inverse !== undefined) return { v: 1 / inverse, ts: iq!.ts };
      }
    }
    return undefined;
  };

  /** 1 USD あたりの c */
  const perUsd = (c: string): { v: number; ts?: number; fallback?: boolean } | undefined => {
    if (c === "USD") return { v: 1 };
    const q = fromQuotes("USD", c);
    if (q) return q;
    return fallback[c] !== undefined ? { v: fallback[c], fallback: true } : undefined;
  };

  const rateInfo = (fromRaw: string, toRaw: string): FxRateInfo => {
    const from = normalizeCurrency(fromRaw);
    const to = normalizeCurrency(toRaw);
    if (from === to) return { rate: 1, source: "identity" };
    const direct = fromQuotes(from, to);
    if (direct !== undefined && Number.isFinite(direct.v) && direct.v > 0) return { rate: direct.v, source: "quote", oldestQuoteTs: direct.ts };
    const f = perUsd(from);
    const t = perUsd(to);
    if (!(f !== undefined && t !== undefined && f.v > 0 && t.v > 0)) return { rate: NaN, source: "none" };
    const tss = [f.ts, t.ts].filter((x): x is number => typeof x === "number");
    const fb = [f.fallback ? from : undefined, t.fallback ? to : undefined].filter((x): x is string => x !== undefined);
    return {
      rate: t.v / f.v,
      source: fb.length ? "fallback" : "quote",
      ...(tss.length ? { oldestQuoteTs: Math.min(...tss) } : {}),
      ...(fb.length ? { fallbackCurrencies: fb } : {}),
    };
  };

  const rate = (from: string, to: string): number => rateInfo(from, to).rate;

  return {
    baseCurrency: o.baseCurrency,
    toAccount: (ccy) => rate(ccy, base),
    toUsd: (ccy) => rate(ccy, "USD"),
    rate,
    rateInfo,
  };
}

/** live の為替の気配がこれより古ければ「古い」とみなす (既定 5 分) */
export const LIVE_FX_MAX_QUOTE_AGE_MS = 5 * 60_000;

/**
 * 換算の信頼性 (live の新規エントリー用)。概算表を使った・気配が古い・換算できない・内訳が分からないなら理由を返す。
 * 問題が無ければ undefined
 */
export function fxApproxReason(fx: FxConverter, from: string, to: string, now: number, maxAgeMs = LIVE_FX_MAX_QUOTE_AGE_MS): string | undefined {
  if (normalizeCurrency(from) === normalizeCurrency(to)) return undefined;
  if (!fx.rateInfo) return `${from}→${to}: 換算の内訳を確認できません`;
  const i = fx.rateInfo(from, to);
  if (i.source === "identity") return undefined;
  if (i.source === "none" || !Number.isFinite(i.rate) || !(i.rate > 0)) return `${from}→${to}: 換算できません`;
  if (i.source === "fallback") return `${from}→${to}: 固定の概算表を使用 (${(i.fallbackCurrencies ?? []).join(", ")})`;
  const ts = i.oldestQuoteTs;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return `${from}→${to}: 為替の気配の時刻が不明`;
  if (now - ts > maxAgeMs) return `${from}→${to}: 為替の気配が古い (${Math.round((now - ts) / 1000)} 秒前)`;
  return undefined;
}

/** シンボルからクオート通貨を推定 (レポート用。"BTC/USDT" → USDT、スラッシュ無しの株式は USD) */
export function quoteCurrencyOfSymbol(symbol: string): string {
  const i = symbol.indexOf("/");
  return i >= 0 ? symbol.slice(i + 1) : "USD";
}
