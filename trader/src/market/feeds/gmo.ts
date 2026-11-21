/**
 * GMOコインの市場データ (venue "gmo")。取引は「取引所 レバレッジ取引」の銘柄 (BTC_JPY など) を使う。
 *
 * - listInstruments: /v1/symbols から GMO_SYMBOLS のレバレッジ銘柄を作る。統一シンボルは "BTC/JPY"、空売り可。
 *   meta: gmoSymbol (例 "BTC_JPY")、gmoSpotSymbol (例 "BTC")、leverage (paper の証拠金計算は 1 倍)、
 *   holdingFeeDaily (建玉の持ち越し手数料の日率。PaperBroker が日本時間 6:00 をまたいだ回数で計上する)。
 * - fetchCandles: /v1/klines を日付ファイル単位でさかのぼる (src/market/gmo/klines.ts)。
 *   レバレッジ銘柄の足を取得できないときは現物銘柄 (BTC) の足にフォールバックする (要確認: レバレッジ銘柄の klines の有無)。
 *   フォールバックは allowSpotCandles が true のときだけ (既定 false = 例外)。setup は paper では許可し、live では
 *   GMO_ALLOW_SPOT_CANDLES=true のときだけ許可する。切り替えたら warn と onSpotCandles (監査ログ) で知らせる。
 * - fetchQuote: /v1/ticker。fetchOrderBook: /v1/orderbooks。fetchPrints: /v1/trades。
 */
import { createLogger } from "../../core/logger";
import { QUOTE_FETCH_OPTIONS } from "../../core/http";
import type { Candle, Instrument, MarketDataFeed, OrderBook, Quote, Timeframe, TradePrint } from "../../core/types";
import { GmoClient, gmoToUnified, unifiedToGmo, type GmoClientOptions } from "../gmo/client";
import { fetchGmoKlines, GmoNoKlinesError, GMO_INTERVALS } from "../gmo/klines";
import { fileCandleRefreshIntervalMs } from "../fileCandles";

const log = createLogger("gmo-feed");

export const GMO_VENUE = "gmo";
export const DEFAULT_GMO_SYMBOLS = ["BTC_JPY", "ETH_JPY", "XRP_JPY"];
/** レバレッジ手数料の既定の日率 (0.04%/日。要確認) */
export const DEFAULT_GMO_LEVERAGE_FEE_DAILY = 0.0004;

export interface GmoFeedOptions {
  /** 既存のクライアント (省略時は client 用の設定から作る) */
  client?: GmoClient;
  clientOptions?: GmoClientOptions;
  /** レバレッジ銘柄 (GMO の表記 "BTC_JPY")。既定 DEFAULT_GMO_SYMBOLS */
  symbols?: string[];
  /** 建玉の持ち越し手数料の日率 (GMO_LEVERAGE_FEE_DAILY) */
  holdingFeeDaily?: number;
  now?: () => number;
  /** レバレッジ銘柄の足が取れないとき現物銘柄の足に切り替えてよいか (既定 false: 切り替えずに例外) */
  allowSpotCandles?: boolean;
  /** 現物銘柄の足に切り替えたときに呼ぶ (監査ログ用) */
  onSpotCandles?: (info: { symbol: string; tf: Timeframe; leverageSymbol: string; spotSymbol: string; error: string }) => void;
}

export class GmoFeed implements MarketDataFeed {
  readonly venue = GMO_VENUE;
  readonly client: GmoClient;
  private readonly symbols: string[];
  private readonly holdingFeeDaily: number;
  private readonly now: () => number;
  private instruments?: Instrument[];
  /** "統一シンボル|時間足" → klines に使う GMO の銘柄 (レバレッジ or 現物)。未確定なら無い */
  private readonly klineSymbol = new Map<string, string>();

  constructor(private readonly o: GmoFeedOptions = {}) {
    this.client = o.client ?? new GmoClient(o.clientOptions);
    this.symbols = (o.symbols?.length ? o.symbols : DEFAULT_GMO_SYMBOLS).map(unifiedToGmo);
    const fee = o.holdingFeeDaily;
    this.holdingFeeDaily = fee !== undefined && Number.isFinite(fee) && fee >= 0 ? fee : DEFAULT_GMO_LEVERAGE_FEE_DAILY;
    this.now = o.now ?? Date.now;
  }

  async listInstruments(): Promise<Instrument[]> {
    if (this.instruments) return this.instruments;
    const rows = await this.client.getSymbols();
    const out: Instrument[] = [];
    for (const g of this.symbols) {
      const unified = gmoToUnified(g);
      const row = rows.find((r) => r.symbol === g);
      if (!unified || !row) {
        log.warn("GMO に無いレバレッジ銘柄を無視します", { symbol: g });
        continue;
      }
      const [base, quote] = unified.split("/");
      out.push({
        symbol: unified,
        venue: GMO_VENUE,
        assetClass: "crypto",
        baseCurrency: base,
        quoteCurrency: quote,
        tickSize: Number(row.tickSize),
        lotSize: Number(row.sizeStep),
        minQty: Number(row.minOrderSize),
        takerFeeRate: Number(row.takerFee),
        makerFeeRate: Number(row.makerFee),
        allowShort: true,
        meta: { gmoSymbol: g, gmoSpotSymbol: base, leverage: 1, holdingFeeDaily: this.holdingFeeDaily, maxOrderSize: Number(row.maxOrderSize) },
      });
    }
    this.instruments = out;
    return out;
  }

