import { describe, expect, it, vi } from "vitest";
import type { EntryContext, Instrument, Quote, TradeRecord } from "../src/core/types";
import { PaperBroker } from "../src/execution/paper";
import { PositionManager, type ExitPlan } from "../src/engine/positions";
import { TradeJournal } from "../src/learning/journal";
import { MemoryStore } from "../src/storage/memory";

const T0 = Date.UTC(2026, 0, 5);

const inst = (symbol: string, allowShort = true): Instrument => ({
  symbol, venue: "paper", assetClass: "crypto", baseCurrency: symbol.split("/")[0], quoteCurrency: "USD", tickSize: 0.01, lotSize: 0.001, minQty: 0.001,
  takerFeeRate: 0.001, makerFeeRate: 0.0005, allowShort,
});

const ctx: EntryContext = {
  regime: { label: "trend_up", trend: 0.5, trendStrength: 30, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 2 },
  confidence: 0.7, expectedEdgeBps: 50, costBps: 22, params: { stopAtr: 1 }, features: {}, riskMultiplier: 1, reason: "test",
};

const q = (mid: number, ts: number, half = 0.01): Quote => ({ ts, bid: mid - half, ask: mid + half });

function setup() {
  const clock = { t: T0, now() { return this.t; } };
  const store = new MemoryStore();
  const instruments = [inst("AAA/USD"), inst("BBB/USD")];
  const paper = new PaperBroker({ instruments, baseCurrency: "USD", initialEquity: 1_000_000, slippageBps: 0, clock });
  const journal = new TradeJournal({ store });
  const closed: TradeRecord[] = [];
  const onOrder = vi.fn();
  const pm = new PositionManager({ journal, brokerFor: () => paper, onTradeClosed: (t) => closed.push(t), onOrder, store });

  /** 成行で建ててから PositionManager に登録 */
  async function open(symbol: string, direction: "long" | "short", price: number, stop: number, plan: ExitPlan, takeProfit?: number) {
    paper.onQuote(symbol, q(price, clock.t, 0));
    const r = await paper.placeOrder({ clientId: `o-${symbol}-${clock.t}`, symbol, side: direction === "long" ? "buy" : "sell", type: "market", qty: "1", strategyId: "s1" });
    const f = r.fills[0];
    return pm.open(
      {
        mode: "paper", symbol, venue: "paper", assetClass: "crypto", strategyId: "s1", horizon: "scalp", direction, qty: 1, entryTs: clock.t,
        entryPrice: f.price, intendedEntryPrice: price, initialStop: stop, ...(takeProfit !== undefined ? { takeProfit } : {}), entryContext: ctx,
        entryFees: Number(f.fee),
      },
      plan,
    );
  }
  /** 気配を進めて PositionManager に渡す */
  async function tick(symbol: string, mid: number, dt = 1_000) {
    clock.t += dt;
    const quote = q(mid, clock.t);
    paper.onQuote(symbol, quote);
    return pm.onQuote(symbol, quote, clock.t);
  }
  return { clock, store, paper, journal, pm, closed, open, tick, onOrder };
}

