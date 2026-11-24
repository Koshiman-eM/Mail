/**
 * バックテスト用: GeckoTerminal のプールの OHLCV を MarketDataFeed の形で返す (`backtest --source jupiter --token <mint|symbol>`)。
 * - 最初に要求された since から今までを、before_timestamp でさかのぼるページング (1 ページ 1000 本) で一度に取り、
 *   この feed 専用のバッファ (本数の上限なし) に持つ。GeckoTerminalClient.fetchOhlcv のキャッシュ (3000 本で切り詰める) は使わない
 *   (前向きのページングで古い足が消え、--days の期間が欠けるため)。以後の呼び出しはバッファから返す。
 * - GeckoTerminal の履歴が要求より短ければ (先頭に達しても since まで届かない)、onWarn で実際に取れた期間を知らせて、取れた分で続ける
 *   (バックテストは実際の期間を表示する)。1 本も取れなければ例外。
 * - 呼び出しは GECKO_CALLS_PER_MIN の枠で待つ (1m の 30 日分は約 44 回)。気配は無い (バックテストは足だけを使う)。
 * - GeckoTerminal が古い 1m の足をどこまで返すかは未確認 (要確認)。
 */
import { GECKO_MAX_LIMIT, pageCandlesBackward, type GeckoTerminalClient } from "../jupiter/gecko";
import { TIMEFRAME_MS, type Candle, type Instrument, type MarketDataFeed, type Quote, type Timeframe } from "../../core/types";

export class GeckoHistoryFeed implements MarketDataFeed {
  readonly venue: string;
  private readonly buffers = new Map<Timeframe, { from: number; candles: Candle[] }>();

  constructor(
    private readonly gecko: GeckoTerminalClient,
    private readonly inst: Instrument,
    private readonly pool: string,
    private readonly now: () => number = Date.now,
    /** ページ数の上限 (既定 400 = 1m で約 277 日) */
    private readonly maxPages = 400,
    /** 履歴が要求より短いときの警告 (既定は何もしない) */
    private readonly onWarn: (msg: string) => void = () => undefined,
  ) {
    this.venue = inst.venue;
  }

  async listInstruments(): Promise<Instrument[]> {
    return [this.inst];
  }

  private async load(tf: Timeframe, from: number): Promise<Candle[]> {
    const have = this.buffers.get(tf);
    if (have && have.from <= from) return have.candles;
    const ms = TIMEFRAME_MS[tf];
    const bars = Math.ceil((this.now() - from) / ms) + 2;
    const pages = Math.ceil(bars / GECKO_MAX_LIMIT) + 1;
    if (pages > this.maxPages) throw new Error(`GeckoTerminal: ${tf} の ${bars} 本は多すぎます (ページの上限 ${this.maxPages})。--days を短くしてください`);
    const r = await pageCandlesBackward(
      (beforeSec, limit) => this.gecko.fetchOhlcvPage(this.pool, tf, { ...(beforeSec !== undefined ? { beforeSec } : {}), limit }),
      { limit: bars, stopAt: from, maxPages: pages },
    );
    const closed = r.candles.filter((c) => c.ts + ms <= this.now());
    const oldest = closed[0]?.ts;
    if (oldest === undefined) {
      throw new Error(`GeckoTerminal の ${tf} の履歴を取得できません (0 本${r.exhausted ? "。プールの履歴の先頭に達しました" : ""})`);
    }
    if (oldest > from + ms) {
      this.onWarn(
        `GeckoTerminal の ${tf} の履歴が要求より短いです (要求 ${new Date(from).toISOString()} 以降、取得できたのは ` +
          `${new Date(oldest).toISOString()} 以降${r.exhausted ? "。プールの履歴の先頭に達しました" : ""})。取れた分だけで計算します`,
      );
    }
    this.buffers.set(tf, { from, candles: closed });
    return closed;
  }

  async fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    if (symbol !== this.inst.symbol) return [];
    const from = since ?? this.now() - Math.max(1, limit) * TIMEFRAME_MS[tf];
    const all = await this.load(tf, from);
    const out = since !== undefined ? all.filter((c) => c.ts >= since).slice(0, Math.max(1, limit)) : all.slice(-Math.max(1, limit));
    return out.map((c) => ({ ...c }));
  }

  async fetchQuote(): Promise<Quote> {
    throw new Error("GeckoHistoryFeed は気配を返しません (バックテスト専用)");
  }
}
