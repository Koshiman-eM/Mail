/**
 * CLI の backtest コマンド (合成データ・feed の履歴で runBacktest)。
 * 足の取得元は synthetic (合成データ) か feed (o.feed)。アプリは取得元の名前を登録する (trader: ccxt・jupiter。registerBacktestSource)
 */
import { generateCandles, syntheticInstrument } from "../backtest/synthetic";
import { runBacktest } from "../backtest/engine";
import type { BacktestMetrics, BacktestOptions } from "../backtest/types";
import { TIMEFRAME_MS, type Candle, type EquityPoint, type Instrument, type MarketDataFeed, type Strategy, type Timeframe, type TradeRecord } from "../core/types";
import { mergeCandles } from "../market/candles";
import { enabledAssetClasses } from "../core/assetClasses";
import { ALL_STRATEGIES, getStrategy } from "../strategies/registry";
import { fmtNum, fmtPct, formatTable } from "./report";
import { isHoldLimitedStrategy } from "./tempo";
import { horizonLabel, strategyLabel } from "../strategies/labels";
import { buyAndHold, foldSummaries, totalR, type BacktestPeriod, type BuyAndHold, type FoldSummary } from "./backtestValidation";

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
  /** ccxt のときの feed (CcxtFeed.create(CCXT_EXCHANGE) など) */
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
  /** 建値ストップ (実運用の BREAKEVEN_TRIGGER_R に合わせる。省略で従来どおり) */
  breakeven?: BacktestOptions["breakeven"];
  /**
   * 銘柄定義の差し替え (コストの前提を変える。例: trader の --cost-model jupiter)。取得元の銘柄定義 (合成データは戦略ごと) に掛ける。
   * 前提に合わない銘柄なら例外にしてよい (足を取る前に呼ぶ)
   */
  adjustInstrument?: (inst: Instrument) => Instrument;
  /** 区間別の成績 (通しの結果を期間で folds 等分して切り出す。0・省略・1 なら出さない) */
  folds?: number;
}

export interface BacktestRow {
  strategyId: string;
  horizon: string;
  baseTimeframe: Timeframe;
  bars: number;
  metrics?: BacktestMetrics;
  note?: string;
  /** 実際にトレードの対象にした期間 (足があれば) */
  period?: BacktestPeriod;
  /** 同じ期間の保有 (buy & hold) */
  benchmark?: BuyAndHold;
  /** 合計 R */
  totalR?: number;
  /** 区間別の成績 (folds を指定したとき) */
  folds?: FoldSummary[];
  /** 銘柄定義 (コストの表示用) */
  instrument?: Instrument;
  /** 取引と評価額曲線 (複数銘柄の合計用) */
  trades?: TradeRecord[];
  equityCurve?: EquityPoint[];
  initialEquity?: number;
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
  // ページの上限: 取引所の 1 回の上限 (feed が limit を切り詰める。例 okx 100) が小さくても長い期間を取り切れるよう、
  // 1 ページ 50 本でも足りる回数にする (進まない・0 本ならその時点で止まる)
  const maxPages = opts.maxPages ?? Math.max(500, Math.ceil((until - from) / ms / 50) + 10);
  let since = from;
  let out: Candle[] = [];
  for (let page = 0; page < maxPages && since < until; page++) {
    const rows = (await feed.fetchCandles(symbol, tf, limit, since)).filter((c) => c.ts >= since && c.ts + ms <= until);
    if (rows.length === 0) break;
    out = mergeCandles(out, rows, Number.MAX_SAFE_INTEGER);
    const next = rows[rows.length - 1].ts + ms;
    if (next <= since) break;
    since = next;
  }
  return out;
}

/**
 * 足の取得元。synthetic は合成データ、それ以外 ("feed"・アプリが登録した名前。trader の ccxt は CcxtFeed、jupiter は
 * GeckoHistoryFeed) は o.feed から履歴を取る
 */
export type BacktestSource = "synthetic" | "feed" | (string & {});

/** アプリが登録する足の取得元 (CLI の --source)。Ctx はアプリの CLI の文脈 (設定・引数・出力) */
export interface BacktestSourceSpec<Ctx = never> {
  name: string;
  /** 表示名 (例: "ccxt bitbank") */
  label(ctx: Ctx): string;
  /** 履歴の feed と既定の銘柄を用意する */
  open(ctx: Ctx): Promise<{ feed: MarketDataFeed; symbol: string }>;
  /** 指値を使わない (成行だけの取引先) */
  marketOnly?: boolean;
}

