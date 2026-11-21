/**
 * 指値 (maker) の実弾の安全性 (PositionManager の単体)。偽のブローカーだけを使う (実在の取引所へは送信しない)。
 * - 状態不明の指値のエントリーは、取消に成功して照会で板に無いと確かめるまで追跡から外さない (建玉の判定だけでは外さない)
 * - 指値を待っている銘柄で、取引所の建玉が説明できる範囲を超えたら異常 (kill switch)
 * - 最小数量未満の一部約定は追跡しない (limit.dust_entry)
 * - 古い気配では損切り価格の越えを判定しない
 * - 利確の指値 (paper 専用) は、注文が終わったと確かめるまで記録を消さない・「見つからない」は猶予の後に別のティックで 2 回
 */
import { describe, expect, it, vi } from "vitest";
import type { Broker, BrokerCapabilities, BrokerPosition, EntryContext, Fill, Instrument, OrderRequest, OrderResult, TradingMode } from "../src/core/types";
import type { PendingEntry, PendingOrder } from "../src/engine/orders";
import { PositionManager } from "../src/engine/positions";
import { TradeJournal } from "../src/learning/journal";
import { MemoryStore } from "../src/storage/memory";

const T = Date.UTC(2025, 0, 10, 12, 0);
const SYM = "BTC/JPY";
const BTC: Instrument = {
  symbol: SYM, venue: "fake", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "JPY", tickSize: 1, lotSize: 0.001, minQty: 0.01,
  takerFeeRate: 0, makerFeeRate: 0, allowShort: true,
};
const ctx: EntryContext = {
  regime: { label: "range", trend: 0, trendStrength: 0, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
  confidence: 0.7, expectedEdgeBps: 50, costBps: 5, params: {}, features: {}, riskMultiplier: 1, reason: "t",
};

/** 振る舞いを切り替えられる偽のブローカー (照会・取消の失敗、取引所の建玉、約定) */
class ScriptedBroker implements Broker {
  readonly venue = "fake";
  readonly mode = "live" as const;
  capabilities?: BrokerCapabilities = { postOnly: true };
  getOrderMode: "normal" | "throw" | "missing" = "normal";
  /** この回数だけ、次の照会を例外にする (一時的な失敗) */
  getOrderFailures = 0;
  cancelFails = false;
  placeThrows = false;
  /** orderId 無しの照会 (hint) で注文を特定できるか */
  lookupByHint = false;
  readonly positions: BrokerPosition[] = [];
  readonly orders = new Map<string, { req: OrderRequest; res: OrderResult }>();
  readonly cancels: string[] = [];
  readonly placed: OrderRequest[] = [];
  readonly getOrderArgs: { clientId: string; orderId?: string }[] = [];
  private seq = 0;

  async getBalance() {
    return { currency: "JPY", equity: "10000000", available: "10000000" };
  }
  async getPositions(): Promise<BrokerPosition[]> {
    return this.positions.map((p) => ({ ...p }));
  }
  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    this.placed.push({ ...req });
    const res: OrderResult = { orderId: `o${++this.seq}`, clientId: req.clientId, status: "open", fills: [] };
    this.orders.set(req.clientId, { req, res });
    if (this.placeThrows) throw new Error("ETIMEDOUT (place)");
    return structuredClone(res);
  }
  /** 取引所側の約定 (累計に追加) */
  fill(clientId: string, qty: string, price: number, status: OrderResult["status"] = "partially_filled"): void {
    const r = this.orders.get(clientId)!;
    const f: Fill = { orderId: r.res.orderId, clientId, ts: 0, price, qty, fee: "0", liquidity: "maker" };
    r.res.fills.push(f);
    r.res.status = status;
  }
  async getOrder(clientId: string, _symbol: string, orderId?: string): Promise<OrderResult | undefined> {
    this.getOrderArgs.push({ clientId, ...(orderId ? { orderId } : {}) });
    if (this.getOrderFailures > 0) {
      this.getOrderFailures--;
      throw new Error("GET /orders 503 (once)");
    }
    if (this.getOrderMode === "throw") throw new Error("GET /orders 503");
    if (this.getOrderMode === "missing") return undefined;
    const r = this.orders.get(clientId);
    if (!r) return undefined;
    // orderId を知らない照会 (発注の例外の後) は hint で特定できるときだけ答える
    if (!orderId && !this.lookupByHint) return undefined;
    return structuredClone(r.res);
  }
  async cancelOrder(orderId: string): Promise<void> {
    this.cancels.push(orderId);
    if (this.cancelFails) throw new Error("POST /cancel 503");
    for (const { res } of this.orders.values()) if (res.orderId === orderId && (res.status === "open" || res.status === "partially_filled")) res.status = "canceled";
  }
}

