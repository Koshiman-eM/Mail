/** CLI の backtest コマンド (合成データ・ccxt・GMOコインの履歴で runBacktest) */
import { generateCandles, syntheticInstrument } from "../backtest/synthetic";
import { runBacktest } from "../backtest/engine";
import type { BacktestMetrics, BacktestOptions } from "../backtest/types";
import { TIMEFRAME_MS, type Candle, type Instrument, type MarketDataFeed, type Strategy, type Timeframe } from "../core/types";
import { mergeCandles } from "../market/candles";
import { ALL_STRATEGIES, getStrategy } from "../strategies/registry";
import { fmtNum, fmtPct, formatTable } from "./report";
import { isHoldLimitedHorizon } from "./tempo";
import { horizonLabel, strategyLabel } from "../strategies/labels";

const DAY = 86_400_000;
/** 合成データの開始時刻 (再現性のため固定) */
export const BACKTEST_SYNTHETIC_START = Date.UTC(2024, 0, 1);

export interface BacktestCommandOptions {
  /** 戦略 ID または "all" */
  strategy: string;
  symbol?: string;
  days: number;
  source: BacktestSource;
  seed: number;
  /** 期待値幅 / コストの下限 (実運用の MIN_EDGE_TO_COST に合わせる) */
  minEdgeToCostRatio?: number;
  riskPerTrade?: number;
  maxPositionPct?: number;
  /** ccxt / gmo のときの feed (CcxtFeed.create(CCXT_EXCHANGE)、GmoFeed など) */
  feed?: MarketDataFeed;
  now?: number;
  /** 戦略一覧の差し替え (テスト用) */
  strategies?: readonly Strategy[];
  /** 指値 (maker) の前提 (実運用の LIMIT_ENTRY / LIMIT_TAKE_PROFIT / LIMIT_ENTRY_TIMEOUT_MS に合わせる。省略時は従来の成行) */
  limitOrders?: BacktestOptions["limitOrders"];
  /**
   * 最大保有 (分。実運用の MAX_HOLD_MINUTES に合わせる。0・省略で無効)。シグナルの最大保有を縮める。
   * 時間軸が中期・長期の戦略 (いまは登録なし) は縮めずに計算し、運用では新規エントリーしない旨を備考に出す
   */
  maxHoldMinutes?: number;
  /** 読みの管理 (実運用の THESIS_* に合わせる。省略で従来の時間切れ) */
  thesis?: BacktestOptions["thesis"];
  /** 転換で決済 (実運用の REVERSAL_* に合わせる。省略で従来どおり) */
  reversal?: BacktestOptions["reversal"];
}

export interface BacktestRow {
  strategyId: string;
  horizon: string;
  baseTimeframe: Timeframe;
  bars: number;
  metrics?: BacktestMetrics;
  note?: string;
}

/** 戦略の全時間足を作れる最小の時間足 */
export function baseTimeframeOf(s: Pick<Strategy, "timeframes" | "primaryTimeframe">): Timeframe {
  return [...s.timeframes, s.primaryTimeframe].reduce((a, b) => (TIMEFRAME_MS[b] < TIMEFRAME_MS[a] ? b : a));
}

/** 合成データのボラティリティ (1 本あたり)。1m で 0.06% → 時間足の平方根でスケール */
export function syntheticVolFor(tf: Timeframe): number {
  return 0.0006 * Math.sqrt(TIMEFRAME_MS[tf] / TIMEFRAME_MS["1m"]);
}

/** feed.fetchCandles をページングして [from, until) の確定足を集める */
export async function fetchCandlesPaged(
  feed: Pick<MarketDataFeed, "fetchCandles">,
  symbol: string,
  tf: Timeframe,
  from: number,
  until: number,
  opts: { pageLimit?: number; maxPages?: number } = {},
): Promise<Candle[]> {
  const ms = TIMEFRAME_MS[tf];
  const limit = opts.pageLimit ?? 1000;
  let since = from;
  let out: Candle[] = [];
  for (let page = 0; page < (opts.maxPages ?? 500) && since < until; page++) {
    const rows = (await feed.fetchCandles(symbol, tf, limit, since)).filter((c) => c.ts >= since && c.ts + ms <= until);
    if (rows.length === 0) break;
    out = mergeCandles(out, rows, Number.MAX_SAFE_INTEGER);
    const next = rows[rows.length - 1].ts + ms;
    if (next <= since) break;
    since = next;
  }
  return out;
}

/** 足の取得元。synthetic 以外は o.feed (ccxt は CcxtFeed、gmo は GmoFeed) から履歴を取る */
export type BacktestSource = "synthetic" | "ccxt" | "gmo";

export interface BacktestData {
  base: Timeframe;
  candles: Candle[];
  instrument: Instrument;
  /** この時刻以降の足からトレードする (それより前はウォームアップ) */
  tradeFromTs: number;
}

/** 取得元ごとの共有状態 (同じ基準足の履歴を戦略ごとに取り直さない) */
export interface BacktestDataLoader {
  load(s: Strategy, leadBars?: number): Promise<BacktestData>;
}

/**
 * バックテスト用の足を用意する。期間 days の前に主時間足で (leadBars ?? warmup + 50) 本分のウォームアップを付ける。
 * synthetic は固定の開始時刻から生成 (シード固定)、ccxt / gmo は feed から [until - 期間 - ウォームアップ, until) をページングで取得する。
 */
