/** CLI の backtest コマンド (合成データ or ccxt の履歴で runBacktest) */
import { generateCandles, syntheticInstrument } from "../backtest/synthetic";
import { runBacktest } from "../backtest/engine";
import type { BacktestMetrics } from "../backtest/types";
import { TIMEFRAME_MS, type Candle, type Instrument, type MarketDataFeed, type Strategy, type Timeframe } from "../core/types";
import { mergeCandles } from "../market/candles";
import { ALL_STRATEGIES, getStrategy } from "../strategies/registry";
import { fmtNum, fmtPct, formatTable } from "./report";

const DAY = 86_400_000;
/** 合成データの開始時刻 (再現性のため固定) */
export const BACKTEST_SYNTHETIC_START = Date.UTC(2024, 0, 1);

export interface BacktestCommandOptions {
  /** 戦略 ID または "all" */
  strategy: string;
  symbol?: string;
  days: number;
  source: "synthetic" | "ccxt";
  seed: number;
  /** 期待値幅 / コストの下限 (実運用の MIN_EDGE_TO_COST に合わせる) */
  minEdgeToCostRatio?: number;
  riskPerTrade?: number;
  maxPositionPct?: number;
  /** ccxt のときの feed (CcxtFeed.create(CCXT_EXCHANGE) など) */
  feed?: MarketDataFeed;
  now?: number;
  /** 戦略一覧の差し替え (テスト用) */
  strategies?: readonly Strategy[];
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

export async function runBacktestCommand(o: BacktestCommandOptions): Promise<BacktestRow[]> {
  const all = o.strategies ?? ALL_STRATEGIES;
  const selected = o.strategy === "all" ? [...all] : [all.find((s) => s.id === o.strategy) ?? getStrategy(o.strategy)].filter((s): s is Strategy => Boolean(s));
  if (selected.length === 0) throw new Error(`未知の戦略: ${o.strategy} (${all.map((s) => s.id).join(", ")}, all)`);
  if (!(o.days > 0)) throw new Error("--days は正の数を指定してください");
  const periodMs = o.days * DAY;
  const now = o.now ?? Date.now();
  const cache = new Map<string, Candle[]>();
  let ccxtInst: Instrument | undefined;
  if (o.source === "ccxt") {
    if (!o.feed) throw new Error("ccxt の feed がありません");
    const sym = o.symbol ?? "BTC/USDT";
    ccxtInst = (await o.feed.listInstruments()).find((i) => i.symbol === sym);
    if (!ccxtInst) throw new Error(`取引所に銘柄がありません: ${sym}`);
  }

  const rows: BacktestRow[] = [];
  for (const s of selected) {
    const base = baseTimeframeOf(s);
    if (s.requiresBook) {
      rows.push({ strategyId: s.id, horizon: s.horizon, baseTimeframe: base, bars: 0, note: "板情報が必要なため履歴バックテストの対象外" });
      continue;
    }
    // 主時間足のウォームアップ分を期間の前に付ける
    const warmupMs = (s.warmup + 50) * TIMEFRAME_MS[s.primaryTimeframe];
    const baseMs = TIMEFRAME_MS[base];
    let candles: Candle[];
    let instrument: Instrument;
    let tradeFromTs: number;
    if (o.source === "synthetic") {
      const bars = Math.ceil((warmupMs + periodMs) / baseMs);
      const key = `syn|${base}|${bars}`;
      candles = cache.get(key) ?? generateCandles({ seed: o.seed, bars, timeframe: base, vol: syntheticVolFor(base), startTs: BACKTEST_SYNTHETIC_START });
      cache.set(key, candles);
      const cls = s.assetClasses.includes("crypto") ? "crypto" : s.assetClasses[0];
      instrument = syntheticInstrument({
        symbol: o.symbol ?? "SYN/USDT",
        assetClass: cls,
        ...(cls === "meme" ? { allowShort: false, meta: { liquidityUsd: 1_000_000 } } : {}),
      });
      tradeFromTs = BACKTEST_SYNTHETIC_START + warmupMs;
    } else {
      const until = Math.floor(now / baseMs) * baseMs;
      const from = until - periodMs - warmupMs;
      const key = `ccxt|${base}`;
      candles = cache.get(key) ?? (await fetchCandlesPaged(o.feed!, ccxtInst!.symbol, base, from, until));
      cache.set(key, candles);
      instrument = ccxtInst!;
      tradeFromTs = until - periodMs;
    }
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
    });
    rows.push({
      strategyId: s.id,
      horizon: s.horizon,
      baseTimeframe: base,
      bars: candles.length,
      metrics: r.metrics,
      ...(r.metrics.trades === 0 ? { note: r.stats.evaluations === 0 ? "ウォームアップ不足" : "シグナルなし" } : {}),
    });
  }
  return rows;
}

const HORIZON_LABEL: Record<string, string> = { scalp: "スキャル", short: "短期", mid: "中期", long: "長期" };

export function formatBacktestRows(rows: BacktestRow[]): string {
  return formatTable(
    ["戦略", "時間軸", "基準足", "本数", "取引数", "勝率", "純損益", "リターン", "最大DD", "PF", "期待値R", "シャープ", "手数料", "備考"],
    rows.map((r) => {
      const m = r.metrics;
      return [
        r.strategyId, HORIZON_LABEL[r.horizon] ?? r.horizon, r.baseTimeframe, r.bars,
        m ? m.trades : "-", m ? fmtPct(m.winRate, 1) : "-", m ? fmtNum(m.netPnl, 0) : "-", m ? fmtPct(m.returnPct) : "-",
        m ? fmtPct(m.maxDrawdown) : "-", m ? m.profitFactor.toFixed(2) : "-", m ? m.expectancyR.toFixed(3) : "-", m ? m.sharpe.toFixed(2) : "-",
        m ? fmtNum(m.fees, 0) : "-", r.note ?? "",
      ];
    }),
  );
}
