import Decimal from "decimal.js";

/**
 * アプリ全体で共有する Decimal コンストラクタ。
 * 金額計算は必ずこれを使い、number による浮動小数点演算を避ける。
 */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;
export type DecInput = Decimal.Value;

export const ZERO = new D(0);

/** 円単位に四捨五入 */
export const yen = (v: DecInput): Dec => new D(v).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

/** 指定単位未満切り捨て (例: unit=100 で 100円未満切捨て) */
export const floorTo = (v: DecInput, unit: number): Dec =>
  new D(v).div(unit).floor().mul(unit);

/** 指定ステップ単位に切り上げ (例: 0.5kg 刻み) */
export const ceilTo = (v: DecInput, step: DecInput): Dec => {
  const s = new D(step);
  if (s.lte(0)) return new D(v);
  return new D(v).div(s).ceil().mul(s);
};

export const pct = (v: DecInput): Dec => new D(v).div(100);