const BACKTEST_SOURCES = new Map<string, BacktestSourceSpec<any>>();

/** 足の取得元を登録する (同じ名前は上書き。"synthetic" / "feed" は登録できない) */
export function registerBacktestSource<Ctx>(spec: BacktestSourceSpec<Ctx>): void {
  if (spec.name === "synthetic" || spec.name === "feed") throw new Error(`${spec.name} はコアの取得元です`);
  BACKTEST_SOURCES.set(spec.name, spec);
}

/** 登録した取得元 (無ければ undefined) */
export function backtestSourceSpec<Ctx>(name: string): BacktestSourceSpec<Ctx> | undefined {
  return BACKTEST_SOURCES.get(name);
}

/** CLI で選べる取得元の名前 (synthetic + 登録順) */
export function backtestSourceNames(): string[] {
  return ["synthetic", ...BACKTEST_SOURCES.keys()];
}

export interface BacktestData {
  base: Timeframe;
  candles: Candle[];
  instrument: Instrument;
  /** この時刻以降の足からトレードする (それより前はウォームアップ) */
  tradeFromTs: number;
  /** 要求した開始時刻 (履歴が短いと tradeFromTs はこれより遅い) */
  requestedFromTs?: number;
}

/** 取得元ごとの共有状態 (同じ基準足の履歴を戦略ごとに取り直さない) */
export interface BacktestDataLoader {
  load(s: Strategy, leadBars?: number): Promise<BacktestData>;
}

/**
 * バックテスト用の足を用意する。期間 days の前に主時間足で (leadBars ?? warmup + 50) 本分のウォームアップを付ける。
 * synthetic は固定の開始時刻から生成 (シード固定)、ccxt は feed から [until - 期間 - ウォームアップ, until) をページングで取得する。
 */
