import { TIMEFRAME_MS, type Candle, type MarketView, type Timeframe } from "../core/types";
import { closedOnly, resample } from "../indicators/resample";

/**
 * 執行足 → 上位足 (マルチタイムフレーム) の対応。
 * 仕様の 30 分足はこのツールの時間足 (Timeframe) に無いので対象外。1w と 1s は上位足なし (MTF の判定をしない)
 */
export const HIGHER_TIMEFRAME: Readonly<Partial<Record<Timeframe, Timeframe>>> = {
  "1m": "15m",
  "5m": "1h",
  "15m": "1h",
  "1h": "4h",
  "4h": "1d",
  "1d": "1w",
};

export function higherTimeframeOf(tf: Timeframe): Timeframe | undefined {
  return HIGHER_TIMEFRAME[tf];
}

/**
 * view に上位足が無いとき、執行足から集約する元の足の本数 (確定足の直近)。
 * 運用 (hub は 1d を約 300 本) とバックテスト (historyBars 443 など) で同じ週足の履歴になるよう、集約の前に固定の長さへ切る
 * (wrap.ts の STRUCTURE_WINDOW_BARS と同じ 300)
 */
export const MTF_FALLBACK_BASE_BARS = 300;

/**
 * 上位足の確定足 (now の時点で終わっている足だけ)。
 * view にその時間足が無い (空) ときは、執行足 (exec) の確定足から既存の resample で集約する
 * (1w を hub が持たないとき 1d から作るなど)。形成中の上位足は resample が返さない。
 */
export function higherCandles(view: Pick<MarketView, "candles" | "now">, exec: Timeframe, upper: Timeframe): Candle[] {
  const own = view.candles[upper];
  if (own && own.length > 0) return closedOnly(own, upper, view.now);
  const base = view.candles[exec];
  if (!base || base.length === 0) return [];
  const fromMs = TIMEFRAME_MS[exec];
  const toMs = TIMEFRAME_MS[upper];
  if (toMs <= fromMs || toMs % fromMs !== 0) return [];
  // 確定足の直近 MTF_FALLBACK_BASE_BARS 本に切ってから集約する (先頭の欠けた週は resample が捨て、形成中の週は返さない)
  const closed = closedOnly(base, exec, view.now);
  const windowed = closed.length > MTF_FALLBACK_BASE_BARS ? closed.slice(closed.length - MTF_FALLBACK_BASE_BARS) : closed;
  return resample(windowed, exec, upper, { now: view.now });
}
