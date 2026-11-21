import { describe, expect, it } from "vitest";
import { D } from "../src/core/decimal";
import { elapsedDays, simulatedShortBorrowModel, type HoldingCostModel } from "../src/core/holdingCost";
import { PaperBroker } from "../src/execution/paper";
import type { Instrument, OrderRequest, Quote } from "../src/core/types";

const DAY = 86_400_000;
const fx: Instrument = {
  symbol: "USD/JPY", venue: "paper", assetClass: "crypto", baseCurrency: "USD", quoteCurrency: "JPY", tickSize: 0.001, lotSize: 1, minQty: 1,
  takerFeeRate: 0, makerFeeRate: 0, allowShort: true,
};
const q = (bid: number, ask: number): Quote => ({ ts: 1, bid, ask });
let n = 0;
const order = (o: Pick<OrderRequest, "symbol" | "side" | "qty">): OrderRequest => ({ clientId: `h${++n}`, type: "market", strategyId: "t", ...o });

describe("HoldingCostModel", () => {
  it("既定: 再現した空売り (allowShort=false の負の建玉) だけ 建玉代金 × 日率 × 日数", () => {
    const m = simulatedShortBorrowModel(0.001);
    const inst = { symbol: "BTC/USDT", assetClass: "crypto" as const, allowShort: false };
    expect(m.appliesTo(inst, D(-1))).toBe(true);
    expect(m.appliesTo(inst, D(1))).toBe(false);
    expect(m.appliesTo({ ...inst, allowShort: true }, D(-1))).toBe(false);
    expect(m.accrue({ inst, qty: D(-2), avgPrice: D(100), from: 0, to: 2 * DAY, mode: "paper" }).toNumber()).toBeCloseTo(0.4, 12);
    expect(m.accrue({ inst, qty: D(2), avgPrice: D(100), from: 0, to: 2 * DAY, mode: "paper" }).toNumber()).toBe(0);
    expect(elapsedDays(10, 5).toNumber()).toBe(0);
  });

  it("PaperBroker: アプリのモデル (例: 買いで受け取るスワップ) を決済の約定の手数料にまとめて計上する", async () => {
    let clock = 0;
    // 買いの建玉は 1 日あたり建玉代金の 0.01% を受け取る (負のコスト)。売りは 0.02% を払う
    const swap: HoldingCostModel = {
      appliesTo: () => true,
      accrue: ({ qty, avgPrice, from, to }) => avgPrice.mul(qty.abs()).mul(qty.isNegative() ? 0.0002 : -0.0001).mul(elapsedDays(from, to)),
    };
    const b = new PaperBroker({ instruments: [fx], baseCurrency: "JPY", initialEquity: 1_000_000, slippageBps: 0, clock: { now: () => clock }, holdingCost: swap });
    b.onQuote("USD/JPY", q(150, 150));
    await b.placeOrder(order({ symbol: "USD/JPY", side: "buy", qty: "1000" }));
    clock = 3 * DAY;
    const r = await b.placeOrder(order({ symbol: "USD/JPY", side: "sell", qty: "1000" }));
    // 150000 × 0.0001 × 3 = 45 円を受け取る (手数料が負)
    expect(Number(r.fills[0].fee)).toBeCloseTo(-45, 6);
    expect((await b.getBalance()).equity).toBeCloseTo(1_000_045, 6);
  });
});
