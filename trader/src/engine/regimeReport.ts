/** CLI の regime コマンド: 運用中と同じ detectRegime で、過去の各時刻の相場の状態 (レジーム) を確かめる */
import { TIMEFRAME_MS, type AssetClass, type Candle, type MarketDataFeed, type RegimeLabel, type Timeframe } from "../core/types";
import { detectRegime, regimeOptionsFor, type RegimeOptions } from "../regime/detect";
import { structureAt } from "../structure/machine";
import type { Bias, StructureOptions, StructureRegime } from "../structure/types";
import { STRUCTURE_WINDOW_BARS } from "../structure/wrap";
import { fetchCandlesPaged } from "./backtestCommand";
import { fmtTime, formatTable } from "./report";
import { REGIME_LABEL_JA } from "../strategies/labels";

export { REGIME_LABEL_JA };
const LABEL_ORDER: RegimeLabel[] = ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"];
export const DEFAULT_REGIME_TIMEFRAMES: Timeframe[] = ["1m", "15m", "1h", "4h"];

/** detectRegime が内部で使う足の本数 (detect.ts の need と同じ式) */
export function regimeNeed(o: RegimeOptions): number {
  return Math.max(o.volLookback + o.atrPeriod, 2 * o.adxPeriod + 50, o.emaPeriod * 3 + o.slopeBars);
}

export interface RegimeCell {
  ts: number;
  /** 判定に必要な本数に足りないとき undefined */
  label?: RegimeLabel;
  adx?: number;
  trend?: number;
  volPct?: number;
  close?: number;
  /** 直前の行からラベルが変わった */
  changed?: boolean;
  /** その時点で使えた確定足の本数 */
  bars: number;
  /** 相場構造 (運用のラッパーと同じく、t までの確定足の直近 STRUCTURE_WINDOW_BARS 本で計算。足が無ければ undefined) */
  structure?: RegimeStructureCell;
}

export interface RegimeStructureCell {
  /** 目線 (方法 1) */
  bias: Bias;
  regime: StructureRegime;
  /** 方法 2 */
  trendConfirmed: Bias;
  oshiYasune: number | null;
  modoriTakane: number | null;
  choppy: boolean;
  flips: number;
}

/** 構造の列の設定 (STRUCTURE_PIVOT_N などから)。省略時は既定値 */
export type RegimeStructureOptions = Partial<Pick<StructureOptions, "pivotN" | "breakMode" | "reversalMode" | "chopM" | "chopR">>;

/** t までに確定した n 本の足 (candles[0..n-1]) の構造。運用と同じく直近 STRUCTURE_WINDOW_BARS 本だけで計算する */
export function structureCell(candles: readonly Candle[], n: number, o: RegimeStructureOptions = {}): RegimeStructureCell | undefined {
  if (n <= 0) return undefined;
  const s = structureAt(candles.slice(Math.max(0, n - STRUCTURE_WINDOW_BARS), n), undefined, o);
  return {
    bias: s.bias, regime: s.regime, trendConfirmed: s.trendConfirmed, oshiYasune: s.oshiYasune, modoriTakane: s.modoriTakane,
    choppy: s.choppy, flips: s.flips,
  };
}

export interface RegimeSeries {
  tf: Timeframe;
  need: number;
  cells: RegimeCell[];
  /** ラベル別の件数 (判定できた行のみ) */
  counts: Record<RegimeLabel, number>;
  insufficient: number;
}

/** candles (ts 昇順) のうち t 時点で確定している本数 (ts + tfMs <= t)。先読みしないための境界 */
export function confirmedCount(candles: readonly Candle[], tfMs: number, t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].ts + tfMs <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 時間足 1 本分の系列: 各時刻 t で、t までに確定した足だけで detectRegime する。気配は無いのでスプレッドは 0 扱い */
export function regimeSeries(
  candles: readonly Candle[],
  tf: Timeframe,
  times: readonly number[],
  opts: RegimeOptions,
  structure: RegimeStructureOptions = {},
): RegimeSeries {
  const ms = TIMEFRAME_MS[tf];
  const need = regimeNeed(opts);
  const counts = Object.fromEntries(LABEL_ORDER.map((l) => [l, 0])) as Record<RegimeLabel, number>;
  const cells: RegimeCell[] = [];
  let insufficient = 0;
  let prev: RegimeLabel | undefined;
  for (const t of times) {
    const n = confirmedCount(candles, ms, t);
    const st = structureCell(candles, n, structure);
    if (n < need) {
      cells.push({ ts: t, bars: n, ...(st ? { structure: st } : {}) });
      insufficient++;
      continue;
    }
    const r = detectRegime(candles.slice(0, n), undefined, opts);
    counts[r.label]++;
    cells.push({
      ts: t, label: r.label, adx: r.trendStrength, trend: r.trend, volPct: r.volatilityPercentile, close: candles[n - 1].close,
      changed: prev !== undefined && prev !== r.label, bars: n, ...(st ? { structure: st } : {}),
    });
    prev = r.label;
  }
  return { tf, need, cells, counts, insufficient };
}

/** [from, until] の step 刻みの時刻 (step の倍数に揃える) */
export function regimeTimes(from: number, until: number, stepMs: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(from / stepMs) * stepMs; t <= until; t += stepMs) out.push(t);
  return out;
}

export function buildRegimeReport(o: {
  candlesByTf: Partial<Record<Timeframe, readonly Candle[]>>;
  timeframes: readonly Timeframe[];
  from: number;
  until: number;
  stepMs: number;
  assetClass?: AssetClass;
  structure?: RegimeStructureOptions;
}): RegimeSeries[] {
  const opts = regimeOptionsFor(o.assetClass ?? "crypto");
  const times = regimeTimes(o.from, o.until, o.stepMs);
  return o.timeframes.map((tf) => regimeSeries(o.candlesByTf[tf] ?? [], tf, times, opts, o.structure ?? {}));
}

