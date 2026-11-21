import { describe, expect, it } from "vitest";
import type { EntryContext, TradeRecord } from "../src/core/types";
import { fillPostExitMoves, TradeJournal, type OpenTradeInput } from "../src/learning/journal";
import { MemoryStore } from "../src/storage/memory";

const ctx: EntryContext = {
  regime: { label: "range", trend: 0, trendStrength: 15, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 2 },
  confidence: 0.7,
  expectedEdgeBps: 40,
  costBps: 10,
  params: { stopAtr: 1.5 },
  features: {},
  riskMultiplier: 1,
  reason: "test",
};

function openInput(over: Partial<OpenTradeInput> = {}): OpenTradeInput {
  return {
    mode: "paper",
    symbol: "BTC/USDT",
    venue: "paper",
    assetClass: "crypto",
    strategyId: "scalp_a",
    horizon: "scalp",
    direction: "long",
    qty: 2,
    entryTs: 1_000,
    entryPrice: 100,
    intendedEntryPrice: 99.9,
    initialStop: 98,
    takeProfit: 104,
    entryContext: ctx,
    ...over,
  };
}

describe("TradeJournal", () => {
  it("ロング: 損益・R・MFE/MAE", () => {
    const j = new TradeJournal();
    const p = j.open(openInput({ entryFees: 0.1 }));
    expect(j.mark("BTC/USDT", 103, 2_000)).toBe(1);
    j.mark("BTC/USDT", 99, 3_000);
    j.mark("BTC/USDT", 101, 4_000);
    expect(j.mark("ETH/USDT", 50, 4_000)).toBe(0);
    const t = j.close({ id: p.id, exitPrice: 102, intendedExitPrice: 102.1, exitTs: 5_000, exitReason: "signal", fees: 0.1 });
    expect(t.grossPnl).toBe(4); // (102 - 100) * 2
    expect(t.fees).toBe(0.2);
    expect(t.netPnl).toBe(3.8);
    expect(t.returnPct).toBe(0.019); // 3.8 / 200
    expect(t.rMultiple).toBe(0.95); // 3.8 / ((100 - 98) * 2)
    expect(t.mfePct).toBe(0.03);
    expect(t.maePct).toBe(0.01);
    expect(t.intendedEntryPrice).toBe(99.9);
    expect(t.intendedExitPrice).toBe(102.1);
    expect(t.exitReason).toBe("signal");
    expect(t.takeProfit).toBe(104);
    expect(t.postExitMovePct).toBeUndefined();
    expect(j.list()).toHaveLength(0);
  });

  it("ショート: 損益・R・MFE/MAE (決済価格も高値・安値に含む)", () => {
    const j = new TradeJournal();
    const p = j.open(openInput({ direction: "short", qty: 1, initialStop: 101, takeProfit: undefined }));
    j.mark("BTC/USDT", 99.5, 2_000);
    j.mark("BTC/USDT", 100.6, 3_000);
    const t = j.close({ id: p.id, exitPrice: 99, exitTs: 4_000, exitReason: "take_profit" });
    expect(t.grossPnl).toBe(1);
    expect(t.netPnl).toBe(1);
    expect(t.rMultiple).toBe(1);
    expect(t.mfePct).toBe(0.01); // 100 → 99
    expect(t.maePct).toBeCloseTo(0.006, 12);
    expect(t.intendedExitPrice).toBe(99); // 省略時は exitPrice
    expect("takeProfit" in t).toBe(false);
  });

  it("ショートの損失", () => {
    const j = new TradeJournal();
    const p = j.open(openInput({ direction: "short", qty: 3, initialStop: 102 }));
    const t = j.close({ id: p.id, exitPrice: 102, exitTs: 2_000, exitReason: "stop", fees: 0.3 });
    expect(t.grossPnl).toBe(-6);
    expect(t.netPnl).toBe(-6.3);
    expect(t.rMultiple).toBe(-1.05);
    expect(t.maePct).toBe(0.02);
    expect(t.mfePct).toBe(0);
  });

  it("decimal で浮動小数点誤差を避ける・契約サイズ", () => {
    const j = new TradeJournal();
    const p = j.open(openInput({ entryPrice: 0.1, intendedEntryPrice: 0.1, initialStop: 0.05, qty: 3 }));
    const t = j.close({ id: p.id, exitPrice: 0.3, exitTs: 2_000, exitReason: "take_profit" });
    expect(t.grossPnl).toBe(0.6); // 浮動小数点だと 0.6000000000000001
    const q = j.open(openInput({ symbol: "USD/JPY", entryPrice: 150, intendedEntryPrice: 150, initialStop: 149.5, qty: 1, contractSize: 1000 }));
    const fx = j.close({ id: q.id, exitPrice: 150.25, exitTs: 3_000, exitReason: "signal" });
    expect(fx.grossPnl).toBe(250);
    expect(fx.rMultiple).toBe(0.5);
  });

  it("ストップ幅 0 なら R は 0、異常入力は例外", () => {
    const j = new TradeJournal();
    const p = j.open(openInput({ initialStop: 100 }));
    expect(j.close({ id: p.id, exitPrice: 101, exitTs: 2, exitReason: "manual" }).rMultiple).toBe(0);
    expect(() => j.open(openInput({ qty: 0 }))).toThrow();
    expect(() => j.close({ id: "none", exitPrice: 1, exitTs: 1, exitReason: "manual" })).toThrow();
    j.open(openInput({ id: "dup" }));
    expect(() => j.open(openInput({ id: "dup" }))).toThrow();
  });

  it("store 連携: 保有中は kv に保存して復元、close で saveTrade", () => {
    const store = new MemoryStore();
    const j1 = new TradeJournal({ store });
    const p = j1.open(openInput({ id: "pos1" }));
    j1.mark("BTC/USDT", 105, 2_000);
    const j2 = new TradeJournal({ store });
    expect(j2.get("pos1")?.highWater).toBe(105);
    expect(j2.find("BTC/USDT", "scalp_a")?.id).toBe("pos1");
    const t = j2.close({ id: p.id, exitPrice: 104, exitTs: 3_000, exitReason: "trailing" });
    expect(t.mfePct).toBe(0.05);
    expect(store.listTrades().map((x) => x.id)).toEqual(["pos1"]);
    expect(new TradeJournal({ store }).list()).toEqual([]);
  });
});

