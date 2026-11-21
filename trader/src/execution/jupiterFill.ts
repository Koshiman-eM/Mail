/**
 * paper の Jupiter の成行の約定価格 (PaperBroker の marketPricer)。
 *
 * - 見積もり (swap/v1/quote。JupiterSwapQuoteProvider) を取り、estimateFill の実効価格 (effectivePrice) で約定させる
 *   (経路の LP 手数料は見積もりの価格に織り込み済み。手数料はネットワーク手数料 = Instrument.fixedFeePerOrder だけで、PaperBroker が計上する)。
 * - 見積もりは (mint, 売買の向き, 金額の帯 = round(log2(USD))) ごとに 15 秒キャッシュする。ただし取得時から参照価格 (仲値) が
 *   0.3% を超えて動いたら使わない。使うときも古い見積もりの絶対価格は使わず、取得時の参照価格に対する価格影響 (bps。金額の違いは
 *   estimateFill が比例で伸縮) を今の参照価格に掛けて値付けする。
 * - レート制限を守る: 枠の待ち (待ちの列を含む) が timeoutMs を超えそうなら見積もりを取らない。timeoutMs 以内に返らなければ中止 (AbortController)
 *   して代わりのモデル (estimateFillFallback: 固定 bps + 金額 / 流動性の影響) で約定する。見積もりの再試行は 1 回まで (quote.ts)。
 * - 気配が maxQuoteAgeMs より古いときは代わりのモデルで値付けしない (古い仲値で約定させない)。見積もりが取れなければ注文を拒否し、
 *   決済は次のティックで再試行される (PositionManager の拒否の扱い)。新規エントリーはエンジンが古い気配で発注しない。
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
/** キャッシュの見積もりを使う参照価格の動きの上限 (割合) */
const QUOTE_CACHE_MAX_MOVE = 0.003;

interface JupiterFillToken {
  mint: string;
  decimals: number;
  liquidityUsd?: number | undefined;
  fallback?: FallbackSlippageSettings;
}

export interface JupiterFillPricerOptions {
  venue?: string;
  provider?: QuoteProvider;
  /** 見積もりの枠の待ち時間 (JupiterClient.limiter。待ちの列を含む)。timeoutMs を超えるなら見積もりを取らない */
  limiter?: { waitMs(): number };
  tokenOf: (symbol: string) => JupiterFillToken | undefined;
  now?: () => number;
  cacheMs?: number;
  timeoutMs?: number;
  slippageBps?: number;
  /** これより古い気配では代わりのモデルで値付けしない (既定 30 秒 = エンジンの maxQuoteAgeMs) */
  maxQuoteAgeMs?: number;
  onFill?: (symbol: string, est: FillEstimate) => void;
}

export interface JupiterFillPricer extends MarketPricer {
  stats: { quote: number; cached: number; fallback: number; aborted: number; staleRejected: number };
}

/** 金額の帯 (2 倍ごと) */
const sizeBucket = (sizeUsd: number) => Math.round(Math.log2(Math.max(1e-9, sizeUsd)));

export function createJupiterFillPricer(o: JupiterFillPricerOptions): JupiterFillPricer {
  const venue = o.venue ?? "jupiter";
  const now = o.now ?? Date.now;
  const cacheMs = o.cacheMs ?? JUPITER_QUOTE_CACHE_MS;
  const timeoutMs = o.timeoutMs ?? JUPITER_QUOTE_TIMEOUT_MS;
  const maxQuoteAgeMs = o.maxQuoteAgeMs ?? 30_000;
  const cache = new Map<string, { at: number; quote: SwapQuote; ref: number }>();
  const stats = { quote: 0, cached: 0, fallback: 0, aborted: 0, staleRejected: 0 };

  const pricer = (async (inst: Instrument, side: "buy" | "sell", qty: Decimal, q: Quote) => {
    if (inst.venue !== venue) return undefined;
    const tok = o.tokenOf(inst.symbol);
    if (!tok) return undefined;
    const ref = q.last !== undefined && q.last > 0 ? q.last : (q.bid + q.ask) / 2;
    if (!(Number.isFinite(ref) && ref > 0)) return undefined;
    const sizeUsd = qty.mul(ref).toNumber();
    if (!(Number.isFinite(sizeUsd) && sizeUsd > 0)) return undefined;
    const t = now();
    const stale = !(t - q.ts <= maxQuoteAgeMs);
    const ctx: FillContext = { baseMint: tok.mint, baseDecimals: tok.decimals, quoteMint: USDC_MINT, quoteDecimals: 6, referencePriceUsd: ref };
    const key = `${tok.mint}|${side}|${sizeBucket(sizeUsd)}`;
    for (const [k, v] of cache) if (t - v.at >= cacheMs) cache.delete(k);
    let est: FillEstimate | undefined;
    const hit = cache.get(key);
    // キャッシュ: 参照価格が 0.3% 以内のときだけ。取得時の参照価格に対する影響を今の参照価格に掛ける (古い絶対価格は使わない)
    if (hit && !stale && Math.abs(ref / hit.ref - 1) <= QUOTE_CACHE_MAX_MOVE) {
      try {
        const e0 = estimateFill(hit.quote, side, sizeUsd, { ...ctx, referencePriceUsd: hit.ref });
        const k = e0.priceImpactBps / 10_000;
        const effectivePrice = side === "buy" ? ref * (1 + k) : ref * (1 - k);
        est = { ...e0, effectivePrice, qty: sizeUsd / effectivePrice };
        stats.cached++;
      } catch {
        est = undefined;
      }
    }
    if (!est && o.provider && (o.limiter?.waitMs() ?? 0) <= timeoutMs) {
      const ctrl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const req = buildQuoteRequest(side, sizeUsd, ctx, o.slippageBps ?? 100);
        const p = o.provider.getQuote(req, { signal: ctrl.signal });
        p.catch(() => undefined);
        const quote = await Promise.race([p, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), timeoutMs)))]);
        if (quote) {
          cache.set(key, { at: now(), quote, ref });
          est = estimateFill(quote, side, sizeUsd, ctx);
          stats.quote++;
        } else {
          // 時間切れ: 中止して共有の枠を使い続けない (送信前なら送らない、送信中なら fetch を中止)
          ctrl.abort();
          stats.aborted++;
        }
      } catch {
        est = undefined;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (!est) {
      if (stale) {
        stats.staleRejected++;
        return { reject: `気配が古い (${Math.round((t - q.ts) / 1000)} 秒前) ため見積もりの代わりのモデルで約定できません (次のティックで再試行)` };
      }
      est = estimateFillFallback(side, sizeUsd, ref, tok.liquidityUsd, tok.fallback ?? DEFAULT_FALLBACK_SLIPPAGE);
      stats.fallback++;
    }
    o.onFill?.(inst.symbol, est);
    return { price: est.effectivePrice, source: est.source };
  }) as JupiterFillPricer;
  pricer.stats = stats;
  return pricer;
}