describe("PositionManager", () => {
  it("損切り: ロングは bid ≤ stop で決済し、意図価格はストップ価格", async () => {
    const s = setup();
    await s.open("AAA/USD", "long", 100, 98, {}, 104);
    expect((await s.tick("AAA/USD", 99)).status).toBe("none");
    const r = await s.tick("AAA/USD", 97.5);
    expect(r.status).toBe("closed");
    expect(r.trade!.exitReason).toBe("stop");
    expect(r.trade!.intendedExitPrice).toBe(98);
    expect(r.trade!.exitPrice).toBeCloseTo(97.49, 6);
    expect(r.trade!.netPnl).toBeLessThan(0);
    expect(s.closed).toHaveLength(1);
    expect(s.pm.has("AAA/USD")).toBe(false);
    expect(await s.paper.getPositions()).toEqual([]);
    expect(s.onOrder).toHaveBeenCalledTimes(1);
    expect(s.store.listAudit({ type: "engine.exit" })).toHaveLength(1);
  });

  it("損切り: ショートは ask ≥ stop", async () => {
    const s = setup();
    await s.open("AAA/USD", "short", 100, 102, {});
    const r = await s.tick("AAA/USD", 102);
    expect(r.trade?.exitReason).toBe("stop");
    expect(r.trade?.direction).toBe("short");
    expect(r.trade?.intendedExitPrice).toBe(102);
  });

  it("利確: bid ≥ 利確価格", async () => {
    const s = setup();
    await s.open("AAA/USD", "long", 100, 98, {}, 104);
    const r = await s.tick("AAA/USD", 104.5);
    expect(r.trade?.exitReason).toBe("take_profit");
    expect(r.trade?.intendedExitPrice).toBe(104);
    expect(r.trade!.netPnl).toBeGreaterThan(0);
  });

  it("トレーリング: 高値から trailingStopPct 下にストップを引き上げる", async () => {
    const s = setup();
    await s.open("AAA/USD", "long", 100, 95, { trailingStopPct: 0.02 });
    await s.tick("AAA/USD", 105);
    await s.tick("AAA/USD", 110);
    const p = s.pm.get("AAA/USD")!;
    expect(p.highWater).toBe(110);
    expect(s.pm.currentStop(p)).toBeCloseTo(107.8, 9);
    expect(s.pm.view(p).stopLoss).toBeCloseTo(107.8, 9);
    expect((await s.tick("AAA/USD", 108)).status).toBe("none");
    const r = await s.tick("AAA/USD", 107.5);
    expect(r.trade?.exitReason).toBe("trailing");
    expect(r.trade?.intendedExitPrice).toBeCloseTo(107.8, 9);
    expect(r.trade!.mfePct).toBeCloseTo(0.1, 2);
  });

  it("トレーリング: 引き上げたストップと当初ストップを一度に割り込んだらトレーリングとして記録", async () => {
    const s = setup();
    await s.open("AAA/USD", "long", 100, 95, { trailingStopPct: 0.02 });
    await s.tick("AAA/USD", 110);
    const r = await s.tick("AAA/USD", 94);
    expect(r.trade?.exitReason).toBe("trailing");
    expect(r.trade?.intendedExitPrice).toBeCloseTo(107.8, 9);
  });

  it("トレーリング (ショート): 安値から上にストップを引き下げる", async () => {
    const s = setup();
    await s.open("AAA/USD", "short", 100, 105, { trailingStopPct: 0.02 });
    await s.tick("AAA/USD", 90);
    const p = s.pm.get("AAA/USD")!;
    expect(s.pm.currentStop(p)).toBeCloseTo(91.8, 9);
    const r = await s.tick("AAA/USD", 92);
    expect(r.trade?.exitReason).toBe("trailing");
    expect(r.trade!.netPnl).toBeGreaterThan(0);
  });

  it("時間切れ: maxHoldMs を過ぎたら判定時点の価格で決済", async () => {
    const s = setup();
    await s.open("AAA/USD", "long", 100, 95, { maxHoldMs: 60_000 });
    expect((await s.tick("AAA/USD", 100.5, 30_000)).status).toBe("none");
    const r = await s.tick("AAA/USD", 100.6, 30_000);
    expect(r.trade?.exitReason).toBe("time");
    expect(r.trade?.intendedExitPrice).toBeCloseTo(100.59, 9);
  });

  it("優先順位: 損切りと時間切れが同時なら損切り", async () => {
    const s = setup();
    await s.open("AAA/USD", "long", 100, 98, { maxHoldMs: 1_000 });
    const r = await s.tick("AAA/USD", 97, 5_000);
    expect(r.trade?.exitReason).toBe("stop");
  });

  it("kill switch: 全ポジションを決済し、学習へ渡す", async () => {
    const s = setup();
    await s.open("AAA/USD", "long", 100, 95, {});
    await s.open("BBB/USD", "short", 50, 55, {});
    expect(s.pm.list()).toHaveLength(2);
    const quotes: Record<string, Quote> = { "AAA/USD": q(99, s.clock.t), "BBB/USD": q(51, s.clock.t) };
    for (const [sym, qq] of Object.entries(quotes)) s.paper.onQuote(sym, qq);
    const res = await s.pm.closeAll("kill_switch", s.clock.t, (sym) => quotes[sym]);
    expect(res.map((r) => r.status)).toEqual(["closed", "closed"]);
    expect(s.closed.map((t) => t.exitReason)).toEqual(["kill_switch", "kill_switch"]);
    expect(s.closed.find((t) => t.symbol === "BBB/USD")?.intendedExitPrice).toBe(51.01);
    expect(s.pm.list()).toHaveLength(0);
    expect(await s.paper.getPositions()).toEqual([]);
  });

  it("1 銘柄 1 ポジション・再起動時の復元と突き合わせ", async () => {
    const s = setup();
    await s.open("AAA/USD", "long", 100, 98, { trailingStopPct: 0.01, maxHoldMs: 60_000 });
    await expect(s.open("AAA/USD", "long", 100, 98, {})).rejects.toThrow(/1 銘柄 1 ポジション/);
    // 同じ store から作り直すと決済ルールも復元される
    const journal2 = new TradeJournal({ store: s.store });
    const pm2 = new PositionManager({ journal: journal2, brokerFor: () => s.paper, store: s.store });
    const p = pm2.get("AAA/USD")!;
    expect(pm2.planOf(p.id)).toEqual({ trailingStopPct: 0.01, maxHoldMs: 60_000 });
    // ブローカーに建玉が無ければ追跡から外す
    const r = pm2.reconcile([], s.clock.t);
    expect(r.orphaned).toEqual(["AAA/USD"]);
    expect(pm2.list()).toHaveLength(0);
    expect(pm2.reconcile([{ symbol: "ZZZ/USD", qty: "1", avgPrice: 1 }], s.clock.t).untracked).toEqual(["ZZZ/USD"]);
  });

  it("決済注文が約定しなければ追跡を続ける (次のティックで再判定)", async () => {
    const s = setup();
    await s.open("AAA/USD", "long", 100, 98, {});
    // ブローカー側の建玉を消してしまう (reduceOnly が拒否される)
    await s.paper.placeOrder({ clientId: "manual", symbol: "AAA/USD", side: "sell", type: "market", qty: "1", strategyId: "x" });
    const r = await s.tick("AAA/USD", 97);
    expect(r.status).toBe("rejected");
    expect(s.pm.has("AAA/USD")).toBe(true);
    expect(s.store.listAudit({ type: "engine.exit_rejected" })).toHaveLength(1);
  });
});