describe("TradeJournal.reduce (一部決済)", () => {
  it("一部決済は TradeRecord を作らずに累計し、最後の全量決済で元の数量・加重平均の決済価格・合計損益の 1 件にする", () => {
    const store = new MemoryStore();
    const j = new TradeJournal({ store });
    const p = j.open(openInput({ id: "r1", qty: 3, entryFees: 0.3 }));
    j.mark("BTC/USDT", 103, 2_000);
    const r1 = j.reduce(p.id, { qty: 1, exitPrice: 102, intendedExitPrice: 101, exitTs: 3_000, exitReason: "stop", fees: 0.1 });
    expect(r1.kind).toBe("reduced");
    if (r1.kind !== "reduced") throw new Error("unreachable");
    expect(r1.position).toMatchObject({ qty: 2, entryFees: 0.3, partials: 1, exitedQty: "1", realizedGross: "2", exitFees: "0.1" });
    expect(store.listTrades()).toEqual([]); // 一部決済では保存しない
    // 再起動しても累計は残る
    const j2 = new TradeJournal({ store });
    expect(j2.get("r1")).toMatchObject({ qty: 2, exitedQty: "1", exitNotional: "102" });
    // 残りの全量を決済すると元の id・元の数量で 1 件
    const r2 = j2.reduce(p.id, { qty: 2, exitPrice: 104, exitTs: 4_000, exitReason: "stop" });
    expect(r2.kind).toBe("closed");
    if (r2.kind !== "closed") throw new Error("unreachable");
    const t = r2.trade;
    expect(t.id).toBe("r1");
    expect(t.qty).toBe(3);
    expect(t.exitPrice).toBeCloseTo(310 / 3, 12); // (1 × 102 + 2 × 104) / 3
    expect(t.intendedExitPrice).toBeCloseTo((101 + 2 * 104) / 3, 12);
    expect(t.grossPnl).toBe(10); // 1 × 2 + 2 × 4
    expect(t.fees).toBe(0.4); // エントリー 0.3 + 一部決済 0.1
    expect(t.netPnl).toBe(9.6);
    expect(t.rMultiple).toBeCloseTo(9.6 / (2 * 3), 12); // 当初リスク = (100 - 98) × 元の数量 3
    expect(t.returnPct).toBeCloseTo(9.6 / 300, 12);
    expect(t.mfePct).toBeCloseTo(0.04, 12);
    expect(t.estimated).toBeUndefined();
    expect(j2.list()).toHaveLength(0);
    expect(store.listTrades().map((x) => x.id)).toEqual(["r1"]);
  });

  it("一部決済の後の close も合算し、推定 (estimated) の印は最後の TradeRecord に残る", () => {
    const j = new TradeJournal();
    const p = j.open(openInput({ id: "r2", qty: 2, direction: "short", entryPrice: 100, initialStop: 102 }));
    j.reduce(p.id, { qty: 0.5, exitPrice: 99, exitTs: 2_000, exitReason: "stop", estimated: true });
    const t = j.close({ id: p.id, exitPrice: 98, exitTs: 3_000, exitReason: "stop" });
    expect(t.qty).toBe(2);
    expect(t.grossPnl).toBe(0.5 + 1.5 * 2); // ショート: (100 - 99) × 0.5 + (100 - 98) × 1.5
    expect(t.exitPrice).toBeCloseTo((0.5 * 99 + 1.5 * 98) / 2, 12);
    expect(t.estimated).toBe(true);
  });

  it("異常な数量・価格は例外", () => {
    const j = new TradeJournal();
    const p = j.open(openInput({ qty: 2 }));
    expect(() => j.reduce(p.id, { qty: 0, exitPrice: 100, exitTs: 1, exitReason: "stop" })).toThrow();
    expect(() => j.reduce(p.id, { qty: 1, exitPrice: 0, exitTs: 1, exitReason: "stop" })).toThrow();
    expect(() => j.close({ id: p.id, exitPrice: Number.NaN, exitTs: 1, exitReason: "stop" })).toThrow();
    expect(() => j.reduce("none", { qty: 1, exitPrice: 100, exitTs: 1, exitReason: "stop" })).toThrow();
  });
});