function world(o: { mode?: TradingMode; limitTakeProfit?: boolean; minQty?: number } = {}) {
  const store = new MemoryStore();
  const journal = new TradeJournal({ store, mode: o.mode ?? "live" });
  const broker = new ScriptedBroker();
  const onAnomaly = vi.fn();
  const onEscalated = vi.fn();
  const onOpened = vi.fn();
  const inst = { ...BTC, ...(o.minQty !== undefined ? { minQty: o.minQty } : {}) };
  const pm = new PositionManager({
    journal, brokerFor: () => broker, store, instrumentOf: () => inst, priceOf: () => 10_000_000, onAnomaly, onEscalated, onOpened,
    ...(o.limitTakeProfit ? { limitTakeProfit: true } : {}),
  });
  return { store, journal, broker, pm, onAnomaly, onEscalated, onOpened };
}

const entryOf = (mode: TradingMode = "live"): PendingEntry => ({
  input: {
    mode, symbol: SYM, venue: "fake", assetClass: "crypto", strategyId: "s", horizon: "scalp", direction: "long", entryTs: T,
    intendedEntryPrice: 10_000_000, initialStop: 9_800_000, takeProfit: 10_200_000, entryContext: ctx,
  },
  plan: {},
  audit: {},
});

async function placeLimit(w: ReturnType<typeof world>, qty = "0.03", mode: TradingMode = "live") {
  const req: OrderRequest = { clientId: "e1", symbol: SYM, side: "buy", type: "limit", qty, limitPrice: 9_990_000, tif: "GTC", postOnly: true, strategyId: "s" };
  const limit: NonNullable<PendingOrder["limit"]> = { price: 9_990_000, expiresAt: T + 15 * 60_000, postOnly: true, stopLoss: 9_800_000, direction: "long" };
  return w.pm.enter(req, entryOf(mode), T, limit);
}

const audits = (store: MemoryStore, type: string) => store.listAudit({ type }).map((a) => a.data as Record<string, unknown>);

