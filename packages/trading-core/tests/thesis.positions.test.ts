/**
 * 読みの管理 (THESIS_EXIT) の PositionManager + PaperBroker の統合。実在の取引所へは送信しない。
 * - 期限で読み当たり → 延長 (建値・トレーリングで保護)、読み外れ → 決済
 * - 延長の状態は決済計画と一緒に保存し、再起動しても続ける
 * - 無効 (THESIS_EXIT=false) なら従来の時間切れと同一
 * - 決済は通常の成行の決済 (利確の指値の取消確認などの安全策をそのまま通る)
 */
import { describe, expect, it } from "vitest";
import type { Broker, EntryContext, Instrument, OrderRequest, OrderResult, Quote, TradeRecord } from "../src/core/types";
import { PaperBroker } from "../src/execution/paper";
import { PositionManager, type ExitPlan } from "../src/engine/positions";
import { DEFAULT_THESIS_SETTINGS, THESIS_DISABLED, type ThesisSettings } from "../src/engine/thesis";
import { TradeJournal } from "../src/learning/journal";
import { MemoryStore } from "../src/storage/memory";

const T0 = Date.UTC(2026, 0, 5);
const MIN = 60_000;
const SYM = "AAA/USD";

const INST: Instrument = {
  symbol: SYM, venue: "paper", assetClass: "crypto", baseCurrency: "AAA", quoteCurrency: "USD", tickSize: 0.01, lotSize: 0.001, minQty: 0.001,
  takerFeeRate: 0.001, makerFeeRate: 0.0005, allowShort: true,
};

const ctx: EntryContext = {
  regime: { label: "trend_up", trend: 0.5, trendStrength: 30, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 2 },
  confidence: 0.7, expectedEdgeBps: 50, costBps: 22, params: { stopAtr: 1 }, features: {}, riskMultiplier: 1, reason: "test",
};

const q = (mid: number, ts: number, half = 0.01): Quote => ({ ts, bid: mid - half, ask: mid + half });