describe("TradeJournal の mode 別の保存", () => {
  it("paper と live は別のキーに保存し、互いに読み込まない", () => {
    const store = new MemoryStore();
    new TradeJournal({ store, mode: "paper" }).open(openInput({ id: "p1" }));
    const live = new TradeJournal({ store, mode: "live" });
    expect(live.list()).toEqual([]);
    expect(() => live.open(openInput({ id: "x", mode: "paper" }))).toThrow(/mode/);
    live.open(openInput({ id: "l1", mode: "live" }));
    expect(new TradeJournal({ store, mode: "paper" }).list().map((p) => p.id)).toEqual(["p1"]);
    expect(new TradeJournal({ store, mode: "live" }).list().map((p) => p.id)).toEqual(["l1"]);
    expect(store.kvGet("journal:open:paper")).toHaveLength(1);
    expect(store.kvGet("journal:open:live")).toHaveLength(1);
  });

  it("旧キー (mode なし) は paper として引き継ぎ、live では読まない。旧キー中の live のポジションは paper に混ぜない", () => {
    const store = new MemoryStore();
    const old = new TradeJournal();
    const a = old.open(openInput({ id: "legacy-paper" }));
    const b = old.open(openInput({ id: "legacy-live", symbol: "ETH/USDT", mode: "live" }));
    store.kvSet("journal:open", [old.get(a.id), old.get(b.id)]);
    expect(new TradeJournal({ store, mode: "live" }).list()).toEqual([]);
    expect(new TradeJournal({ store, mode: "paper" }).list().map((p) => p.id)).toEqual(["legacy-paper"]);
    expect(new TradeJournal({ store }).list().map((p) => p.id)).toEqual(["legacy-paper"]);
  });
});

function closed(id: string, over: Partial<TradeRecord>): TradeRecord {
  const j = new TradeJournal();
  const p = j.open(openInput({ id, ...over }));
  return { ...j.close({ id: p.id, exitPrice: 100, exitTs: 10_000, exitReason: "stop" }), ...over };
}

describe("fillPostExitMoves", () => {
  it("エグジット後の値動きを方向付きで埋める", () => {
    const store = new MemoryStore();
    store.saveTrade(closed("long1", { direction: "long", exitPrice: 100, exitTs: 10_000 }));
    store.saveTrade(closed("short1", { direction: "short", exitPrice: 100, exitTs: 10_000, initialStop: 102 }));
    store.saveTrade(closed("noprice", { symbol: "ETH/USDT", exitPrice: 100, exitTs: 10_000 }));
    store.saveTrade(closed("done", { exitPrice: 100, exitTs: 10_000, postExitMovePct: 0.5 }));
    store.saveTrade(closed("recent", { exitPrice: 100, exitTs: 900_000 }));
    const asked: number[] = [];
    const priceAt = (symbol: string, ts: number) => {
      asked.push(ts);
      return symbol === "BTC/USDT" ? 102 : undefined;
    };
    const updated = fillPostExitMoves(store, priceAt, { scalp: 60_000 }, { now: 100_000 });
    expect(updated.map((t) => t.id).sort()).toEqual(["long1", "short1"]);
    expect(asked.every((ts) => ts === 70_000)).toBe(true);
    const byId = Object.fromEntries(store.listTrades().map((t) => [t.id, t]));
    expect(byId.long1.postExitMovePct).toBeCloseTo(0.02, 12);
    expect(byId.short1.postExitMovePct).toBeCloseTo(-0.02, 12);
    expect(byId.noprice.postExitMovePct).toBeUndefined();
    expect(byId.done.postExitMovePct).toBe(0.5);
    expect(byId.recent.postExitMovePct).toBeUndefined(); // horizon 未経過 (now 以降の決済)
    // 2 回目は何もしない
    expect(fillPostExitMoves(store, priceAt, { scalp: 60_000 }, { now: 100_000 })).toHaveLength(0);
  });
});