describe("状態不明の指値のエントリー: 板に無いと確かめるまで追跡から外さない", () => {
  it("照会も取消も失敗し続ける間は、建玉が「約定なし」でも確定せず escalated のまま (S2)。回復したら照会の結果で確定する", async () => {
    const w = world();
    expect((await placeLimit(w)).status).toBe("pending");
    w.broker.getOrderMode = "throw";
    w.broker.cancelFails = true;
    let t = T;
    for (let k = 1; k <= 60; k++) {
      t = T + k * 5_000;
      await w.pm.syncPending(t);
    }
    const o = w.pm.pendingLimitEntry(SYM);
    expect(o).toBeDefined();
    expect(o!.escalated).toBe(true);
    expect(w.pm.escalatedOrders()).toHaveLength(1);
    expect(w.pm.hasPending(SYM)).toBe(true); // この銘柄の新規は止まったまま
    expect(audits(w.store, "order.resolved_by_position")).toHaveLength(0);
    expect(audits(w.store, "order.limit_unconfirmed").length).toBeGreaterThan(0);
    expect(w.broker.cancels.length).toBeGreaterThan(0);
    // 取消は成功するようになったが、照会はまだできない: 確定しない
    w.broker.cancelFails = false;
    t += 60_000;
    await w.pm.syncPending(t);
    expect(w.pm.pendingLimitEntry(SYM)).toBeDefined();
    // 照会が回復: 取消済み (canceled) を照会で確かめて外す (約定なし)
    w.broker.getOrderMode = "normal";
    t += 5_000;
    const r = await w.pm.syncPending(t);
    expect(w.pm.pendingOrders()).toHaveLength(0);
    expect(w.pm.list()).toHaveLength(0);
    expect(r.limitUnfilled).toHaveLength(1);
    expect(audits(w.store, "order.resolved_by_position")).toHaveLength(0);
  });

  it("取消に成功し、照会でも「見つからない」なら建玉の判定 (約定なし) で確定する", async () => {
    const w = world();
    await placeLimit(w);
    w.broker.getOrderMode = "throw";
    let t = T;
    for (let k = 1; k <= 40 && w.pm.pendingOrders().length; k++) {
      t = T + k * 5_000;
      // 取消の後の照会でだけ「見つからない」と答える
      if (w.broker.cancels.length > 0) w.broker.getOrderMode = "missing";
      await w.pm.syncPending(t);
    }
    expect(w.pm.pendingOrders()).toHaveLength(0);
    expect(w.broker.cancels.length).toBeGreaterThan(0);
    expect(audits(w.store, "order.resolved_by_position")[0]).toMatchObject({ clientId: "e1", result: "none" });
  });

  it("建玉で一部約定と判定しても、取消を確かめるまでは確定しない。確かめたら照会の実際の約定で建玉にする", async () => {
    const w = world();
    await placeLimit(w);
    w.broker.fill("e1", "0.02", 9_990_000);
    w.broker.positions.push({ symbol: SYM, qty: "0.02", avgPrice: 9_990_000 });
    w.broker.getOrderMode = "throw";
    w.broker.cancelFails = true;
    let t = T;
    for (let k = 1; k <= 60; k++) {
      t = T + k * 5_000;
      await w.pm.syncPending(t);
    }
    expect(w.pm.pendingLimitEntry(SYM)?.escalated).toBe(true);
    expect(w.pm.list()).toHaveLength(0);
    expect(audits(w.store, "order.resolved_by_position")).toHaveLength(0);
    // 取消が通り、取消の後の照会で canceled (約定 0.02) を確かめた (このティックの定期の照会だけは失敗)
    w.broker.cancelFails = false;
    w.broker.getOrderMode = "normal";
    w.broker.getOrderFailures = 1;
    t += 60_000;
    await w.pm.syncPending(t);
    const p = w.pm.list();
    expect(p).toHaveLength(1);
    expect(p[0].qty).toBeCloseTo(0.02, 10);
    expect(p[0].estimated).toBeFalsy(); // 推定ではなく照会の約定
    expect(w.onOpened).toHaveBeenCalledTimes(1);
    expect(w.pm.pendingOrders()).toHaveLength(0);
    expect(audits(w.store, "order.resolved_by_position")).toHaveLength(0);
  });

  it("orderId が分からない指値は、照会で特定できない間は確定しない。特定できたら取消 → 照会で確定する", async () => {
    const w = world();
    w.broker.placeThrows = true;
    expect((await placeLimit(w)).status).toBe("pending");
    expect(w.pm.pendingLimitEntry(SYM)?.orderId).toBeUndefined();
    let t = T;
    for (let k = 1; k <= 60; k++) {
      t = T + k * 5_000;
      await w.pm.syncPending(t);
    }
    expect(w.pm.pendingLimitEntry(SYM)?.escalated).toBe(true);
    expect(w.broker.cancels).toHaveLength(0);
    expect(audits(w.store, "order.resolved_by_position")).toHaveLength(0);
    // 照会 (hint) で特定できるようになった (このティックの定期の照会だけは失敗): 建玉による確定の前に特定した orderId で取り消し、
    // 照会で canceled を確かめてから外す
    w.broker.lookupByHint = true;
    w.broker.getOrderFailures = 1;
    t += 60_000;
    const r = await w.pm.syncPending(t);
    expect(w.pm.pendingOrders()).toHaveLength(0);
    expect(w.broker.cancels).toEqual(["o1"]);
    expect(r.limitUnfilled).toHaveLength(1);
    expect(audits(w.store, "order.resolved_by_position")).toHaveLength(0);
  });

  it("手動の解消 (--none) は orderId の無い指値でも従来どおり適用できる (取引所で確認した人の判断)", async () => {
    const w = world();
    w.broker.placeThrows = true;
    await placeLimit(w);
    const r = await w.pm.applyResolveRequest({ id: "r1", clientId: "e1", outcome: "none", at: T, by: "test", force: true }, T + 1_000);
    expect(r.applied).toBe(true);
    expect(w.pm.pendingOrders()).toHaveLength(0);
  });
});

