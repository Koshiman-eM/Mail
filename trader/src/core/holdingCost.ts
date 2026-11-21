/**
 * 建玉の保有コスト (持ち越しのコスト) のモデル。PaperBroker と仮想トレード (src/learning/shadow.ts) が使う。
 *
 * - 既定 (`simulatedShortBorrowModel`): paper で再現した空売り (取引所で空売りできない銘柄の負の建玉) の借入コスト
 *   = 建玉代金 (平均建値 × |数量| × 契約サイズ) × 日率 (PAPER_SHORT_BORROW_RATE_DAILY) × 経過日数 (日割り)。
 * - アプリは独自のモデルを渡せる (FX のスワップポイント・株式の信用の金利・貸株料など。金額は正 = 払う、負 = 受け取る)。
 * - 金額はクオート通貨建て。会計値なので decimal で計算する。
 */
import { D, Decimal } from "./decimal";
import type { Instrument, TradingMode } from "./types";

const DAY_MS = 86_400_000;

export type HoldingCostInstrument = Pick<Instrument, "symbol" | "assetClass" | "allowShort"> & Partial<Pick<Instrument, "contractSize" | "quoteCurrency" | "meta" | "venue">>;

export interface HoldingCostInput {
  inst: HoldingCostInstrument;
  /** 符号つきの数量 (負 = 売り建て) */
  qty: Decimal;
  /** 平均建値 (クオート通貨建て) */
  avgPrice: Decimal;
  /** 計算の起点と終点 (UNIX ミリ秒。to ≤ from なら 0) */
  from: number;
  to: number;
  mode: TradingMode;
}

export interface HoldingCostModel {
  /** from から to までの保有コスト (クオート通貨建て。正 = 払う、負 = 受け取る) */
  accrue(i: HoldingCostInput): Decimal;
  /**
   * 新しい建玉 (数量 qty) にコストを積むか (PaperBroker が起点を記録して、決済の約定の手数料にまとめて計上する建玉)。
   * false の建玉は起点を記録しない (積んだ分があれば決済時に払うだけ)
   */
  appliesTo(inst: HoldingCostInstrument, qty: Decimal): boolean;
}

/** 経過日数 (日割り。負は 0) */
export const elapsedDays = (from: number, to: number): Decimal => D(Math.max(0, to - from)).div(DAY_MS);

/**
 * 既定のモデル: paper で再現した空売り (allowShort=false の銘柄の負の建玉) の借入コスト。
 * accrue は負の建玉なら 建玉代金 × 日率 × 日数、それ以外は 0 (買いの建玉には新たに積まない)
 */
export function simulatedShortBorrowModel(rateDaily: number | Decimal): HoldingCostModel {
  const rate = D(rateDaily);
  return {
    accrue({ inst, qty, avgPrice, from, to }) {
      if (!qty.isNegative()) return D(0);
      const notional = avgPrice.mul(qty.abs()).mul(D(inst.contractSize ?? 1));
      return notional.mul(rate).mul(elapsedDays(from, to));
    },
    appliesTo: (inst, qty) => qty.isNegative() && !inst.allowShort,
  };
}
