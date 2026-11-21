import { describe, expect, it, vi } from "vitest";
import type { EntryContext, Instrument, Quote, TradeRecord } from "../src/core/types";
import { PaperBroker } from "../src/execution/paper";
import { PositionManager, type ExitPlan, type OrderPolicy } from "../src/engine/positions";
import { TradeJournal } from "../src/learning/journal";
import { MemoryStore } from "../src/storage/memory";
import { SqliteStore } from "../src/storage/sqlite";
import { FakeLiveBroker } from "./helpers/fakeLiveBroker";

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

describe("PositionManager: 保留中の注文・約定の検証 (live の偽ブローカー)", () => {
  function liveSetup(
    o: { fxRate?: (from: string, to: string) => number; maxExitOrdersPerMinute?: number; store?: MemoryStore | SqliteStore; policy?: Partial<OrderPolicy> } = {},
  ) {
    const store = o.store ?? new MemoryStore();
    const broker = new FakeLiveBroker("x");
    const journal = new TradeJournal({ store, mode: "live" });
    const closed: TradeRecord[] = [];
    const onAnomaly = vi.fn();
    const onEscalated = vi.fn();
    let price = 100;
    const pm = new PositionManager({
      journal, brokerFor: () => broker, onTradeClosed: (t) => closed.push(t), store, onAnomaly, onEscalated,
      instrumentOf: () => ({ baseCurrency: "AAA", quoteCurrency: "USD", minQty: 0.001 }),
      quoteCurrencyOf: () => "USD",
      priceOf: () => price,
      ...(o.fxRate ? { fxRate: o.fxRate } : {}),
      orderPolicy: { ...(o.maxExitOrdersPerMinute ? { maxExitOrdersPerMinute: o.maxExitOrdersPerMinute } : {}), ...(o.policy ?? {}) },
    });
    const quote = { ts: T0, bid: 99.99, ask: 100.01 };
    broker.quoteOf = () => quote;
    const entry = (clientId: string) => ({
      req: { clientId, symbol: "AAA/USD", side: "buy" as const, type: "market" as const, qty: "2", strategyId: "s1" },
      entry: {
        input: {
          mode: "live" as const, symbol: "AAA/USD", venue: "x", assetClass: "crypto" as const, strategyId: "s1", horizon: "scalp" as const,
          direction: "long" as const, entryTs: T0, intendedEntryPrice: 100.01, initialStop: 98, entryContext: ctx,
        },
        plan: {},
        audit: {},
      },
    });
    return { store, broker, journal, pm, closed, onAnomaly, onEscalated, entry, setPrice: (p: number) => (price = p) };
  }

  it("決済の発注が例外なら保留中として記録し、照会中は再送しない。不明 2 回で escalated、建玉で「約定なし」を 10 秒空けて 2 回確認したら新しい clientId で再送する", async () => {
    const s = liveSetup();
    s.broker.placeMode = "fill";
    const e = s.entry("e1");
    expect((await s.pm.enter(e.req, e.entry, T0)).status).toBe("opened");
    s.broker.placeMode = "throw";
    expect((await s.pm.close("AAA/USD", "stop", 98, T0 + 1_000)).status).toBe("pending");
    expect((await s.pm.close("AAA/USD", "stop", 98, T0 + 2_000)).status).toBe("pending");
    expect(s.broker.placed).toHaveLength(2);
    expect(s.pm.pendingOrders()[0]).toMatchObject({ kind: "exit", status: "unknown", unknownCount: 1 });
    // 照会でも見つからない → 決済は不明 2 回で escalated (kill switch は発動しない = onAnomaly は呼ばない)
    await s.pm.syncPending(T0 + 3_000);
    expect(s.onEscalated).toHaveBeenCalledTimes(1);
    expect(s.onEscalated.mock.calls[0][0]).toMatchObject({ kind: "exit", escalated: true });
    expect(s.onAnomaly).not.toHaveBeenCalled();
    expect(s.store.listAudit({ type: "order.unknown_escalated" })).toHaveLength(1);
    expect(s.pm.has("AAA/USD")).toBe(true);
    // 照会の hint (発注時刻・売買方向・数量) を渡している
    expect(s.broker.getOrderHints.at(-1)).toEqual({ createdAt: T0 + 1_000, side: "sell", qty: "2" });
    // 建玉は減っていない → 1 回目の判定 (escalated と同じ照会)
    expect(s.pm.pendingOrders()[0].positionObs).toMatchObject({ verdict: "none" });
    await s.pm.syncPending(T0 + 8_000);
    expect(s.pm.hasPending("AAA/USD")).toBe(true); // 10 秒経っていない
    expect(s.broker.placed).toHaveLength(2); // 照会中は再送しない
    // 10 秒後の 2 回目の判定で「約定なし」と確定し、すぐに新しい clientId で決済を再送する
    s.broker.placeMode = "fill";
    const sync = await s.pm.syncPending(T0 + 13_000);
    expect(s.store.listAudit({ type: "order.resolved_by_position" })[0].data).toMatchObject({ kind: "exit", result: "none", qty: "0" });
    expect(s.broker.placed).toHaveLength(3);
    const resend = s.broker.placed[2];
    expect(resend).toMatchObject({ side: "sell", reduceOnly: true, qty: "2" });
    expect(resend.clientId).not.toBe(s.broker.placed[1].clientId);
    expect(s.store.listAudit({ type: "engine.exit_resend" })[0].data).toMatchObject({ symbol: "AAA/USD", previousClientId: s.broker.placed[1].clientId, qty: "2" });
    expect(sync.closed).toHaveLength(1);
    expect(s.pm.has("AAA/USD")).toBe(false);
    expect(s.pm.hasPending("AAA/USD")).toBe(false);
    // 過剰決済しない: 取引所の建玉はちょうど 0
    expect(s.broker.positions.get("AAA/USD")).toBeCloseTo(0, 12);
    expect(s.closed).toHaveLength(1);
    expect(s.store.listAudit({ type: "order.unknown_escalated" })).toHaveLength(1);
  });

  it("決済の再送は取引所の保有数量を上限にする (追跡数量より少なければ保有数量だけ)", async () => {
    const s = liveSetup();
    s.broker.placeMode = "fill";
    const e = s.entry("e1");
    await s.pm.enter(e.req, e.entry, T0);
    s.broker.placeMode = "throw";
    await s.pm.close("AAA/USD", "stop", 98, T0 + 1_000);
    // 許容差 (0.5%) の範囲で保有数量が少ない (約定なしと判定される)
    s.broker.positions.set("AAA/USD", 1.995);
    await s.pm.syncPending(T0 + 2_000);
    s.broker.placeMode = "fill";
    await s.pm.syncPending(T0 + 12_000);
    expect(s.broker.placed.at(-1)).toMatchObject({ reduceOnly: true, qty: "1.995" });
    expect(s.broker.positions.get("AAA/USD")).toBeCloseTo(0, 12);
  });

  it("feeCurrency 付きの手数料はクオート通貨へ換算する (ベース通貨は約定価格、その他は fxRate)", async () => {
    const s = liveSetup({ fxRate: (from, to) => (from === "BNB" && to === "USD" ? 600 : Number.NaN) });
    s.broker.placeMode = "fill";
    s.broker.fee = "0.001";
    s.broker.feeCurrency = "BNB";
    const e = s.entry("e1");
    const r = await s.pm.enter(e.req, e.entry, T0);
    expect(r.position!.entryFees).toBeCloseTo(0.6, 9);
    s.broker.fee = "0.002";
    s.broker.feeCurrency = "AAA"; // ベース通貨建て → 約定価格 99.99 で換算
    const c = await s.pm.close("AAA/USD", "signal", 99.99, T0 + 1_000);
    expect(c.status).toBe("closed");
    expect(c.trade!.fees).toBeCloseTo(0.6 + 0.002 * 99.99, 9);
  });

  it("換算できない手数料は 0 にして警告と監査ログを残す。数量 0・手数料だけの明細も計上する", async () => {
    const s = liveSetup({ fxRate: (from) => (from === "BNB" ? 600 : Number.NaN) });
    const e = s.entry("e1");
    s.broker.placeMode = "accept";
    await s.pm.enter(e.req, e.entry, T0);
    s.broker.fee = "1";
    s.broker.feeCurrency = "XYZ";
    s.broker.fill("e1", { status: "partially_filled" });
    s.broker.fee = "0.001";
    s.broker.feeCurrency = "BNB";
    s.broker.fill("e1", { qty: "0" }); // 手数料だけの明細
    await s.pm.syncPending(T0 + 1_000);
    const p = s.pm.get("AAA/USD")!;
    expect(p.qty).toBe(2);
    expect(p.entryFees).toBeCloseTo(0.6, 9);
    expect(s.store.listAudit({ type: "engine.fee_unconverted" })[0].data).toMatchObject({ feeCurrency: "XYZ" });
  });

  it("決済の発注レートに上限をかける (エントリーとは別枠)", async () => {
    const s = liveSetup({ maxExitOrdersPerMinute: 1 });
    s.broker.placeMode = "fill";
    const e = s.entry("e1");
    await s.pm.enter(e.req, e.entry, T0);
    s.broker.placeMode = "reject";
    expect((await s.pm.close("AAA/USD", "stop", 98, T0 + 1_000)).status).toBe("rejected");
    expect((await s.pm.close("AAA/USD", "stop", 98, T0 + 20_000)).status).toBe("throttled");
    expect(s.broker.placed.filter((r) => r.reduceOnly)).toHaveLength(1);
    expect(s.store.listAudit({ type: "engine.exit_throttled" })).toHaveLength(1);
  });

  it("reconcile: ブローカーの建玉が少なければ差分を manual の一部決済として記録 (確認回数を満たしてから)", async () => {
    const s = liveSetup();
    s.broker.placeMode = "fill";
    const e = s.entry("e1");
    await s.pm.enter(e.req, e.entry, T0);
    const bp = [{ symbol: "AAA/USD", qty: "0.5", avgPrice: 0 }];
    const r1 = s.pm.reconcile(bp, T0 + 1_000, { confirmations: 2, priceOf: () => 101 });
    expect(r1.waiting).toEqual(["AAA/USD"]);
    expect(s.pm.get("AAA/USD")!.qty).toBe(2);
    const r2 = s.pm.reconcile(bp, T0 + 2_000, { confirmations: 2, priceOf: () => 101 });
    expect(r2.reduced).toEqual(["AAA/USD"]);
    expect(s.pm.get("AAA/USD")!.qty).toBeCloseTo(0.5, 9);
    // 一部決済はポジションに累計する (TradeRecord は全量を決済したときに 1 件)
    expect(r2.trades).toEqual([]);
    expect(s.pm.get("AAA/USD")).toMatchObject({ exitedQty: "1.5", exitNotional: "151.5" });
    expect(s.store.listTrades()).toHaveLength(0);
    expect(s.closed).toHaveLength(0); // 学習には渡さない
    expect(s.store.listAudit({ type: "reconcile.external_reduce" })).toHaveLength(1);
    // 保留中の注文がある銘柄は対象外
    s.broker.placeMode = "accept";
    await s.pm.close("AAA/USD", "stop", 98, T0 + 3_000);
    expect(s.pm.reconcile([], T0 + 4_000).orphaned).toEqual([]);
  });
});

