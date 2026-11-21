/**
 * paper の Jupiter の成行の約定価格 (PaperBroker の marketPricer)。
 *
 * - 見積もり (swap/v1/quote。JupiterSwapQuoteProvider) を取り、estimateFill の実効価格 (effectivePrice) で約定させる
 *   (経路の LP 手数料は見積もりの価格に織り込み済み。手数料はネットワーク手数料 = Instrument.fixedFeePerOrder だけで、PaperBroker が計上する)。
 * - 見積もりは (mint, 売買の向き, 金額の帯 = round(log2(USD))) ごとに 15 秒キャッシュし、同じ帯の金額の違いは estimateFill が比例で伸縮する。
 * - レート制限を守る: 枠の待ちが timeoutMs を超えそうなら見積もりを取らない。見積もりが timeoutMs 以内に返らない・失敗したら
 *   代わりのモデル (estimateFillFallback: 固定 bps + 金額 / 流動性の影響) で約定する (遅れて返った見積もりはキャッシュにだけ入れる)。
 * - 参照価格 (仲値) は気配の last (Jupiter の feed は Price V3 の価格を入れる)、無ければ買い・売り気配の平均。
 * - 数量は発注の数量 (decimal) のまま。金額 = 数量 × 参照価格 (USDC = USD とみなす)。
 * - スワップの実行・署名・送信はしない (見積もりだけ。クライアントは読み取り専用)。
 */
import type { Decimal } from "../core/decimal";
import type { Instrument, Quote } from "../core/types";
import { USDC_MINT } from "../market/jupiter/discovery";
import {
  buildQuoteRequest, DEFAULT_FALLBACK_SLIPPAGE, estimateFill, estimateFillFallback, type FallbackSlippageSettings, type FillContext,
  type FillEstimate, type QuoteProvider, type SwapQuote,
} from "../market/jupiter/quote";
import type { MarketPricer } from "./paper";

const JUPITER_QUOTE_CACHE_MS = 15_000;
const JUPITER_QUOTE_TIMEOUT_MS = 4_000;

interface JupiterFillToken {
  mint: string;
  decimals: number;
  liquidityUsd?: number;
  fallback?: FallbackSlippageSettings;
}

export interface JupiterFillPricerOptions {
  venue?: string;
  provider?: QuoteProvider;
  /** 見積もりの枠の待ち時間 (JupiterClient.limiter)。timeoutMs を超えるなら見積もりを取らない */
  limiter?: { waitMs(): number };
  tokenOf: (symbol: string) => JupiterFillToken | undefined;
  now?: () => number;
  cacheMs?: number;
  timeoutMs?: number;
  slippageBps?: number;
  onFill?: (symbol: string, est: FillEstimate) => void;
}

export interface JupiterFillPricer extends MarketPricer {
  stats: { quote: number; cached: number; fallback: number };
}

/** 金額の帯 (2 倍ごと) */
const sizeBucket = (sizeUsd: number) => Math.round(Math.log2(Math.max(1e-9, sizeUsd)));

export function createJupiterFillPricer(o: JupiterFillPricerOptions): JupiterFillPricer {
  const venue = o.venue ?? "jupiter";
  const now = o.now ?? Date.now;
  const cacheMs = o.cacheMs ?? JUPITER_QUOTE_CACHE_MS;
  const timeoutMs = o.timeoutMs ?? JUPITER_QUOTE_TIMEOUT_MS;
  const cache = new Map<string, { at: number; quote: SwapQuote }>();
  const stats = { quote: 0, cached: 0, fallback: 0 };

  const pricer = (async (inst: Instrument, side: "buy" | "sell", qty: Decimal, q: Quote) => {
    if (inst.venue !== venue) return undefined;
    const tok = o.tokenOf(inst.symbol);
    if (!tok) return undefined;
    const ref = q.last !== undefined && q.last > 0 ? q.last : (q.bid + q.ask) / 2;
    if (!(Number.isFinite(ref) && ref > 0)) return undefined;
    const sizeUsd = qty.mul(ref).toNumber();
    if (!(Number.isFinite(sizeUsd) && sizeUsd > 0)) return undefined;
    const ctx: FillContext = { baseMint: tok.mint, baseDecimals: tok.decimals, quoteMint: USDC_MINT, quoteDecimals: 6, referencePriceUsd: ref };
    const key = `${tok.mint}|${side}|${sizeBucket(sizeUsd)}`;
    const t = now();
    for (const [k, v] of cache) if (t - v.at >= cacheMs) cache.delete(k);
    let est: FillEstimate | undefined;
    const hit = cache.get(key);
    if (hit) {
      try {
        est = estimateFill(hit.quote, side, sizeUsd, ctx);
        stats.cached++;
      } catch {
        est = undefined;
      }
    }
    if (!est && o.provider && (o.limiter?.waitMs() ?? 0) <= timeoutMs) {
      try {
        const req = buildQuoteRequest(side, sizeUsd, ctx, o.slippageBps ?? 100);
        const p = o.provider.getQuote(req).then((quote) => {
          cache.set(key, { at: now(), quote });
          return quote;
        });
        p.catch(() => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const quote = await Promise.race([p, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), timeoutMs)))]);
        if (timer) clearTimeout(timer);
        if (quote) {
          est = estimateFill(quote, side, sizeUsd, ctx);
          stats.quote++;
        }
      } catch {
        est = undefined;
      }
    }
    if (!est) {
      est = estimateFillFallback(side, sizeUsd, ref, tok.liquidityUsd, tok.fallback ?? DEFAULT_FALLBACK_SLIPPAGE);
      stats.fallback++;
    }
    o.onFill?.(inst.symbol, est);
    return { price: est.effectivePrice, source: est.source };
  }) as JupiterFillPricer;
  pricer.stats = stats;
  return pricer;
}
