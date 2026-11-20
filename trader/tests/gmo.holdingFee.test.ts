import { describe, expect, it } from "vitest";
import { holdingFeeDailyOf, jstCutoffCrossings } from "../src/core/holdingFee";
import type { Instrument, OrderRequest, Quote } from "../src/core/types";
import { PaperBroker } from "../src/execution/paper";
import { ShadowTracker } from "../src/learning/shadow";
import { MemoryStore } from "../src/storage/memory";

const H = 3_600_000;
const DAY = 24 * H;
/** 2025-01-10 05:00 JST (= 2025-01-09 20:00 UTC)。日本時間 6:00 (= 21:00 UTC) の 1 時間前 */
const BEFORE_CUTOFF = Date.UTC(2025, 0, 9, 20, 0);

const gmoBtc: Instrument = {
  symbol: "BTC/JPY", venue: "gmo", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "JPY",
  tickSize: 1, lotSize: 0.01, minQty: 0.01, takerFeeRate: 0, makerFeeRate: 0, allowShort: true,
  meta: { gmoSymbol: "BTC_JPY", leverage: 1, holdingFeeDaily: 0.0004 },
};
/** paper で空売りを再現する現物 (既存の挙動が変わらないことの確認用) */
const spot: Instrument = {
  symbol: "ETH/JPY", venue: "ccxt:bitbank", assetClass: "crypto", baseCurrency: "ETH", quoteCurrency: "JPY",
  tickSize: 1, lotSize: 0.0001, minQty: 0.0001, takerFeeRate: 0.001, makerFeeRate: 0.001, allowShort: false, simulatedShort: true,
};

const q = (bid: number, ask: number): Quote => ({ ts: 1, bid, ask });
let n = 0;
const order = (o: Partial<OrderRequest> & Pick<OrderRequest, "symbol" | "side" | "qty">): OrderRequest => ({ clientId: `h${++n}`, type: "market", strategyId: "t", ...o });

function mk(start: number) {
  let t = start;
  const b = new PaperBroker({
    instruments: [gmoBtc, spot], baseCurrency: "JPY", initialEquity: 10_000_000, slippageBps: 0, clock: { now: () => t }, shortBorrowRateDaily: 0.001,
  });
  b.onQuote("BTC/JPY", q(10_000_000, 10_000_000));
  b.onQuote("ETH/JPY", q(500_000, 500_000));
  return { b, advance: (ms: number) => (t += ms) };
}

describe("jstCutoffCrossings (日本時間 6:00 をまたいだ回数)", () => {
  it("またぐ・またがない・ちょうど", () => {
    expect(jstCutoffCrossings(BEFORE_CUTOFF, BEFORE_CUTOFF + 50 * 60_000)).toBe(0); // 5:50 JST まで
    expect(jstCutoffCrossings(BEFORE_CUTOFF, BEFORE_CUTOFF + H)).toBe(1); // ちょうど 6:00 まで保有
    expect(jstCutoffCrossings(BEFORE_CUTOFF + H, BEFORE_CUTOFF + 2 * H)).toBe(0); // 6:00 ちょうどに建てた分は数えない
    expect(jstCutoffCrossings(BEFORE_CUTOFF, BEFORE_CUTOFF + 2 * DAY)).toBe(2);
    expect(jstCutoffCrossings(BEFORE_CUTOFF + 2 * H, BEFORE_CUTOFF + 22 * H)).toBe(0); // 7:00 → 翌 3:00 (24h 未満でまたがない)
    expect(holdingFeeDailyOf(gmoBtc)).toBe(0.0004);
    expect(holdingFeeDailyOf(spot)).toBeUndefined();
  });
});