  /** 統一シンボル → GMO のレバレッジ銘柄 */
  private gmoSymbol(symbol: string): string {
    const i = this.instruments?.find((x) => x.symbol === symbol);
    const g = i?.meta?.gmoSymbol;
    return typeof g === "string" ? g : unifiedToGmo(symbol);
  }

  private spotSymbol(symbol: string): string {
    const i = this.instruments?.find((x) => x.symbol === symbol);
    const s = i?.meta?.gmoSpotSymbol;
    return typeof s === "string" ? s : symbol.split("/")[0];
  }

  private fetchFile = async (gmoSymbol: string, interval: string, date: string): Promise<Candle[]> => {
    const rows = await this.client.getKlines(gmoSymbol, interval, date);
    return rows.map((r) => ({ ts: r.openTime, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
  };

  async fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    if (!GMO_INTERVALS[tf]) throw new Error(`GMO は時間足 ${tf} のローソク足を提供していません`);
    const key = `${symbol}|${tf}`;
    const now = this.now();
    let chosen = this.klineSymbol.get(key);
    if (chosen === undefined) {
      // 使う銘柄が未確定: 最新のファイルで確かめる (レバレッジ銘柄 → だめなら現物銘柄)
      const lev = this.gmoSymbol(symbol);
      try {
        const probe = await fetchGmoKlines(this.fetchFile, lev, tf, since === undefined ? limit : 1, now);
        if (probe.length === 0) throw new GmoNoKlinesError(lev, tf, "足が 0 本");
        this.klineSymbol.set(key, lev);
        if (since === undefined) return probe;
      } catch (e) {
        if (!(e instanceof GmoNoKlinesError)) throw e;
        if (this.o.allowSpotCandles !== true) {
          throw new Error(
            `GMO: ${lev} の ${tf} のローソク足を取得できません。現物銘柄の足への切り替えは許可されていません ` +
              `(live では GMO_ALLOW_SPOT_CANDLES=true で許可。paper は常に許可): ${e.message}`,
          );
        }
        const spot = this.spotSymbol(symbol);
        const probe = await fetchGmoKlines(this.fetchFile, spot, tf, since === undefined ? limit : 1, now);
        if (probe.length === 0) throw new GmoNoKlinesError(spot, tf, "足が 0 本");
        log.warn("レバレッジ銘柄のローソク足を取得できないため、現物銘柄の足を使います (要確認)", { symbol, leverage: lev, spot, tf, error: e.message });
        this.klineSymbol.set(key, spot);
        try {
          this.o.onSpotCandles?.({ symbol, tf, leverageSymbol: lev, spotSymbol: spot, error: e.message });
        } catch (err) {
          log.warn("現物の足への切り替えの記録に失敗", { error: err instanceof Error ? err.message : String(err) });
        }
        if (since === undefined) return probe;
      }
      chosen = this.klineSymbol.get(key)!;
    }
    try {
      return await fetchGmoKlines(this.fetchFile, chosen, tf, limit, now, since);
    } catch (e) {
      // 銘柄は確かめ済み。since の範囲のファイルがすべて無い (上場前など) なら 0 本
      if (e instanceof GmoNoKlinesError && since !== undefined) return [];
      throw e;
    }
  }

  /** MarketHub の毎回更新で同じ (銘柄, 時間足) を取り直す最短間隔 (ファイル単位で返すので間引く) */
  candleRefreshIntervalMs(tf: Timeframe): number {
    return fileCandleRefreshIntervalMs(tf);
  }

  async fetchQuote(symbol: string): Promise<Quote> {
    const g = this.gmoSymbol(symbol);
    const rows = await this.client.getTicker(g, QUOTE_FETCH_OPTIONS.retries);
    const t = rows.find((r) => r.symbol === g);
    if (!t) throw new Error(`GMO: ticker に ${g} がありません`);
    const bid = Number(t.bid);
    const ask = Number(t.ask);
    const last = Number(t.last);
    if (!(bid > 0) || !(ask > 0) || bid > ask) throw new Error(`GMO: ${g} の気配が不正です (bid=${t.bid}, ask=${t.ask})`);
    return { ts: t.timestamp, bid, ask, ...(last > 0 ? { last } : {}) };
  }

  async fetchOrderBook(symbol: string, depth = 20): Promise<OrderBook> {
    const g = this.gmoSymbol(symbol);
    const ob = await this.client.getOrderbooks(g, QUOTE_FETCH_OPTIONS.retries);
    if (ob.symbol !== g) throw new Error(`GMO: 板の銘柄が違います (${ob.symbol} ≠ ${g})`);
    const conv = (rows: { price: string; size: string }[]): [number, number][] => rows.map((r) => [Number(r.price), Number(r.size)]);
    const bids = conv(ob.bids).sort((a, b) => b[0] - a[0]).slice(0, depth);
    const asks = conv(ob.asks).sort((a, b) => a[0] - b[0]).slice(0, depth);
    return { ts: this.now(), bids, asks };
  }

  async fetchPrints(symbol: string, limit = 100): Promise<TradePrint[]> {
    const g = this.gmoSymbol(symbol);
    const r = await this.client.getTrades(g, 1, Math.min(100, Math.max(1, Math.floor(limit))), QUOTE_FETCH_OPTIONS.retries);
    return r.list
      .map((t) => ({ ts: t.timestamp, price: Number(t.price), size: Number(t.size), side: t.side === "SELL" ? ("sell" as const) : ("buy" as const) }))
      .sort((a, b) => a.ts - b.ts);
  }
}
