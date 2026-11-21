/**
 * Jupiter (Solana のトークン・ミームコイン) の相場データと銘柄探索の層。paper 用 (スワップの実行・署名・送信は未実装)。
 *
 * - client.ts: 読み取り専用の HTTP クライアント (トークンバケットのレート制限・429/5xx の再試行・x-api-key・キーの伏せ字)
 * - price.ts: Price V3 の一括取得 (50 件ずつ)
 * - tokens.ts: Tokens V2 (search / tag / カテゴリー / recent) → JupiterToken
 * - candles.ts: ポーリングした価格から 1m 足 (出来高なし・空白は横ばいで埋める) と 5m/15m/1h/4h への集約
 * - gecko.ts: GeckoTerminal (プールの検索・OHLCV のページング・キャッシュ・専用のレート制限)
 * - quote.ts: 見積もり (swap/v1/quote・ultra/v1/order) と実効価格の推定 estimateFill・代わりのスリッページのモデル
 * - discovery.ts: ミームコインの選別 (理由は日本語) と監視銘柄の合成 (自動追加は期限つき)
 * - check.ts: 各エンドポイントの形の確認 runJupiterCheck (読み取りだけ)
 * API の仕様は公式資料の記述だけで、実際の応答とは未照合 (要確認の項目は JUPITER_UNVERIFIED_ITEMS)。
 */
export {
  assertReadOnlyPath, buildQuery, JUPITER_BASE_URL, JUPITER_KEYED_RPS, JUPITER_KEYLESS_RPS, JupiterClient, scrubSecret, TokenBucket,
  type HttpJsonClientOptions, type JupiterClientOptions, type Query, type TokenBucketOptions,
} from "./client";
export { isSolanaAddress, JupiterShapeError, toBool, toFiniteNumber, toMs } from "./parse";
export {
  fetchPrices, parsePriceResponse, PRICE_IDS_PER_CALL,
  type FetchPricesOptions, type JupiterPrice, type PriceBatchResult, type PriceIssue, type PriceParseResult,
} from "./price";
export {
  fetchRecentTokens, fetchTokenCategory, fetchTokensByTag, normalizeToken, parseTokenList, searchTokens,
  TOKEN_CATEGORIES, TOKEN_INTERVALS, TOKEN_TAGS,
  type JupiterToken, type JupiterTokenAudit, type JupiterTokenStats, type OrganicScoreLabel, type TokenCategory, type TokenInterval,
  type TokenListResult, type TokenTag,
} from "./tokens";
export {
  DEFAULT_MAX_FILL_BARS, fillGaps, POLLED_TIMEFRAMES, PolledCandleBuilder, polledCandlesFor, PolledCandleStore, resamplePolled,
  type PolledCandle, type PolledCandleBuilderOptions, type PolledTimeframe,
} from "./candles";
export {
  GECKO_ACCEPT, GECKO_BASE_URL, GECKO_DEFAULT_CALLS_PER_MINUTE, GECKO_TIMEFRAMES, GeckoTerminalClient, mergeByTs, pageCandlesBackward,
  parseGeckoOhlcv, parseGeckoPools, pickBestPool,
  type FetchOhlcvOptions, type GeckoClientOptions, type GeckoPool, type OhlcvPageFetcher, type PageBackwardOptions, type PageBackwardResult,
} from "./gecko";
export {
  buildQuoteRequest, DEFAULT_FALLBACK_SLIPPAGE, estimateFill, estimateFillFallback, JupiterSwapQuoteProvider, JupiterUltraOrderProvider,
  parseSwapQuote, quoteAndEstimate,
  type FallbackSlippageSettings, type FillContext, type FillEstimate, type QuoteProvider, type QuoteRequest, type RouteLeg, type SwapQuote,
} from "./quote";
export {
  DEFAULT_DISCOVERY_SETTINGS, DEFAULT_MEME_TOKENS, DEFAULT_WATCH_TTL_MS, MAJOR_TOKENS, mergeWatchlist, REJECT_CODE_LABELS, rejectionsFor,
  screenTokens, SOL_MINT, USDC_MINT,
  type DiscoverySettings, type KnownToken, type RejectCode, type Rejection, type ScreenResult, type WatchEntry, type WatchlistMergeOptions,
  type WatchlistMergeResult, type WatchSource,
} from "./discovery";
export { JUPITER_UNVERIFIED_ITEMS, runJupiterCheck, type JupiterCheckOptions, type JupiterCheckReport, type JupiterCheckStep } from "./check";
