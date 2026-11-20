/**
 * ダウ理論の相場構造 (スイング・押し安値・戻り高値・目線) の型。
 * 考え方の出典は docs ではなく実装仕様 (ダウ理論・相場構造モジュール)。Pine Script は移植していない。
 */

/** 目線 */
export type Bias = "up" | "down" | "none";

/**
 * 目線の状態。purist は up / down / none だけ。
 * conservative は押し安値 (戻り高値) を割った後、転換が確定するまでの中間状態 weakeningUp / weakeningDown を持つ。
 */
export type StructureRegime = "up" | "weakeningUp" | "down" | "weakeningDown" | "none";

export type PivotType = "SH" | "SL";

/** HH/LH (高値)、HL/LL (安値)。前のピボットと同値なら EH / EL */
export type PivotLabel = "HH" | "LH" | "EH" | "HL" | "LL" | "EL";

export interface Pivot {
  /** ピボットの足の添字 (入力配列内) */
  idx: number;
  /** ピボットの足の開始時刻 */
  ts: number;
  /** SH は高値、SL は安値 */
  price: number;
  type: PivotType;
  /** 判定できる足の添字 (= idx + N)。この足が確定するまでは使わない */
  confirmedAt: number;
  /** 1 つ前の同じ種類のピボットとの比較 (最初のピボットは undefined) */
  label?: PivotLabel;
}

export type BreakMode = "close" | "wick";
export type ReversalMode = "purist" | "conservative";
export type BiasMethod = "method1" | "method2" | "both";
export type MaType = "sma" | "ema";

export interface PerfectOrderOptions {
  type: MaType;
  /** 短期・中期・長期 */
  periods: [number, number, number];
}

/** 構造の判定の設定 (純粋関数の入力) */
export interface StructureOptions {
  /** スイングの左右の本数 (既定 6) */
  pivotN: number;
  /** ブレイクの判定 (終値 / ヒゲ。既定 close) */
  breakMode: BreakMode;
  /** 転換の判定 (既定 purist) */
  reversalMode: ReversalMode;
  /** ちゃぶつきの判定: 直近 chopM 本で目線が chopR 回以上反転したら choppy (既定 50 / 3) */
  chopM: number;
  chopR: number;
  /** 指定したときだけパーフェクトオーダーを計算する */
  perfectOrder?: PerfectOrderOptions;
}

export const DEFAULT_STRUCTURE_OPTIONS: Readonly<StructureOptions> = {
  pivotN: 6,
  breakMode: "close",
  reversalMode: "purist",
  chopM: 50,
  chopR: 3,
};

export const DEFAULT_PERFECT_ORDER: Readonly<PerfectOrderOptions> = { type: "sma", periods: [5, 20, 50] };

/** conservative の中間状態の基準 */
export interface ReversalRef {
  /** これを逆方向にブレイクしたら元のトレンドに戻る (weakeningUp なら天井の高値 high1) */
  invalidation: number;
  /** これをブレイクしたら転換が確定する (weakeningUp なら安値 2。まだ無ければ null) */
  confirmation: number | null;
}

/** 足 k が確定した時点の構造 */
export interface StructureState {
  /** 足の添字 (入力配列内。足が無ければ -1) */
  idx: number;
  /**
   * 目線 (方法 1: 押し安値・戻り高値の状態マシン)。
   * conservative の weakeningUp は転換が確定していないので up のまま (weakeningDown は down)
   */
  bias: Bias;
  /** 状態 (purist は up / down / none) */
  regime: StructureRegime;
  /** 方法 2: 直近の SH / SL のラベルが HH+HL なら up、LH+LL なら down、それ以外は none */
  trendConfirmed: Bias;
  /** 有効な押し安値 (up のときだけ。無ければ null) */
  oshiYasune: number | null;
  /** 有効な戻り高値 (down のときだけ。無ければ null) */
  modoriTakane: number | null;
  lastSH: Pivot | null;
  lastSL: Pivot | null;
  /** 直近の SH / SL のラベル */
  labels: { sh: PivotLabel | null; sl: PivotLabel | null };
  /** 直近 chopM 本の目線の反転回数 (up ↔ down) */
  flips: number;
  choppy: boolean;
  /** conservative の weakening 中だけ */
  reversalRef: ReversalRef | null;
  /** パーフェクトオーダー (perfectOrder を指定したときだけ) */
  perfectOrder?: Bias;
}