describe("指値を待っている銘柄の建玉の突き合わせ", () => {
  it("待っている指値の数量で説明できる建玉は異常にしない。超える・逆方向なら onAnomaly (kill switch)", async () => {
    const w = world();
    await placeLimit(w, "0.03");
    // 待っている買い 0.03 の約定 (照会の前) で説明できる
    let r = w.pm.reconcile([{ symbol: SYM, qty: "0.02", avgPrice: 1 }], T + 1_000);
    expect(r.limitExcess).toEqual([]);
    expect(w.onAnomaly).not.toHaveBeenCalled();
    // 最小数量未満の端数も異常にしない
    r = w.pm.reconcile([{ symbol: SYM, qty: "0.035", avgPrice: 1 }], T + 2_000);
    expect(r.limitExcess).toEqual([]);
    // 待っている指値より大きい: 取消できずに残った注文の約定など
    r = w.pm.reconcile([{ symbol: SYM, qty: "0.06", avgPrice: 1 }], T + 3_000);
    expect(r.limitExcess).toEqual([SYM]);
    expect(w.onAnomaly).toHaveBeenCalledTimes(1);
    expect(String(w.onAnomaly.mock.calls[0][0])).toContain("説明できる範囲を超えています");
    expect(audits(w.store, "reconcile.limit_excess")).toHaveLength(1);
    // 追跡していない逆方向の建玉
    r = w.pm.reconcile([{ symbol: SYM, qty: "-0.02", avgPrice: 1 }], T + 4_000);
    expect(r.limitExcess).toEqual([SYM]);
    expect(w.onAnomaly).toHaveBeenCalledTimes(2);
  });

  it("confirmations 回続いたときだけ異常にする (照会の一時的な揺れで止めない)", async () => {
    const w = world();
    await placeLimit(w, "0.03");
    const bp = [{ symbol: SYM, qty: "0.1", avgPrice: 1 }];
    expect(w.pm.reconcile(bp, T + 1_000, { confirmations: 2 }).limitExcess).toEqual([]);
    expect(audits(w.store, "reconcile.limit_excess_waiting")).toHaveLength(1);
    expect(w.onAnomaly).not.toHaveBeenCalled();
    expect(w.pm.reconcile(bp, T + 2_000, { confirmations: 2 }).limitExcess).toEqual([SYM]);
    expect(w.onAnomaly).toHaveBeenCalledTimes(1);
  });
});

describe("最小数量未満の一部約定 (limit.dust_entry)", () => {
  it("建玉にせず (onOpened も呼ばない)、監査ログに残して銘柄を止めない", async () => {
    const w = world();
    await placeLimit(w, "0.03");
    w.broker.fill("e1", "0.004", 9_990_000);
    w.pm.requestLimitCancel("e1", "expired", T + 1_000);
    const r = await w.pm.syncPending(T + 2_000);
    expect(w.pm.list()).toHaveLength(0);
    expect(w.pm.pendingOrders()).toHaveLength(0);
    expect(w.pm.hasPending(SYM)).toBe(false);
    expect(w.onOpened).not.toHaveBeenCalled();
    expect(audits(w.store, "limit.dust_entry")[0]).toMatchObject({ symbol: SYM, clientId: "e1", qty: "0.004", minQty: 0.01, cause: "expired" });
    expect(r.limitUnfilled).toHaveLength(1);
    expect(r.limitUnfilled[0].cause).toBe("expired");
    // 端数 (最小数量未満) は突き合わせの「追跡していない建玉」にもならない
    expect(w.pm.reconcile([{ symbol: SYM, qty: "0.004", avgPrice: 1 }], T + 3_000).untracked).toEqual([]);
  });
});

