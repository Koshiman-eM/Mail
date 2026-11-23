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
 * - エントリー前のコストの確認 (entryCost): エンジンが RiskManager の承認後・発注前に、承認された数量・向きで同じ見積もりを取り
 *   (キャッシュに入るので、直後の約定は API を呼ばずにそれを使う)、往復コストで期待値をもう一度確かめる (setup.ts の entryQuoteCost)。
 */
import { D, type Decimal } from "../core/decimal";
import type { EntryQuoteCost } from "../engine/engine";
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

/**
 * エントリー前の見積もりのコスト (entryCost)。source "quote" は見積もり (キャッシュを含む)、"fallback" は代わりのモデル
 * (見積もりが取れなかった・枠の待ちが長い)、"unavailable" は値付けできない (古い気配など)
 */
export type JupiterEntryCost =
  | { source: "quote" | "fallback"; costBps: number; oneWayBps: number; notionalUsd: number }
  | { source: "unavailable"; reason: string };

export interface JupiterFillPricer extends MarketPricer {
  stats: { quote: number; cached: number; fallback: number; aborted: number; staleRejected: number };
  /**
   * 予定の数量・向きの往復コスト (bps) = 2 × 見積もりの片道の影響 (仲値基準) + 2 × 固定手数料 / 代金。
   * 約定と同じキャッシュ・枠 (limiter)・時間切れ (timeoutMs) を使う。この venue・銘柄でなければ undefined
   */
  entryCost(inst: Instrument, side: "buy" | "sell", qty: Decimal, q: Quote): Promise<JupiterEntryCost | undefined>;
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

  /**
   * 見積もり (キャッシュ → swap/v1/quote → 代わりのモデル) で約定の見込みを出す。約定 (pricer) とエントリー前のコストの確認 (entryCost) で共有する
   * (エントリー前に取った見積もりを 15 秒以内の約定がキャッシュから使う。API の呼び出しは 1 エントリー 1 回)。
   * undefined = この venue・銘柄ではない / 価格・数量が不正
   */
  const estimate = async (
    inst: Instrument, side: "buy" | "sell", qty: Decimal, q: Quote,
  ): Promise<{ est: FillEstimate; ref: number; sizeUsd: number } | { reject: string } | undefined> => {
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
    return { est, ref, sizeUsd };
  };

  const pricer = (async (inst: Instrument, side: "buy" | "sell", qty: Decimal, q: Quote) => {
    const r = await estimate(inst, side, qty, q);
    if (!r) return undefined;
    if ("reject" in r) return r;
    o.onFill?.(inst.symbol, r.est);
    return { price: r.est.effectivePrice, source: r.est.source };
  }) as JupiterFillPricer;
  pricer.entryCost = async (inst, side, qty, q) => {
    const r = await estimate(inst, side, qty, q);
    if (!r) return undefined;
    if ("reject" in r) return { source: "unavailable", reason: r.reject };
    const mid = (q.bid + q.ask) / 2;
    const base = Number.isFinite(mid) && mid > 0 ? mid : r.ref;
    // 片道 = 実効価格の仲値からの不利な方向の差 (有利な向きは 0 とみなす)。往復 = 2 × 片道 + 2 × 固定手数料 / 代金 (costBpsAt と同じ形)
    const adverse = side === "buy" ? r.est.effectivePrice / base - 1 : 1 - r.est.effectivePrice / base;
    const oneWayBps = Math.max(0, adverse * 10_000);
    const feeBps = ((inst.fixedFeePerOrder ?? 0) / r.sizeUsd) * 10_000;
    const costBps = 2 * oneWayBps + 2 * feeBps;
    if (!Number.isFinite(costBps)) return { source: "unavailable", reason: `見積もりのコストが計算できません (${costBps})` };
    return { source: r.est.source, costBps, oneWayBps, notionalUsd: r.sizeUsd };
  };
  pricer.stats = stats;
  return pricer;
}

/** 見積もりが取れないときの見送りの理由 (risk.reject・見送りの集計に出る) */
export const ENTRY_QUOTE_UNAVAILABLE_REASON = "見積もりが取れないため見送り";

/**
 * エンジンの MarketExtras.entryQuoteCost (発注前の見積もりのコスト)。
 * - 見積もり (キャッシュを含む) が取れた: 往復コストを返す (エンジンが RiskManager.recheckEdge で期待値を確かめ直す)
 * - 取れない (失敗・時間切れ・枠の待ちが長い・古い気配): meme は見送り (fail closed。薄い板で代わりのモデルは実際の滑りを大きく下回るため)、
 *   crypto (主要銘柄) は undefined = 承認時のモデルのコストのまま (RiskManager がすでに確かめている)
 * - この venue・銘柄でない: undefined
 */
export async function jupiterEntryQuoteCost(
  pricer: Pick<JupiterFillPricer, "entryCost">, inst: Instrument, side: "buy" | "sell", qty: string, q: Quote,
): Promise<EntryQuoteCost | undefined> {
  let qd: Decimal;
  try {
    qd = D(qty);
  } catch {
    return inst.assetClass === "meme" ? { unavailable: `${ENTRY_QUOTE_UNAVAILABLE_REASON} (数量が不正: ${qty})` } : undefined;
  }
  let r: JupiterEntryCost | undefined;
  try {
    r = await pricer.entryCost(inst, side, qd, q);
  } catch {
    r = { source: "unavailable", reason: "見積もりの取得に失敗" };
  }
  if (r && r.source === "quote") return { costBps: r.costBps, source: "quote" };
  if (inst.assetClass !== "meme") return undefined;
  // ミーム: 見積もりが無ければ発注しない (銘柄がこの pricer の対象外 (r が undefined) でも同じ)
  return { unavailable: ENTRY_QUOTE_UNAVAILABLE_REASON };
}