/** 決済 (reduceOnly) の応答を切り替えられる包み (normal: そのまま / reject: 拒否 / half: 半分だけ約定して残りは取消) */
function scripted(paper: PaperBroker): { broker: Broker; mode: { exit: "normal" | "reject" | "half" } } {
  const mode = { exit: "normal" as "normal" | "reject" | "half" };
  const broker = new Proxy(paper as unknown as Broker, {
    get(t, k) {
      if (k === "placeOrder") {
        return async (req: OrderRequest): Promise<OrderResult> => {
          if (req.reduceOnly && mode.exit === "reject") return { orderId: "", clientId: req.clientId, status: "rejected", fills: [], reason: "test reject" };
          if (req.reduceOnly && mode.exit === "half") {
            const r = await t.placeOrder({ ...req, qty: String(Number(req.qty) / 2) });
            return { ...r, clientId: req.clientId, status: "canceled" };
          }
          return t.placeOrder(req);
        };
      }
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { broker, mode };
}

function setup(
  o: { thesis?: ThesisSettings; store?: MemoryStore; paper?: PaperBroker; clock?: { t: number; now(): number }; limitTakeProfit?: boolean; broker?: (p: PaperBroker) => Broker } = {},
) {
  const clock = o.clock ?? { t: T0, now() { return this.t; } };
  const store = o.store ?? new MemoryStore();
  const paper = o.paper ?? new PaperBroker({ instruments: [INST], baseCurrency: "USD", initialEquity: 1_000_000, slippageBps: 0, clock });
  const journal = new TradeJournal({ store, mode: "paper" });
  const closed: TradeRecord[] = [];
  const broker = o.broker ? o.broker(paper) : paper;
  const pm = new PositionManager({
    journal, brokerFor: () => broker, onTradeClosed: (t) => closed.push(t), store, instrumentOf: () => INST,
    ...(o.thesis ? { thesis: o.thesis } : {}),
    ...(o.limitTakeProfit ? { limitTakeProfit: true } : {}),
  });
  async function open(direction: "long" | "short", price: number, stop: number, plan: ExitPlan, takeProfit?: number) {
    paper.onQuote(SYM, q(price, clock.t, 0));
    const r = await paper.placeOrder({ clientId: `o-${clock.t}`, symbol: SYM, side: direction === "long" ? "buy" : "sell", type: "market", qty: "1", strategyId: "s1" });
    const f = r.fills[0];
    return pm.open(
      {
        mode: "paper", symbol: SYM, venue: "paper", assetClass: "crypto", strategyId: "s1", horizon: "scalp", direction, qty: 1, entryTs: clock.t,
        entryPrice: f.price, intendedEntryPrice: price, initialStop: stop, ...(takeProfit !== undefined ? { takeProfit } : {}), entryContext: ctx,
        entryFees: Number(f.fee),
      },
      plan,
    );
  }
  /** 時刻を at (エントリーからの分) に進めて気配を渡す */
  async function tickAt(min: number, mid: number) {
    clock.t = T0 + min * MIN;
    const quote = q(mid, clock.t);
    paper.onQuote(SYM, quote);
    return pm.onQuote(SYM, quote, clock.t);
  }
  return { clock, store, paper, journal, pm, closed, open, tickAt };
}

const ON: ThesisSettings = { ...DEFAULT_THESIS_SETTINGS };

describe("読みの管理 (PositionManager・paper)", () => {
  it("期限で利益が出ていれば延長し、建値 (手数料込み) を割ったら trailing で決済する。延長の記録が TradeRecord と監査ログに残る", async () => {
    const s = setup({ thesis: ON });
    const p = await s.open("long", 100, 98, { maxHoldMs: 10 * MIN });
    expect((await s.tickAt(5, 100.3)).status).toBe("none");
    // 期限: bid 100.49 → 純R = (0.49 − 0.1 − 0.10049) / 2 ≈ 0.145 ≥ 0.1 → 延長
    expect((await s.tickAt(10, 100.5)).status).toBe("none");
    const plan = s.pm.planOf(p.id);
    expect(plan.thesis?.extendedAt).toBe(T0 + 10 * MIN);
    expect(plan.thesis?.netRAtDeadline).toBeCloseTo((0.49 - 0.1 - 0.10049) / 2, 6);
    const be = 100.1 / 0.999;
    expect(s.pm.currentStop(s.pm.get(SYM)!)).toBeCloseTo(be, 9);
    expect(s.pm.view(s.pm.get(SYM)!).stopLoss).toBeCloseTo(be, 9);
    const audit = s.store.listAudit({ type: "thesis.extended" });
    expect(audit).toHaveLength(1);
    expect(audit[0].data).toMatchObject({ tradeId: p.id, symbol: SYM, deadlineTs: T0 + 10 * MIN, capTs: T0 + 40 * MIN });
    // 延長中は期限を過ぎても持つ
    expect((await s.tickAt(15, 100.4)).status).toBe("none");
    // 建値を割る → トレーリング (延長後の保護ストップ)
    const r = await s.tickAt(16, 100.15);
    expect(r.status).toBe("closed");
    expect(r.trade!.exitReason).toBe("trailing");
    expect(r.trade!.intendedExitPrice).toBeCloseTo(be, 9);
    expect(r.trade).toMatchObject({
      thesisExpectedMs: 10 * MIN, thesisDeadlineTs: T0 + 10 * MIN, thesisExtendedAt: T0 + 10 * MIN, thesisOutcome: "extended",
    });
    expect(r.trade!.thesisNetRAtDeadline).toBeCloseTo((0.49 - 0.1 - 0.10049) / 2, 6);
    expect(s.closed).toHaveLength(1);
  });

  it("延長後のトレーリングは延長してからの高値 (bid) − 0.5R で、高値が進むほど上がるだけ。決済に thesisStopExit が付く", async () => {
    const s = setup({ thesis: ON });
    const p = await s.open("long", 100, 98, { maxHoldMs: 10 * MIN });
    await s.tickAt(10, 101);
    // 延長した時点の bid 100.99 から測る → 100.99 − 1 < 建値なので建値
    expect(s.pm.planOf(p.id).thesis?.peak).toBeCloseTo(100.99, 9);
    expect(s.pm.currentStop(s.pm.get(SYM)!)).toBeCloseTo(100.1 / 0.999, 9);
    await s.tickAt(12, 103);
    const stop1 = s.pm.currentStop(s.pm.get(SYM)!);
    expect(stop1).toBeCloseTo(102.99 - 1, 9);
    await s.tickAt(13, 102.5);
    expect(s.pm.currentStop(s.pm.get(SYM)!)).toBeCloseTo(stop1, 9);
    await s.tickAt(14, 104);
    expect(s.pm.currentStop(s.pm.get(SYM)!)).toBeCloseTo(102.99, 9);
    expect(s.pm.planOf(p.id).thesis?.peak).toBeCloseTo(103.99, 9);
    const r = await s.tickAt(15, 102.9);
    expect(r.trade?.exitReason).toBe("trailing");
    expect(r.trade?.thesisStopExit).toBe(true);
    expect(r.trade!.netPnl).toBeGreaterThan(0);
  });

  it("期限の前に +1.5R まで伸びて期限で +0.3R: 延長して持ち続ける (延長より前の高値ではストップを上げない)", async () => {
    const s = setup({ thesis: ON });
    const p = await s.open("long", 100, 98, { maxHoldMs: 10 * MIN });
    expect((await s.tickAt(6, 103.01)).status).toBe("none"); // bid 103 = +1.5R
    // 期限: bid 100.82 → 純R = (0.82 − 0.1 − 0.10082) / 2 ≈ 0.31
    expect((await s.tickAt(10, 100.83)).status).toBe("none");
    const plan = s.pm.planOf(p.id);
    expect(plan.thesis?.extendedAt).toBe(T0 + 10 * MIN);
    expect(plan.thesis?.netRAtDeadline).toBeCloseTo((0.82 - 0.1 - 0.10082) / 2, 6);
    expect(plan.thesis?.peak).toBeCloseTo(100.82, 9);
    // ストップは max(建値, 100.82 − 1) = 建値 (103 − 1 = 102 にはしない)
    const be = 100.1 / 0.999;
    expect(s.pm.currentStop(s.pm.get(SYM)!)).toBeCloseTo(be, 9);
    for (let m = 11; m <= 20; m++) expect((await s.tickAt(m, 100.83)).status).toBe("none");
    expect(s.pm.has(SYM)).toBe(true);
    // 延長後の高値 101.49 − 1 = 100.49 を割ったら trailing
    await s.tickAt(21, 101.5);
    expect(s.pm.currentStop(s.pm.get(SYM)!)).toBeCloseTo(100.49, 9);
    const r = await s.tickAt(22, 100.45);
    expect(r.trade).toMatchObject({ exitReason: "trailing", thesisOutcome: "extended", thesisStopExit: true });
    expect(r.trade!.intendedExitPrice).toBeCloseTo(100.49, 9);
  });

  it("期限で利益が出ていなければ thesis_timeout (判定時点の決済側の気配で成行)", async () => {
    const s = setup({ thesis: ON });
    await s.open("long", 100, 98, { maxHoldMs: 10 * MIN });
    expect((await s.tickAt(9.9, 100.2)).status).toBe("none");
    const r = await s.tickAt(10, 100.2);
    expect(r.trade?.exitReason).toBe("thesis_timeout");
    expect(r.trade?.intendedExitPrice).toBeCloseTo(100.19, 9);
    expect(r.trade).toMatchObject({ thesisOutcome: "timeout", thesisDeadlineTs: T0 + 10 * MIN });
    expect(r.trade!.thesisExtendedAt).toBeUndefined();
    expect(r.trade!.thesisNetRAtDeadline).toBeCloseTo((0.19 - 0.1 - 0.10019) / 2, 6);
    expect(s.store.listAudit({ type: "thesis.extended" })).toHaveLength(0);
  });

  it("期限の半分を過ぎて −0.5R 以下なら途中で thesis_failed (半分より前は持つ)", async () => {
    const s = setup({ thesis: ON });
    await s.open("long", 100, 98, { maxHoldMs: 10 * MIN });
    expect((await s.tickAt(4, 98.9)).status).toBe("none");
    const r = await s.tickAt(5, 98.9);
    expect(r.trade?.exitReason).toBe("thesis_failed");
    expect(r.trade?.thesisOutcome).toBe("failed_early");
    expect(r.trade!.rMultiple).toBeLessThan(-0.5);
  });

  it("延長しても 期限 × THESIS_EXTEND_MULT で thesis_cap", async () => {
    const s = setup({ thesis: ON });
    await s.open("long", 100, 98, { maxHoldMs: 10 * MIN });
    await s.tickAt(10, 100.6);
    for (let m = 11; m < 40; m += 3) expect((await s.tickAt(m, 100.6 + m * 0.01)).status).toBe("none");
    const r = await s.tickAt(40, 101);
    expect(r.trade?.exitReason).toBe("thesis_cap");
    expect(r.trade?.thesisOutcome).toBe("extended");
  });

  it("期限の前に利確したら thesisOutcome は none (期限前に決着)", async () => {
    const s = setup({ thesis: ON });
    await s.open("long", 100, 98, { maxHoldMs: 10 * MIN }, 103);
    const r = await s.tickAt(3, 103.5);
    expect(r.trade?.exitReason).toBe("take_profit");
    expect(r.trade?.thesisOutcome).toBe("none");
  });

  it("期限の気配で利確にも届くなら利確 (延長を記録しない)", async () => {
    const s = setup({ thesis: ON });
    await s.open("long", 100, 98, { maxHoldMs: 10 * MIN }, 103);
    const r = await s.tickAt(10, 103.5);
    expect(r.trade?.exitReason).toBe("take_profit");
    expect(r.trade?.thesisOutcome).toBe("none");
    expect(s.store.listAudit({ type: "thesis.extended" })).toHaveLength(0);
  });

  it("延長した瞬間のストップは max(建値, 決済できる価格 − 0.5R) より厳しくならず、延長そのもので決済しない (THESIS_MIN_R = 0 で建値すれすれ)", async () => {
    const s = setup({ thesis: { ...ON, minR: 0 } });
    const p = await s.open("long", 100, 98, { maxHoldMs: 10 * MIN });
    // bid = 建値 (手数料込み) + 0.001 → 純R ≈ 0 で延長。ストップ = 建値 (bid のすぐ下)
    const be = 100.1 / 0.999;
    expect((await s.tickAt(10, be + 0.011)).status).toBe("none");
    expect(s.pm.planOf(p.id).thesis?.extendedAt).toBe(T0 + 10 * MIN);
    expect(s.pm.planOf(p.id).thesis?.peak).toBeCloseTo(be + 0.001, 9);
    expect(s.pm.currentStop(s.pm.get(SYM)!)).toBeCloseTo(Math.max(be, be + 0.001 - 1), 9);
    // 次の気配で建値を割れば trailing
    expect((await s.tickAt(11, be - 0.05)).trade?.exitReason).toBe("trailing");
  });

  it("売りは逆向き: 期限で利益なら延長し、建値 (手数料込み) を上に越えたら trailing", async () => {
    const s = setup({ thesis: ON });
    await s.open("short", 100, 102, { maxHoldMs: 10 * MIN });
    // ask 99.51 → 純R = (0.49 − 0.1 − 0.09951) / 2 ≈ 0.145
    expect((await s.tickAt(10, 99.5)).status).toBe("none");
    const be = 99.9 / 1.001;
    expect(s.pm.currentStop(s.pm.get(SYM)!)).toBeCloseTo(be, 9);
    const r = await s.tickAt(12, 99.85);
    expect(r.trade?.exitReason).toBe("trailing");
    expect(r.trade?.thesisOutcome).toBe("extended");
    // 売りの期限で読み外れ
    const t = setup({ thesis: ON });
    await t.open("short", 100, 102, { maxHoldMs: 10 * MIN });
    expect((await t.tickAt(10, 100.05)).trade?.exitReason).toBe("thesis_timeout");
  });

  it("expectedMs (戦略の読みの期限) があれば maxHoldMs ではなくそれで判定する", async () => {
    const s = setup({ thesis: ON });
    await s.open("long", 100, 98, { maxHoldMs: 30 * MIN, expectedMs: 5 * MIN });
    const r = await s.tickAt(5, 100.1);
    expect(r.trade?.exitReason).toBe("thesis_timeout");
    expect(r.trade?.thesisExpectedMs).toBe(5 * MIN);
  });

  it("再起動しても延長の状態 (決済計画) を引き継ぎ、建値・トレーリングで守り続ける", async () => {
    const store = new MemoryStore();
    const clock = { t: T0, now() { return this.t; } };
    const paper = new PaperBroker({ instruments: [INST], baseCurrency: "USD", initialEquity: 1_000_000, slippageBps: 0, clock });
    const a = setup({ thesis: ON, store, paper, clock });
    const p = await a.open("long", 100, 98, { maxHoldMs: 10 * MIN });
    await a.tickAt(10, 100.8);
    expect(a.pm.planOf(p.id).thesis?.extendedAt).toBe(T0 + 10 * MIN);
    await a.tickAt(12, 101.5); // 延長後の高値 (bid) 101.49 → ストップ 100.49
    // 再起動 (同じ store から journal と PositionManager を作り直す)
    const b = setup({ thesis: ON, store, paper, clock });
    expect(b.pm.get(SYM)?.id).toBe(p.id);
    expect(b.pm.planOf(p.id)).toMatchObject({ maxHoldMs: 10 * MIN, thesis: { extendedAt: T0 + 10 * MIN } });
    expect(b.pm.planOf(p.id).thesis?.peak).toBeCloseTo(101.49, 9);
    expect(b.pm.currentStop(b.pm.get(SYM)!)).toBeCloseTo(100.49, 9);
    // 期限を過ぎていても延長中なので持ち、延長後の高値 − 0.5R を割ったら trailing。延長の監査ログは 1 回だけ
    expect((await b.tickAt(20, 100.6)).status).toBe("none");
    const r = await b.tickAt(21, 100.4);
    expect(r.trade?.exitReason).toBe("trailing");
    expect(r.trade).toMatchObject({ thesisOutcome: "extended", thesisExtendedAt: T0 + 10 * MIN });
    expect(store.listAudit({ type: "thesis.extended" })).toHaveLength(1);
  });

  it("無効 (THESIS_EXIT=false・設定なし) なら従来どおり maxHoldMs で time。読みの記録は付かない", async () => {
    for (const thesis of [THESIS_DISABLED, undefined]) {
      const s = setup(thesis ? { thesis } : {});
      await s.open("long", 100, 98, { maxHoldMs: 10 * MIN });
      // 途中の大きな逆行でも決済しない
      expect((await s.tickAt(6, 98.9)).status).toBe("none");
      const r = await s.tickAt(10, 100.5);
      expect(r.trade?.exitReason).toBe("time");
      expect(r.trade?.intendedExitPrice).toBeCloseTo(100.49, 9);
      expect(r.trade?.thesisOutcome).toBeUndefined();
      expect(r.trade?.thesisDeadlineTs).toBeUndefined();
      expect(s.store.listAudit({ type: "thesis.extended" })).toHaveLength(0);
    }
  });

  it("maxHoldMs の無い建玉 (以前の建玉など) は期限なし・時間切れなし (従来どおり)", async () => {
    const s = setup({ thesis: ON });
    await s.open("long", 100, 98, {});
    expect((await s.tickAt(500, 100)).status).toBe("none");
    expect(s.pm.thesisView(s.pm.get(SYM)!, q(100, s.clock.t), s.clock.t)).toBeUndefined();
  });

  it("当初のリスクが 0 (損切り = 建値) の建玉は従来の時間切れに戻す", async () => {
    const s = setup({ thesis: ON });
    await s.open("long", 100, 100, { maxHoldMs: 10 * MIN });
    expect((await s.tickAt(9, 100.5)).status).toBe("none");
    expect((await s.tickAt(10, 100.5)).trade?.exitReason).toBe("time");
  });

  it("表示用の読みの状態: 期限・残り分・状態・現在の R", async () => {
    const s = setup({ thesis: ON });
    const p = await s.open("long", 100, 98, { maxHoldMs: 10 * MIN });
    await s.tickAt(4, 100.3);
    const v = s.pm.thesisView(s.pm.get(SYM)!, q(100.3, s.clock.t), s.clock.t)!;
    expect(v).toMatchObject({ deadlineTs: T0 + 10 * MIN, capTs: T0 + 40 * MIN, state: "watching" });
    expect(v.remainingMin).toBeCloseTo(6, 9);
    expect(v.netR).toBeCloseTo((0.29 - 0.1 - 0.10029) / 2, 6);
    await s.tickAt(10, 100.8);
    const w = s.pm.thesisView(s.pm.get(SYM)!, q(100.8, s.clock.t), s.clock.t)!;
    expect(w.state).toBe("extended");
    expect(w.remainingMin).toBeCloseTo(30, 9);
    expect(p.id).toBeTruthy();
  });

  it("板に置いた利確の指値がある建玉の読みの決済は、先に利確の指値を取り消して確かめてから成行 (安全策を通る)", async () => {
    const s = setup({ thesis: ON, limitTakeProfit: true });
    const p = await s.open("long", 100, 98, { maxHoldMs: 10 * MIN }, 105);
    await s.tickAt(1, 100.1);
    expect(s.pm.restingTakeProfits()).toHaveLength(1);
    let r = await s.tickAt(10, 100.1);
    // 取消の確認が済むまで (同じティックで済めば closed)
    for (let m = 10.1; r.status !== "closed" && m < 11; m += 0.1) r = await s.tickAt(m, 100.1);
    expect(r.status).toBe("closed");
    expect(r.trade?.exitReason).toBe("thesis_timeout");
    expect(r.trade?.exitOrderType).toBe("market");
    expect(s.pm.restingTakeProfits()).toHaveLength(0);
    const types = s.store.listAudit({}).map((a) => a.type);
    expect(types.indexOf("engine.tp_cancel")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("engine.tp_cancel")).toBeLessThan(types.indexOf("engine.exit"));
    expect(await s.paper.getPositions()).toEqual([]);
    expect(p.id).toBeTruthy();
  });
});

describe("読みの管理 (PositionManager・paper): 決済の再試行・延長の上限・保護ストップ", () => {
  it("延長していない建玉が上限に届いても (THESIS_EXTEND_MULT = 1・停止中に上限を過ぎた)、利益が出ていれば延長を記録してから thesis_cap", async () => {
    const s = setup({ thesis: { ...ON, extendMult: 1 } });
    await s.open("long", 100, 98, { maxHoldMs: 10 * MIN });
    const r = await s.tickAt(10, 101);
    expect(r.trade).toMatchObject({ exitReason: "thesis_cap", thesisOutcome: "extended", thesisExtendedAt: T0 + 10 * MIN });
    expect(r.trade!.thesisNetRAtDeadline).toBeCloseTo((0.99 - 0.1 - 0.10099) / 2, 6);
    expect(s.store.listAudit({ type: "thesis.extended" })[0].data).toMatchObject({ capped: true });
    // 停止していて上限 (期限 × 4) を過ぎてから初めて判定した場合も同じ
    const t = setup({ thesis: ON });
    await t.open("long", 100, 98, { maxHoldMs: 10 * MIN });
    const r2 = await t.tickAt(45, 101);
    expect(r2.trade).toMatchObject({ exitReason: "thesis_cap", thesisOutcome: "extended", thesisExtendedAt: T0 + 45 * MIN });
  });

  it("期限で読み外れの決済が拒否されたら、再試行の待ちを守って同じ理由で再試行する (価格が戻っても延長しない)", async () => {
    let ctl!: ReturnType<typeof scripted>;
    const s = setup({ thesis: ON, broker: (p) => (ctl = scripted(p)).broker });
    const p = await s.open("long", 100, 98, { maxHoldMs: 10 * MIN });
    ctl.mode.exit = "reject";
    expect((await s.tickAt(10, 100.0)).status).toBe("rejected");
    expect(s.pm.planOf(p.id).thesis?.exit).toMatchObject({ reason: "thesis_timeout", at: T0 + 10 * MIN });
    ctl.mode.exit = "normal";
    // 再試行の待ち (exitRetryMs) の間は送らない
    expect((await s.tickAt(10 + 1 / 60, 100.8)).status).toBe("throttled");
    expect(s.pm.planOf(p.id).thesis?.extendedAt).toBeUndefined();
    // 待ちの後は、純 R が延長の基準を上回っていても期限で読み外れのまま決済する
    const r = await s.tickAt(12, 100.8);
    expect(r.trade).toMatchObject({ exitReason: "thesis_timeout", thesisOutcome: "timeout" });
    expect(r.trade!.thesisExtendedAt).toBeUndefined();
    expect(s.store.listAudit({ type: "thesis.extended" })).toHaveLength(0);
  });

  it("読みの決済が一部約定でも、残りは同じ理由で決済し、延長を記録しない (outcome=timeout に extendedAt が付かない)", async () => {
    let ctl!: ReturnType<typeof scripted>;
    const s = setup({ thesis: ON, broker: (p) => (ctl = scripted(p)).broker });
    const p = await s.open("long", 100, 98, { maxHoldMs: 10 * MIN });
    ctl.mode.exit = "half";
    expect((await s.tickAt(10, 100.2)).status).toBe("reduced");
    expect(s.pm.planOf(p.id).retryExit?.reason).toBe("thesis_timeout");
    ctl.mode.exit = "normal";
    const r = await s.tickAt(11, 100.9);
    expect(r.status).toBe("closed");
    expect(r.trade).toMatchObject({ exitReason: "thesis_timeout", thesisOutcome: "timeout", qty: 1 });
    expect(r.trade!.thesisExtendedAt).toBeUndefined();
    expect(s.store.listAudit({ type: "thesis.extended" })).toHaveLength(0);
  });

  it("途中で読み外れは値動きだけで判定する: 損切りが近くコストで純 R が −0.5 を下回っても、価格が動いていなければ途中では切らない", async () => {
    const s = setup({ thesis: ON });
    // 1R = 0.4 (損切り 99.6)。往復手数料 ≈ 0.2 → 動いていなくても純 R ≈ −0.55
    await s.open("long", 100, 99.6, { maxHoldMs: 10 * MIN });
    for (const m of [5, 7, 9]) expect((await s.tickAt(m, 100)).status).toBe("none");
    // 期限は純 R (コスト込み) で判定する → 期限で読み外れ
    expect((await s.tickAt(10, 100)).trade?.exitReason).toBe("thesis_timeout");
    // 値動きが −0.5R (仲値 99.8) を下回れば途中で切る
    const t = setup({ thesis: ON });
    await t.open("long", 100, 99.6, { maxHoldMs: 10 * MIN });
    expect((await t.tickAt(5, 99.79)).trade?.exitReason).toBe("thesis_failed");
  });

  it("延長後の保護ストップの印は約定した決済の注文に付く: 保護ストップの決済が拒否され、後で戦略のトレーリングで決済したら thesisStopExit は付かない", async () => {
    let ctl!: ReturnType<typeof scripted>;
    const s = setup({ thesis: ON, broker: (p) => (ctl = scripted(p)).broker });
    await s.open("long", 100, 98, { maxHoldMs: 10 * MIN, trailingStopPct: 0.005 });
    await s.tickAt(10, 100.5); // 延長 (建値 ≈ 100.2)
    ctl.mode.exit = "reject";
    expect((await s.tickAt(11, 100.15)).status).toBe("rejected"); // 延長後の保護ストップ
    ctl.mode.exit = "normal";
    await s.tickAt(13, 102.5); // 戦略のトレーリング 102.5 × 0.995 = 101.99 が延長後の保護ストップ (102.49 − 1) よりきつい
    const r = await s.tickAt(14, 101.9);
    expect(r.trade?.exitReason).toBe("trailing");
    expect(r.trade?.intendedExitPrice).toBeCloseTo(101.9875, 9);
    expect(r.trade?.thesisStopExit).toBeUndefined();
    expect(r.trade?.thesisOutcome).toBe("extended");
  });

  it("延長後の保護ストップは保存し、設定を緩めて再起動しても緩めない。THESIS_EXIT=false で再起動しても保存したストップで守る", async () => {
    const store = new MemoryStore();
    const clock = { t: T0, now() { return this.t; } };
    const paper = new PaperBroker({ instruments: [INST], baseCurrency: "USD", initialEquity: 1_000_000, slippageBps: 0, clock });
    const a = setup({ thesis: ON, store, paper, clock });
    // 期限 5 分 (expectedMs)、最大保有 30 分
    const p = await a.open("long", 100, 98, { maxHoldMs: 30 * MIN, expectedMs: 5 * MIN });
    await a.tickAt(5, 100.8);
    await a.tickAt(6, 103); // 延長後の高値 (bid) 102.99 → ストップ 101.99
    expect(a.pm.planOf(p.id).thesis?.stop).toBeCloseTo(101.99, 9);
    // トレーリングの幅を 3R に緩めて再起動: 計算上は 102.99 − 6 だが、保存したストップより緩めない
    const b = setup({ thesis: { ...ON, trailR: 3 }, store, paper, clock });
    expect(b.pm.currentStop(b.pm.get(SYM)!)).toBeCloseTo(101.99, 9);
    expect((await b.tickAt(7, 102.5)).status).toBe("none");
    expect(b.pm.planOf(p.id).thesis?.stop).toBeCloseTo(101.99, 9);
    // THESIS_EXIT=false で再起動: 保存したストップは残る (最大保有 30 分の前に割ったら決済)
    const c = setup({ thesis: THESIS_DISABLED, store, paper, clock });
    expect(c.pm.currentStop(c.pm.get(SYM)!)).toBeCloseTo(101.99, 9);
    expect((await c.tickAt(8, 102.5)).status).toBe("none");
    const r = await c.tickAt(9, 101.8);
    expect(r.trade?.exitReason).toBe("trailing");
    expect(r.trade?.intendedExitPrice).toBeCloseTo(101.99, 9);
  });
});
