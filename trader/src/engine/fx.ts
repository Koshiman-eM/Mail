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

export interface FxConverter {
  readonly baseCurrency: string;
  /** 1 単位の ccy が口座通貨でいくらか。換算できなければ NaN */
  toAccount(ccy: string): number;
  /** 1 単位の ccy が USD でいくらか。換算できなければ NaN */
  toUsd(ccy: string): number;
  /** 1 単位の from が to でいくらか。換算できなければ NaN */
  rate(from: string, to: string): number;
}

const midOf = (q: Quote | undefined): number | undefined => {
  if (!q) return undefined;
  if (q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  return q.last !== undefined && q.last > 0 ? q.last : undefined;
};

export function createFxConverter(o: FxConverterOptions): FxConverter {
  const fallback = { ...FALLBACK_PER_USD, ...(o.fallbackPerUsd ?? {}) };
  const base = normalizeCurrency(o.baseCurrency);

  /** 監視中のペア (from/to または to/from) の仲値から 1 from = ? to */
  const fromQuotes = (from: string, to: string): number | undefined => {
    for (const a of aliasesOf(from)) {
      for (const b of aliasesOf(to)) {
        const direct = midOf(o.getQuote(`${a}/${b}`));
        if (direct !== undefined) return direct;
        const inverse = midOf(o.getQuote(`${b}/${a}`));
        if (inverse !== undefined) return 1 / inverse;
      }
    }
    return undefined;
  };

  /** 1 USD あたりの c */
  const perUsd = (c: string): number | undefined => (c === "USD" ? 1 : (fromQuotes("USD", c) ?? fallback[c]));

  const rate = (fromRaw: string, toRaw: string): number => {
    const from = normalizeCurrency(fromRaw);
    const to = normalizeCurrency(toRaw);
    if (from === to) return 1;
    const direct = fromQuotes(from, to);
    if (direct !== undefined && Number.isFinite(direct) && direct > 0) return direct;
    const f = perUsd(from);
    const t = perUsd(to);
    return f !== undefined && t !== undefined && f > 0 && t > 0 ? t / f : NaN;
  };

  return {
    baseCurrency: o.baseCurrency,
    toAccount: (ccy) => rate(ccy, base),
    toUsd: (ccy) => rate(ccy, "USD"),
    rate,
  };
}

/** シンボルからクオート通貨を推定 (レポート用。"BTC/USDT" → USDT、スラッシュ無しの株式は USD) */
export function quoteCurrencyOfSymbol(symbol: string): string {
  const i = symbol.indexOf("/");
  return i >= 0 ? symbol.slice(i + 1) : "USD";
}