describe("待っている指値の損切り価格の越え", () => {
  it("気配が maxQuoteAgeMs より古ければ判定しない", async () => {
    const w = world();
    await placeLimit(w);
    const now = T + 60_000;
    const stale = { ts: now - 40_000, bid: 9_700_000, ask: 9_700_100 };
    expect(w.pm.checkLimitEntries(() => stale, now, { maxQuoteAgeMs: 30_000 })).toEqual([]);
    expect(w.pm.pendingLimitEntry(SYM)?.limit?.cancelReason).toBeUndefined();
    const fresh = { ...stale, ts: now - 1_000 };
    expect(w.pm.checkLimitEntries(() => fresh, now, { maxQuoteAgeMs: 30_000 })).toEqual(["e1"]);
    expect(w.pm.pendingLimitEntry(SYM)?.limit?.cancelReason).toBe("stop_crossed");
  });
});

describe("利確の指値 (paper 専用)", () => {
  function opened(mode: TradingMode) {
    const w = world({ mode, limitTakeProfit: true });
    w.broker.capabilities = { restingTakeProfit: true };
    const p = w.pm.open(
      {
        mode, symbol: SYM, venue: "fake", assetClass: "crypto", strategyId: "s", horizon: "scalp", direction: "long", qty: 0.03, entryTs: T,
        entryPrice: 10_000_000, intendedEntryPrice: 10_000_000, initialStop: 9_800_000, takeProfit: 10_200_000, entryContext: ctx,
      },
      {},
    );
    w.broker.positions.push({ symbol: SYM, qty: "0.03", avgPrice: 10_000_000 });
    return { ...w, p };
  }
  const quote = (ts: number, bid = 10_000_000) => ({ ts, bid, ask: bid + 100 });

  it("live では limitTakeProfit を渡されても置かない", async () => {
    const w = opened("live");
    expect(await w.pm.placeTakeProfit(w.p, quote(T), T)).toBe(false);
    expect(w.broker.placed).toHaveLength(0);
  });

  it("孤児の利確の指値は、取消に失敗している間は記録を消さない (S3)。取消・照会で終わったと確かめたら消す", async () => {
    const w = opened("paper");
    expect(await w.pm.placeTakeProfit(w.p, quote(T), T)).toBe(true);
    w.journal.close({ id: w.p.id, exitPrice: 10_000_000, intendedExitPrice: 10_000_000, exitTs: T + 1_000, exitReason: "manual" });
    w.broker.cancelFails = true;
    expect(await w.pm.sweepTakeProfits(T + 2_000)).toBe(0);
    expect(w.pm.restingTakeProfits()).toHaveLength(1);
    expect(w.pm.hasOrphanTakeProfit(SYM)).toBe(true);
    w.broker.cancelFails = false;
    expect(await w.pm.sweepTakeProfits(T + 20_000)).toBe(1);
    expect(w.pm.restingTakeProfits()).toHaveLength(0);
    expect(w.pm.hasOrphanTakeProfit(SYM)).toBe(false);
  });

  it("orderId の無い利確の指値 (発注で例外) は、猶予の間と同じティックの 2 回の「見つからない」では消さず、成行の決済も送らない (S4)", async () => {
    const w = opened("paper");
    w.broker.placeThrows = true;
    w.broker.getOrderMode = "missing";
    expect(await w.pm.placeTakeProfit(w.p, quote(T), T)).toBe(true);
    w.broker.placeThrows = false;
    const marketExits = () => w.broker.placed.filter((r) => r.reduceOnly && r.type === "market");
    // 発注の 5 秒後に損切り: 定期の照会と取消の確認が同じティック → 消さない
    let r = await w.pm.onQuote(SYM, quote(T + 5_000, 9_700_000), T + 5_000);
    expect(r.status).toBe("pending");
    expect(w.pm.restingTakeProfits()).toHaveLength(1);
    expect(marketExits()).toHaveLength(0);
    // 猶予 (notFoundGraceMs = 60 秒) を過ぎた 1 回目: まだ消さない
    r = await w.pm.onQuote(SYM, quote(T + 61_000, 9_700_000), T + 61_000);
    expect(w.pm.restingTakeProfits()).toHaveLength(1);
    expect(marketExits()).toHaveLength(0);
    // 別のティックで続けて「見つからない」: 約定なしで消えたとみなし、成行で決済する
    r = await w.pm.onQuote(SYM, quote(T + 66_000, 9_700_000), T + 66_000);
    expect(w.pm.restingTakeProfits()).toHaveLength(0);
    expect(marketExits()).toHaveLength(1);
  });
});