const BIAS_JA: Record<StructureRegime, string> = {
  up: "上",
  weakeningUp: "上 (転換途中)",
  down: "下",
  weakeningDown: "下 (転換途中)",
  none: "なし",
};
const BIAS2_JA: Record<Bias, string> = { up: "上", down: "下", none: "なし" };

/** 構造の列 (目線・方法 2・押し安値 / 戻り高値・ちゃぶつき) */
export function structureColumns(st: RegimeStructureCell | undefined): string[] {
  if (!st) return ["-", "-", "-", ""];
  const level = st.oshiYasune !== null ? `押し ${st.oshiYasune}` : st.modoriTakane !== null ? `戻り ${st.modoriTakane}` : "-";
  return [BIAS_JA[st.regime], BIAS2_JA[st.trendConfirmed], level, st.choppy ? `ちゃぶつき (${st.flips})` : ""];
}

const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 16);

export function formatRegimeReport(series: readonly RegimeSeries[], head: { symbol: string; from: number; until: number; stepMs: number }): string {
  const lines = [
    `レジーム判定: ${head.symbol} / ${fmtTime(head.from)} 〜 ${fmtTime(head.until)} / ${head.stepMs / 60_000} 分ごと (運用中と同じ detectRegime。各時刻の確定足だけで判定)`,
    "注記: 気配 (スプレッド) の過去分は無いので、スプレッドは 0 として判定します (流動性が低い判定は出ません)。",
    `注記: 目線・押し安値/戻り高値・ちゃぶつきは相場構造 (ダウ理論) の判定。運用のフィルターと同じく、各時刻の確定足の直近 ${STRUCTURE_WINDOW_BARS} 本で計算します。`,
  ];
  for (const s of series) {
    lines.push("", `■ ${s.tf} (判定に必要な足 ${s.need} 本)`);
    // レジームも構造も判定できない時間足は 1 行にまとめる (構造だけでも出せるなら表を出す)
    if (s.cells.length > 0 && s.insufficient === s.cells.length && s.cells.every((c) => !c.structure || c.structure.bias === "none")) {
      lines.push(`  足りない (使える確定足 ${s.cells[s.cells.length - 1].bars} 本 < ${s.need} 本)`);
      continue;
    }
    lines.push(
      formatTable(
        ["時刻", "判定", "ADX", "trend", "ボラ%ile", "終値", "", "目線", "方法2", "押し安値/戻り高値", "ちゃぶつき"],
        s.cells.map((c) =>
          c.label
            ? [
                hhmm(c.ts), REGIME_LABEL_JA[c.label], c.adx!.toFixed(1), c.trend!.toFixed(2), `${(c.volPct! * 100).toFixed(0)}%`, String(c.close),
                c.changed ? "◀ 変化" : "", ...structureColumns(c.structure),
              ]
            : [hhmm(c.ts), "足りない", "-", "-", "-", "-", "", ...structureColumns(c.structure)],
        ),
      ),
    );
    const judged = s.cells.length - s.insufficient;
    lines.push(
      `  集計 (${judged} 件${s.insufficient ? `、足りない ${s.insufficient} 件を除く` : ""}): ` +
        LABEL_ORDER.map((l) => `${REGIME_LABEL_JA[l]} ${judged ? ((s.counts[l] / judged) * 100).toFixed(1) : "0.0"}%`).join(" / "),
    );
  }
  return lines.join("\n");
}

export interface RegimeCommandOptions {
  feed: Pick<MarketDataFeed, "fetchCandles" | "listInstruments">;
  symbol: string;
  hours: number;
  timeframes?: readonly Timeframe[];
  /** 表示の刻み (分) */
  stepMin?: number;
  now?: number;
  /** 構造の列の設定 (STRUCTURE_PIVOT_N など) */
  structure?: RegimeStructureOptions;
}

/** feed から足を取り (ウォームアップ分を前に付ける)、整形済みの文字列を返す */
export async function runRegimeCommand(o: RegimeCommandOptions): Promise<string> {
  const tfs = o.timeframes ?? DEFAULT_REGIME_TIMEFRAMES;
  const stepMs = (o.stepMin ?? 5) * 60_000;
  const now = o.now ?? Date.now();
  const until = Math.floor(now / 60_000) * 60_000;
  const from = until - o.hours * 3_600_000;
  const inst = (await o.feed.listInstruments()).find((i) => i.symbol === o.symbol);
  if (!inst) throw new Error(`取引所に銘柄がありません: ${o.symbol}`);
  // ウォームアップ: レジームの判定に必要な本数と、構造の窓 (STRUCTURE_WINDOW_BARS) の長い方
  const need = Math.max(regimeNeed(regimeOptionsFor(inst.assetClass)), STRUCTURE_WINDOW_BARS);
  const candlesByTf: Partial<Record<Timeframe, Candle[]>> = {};
  for (const tf of tfs) candlesByTf[tf] = await fetchCandlesPaged(o.feed, inst.symbol, tf, from - (need + 2) * TIMEFRAME_MS[tf], until);
  const series = buildRegimeReport({ candlesByTf, timeframes: tfs, from, until, stepMs, assetClass: inst.assetClass, ...(o.structure ? { structure: o.structure } : {}) });
  return formatRegimeReport(series, { symbol: inst.symbol, from, until, stepMs });
}
