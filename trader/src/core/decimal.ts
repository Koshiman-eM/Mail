import Decimal from "decimal.js";

/**
 * 会計値 (残高・数量・手数料・損益) 用の decimal ヘルパー。
 * 浮動小数点誤差を避けるため、加減乗除はここを経由する。
 */
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };
export type Num = Decimal.Value;

export const D = (v: Num) => new Decimal(v);

/** 刻み (lotSize/tickSize) の倍数へ切り捨て */
export function floorToStep(value: Num, step: Num): Decimal {
  const s = D(step);
  if (s.lte(0)) return D(value);
  return D(value).div(s).floor().mul(s);
}

/** 刻みの倍数へ四捨五入 */
export function roundToStep(value: Num, step: Num): Decimal {
  const s = D(step);
  if (s.lte(0)) return D(value);
  return D(value).div(s).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(s);
}

export const toNum = (v: Num) => D(v).toNumber();
export const toStr = (v: Num) => D(v).toString();