describe("PositionManager: 状態不明の注文の確定 (建玉・手動の申告)", () => {
  const ctx2 = ctx;
  function setup(o: { store?: MemoryStore | SqliteStore; policy?: Partial<OrderPolicy> } = {}) {
    const store = o.store ?? new MemoryStore();
    const broker = new FakeLiveBroker("x");
    const journal = new TradeJournal({ store, mode: "live" });
    const closed: TradeRecord[] = [];
    const onEscalated = vi.fn();
    const onAnomaly = vi.fn();
    let price = 100;
    const pm = new PositionManager({
      journal, brokerFor: () => broker, onTradeClosed: (t) => closed.push(t), store, onEscalated, onAnomaly,
      instrumentOf: () => ({ baseCurrency: "AAA", quoteCurrency: "USD", minQty: 0.001 }),
      quoteCurrencyOf: () => "USD",
      priceOf: () => price,
      orderPolicy: o.policy ?? {},
    });
    const quote = { ts: T0, bid: 99.99, ask: 100.01 };
    broker.quoteOf = () => quote;
    const entry = (clientId: string, qty = "2") => ({
      req: { clientId, symbol: "AAA/USD", side: "buy" as const, type: "market" as const, qty, strategyId: "s1" },
      entry: {
        input: {
          mode: "live" as const, symbol: "AAA/USD", venue: "x", assetClass: "crypto" as const, strategyId: "s1", horizon: "scalp" as const,
          direction: "long" as const, entryTs: T0, intendedEntryPrice: 100.01, initialStop: 98, entryContext: ctx2,
        },
        plan: { trailingStopPct: 0.01, maxHoldMs: 600_000 },
        audit: {},
      },
    });
    return { store, broker, journal, pm, closed, onEscalated, onAnomaly, entry, setPrice: (p: number) => (price = p) };
  }

  /** 例外で状態不明にしてから、不明が 5 回続くまで照会する (escalated) */
  async function escalate(s: ReturnType<typeof setup>, t0: number) {
    for (let i = 1; i <= 4; i++) await s.pm.syncPending(t0 + i * 1_000);
  }

  it("エントリー: 建玉が増えていれば (2 回確認して) 推定で建玉を登録し、決済ルールで管理する。学習には渡さない", async () => {
    const s = setup();
    s.broker.placeMode = "throw";
    const e = s.entry("e1");
    expect((await s.pm.enter(e.req, e.entry, T0)).status).toBe("pending");
    s.broker.positions.set("AAA/USD", 2); // 実は取引所で約定していた
    s.broker.avgPrices.set("AAA/USD", 100.2);
    await escalate(s, T0);
    expect(s.onEscalated).toHaveBeenCalledTimes(1);
    expect(s.pm.has("AAA/USD")).toBe(false); // 1 回目の判定では確定しない
    expect(s.pm.pendingOrders()[0].positionObs).toMatchObject({ verdict: "filled", qty: "2" });
    await s.pm.syncPending(T0 + 4_000 + 30_000);
    const p = s.pm.get("AAA/USD")!;
    expect(p).toMatchObject({ qty: 2, entryPrice: 100.2, estimated: true, initialStop: 98 });
    expect(s.pm.planOf(p.id)).toEqual({ trailingStopPct: 0.01, maxHoldMs: 600_000 });
    expect(s.pm.hasPending("AAA/USD")).toBe(false);
    expect(s.broker.canceled).toEqual([]); // 約定ありは取消しない
    expect(s.store.listAudit({ type: "order.resolved_by_position" })[0].data).toMatchObject({ kind: "entry", result: "filled", qty: "2", price: 100.2, estimated: true });
    expect(s.store.listAudit({ type: "engine.entry" })[0].data).toMatchObject({ estimated: true, source: "position" });
    // 損切りは管理下に戻る。推定を含むトレードは学習に渡さない
    s.broker.placeMode = "fill";
    const r = await s.pm.onQuote("AAA/USD", { ts: T0 + 40_000, bid: 97.5, ask: 97.52 }, T0 + 40_000);
    expect(r.status).toBe("closed");
    // 保留の entry.plan のトレーリング (1%) が引き上げたストップで記録される
    expect(r.trade).toMatchObject({ exitReason: "trailing", estimated: true });
    expect(s.closed).toHaveLength(0);
  });

  it("エントリー: 建玉が増えていなければ、orderId があれば取消してから「約定なし」で外す。判定が変われば数え直す", async () => {
    const s = setup();
    const e = s.entry("e1");
    await s.pm.enter(e.req, e.entry, T0); // 受付のみ (orderId fake-1)
    s.broker.getOrderMode = "throw";
    await escalate(s, T0);
    await s.pm.syncPending(T0 + 5_000);
    expect(s.pm.pendingOrders()[0]).toMatchObject({ escalated: true, positionObs: { verdict: "none" } });
    // 一覧の反映遅れで一時的に建玉が見えた → 判定が変わったので確定しない
    s.broker.positions.set("AAA/USD", 2);
    await s.pm.syncPending(T0 + 40_000);
    expect(s.pm.pendingOrders()[0].positionObs).toMatchObject({ verdict: "filled" });
    s.broker.positions.delete("AAA/USD");
    await s.pm.syncPending(T0 + 75_000);
    expect(s.pm.hasPending("AAA/USD")).toBe(true);
    await s.pm.syncPending(T0 + 110_000);
    expect(s.pm.hasPending("AAA/USD")).toBe(false);
    expect(s.pm.has("AAA/USD")).toBe(false);
    expect(s.broker.canceled).toEqual(["fake-1"]);
    expect(s.store.listAudit({ type: "order.resolved_by_position" })[0].data).toMatchObject({ result: "none", orderId: "fake-1" });
  });

  it("決済: 建玉が一部だけ減っていれば差分を推定の一部決済として記録し、残りは同じ理由で決済を続ける", async () => {
    const s = setup();
    s.broker.placeMode = "fill";
    const e = s.entry("e1");
    await s.pm.enter(e.req, e.entry, T0);
    s.broker.placeMode = "throw";
    s.broker.getOrderMode = "throw";
    expect((await s.pm.close("AAA/USD", "stop", 98, T0 + 1_000)).status).toBe("pending");
    s.broker.positions.set("AAA/USD", 0.5); // 1.5 だけ約定していた
    s.setPrice(97.9);
    await escalate(s, T0 + 1_000);
    await s.pm.syncPending(T0 + 40_000);
    const p = s.pm.get("AAA/USD")!;
    expect(p.qty).toBeCloseTo(0.5, 9);
    expect(p).toMatchObject({ exitedQty: "1.5", estimated: true });
    expect(s.pm.planOf(p.id).retryExit).toEqual({ reason: "stop", intendedPrice: 98 });
    expect(s.store.listAudit({ type: "order.resolved_by_position" })[0].data).toMatchObject({ kind: "exit", result: "partial", qty: "1.5", price: 97.9 });
    // 残りは次の判定で同じ理由で決済 → 1 件の TradeRecord (元の数量・推定・学習には渡さない)
    s.broker.placeMode = "fill";
    s.broker.getOrderMode = "normal";
    const r = await s.pm.onQuote("AAA/USD", { ts: T0 + 41_000, bid: 99.5, ask: 99.52 }, T0 + 41_000);
    expect(r.status).toBe("closed");
    expect(r.trade).toMatchObject({ qty: 2, exitReason: "stop", estimated: true });
    expect(s.closed).toHaveLength(0);
    expect(s.store.listTrades()).toHaveLength(1);
  });

  it("決済: 建玉が無くなっていれば現在値で決済済みとして記録する (exitReason は保留の理由・推定)", async () => {
    const s = setup();
    s.broker.placeMode = "fill";
    const e = s.entry("e1");
    await s.pm.enter(e.req, e.entry, T0);
    s.broker.placeMode = "throw";
    s.broker.getOrderMode = "throw";
    await s.pm.close("AAA/USD", "take_profit", 104, T0 + 1_000);
    s.broker.positions.delete("AAA/USD");
    s.setPrice(104.1);
    await escalate(s, T0 + 1_000);
    s.broker.failAccount = true; // 照会が例外なら何もしない
    await s.pm.syncPending(T0 + 40_000);
    expect(s.pm.has("AAA/USD")).toBe(true);
    s.broker.failAccount = false;
    await s.pm.syncPending(T0 + 41_000);
    expect(s.pm.has("AAA/USD")).toBe(false);
    const t = s.store.listTrades()[0];
    expect(t).toMatchObject({ qty: 2, exitReason: "take_profit", exitPrice: 104.1, intendedExitPrice: 104, estimated: true });
    expect(s.closed).toHaveLength(0);
  });

  it("orderId が分かっている注文の「見つからない」は作成から 60 秒は不明として数えない (例外は数える)", async () => {
    const s = setup();
    const e = s.entry("e1");
    await s.pm.enter(e.req, e.entry, T0); // orderId fake-1
    s.broker.getOrderMode = "missing";
    for (let t = 5_000; t < 60_000; t += 5_000) await s.pm.syncPending(T0 + t);
    expect(s.pm.pendingOrders()[0]).toMatchObject({ unknownCount: 0 });
    expect(s.onEscalated).not.toHaveBeenCalled();
    await s.pm.syncPending(T0 + 60_000);
    expect(s.pm.pendingOrders()[0]).toMatchObject({ unknownCount: 1 });
    s.broker.getOrderMode = "throw";
    await s.pm.syncPending(T0 + 61_000);
    expect(s.pm.pendingOrders()[0]).toMatchObject({ unknownCount: 2 });
  });

  it("同じ時刻 (同じティック) に作った注文はその時刻には照会しない", async () => {
    const s = setup();
    const e = s.entry("e1");
    await s.pm.enter(e.req, e.entry, T0);
    await s.pm.syncPending(T0);
    expect(s.broker.getOrderCalls).toEqual([]);
    await s.pm.syncPending(T0 + 1);
    expect(s.broker.getOrderCalls).toEqual(["e1"]);
  });

  it("ブローカー呼び出しの締め切り: 決済の発注が返らなければ状態不明の保留として扱う", async () => {
    const s = setup({ policy: { brokerTimeoutMs: 30 } });
    s.broker.placeMode = "fill";
    const e = s.entry("e1");
    await s.pm.enter(e.req, e.entry, T0);
    let release!: () => void;
    s.broker.placeGate = () => new Promise<void>((r) => (release = r));
    const r = await s.pm.close("AAA/USD", "stop", 98, T0 + 1_000);
    expect(r.status).toBe("pending");
    expect(s.pm.pendingOrders()[0]).toMatchObject({ kind: "exit", status: "unknown", unknownCount: 1 });
    expect(s.pm.pendingOrders()[0].lastError).toMatch(/締め切り/);
    release();
  });

  it("手動の解消: --filled は申告の数量・価格で推定の約定として記録し、--none は取消してから外す", async () => {
    const s = setup();
    const e1 = s.entry("e1");
    await s.pm.enter(e1.req, e1.entry, T0); // 受付のみ
    const res = await s.pm.applyResolveRequest({ id: "r1", clientId: "e1", outcome: "filled", qty: "1.5", price: 100.3, at: T0, by: "cli", force: true }, T0 + 1_000);
    expect(res.applied).toBe(true);
    expect(s.pm.get("AAA/USD")).toMatchObject({ qty: 1.5, entryPrice: 100.3, estimated: true });
    expect(s.broker.canceled).toEqual(["fake-1"]); // 残りが後から約定しないように取消す
    expect(s.store.listAudit({ type: "order.manual_resolve" })[0].data).toMatchObject({ clientId: "e1", outcome: "filled", result: "partial", qty: "1.5", price: 100.3, by: "cli" });
    // 対象が無い要求は監査ログに残して捨てる
    const miss = await s.pm.applyResolveRequest({ id: "r2", clientId: "nope", outcome: "none", at: T0, by: "cli" }, T0 + 2_000);
    expect(miss.applied).toBe(false);
    expect(s.store.listAudit({ type: "order.manual_resolve" })[1].data).toMatchObject({ clientId: "nope", result: "rejected" });
    // 決済の保留を「約定なし」で外す
    s.broker.placeMode = "accept";
    s.broker.positions.set("AAA/USD", 1.5);
    const c = await s.pm.close("AAA/USD", "stop", 98, T0 + 3_000);
    expect(c.status).toBe("pending");
    const exitId = s.pm.pendingOrders()[0].clientId;
    await s.pm.applyResolveRequest({ id: "r3", clientId: exitId, outcome: "none", at: T0, by: "cli", force: true }, T0 + 4_000);
    expect(s.pm.hasPending("AAA/USD")).toBe(false);
    expect(s.pm.get("AAA/USD")?.qty).toBe(1.5);
  });

  it("手動の解消: 状態不明 (escalated) でない注文は force が無ければ適用しない", async () => {
    const s = setup();
    const e1 = s.entry("e1");
    await s.pm.enter(e1.req, e1.entry, T0); // 受付のみ (照会で状態が分かっている)
    const res = await s.pm.applyResolveRequest({ id: "r1", clientId: "e1", outcome: "none", at: T0, by: "cli" }, T0 + 1_000);
    expect(res.applied).toBe(false);
    expect(res.message).toMatch(/--force/);
    expect(s.pm.hasPending("AAA/USD")).toBe(true);
    expect(s.broker.canceled).toEqual([]);
    expect(s.store.listAudit({ type: "order.manual_resolve" })[0].data).toMatchObject({ clientId: "e1", result: "rejected" });
  });

  it("手動の解消 --none: 取消に失敗したら確定せず保留のまま (escalated にして建玉の照会に任せる)。監査ログに残す", async () => {
    const s = setup();
    const e1 = s.entry("e1");
    await s.pm.enter(e1.req, e1.entry, T0); // 受付のみ (orderId fake-1)
    s.broker.failCancel = true;
    const res = await s.pm.applyResolveRequest({ id: "r1", clientId: "e1", outcome: "none", at: T0, by: "cli", force: true }, T0 + 1_000);
    expect(res.applied).toBe(false);
    expect(res.message).toMatch(/取消に失敗/);
    expect(s.pm.hasPending("AAA/USD")).toBe(true);
    expect(s.pm.pendingOrders()[0]).toMatchObject({ clientId: "e1", escalated: true });
    expect(s.onEscalated).toHaveBeenCalledTimes(1);
    expect(s.store.listAudit({ type: "order.manual_resolve" })[0].data).toMatchObject({ clientId: "e1", outcome: "none", result: "deferred", force: true });
    expect(s.store.listAudit({ type: "order.resolved_by_position" })).toHaveLength(0);
    // 後から取引所で約定していた → 建玉の照会で約定ありとして確定する (「約定なし」で漏らさない)
    s.broker.fill("e1");
    s.broker.getOrderMode = "throw";
    s.broker.avgPrices.set("AAA/USD", 100.01);
    await s.pm.syncPending(T0 + 2_000);
    await s.pm.syncPending(T0 + 40_000);
    expect(s.pm.get("AAA/USD")).toMatchObject({ qty: 2, estimated: true });
    expect(s.store.listAudit({ type: "order.resolved_by_position" })[0].data).toMatchObject({ kind: "entry", result: "filled" });
  });

  it("約定の反映と保留の削除は 1 つのトランザクション (途中で失敗したら両方とも書かない = 再起動後に 1 回だけ反映)", async () => {
    class FlakyStore extends SqliteStore {
      failPendingWrite = false;
      kvSet<T>(key: string, value: T): void {
        if (this.failPendingWrite && key === "orders:pending:live") {
          this.failPendingWrite = false;
          throw new Error("disk I/O error (fake)");
        }
        super.kvSet(key, value);
      }
    }
    const store = new FlakyStore(":memory:");
    const s = setup({ store });
    s.broker.placeMode = "fill";
    const e = s.entry("e1");
    await s.pm.enter(e.req, e.entry, T0);
    s.broker.placeMode = "accept";
    await s.pm.close("AAA/USD", "stop", 98, T0 + 1_000);
    s.broker.fill(s.broker.last().clientId);
    store.failPendingWrite = true; // 決済の約定を反映した後、保留の削除の書き込みで停止したのと同じ
    await s.pm.syncPending(T0 + 2_000);
    expect(store.listTrades()).toHaveLength(0); // trades も journal も巻き戻っている
    expect(store.kvGet<unknown[]>("journal:open:live")).toHaveLength(1);
    expect(store.kvGet<unknown[]>("orders:pending:live")).toHaveLength(1);
    // 再起動 (同じ DB から作り直す) → 照会で 1 回だけ反映
    const journal2 = new TradeJournal({ store, mode: "live" });
    const pm2 = new PositionManager({ journal: journal2, brokerFor: () => s.broker, store, instrumentOf: () => ({ baseCurrency: "AAA", quoteCurrency: "USD", minQty: 0.001 }) });
    await pm2.syncPending(T0 + 3_000);
    expect(store.listTrades()).toHaveLength(1);
    expect(pm2.list()).toHaveLength(0);
    expect(pm2.pendingOrders()).toHaveLength(0);
    store.close();
  });
});