export async function createBacktestDataLoader(o: Pick<BacktestCommandOptions, "symbol" | "days" | "source" | "seed" | "feed" | "now">): Promise<BacktestDataLoader> {
  if (!(o.days > 0)) throw new Error("--days は正の数を指定してください");
  const periodMs = o.days * DAY;
  const now = o.now ?? Date.now();
  const cache = new Map<string, Candle[]>();
  let feedInst: Instrument | undefined;
  if (o.source !== "synthetic") {
    if (!o.feed) throw new Error(`${o.source} の feed がありません`);
    const sym = o.symbol ?? (o.source === "gmo" ? "BTC/JPY" : "BTC/USDT");
    feedInst = (await o.feed.listInstruments()).find((i) => i.symbol === sym);
    if (!feedInst) throw new Error(`取引所に銘柄がありません: ${sym}`);
  }
  return {
    async load(s: Strategy, leadBars?: number): Promise<BacktestData> {
      const base = baseTimeframeOf(s);
      const warmupMs = (leadBars ?? s.warmup + 50) * TIMEFRAME_MS[s.primaryTimeframe];
      const baseMs = TIMEFRAME_MS[base];
      if (o.source === "synthetic") {
        const bars = Math.ceil((warmupMs + periodMs) / baseMs);
        const key = `syn|${base}|${bars}`;
        const candles = cache.get(key) ?? generateCandles({ seed: o.seed, bars, timeframe: base, vol: syntheticVolFor(base), startTs: BACKTEST_SYNTHETIC_START });
        cache.set(key, candles);
        const cls = s.assetClasses.includes("crypto") ? "crypto" : s.assetClasses[0];
        const instrument = syntheticInstrument({ symbol: o.symbol ?? "SYN/USDT", assetClass: cls });
        return { base, candles, instrument, tradeFromTs: BACKTEST_SYNTHETIC_START + warmupMs };
      }
      const until = Math.floor(now / baseMs) * baseMs;
      const from = until - periodMs - warmupMs;
      const key = `${o.source}|${base}|${from}`;
      const candles = cache.get(key) ?? (await fetchCandlesPaged(o.feed!, feedInst!.symbol, base, from, until));
      cache.set(key, candles);
      return { base, candles, instrument: feedInst!, tradeFromTs: until - periodMs };
    },
  };
}

export async function runBacktestCommand(o: BacktestCommandOptions): Promise<BacktestRow[]> {
  const all = o.strategies ?? ALL_STRATEGIES;
  const selected = o.strategy === "all" ? [...all] : [all.find((s) => s.id === o.strategy) ?? getStrategy(o.strategy)].filter((s): s is Strategy => Boolean(s));
  if (selected.length === 0) throw new Error(`未知の戦略: ${o.strategy} (${all.map((s) => s.id).join(", ")}, all)`);
  const loader = await createBacktestDataLoader(o);
  const holdOn = o.maxHoldMinutes !== undefined && Number.isFinite(o.maxHoldMinutes) && o.maxHoldMinutes > 0;

  const rows: BacktestRow[] = [];
  for (const s of selected) {
    const base = baseTimeframeOf(s);
    if (s.requiresBook) {
      rows.push({ strategyId: s.id, horizon: s.horizon, baseTimeframe: base, bars: 0, note: "板情報が必要なため履歴バックテストの対象外" });
      continue;
    }
    const { candles, instrument, tradeFromTs } = await loader.load(s);
    if (candles.length === 0) {
      rows.push({ strategyId: s.id, horizon: s.horizon, baseTimeframe: base, bars: 0, note: "足を取得できませんでした" });
      continue;
    }
    const r = runBacktest({
      strategy: s,
      instrument,
      candles,
      baseTimeframe: base,
      tradeFromTs,
      ...(o.minEdgeToCostRatio !== undefined ? { minEdgeToCostRatio: o.minEdgeToCostRatio } : {}),
      ...(o.riskPerTrade !== undefined ? { riskPerTrade: o.riskPerTrade } : {}),
      ...(o.maxPositionPct !== undefined ? { maxPositionPct: o.maxPositionPct } : {}),
      ...(o.limitOrders ? { limitOrders: o.limitOrders } : {}),
      ...(holdOn && !isHoldLimitedHorizon(s.horizon) ? { maxHoldMinutes: o.maxHoldMinutes } : {}),
      ...(o.thesis ? { thesis: o.thesis } : {}),
      ...(o.reversal ? { reversal: o.reversal } : {}),
    });
    const notes = [
      ...(r.metrics.trades === 0 ? [r.stats.evaluations === 0 ? "ウォームアップ不足" : "シグナルなし"] : []),
      ...(holdOn && isHoldLimitedHorizon(s.horizon) ? [`最大保有 ${o.maxHoldMinutes} 分のため運用では発注しない (仮想トレードのみ)`] : []),
    ];
    rows.push({
      strategyId: s.id,
      horizon: s.horizon,
      baseTimeframe: base,
      bars: candles.length,
      metrics: r.metrics,
      ...(notes.length ? { note: notes.join(" / ") } : {}),
    });
  }
  return rows;
}


export function formatBacktestRows(rows: BacktestRow[]): string {
  return formatTable(
    ["戦略", "時間軸", "基準足", "本数", "取引数", "勝率", "純損益", "リターン", "最大DD", "PF", "期待値R", "シャープ", "手数料", "備考"],
    rows.map((r) => {
      const m = r.metrics;
      return [
        strategyLabel(r.strategyId), horizonLabel(r.horizon), r.baseTimeframe, r.bars,
        m ? m.trades : "-", m ? fmtPct(m.winRate, 1) : "-", m ? fmtNum(m.netPnl, 0) : "-", m ? fmtPct(m.returnPct) : "-",
        m ? fmtPct(m.maxDrawdown) : "-", m ? m.profitFactor.toFixed(2) : "-", m ? m.expectancyR.toFixed(3) : "-", m ? m.sharpe.toFixed(2) : "-",
        m ? fmtNum(m.fees, 0) : "-", r.note ?? "",
      ];
    }),
  );
}