export async function createBacktestDataLoader(
  o: Pick<BacktestCommandOptions, "symbol" | "days" | "source" | "seed" | "feed" | "now" | "adjustInstrument">,
): Promise<BacktestDataLoader> {
  if (!(o.days > 0)) throw new Error("--days は正の数を指定してください");
  const periodMs = o.days * DAY;
  const now = o.now ?? Date.now();
  const cache = new Map<string, Candle[]>();
  let feedInst: Instrument | undefined;
  if (o.source !== "synthetic") {
    if (!o.feed) throw new Error(`${o.source} の feed がありません`);
    const sym = o.symbol ?? "BTC/USDT";
    feedInst = (await o.feed.listInstruments()).find((i) => i.symbol === sym);
    if (!feedInst) throw new Error(`取引所に銘柄がありません: ${sym}`);
    if (o.adjustInstrument) feedInst = o.adjustInstrument(feedInst);
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
        // アプリが使う資産クラスのうち戦略が対応する最初のもの (trader は crypto 優先)
        const cls = enabledAssetClasses().find((c) => s.assetClasses.includes(c)) ?? s.assetClasses[0];
        const synInst = syntheticInstrument({ symbol: o.symbol ?? "SYN/USDT", assetClass: cls });
        const instrument = o.adjustInstrument ? o.adjustInstrument(synInst) : synInst;
        return { base, candles, instrument, tradeFromTs: BACKTEST_SYNTHETIC_START + warmupMs, requestedFromTs: BACKTEST_SYNTHETIC_START + warmupMs };
      }
      const until = Math.floor(now / baseMs) * baseMs;
      const from = until - periodMs - warmupMs;
      const key = `${o.source}|${base}|${from}`;
      const candles = cache.get(key) ?? (await fetchCandlesPaged(o.feed!, feedInst!.symbol, base, from, until));
      cache.set(key, candles);
      // 履歴が要求より短い (上場が新しい・取引所の履歴の先頭) ときは、取れた最初の足からウォームアップしてからトレードする
      const requestedFromTs = until - periodMs;
      const tradeFromTs = candles.length > 0 ? Math.max(requestedFromTs, candles[0].ts + warmupMs) : requestedFromTs;
      return { base, candles, instrument: feedInst!, tradeFromTs, requestedFromTs };
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
    const { candles, instrument, tradeFromTs, requestedFromTs } = await loader.load(s);
    if (candles.length === 0) {
      rows.push({ strategyId: s.id, horizon: s.horizon, baseTimeframe: base, bars: 0, note: "足を取得できませんでした" });
      continue;
    }
    const initialEquity = 1_000_000;
    const r = runBacktest({
      initialEquity,
      strategy: s,
      instrument,
      candles,
      baseTimeframe: base,
      tradeFromTs,
      ...(o.minEdgeToCostRatio !== undefined ? { minEdgeToCostRatio: o.minEdgeToCostRatio } : {}),
      ...(o.riskPerTrade !== undefined ? { riskPerTrade: o.riskPerTrade } : {}),
      ...(o.maxPositionPct !== undefined ? { maxPositionPct: o.maxPositionPct } : {}),
      ...(o.limitOrders ? { limitOrders: o.limitOrders } : {}),
      ...(holdOn && !isHoldLimitedStrategy(s) ? { maxHoldMinutes: o.maxHoldMinutes } : {}),
      ...(o.thesis ? { thesis: o.thesis } : {}),
      ...(o.reversal ? { reversal: o.reversal } : {}),
      ...(o.breakeven ? { breakeven: o.breakeven } : {}),
    });
    const notes = [
      ...(r.metrics.trades === 0 ? [r.stats.evaluations === 0 ? "ウォームアップ不足" : "シグナルなし"] : []),
      ...(holdOn && isHoldLimitedStrategy(s) ? [`最大保有 ${o.maxHoldMinutes} 分のため運用では発注しない (仮想トレードのみ)`] : []),
    ];
    const baseMs = TIMEFRAME_MS[base];
    const firstTraded = candles.find((c) => c.ts >= tradeFromTs);
    const period: BacktestPeriod | undefined = firstTraded
      ? { requestedFrom: requestedFromTs ?? tradeFromTs, from: firstTraded.ts, to: candles[candles.length - 1].ts + baseMs }
      : undefined;
    const benchmark = buyAndHold(candles, tradeFromTs, baseMs);
    const folds = period && o.folds !== undefined && o.folds >= 2 ? foldSummaries(r, period.from, period.to, o.folds) : undefined;
    rows.push({
      strategyId: s.id,
      horizon: s.horizon,
      baseTimeframe: base,
      bars: candles.length,
      metrics: r.metrics,
      ...(notes.length ? { note: notes.join(" / ") } : {}),
      ...(period ? { period } : {}),
      ...(benchmark ? { benchmark } : {}),
      totalR: totalR(r.trades),
      ...(folds ? { folds } : {}),
      instrument,
      trades: r.trades,
      equityCurve: r.equityCurve,
      initialEquity,
    });
  }
  return rows;
}


/**
 * 戦略ごとの表。benchmark: true で合計 R と同じ期間の保有 (buy & hold) のリターン・最大DD の列を足す
 * (トレンドフォローを単に持っていた場合と比べる)
 */
export function formatBacktestRows(rows: BacktestRow[], opts: { benchmark?: boolean } = {}): string {
  const bench = opts.benchmark === true;
  return formatTable(
    [
      "戦略", "時間軸", "基準足", "本数", "取引数", "勝率", "純損益", "リターン", "最大DD", "PF", "期待値R",
      ...(bench ? ["合計R"] : []), "シャープ", "手数料", ...(bench ? ["保有リターン", "保有DD"] : []), "備考",
    ],
    rows.map((r) => {
      const m = r.metrics;
      const b = r.benchmark;
      return [
        strategyLabel(r.strategyId), horizonLabel(r.horizon), r.baseTimeframe, r.bars,
        m ? m.trades : "-", m ? fmtPct(m.winRate, 1) : "-", m ? fmtNum(m.netPnl, 0) : "-", m ? fmtPct(m.returnPct) : "-",
        m ? fmtPct(m.maxDrawdown) : "-", m ? m.profitFactor.toFixed(2) : "-", m ? m.expectancyR.toFixed(3) : "-",
        ...(bench ? [m && r.totalR !== undefined ? r.totalR.toFixed(2) : "-"] : []),
        m ? m.sharpe.toFixed(2) : "-", m ? fmtNum(m.fees, 0) : "-",
        ...(bench ? [b ? fmtPct(b.returnPct) : "-", b ? fmtPct(b.maxDrawdown) : "-"] : []),
        r.note ?? "",
      ];
    }),
  );
}
