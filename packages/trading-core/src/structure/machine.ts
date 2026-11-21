import type { Candle } from "../core/types";
import { perfectOrderSeries } from "./perfectOrder";
import { detectPivots, normalizePivotN } from "./pivots";
import {
  DEFAULT_STRUCTURE_OPTIONS, type Bias, type Pivot, type ReversalRef, type StructureOptions, type StructureRegime, type StructureState,
} from "./types";

/**
 * 押し安値・戻り高値の状態マシン (目線付け 方法 1) と、方法 2・ちゃぶつき・パーフェクトオーダー。
 *
 * 入力は確定済みの足の配列 (昇順)。足 k を処理するときに使うのは
 *   - 足 0..k の OHLC
 *   - confirmedAt <= k のピボット (= 足 k までで判定できるもの)
 * だけ。したがって足 k の状態は candles.slice(0, k + 1) で計算した最後の状態と一致する (リペイントしない)。
 *
 * 規則 (上目線。下目線は対称):
 *   1. 直近の確定 SH (まだブレイクされていないもの) をブレイク → 高値更新。
 *      押し安値 =「その SH の位置からブレイクした足まで」の確定 SL のうち最も安いもの。
 *      その範囲の SL が後から確定したら (範囲は足 k まで = 確定は足 k+N まで) その時点で更新する。
 *      範囲に確定 SL がまだ無ければ、確定するまで前の押し安値を使う。
 *   2. 押し安値をブレイク:
 *      - purist: 下目線へ。戻り高値 =「押し安値の位置からブレイクした足まで」の確定 SH のうち直近 (最も新しい) のもの
 *        (後から確定したものも同様に反映。確定するまでは null)。押し安値は無効 (共存禁止)
 *      - conservative: weakeningUp へ。high1 = 押し安値からブレイクした足までの最高値 (天井)。
 *        ブレイクの後に確定した SL (安値 2。最新のもの) を終値 (ヒゲ) で割ったら下目線へ確定
 *        (戻り高値 = 安値 2 からブレイクした足までの確定 SH の直近)。
 *        それより先に high1 をブレイクしたらだましとして上目線へ戻す (押し安値は 1 の規則で high1 の位置から計算し直す)。
 *   3. 初期化: SH と SL が 2 つずつ確定するまでは none。そろったら HH+HL で up、LH+LL で down、それ以外は none のまま
 *      (以降、新しいピボットが確定するたびに判定し直す)。up で始めるときの押し安値 = 直近 2 つの SH の間の最安の SL。
 *   4. ブレイクの判定: close は終値が水準を越えたら、wick は高値 (安値) が越えたら。
 *      wick で 1 本の足が両方向を同時に越えたときは、転換側 (押し安値割れ・安値 2 割れ) を優先する (保守的)。
 *   5. ちゃぶつき: 目線 (bias) の up ↔ down の反転が直近 chopM 本で chopR 回以上なら choppy。
 */

interface Level {
  price: number;
  idx: number;
}

/** 押し安値・戻り高値を探す範囲 (範囲内のピボットが後から確定したら反映する) */
interface Win {
  from: number;
  to: number;
  pick: "min" | "max" | "latest";
  best: Pivot | null;
}

const better = (w: Win, p: Pivot): boolean => {
  if (!w.best) return true;
  if (w.pick === "min") return p.price < w.best.price;
  if (w.pick === "max") return p.price > w.best.price;
  return p.idx > w.best.idx;
};

function openWin(list: readonly Pivot[], from: number, to: number, pick: Win["pick"]): Win {
  const w: Win = { from, to, pick, best: null };
  for (const p of list) if (p.idx >= from && p.idx <= to && better(w, p)) w.best = p;
  return w;
}

/** 範囲内のピボットなら取り込む。更新したら true */
function feedWin(w: Win | null, p: Pivot): boolean {
  if (!w || p.idx < w.from || p.idx > w.to || !better(w, p)) return false;
  w.best = p;
  return true;
}

const level = (p: Pivot): Level => ({ price: p.price, idx: p.idx });

function extreme(candles: readonly Candle[], from: number, to: number, kind: "high" | "low"): Level {
  let best: Level = { price: kind === "high" ? -Infinity : Infinity, idx: from };
  for (let i = Math.max(0, from); i <= to; i++) {
    const x = candles[i][kind];
    if (kind === "high" ? x > best.price : x < best.price) best = { price: x, idx: i };
  }
  return best;
}

const biasOfRegime = (r: StructureRegime): Bias => (r === "up" || r === "weakeningUp" ? "up" : r === "down" || r === "weakeningDown" ? "down" : "none");

export function resolveStructureOptions(o: Partial<StructureOptions> = {}): StructureOptions {
  const d = DEFAULT_STRUCTURE_OPTIONS;
  return {
    pivotN: normalizePivotN(o.pivotN ?? d.pivotN),
    breakMode: o.breakMode === "wick" ? "wick" : "close",
    reversalMode: o.reversalMode === "conservative" ? "conservative" : "purist",
    chopM: Math.max(1, Math.round(o.chopM ?? d.chopM)),
    chopR: Math.max(1, Math.round(o.chopR ?? d.chopR)),
    ...(o.perfectOrder ? { perfectOrder: o.perfectOrder } : {}),
  };
}