describe("PaperBroker: GMO の持ち越し手数料", () => {
  it("買い: 日本時間 6:00 をまたがなければ手数料 0", async () => {
    const { b, advance } = mk(BEFORE_CUTOFF);
    await b.placeOrder(order({ symbol: "BTC/JPY", side: "buy", qty: "0.1" }));
    advance(50 * 60_000);
    const r = await b.placeOrder(order({ symbol: "BTC/JPY", side: "sell", qty: "0.1", reduceOnly: true }));
    expect(r.fills[0].fee).toBe("0");
    expect(b.markToMarket().equity).toBe(10_000_000);
  });

  it("買い: 6:00 を 1 回またぐと 建玉代金 × 日率 を決済の手数料に計上 (評価額にも未払いとして反映)", async () => {
    const { b, advance } = mk(BEFORE_CUTOFF);
    await b.placeOrder(order({ symbol: "BTC/JPY", side: "buy", qty: "0.1" }));
    advance(2 * H);
    // 決済前でも未払いの持ち越し手数料は評価額から引く: 1,000,000 × 0.0004 = 400
    expect(b.markToMarket().equity).toBe(10_000_000 - 400);
    const r = await b.placeOrder(order({ symbol: "BTC/JPY", side: "sell", qty: "0.1", reduceOnly: true }));
    expect(r.fills[0].fee).toBe("400");
    expect(b.markToMarket().equity).toBe(10_000_000 - 400);
  });

  it("売り (空売り): 6:00 を 2 回またぐと 2 日分。部分決済は数量の割合で払い、残りは持ち越す", async () => {
    const { b, advance } = mk(BEFORE_CUTOFF);
    await b.placeOrder(order({ symbol: "BTC/JPY", side: "sell", qty: "0.2" }));
    advance(DAY + 2 * H); // 2 回
    const r1 = await b.placeOrder(order({ symbol: "BTC/JPY", side: "buy", qty: "0.1", reduceOnly: true }));
    // 建玉代金 2,000,000 × 0.0004 × 2 = 1600、その半分
    expect(r1.fills[0].fee).toBe("800");
    advance(H); // またがない
    const r2 = await b.placeOrder(order({ symbol: "BTC/JPY", side: "buy", qty: "0.1", reduceOnly: true }));
    expect(r2.fills[0].fee).toBe("800");
    expect(await b.getPositions()).toEqual([]);
  });

  it("スナップショットの復元後も持ち越し手数料を引き継ぐ", async () => {
    const { b, advance } = mk(BEFORE_CUTOFF);
    await b.placeOrder(order({ symbol: "BTC/JPY", side: "buy", qty: "0.1" }));
    advance(2 * H);
    const snap = JSON.parse(JSON.stringify(b.snapshot()));
    const c = mk(BEFORE_CUTOFF + 2 * H);
    c.b.restore(snap);
    c.advance(DAY);
    const r = await c.b.placeOrder(order({ symbol: "BTC/JPY", side: "sell", qty: "0.1", reduceOnly: true }));
    expect(r.fills[0].fee).toBe("800");
  });

  it("再現の空売り (allowShort=false の現物) は従来どおり日数比例の借入コスト", async () => {
    const { b, advance } = mk(BEFORE_CUTOFF);
    await b.placeOrder(order({ symbol: "ETH/JPY", side: "sell", qty: "1" }));
    advance(DAY / 2);
    const r = await b.placeOrder(order({ symbol: "ETH/JPY", side: "buy", qty: "1", reduceOnly: true }));
    // taker 500,000 × 0.001 = 500 + 借入 500,000 × 0.001 × 0.5 日 = 250
    expect(r.fills[0].fee).toBe("750");
    // 現物の買いには保有コストを付けない
    await b.placeOrder(order({ symbol: "ETH/JPY", side: "buy", qty: "1" }));
    advance(3 * DAY);
    const s = await b.placeOrder(order({ symbol: "ETH/JPY", side: "sell", qty: "1", reduceOnly: true }));
    expect(s.fills[0].fee).toBe("500");
  });
});

describe("仮想トレード (shadow): GMO の持ち越し手数料を PaperBroker と同じ計算で R に含める", () => {
  const sig = { strategyId: "x", direction: "long" as const, confidence: 0.5, expectedEdgeBps: 10, stopLoss: 9_900_000, maxHoldMs: 3 * H, horizon: "short" as const };
  const run = (instrument: { symbol: string; assetClass: "crypto"; takerFeeRate: number; meta?: Instrument["meta"] }, holdMs: number) => {
    const tr = new ShadowTracker({ store: new MemoryStore(), mode: "paper", options: { slippageBps: 0 } });
    tr.record({ instrument, quote: q(10_000_000, 10_000_000), signal: { ...sig, maxHoldMs: holdMs }, regime: "range", reason: "risk: x", now: BEFORE_CUTOFF });
    return tr.update(BEFORE_CUTOFF + holdMs, () => q(10_000_000, 10_000_000))[0];
  };

  it("6:00 をまたいだ回数 × 仲値 × 日率 / 1R を costR に加える。またがなければ 0", () => {
    const base = { symbol: "BTC/JPY", assetClass: "crypto" as const, takerFeeRate: 0 };
    const plain = run(base, 2 * H);
    const crossed = run({ ...base, meta: { holdingFeeDaily: 0.0004 } }, 2 * H);
    const notCrossed = run({ ...base, meta: { holdingFeeDaily: 0.0004 } }, 30 * 60_000);
    // 1R = 100,000、手数料 10,000,000 × 0.0004 × 1 = 4000 → 0.04R
    expect(crossed.costR - plain.costR).toBeCloseTo(0.04, 10);
    expect(crossed.holdingFeeDaily).toBe(0.0004);
    expect(notCrossed.costR).toBeCloseTo(run(base, 30 * 60_000).costR, 10);
  });
});