/** 足が 1 本も無いときの状態 */
export function emptyStructureState(withPerfectOrder = false): StructureState {
  return {
    idx: -1, bias: "none", regime: "none", trendConfirmed: "none", oshiYasune: null, modoriTakane: null,
    lastSH: null, lastSL: null, labels: { sh: null, sl: null }, flips: 0, choppy: false, reversalRef: null,
    ...(withPerfectOrder ? { perfectOrder: "none" as Bias } : {}),
  };
}

/** 状態マシン本体。emit があれば各足の状態を渡す。戻り値は最後の足の状態 */
function runMachine(candles: readonly Candle[], o: StructureOptions, emit?: (s: StructureState) => void): StructureState {
  const n = candles.length;
  if (n === 0) return emptyStructureState(Boolean(o.perfectOrder));
  const N = o.pivotN;
  const pivots = detectPivots(candles, N);
  const po = o.perfectOrder ? perfectOrderSeries(candles.map((c) => c.close), o.perfectOrder) : undefined;
  const wick = o.breakMode === "wick";
  const conservative = o.reversalMode === "conservative";
  const crossUp = (c: Candle, x: number) => (wick ? c.high > x : c.close > x);
  const crossDown = (c: Candle, x: number) => (wick ? c.low < x : c.close < x);

  const shs: Pivot[] = [];
  const sls: Pivot[] = [];
  let pi = 0;
  let regime: StructureRegime = "none";
  let oshi: Level | null = null;
  let modori: Level | null = null;
  let oshiWin: Win | null = null;
  let modoriWin: Win | null = null;
  let shBroken = false;
  let slBroken = false;
  // conservative の中間状態
  let breakBar = -1;
  let invalidation: Level | null = null;
  let confirmation: Pivot | null = null;
  // ちゃぶつき
  const flipBars: number[] = [];
  let fi = 0;
  let lastDir: Bias = "none";
  let last = emptyStructureState(Boolean(po));

  const toDown = (k: number, from: number) => {
    regime = "down";
    modoriWin = openWin(shs, from, k, "latest");
    modori = modoriWin.best ? level(modoriWin.best) : null;
    oshi = null;
    oshiWin = null;
  };
  const toUp = (k: number, from: number) => {
    regime = "up";
    oshiWin = openWin(sls, from, k, "latest");
    oshi = oshiWin.best ? level(oshiWin.best) : null;
    modori = null;
    modoriWin = null;
  };
  const clearWeakening = () => {
    invalidation = null;
    confirmation = null;
    breakBar = -1;
  };

  for (let k = 0; k < n; k++) {
    const c = candles[k];

    // 1. この足で確定したピボットを取り込む
    while (pi < pivots.length && pivots[pi].confirmedAt <= k) {
      const p = pivots[pi++];
      if (p.type === "SH") {
        shs.push(p);
        shBroken = false;
        if (regime === "down" && feedWin(modoriWin, p)) modori = level(p);
        if (regime === "weakeningDown" && p.confirmedAt > breakBar) confirmation = p;
      } else {
        sls.push(p);
        slBroken = false;
        if (regime === "up" && feedWin(oshiWin, p)) oshi = level(p);
        if (regime === "weakeningUp" && p.confirmedAt > breakBar) confirmation = p;
      }
    }

    // 2. 初期化 (SH・SL が 2 つずつそろってから。HH+HL / LH+LL)
    if (regime === "none" && shs.length >= 2 && sls.length >= 2) {
      const [sh1, sh2] = shs.slice(-2);
      const [sl1, sl2] = sls.slice(-2);
      if (sh2.price > sh1.price && sl2.price > sl1.price) {
        regime = "up";
        const w = openWin(sls, sh1.idx, sh2.idx, "min");
        const fallback = [...sls].reverse().find((s) => s.idx < sh2.idx);
        const src = w.best ?? fallback;
        oshi = src ? level(src) : null;
        oshiWin = null;
      } else if (sh2.price < sh1.price && sl2.price < sl1.price) {
        regime = "down";
        const w = openWin(shs, sl1.idx, sl2.idx, "max");
        const fallback = [...shs].reverse().find((s) => s.idx < sl2.idx);
        const src = w.best ?? fallback;
        modori = src ? level(src) : null;
        modoriWin = null;
      }
    }

    // 3. ブレイクの判定
    const lastSH = shs.length ? shs[shs.length - 1] : null;
    const lastSL = sls.length ? sls[sls.length - 1] : null;
    if (regime === "up") {
      if (oshi && crossDown(c, oshi.price)) {
        if (conservative) {
          regime = "weakeningUp";
          invalidation = extreme(candles, oshi.idx, k, "high");
          confirmation = null;
          breakBar = k;
          oshi = null;
          oshiWin = null;
        } else toDown(k, oshi.idx);
      } else if (lastSH && !shBroken && crossUp(c, lastSH.price)) {
        // 高値更新: 押し安値 = その SH からブレイクした足までの最安の確定 SL (無ければ確定するまで前の押し安値)
        oshiWin = openWin(sls, lastSH.idx, k, "min");
        if (oshiWin.best) oshi = level(oshiWin.best);
      }
    } else if (regime === "down") {
      if (modori && crossUp(c, modori.price)) {
        if (conservative) {
          regime = "weakeningDown";
          invalidation = extreme(candles, modori.idx, k, "low");
          confirmation = null;
          breakBar = k;
          modori = null;
          modoriWin = null;
        } else toUp(k, modori.idx);
      } else if (lastSL && !slBroken && crossDown(c, lastSL.price)) {
        modoriWin = openWin(shs, lastSL.idx, k, "max");
        if (modoriWin.best) modori = level(modoriWin.best);
      }
    } else if (regime === "weakeningUp" && invalidation) {
      if (confirmation && crossDown(c, confirmation.price)) {
        // 安値 2 を割った → 高値・安値の両方の切り下げ → 下降トレンド確定
        toDown(k, confirmation.idx);
        clearWeakening();
      } else if (crossUp(c, invalidation.price)) {
        // だまし: 天井 (high1) を超えた → 上目線へ戻す。押し安値は high1 の位置からの最安の確定 SL
        regime = "up";
        oshiWin = openWin(sls, invalidation.idx, k, "min");
        oshi = oshiWin.best ? level(oshiWin.best) : null;
        modori = null;
        modoriWin = null;
        clearWeakening();
      }
    } else if (regime === "weakeningDown" && invalidation) {
      if (confirmation && crossUp(c, confirmation.price)) {
        toUp(k, confirmation.idx);
        clearWeakening();
      } else if (crossDown(c, invalidation.price)) {
        regime = "down";
        modoriWin = openWin(shs, invalidation.idx, k, "max");
        modori = modoriWin.best ? level(modoriWin.best) : null;
        oshi = null;
        oshiWin = null;
        clearWeakening();
      }
    }

    // 4. 直近のピボットがブレイクされたか (目線によらず記録。同じピボットで二度更新しない)
    if (lastSH && crossUp(c, lastSH.price)) shBroken = true;
    if (lastSL && crossDown(c, lastSL.price)) slBroken = true;

    // 5. ちゃぶつき (up ↔ down の反転)
    const bias = biasOfRegime(regime);
    if (bias !== "none") {
      if (lastDir !== "none" && lastDir !== bias) flipBars.push(k);
      lastDir = bias;
    }
    while (fi < flipBars.length && flipBars[fi] <= k - o.chopM) fi++;
    const flips = flipBars.length - fi;

    const shLabel = lastSH?.label ?? null;
    const slLabel = lastSL?.label ?? null;
    const trendConfirmed: Bias = shLabel === "HH" && slLabel === "HL" ? "up" : shLabel === "LH" && slLabel === "LL" ? "down" : "none";
    const inv = invalidation as Level | null;
    const conf = confirmation as Pivot | null;
    const reversalRef: ReversalRef | null =
      (regime === "weakeningUp" || regime === "weakeningDown") && inv ? { invalidation: inv.price, confirmation: conf ? conf.price : null } : null;
    const o1 = oshi as Level | null;
    const m1 = modori as Level | null;
    last = {
      idx: k,
      bias,
      regime,
      trendConfirmed,
      oshiYasune: regime === "up" && o1 ? o1.price : null,
      modoriTakane: regime === "down" && m1 ? m1.price : null,
      lastSH,
      lastSL,
      labels: { sh: shLabel, sl: slLabel },
      flips,
      choppy: flips >= o.chopR,
      reversalRef,
      ...(po ? { perfectOrder: po[k] } : {}),
    };
    emit?.(last);
  }
  return last;
}

/** 全期間を一度に計算する (各足 k が確定した時点の状態の配列。添字は入力と同じ) */
export function computeStructureSeries(candles: readonly Candle[], opts: Partial<StructureOptions> = {}): StructureState[] {
  const out: StructureState[] = [];
  runMachine(candles, resolveStructureOptions(opts), (s) => out.push(s));
  return out;
}

/**
 * 足 k が確定した時点の状態 (candles[0..k] だけで計算する)。k 省略時は最後の足。
 * computeStructureSeries(candles)[k] と一致する (テストで保証)
 */
export function structureAt(candles: readonly Candle[], k: number = candles.length - 1, opts: Partial<StructureOptions> = {}): StructureState {
  const o = resolveStructureOptions(opts);
  const end = Math.min(candles.length, Math.max(0, Math.floor(k) + 1));
  if (k < 0) return emptyStructureState(Boolean(o.perfectOrder));
  return runMachine(end === candles.length ? candles : candles.slice(0, end), o);
}
