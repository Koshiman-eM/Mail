/**
 * 発注前の見積もりのコスト (MarketExtras.entryQuoteCost) と RiskManager.recheckEdge。
 * evaluateEntry が承認した後に、承認された数量・向きの見積もりのコストで同じ期待値の規則をもう一度確かめる (オフライン・合成フィード)
 */
import { describe, expect, it } from "vitest";
import type { AuditEvent, Instrument, Quote, RiskLimits, Side, Signal, Store, Strategy, StrategyContext } from "../src/core/types";
import type { EntryQuoteCost } from "../src/engine/engine";
import { defaultSyntheticSpecs, mulberry32 } from "../src/market/feeds/synthetic";
import { RiskManager, type EntryParams } from "../src/risk/manager";
import { buildTestRuntime, coreDefaultRisk, testConfig } from "../src/testing/runtime";

const MIN = 60_000;
const START = Date.UTC(2026, 0, 5);
const BTC = defaultSyntheticSpecs().filter((s) => s.instrument.symbol === "BTC/USDT");

describe("RiskManager.recheckEdge", () => {
  const NOW = Date.parse("2025-03-01T12:00:00Z");
  const limits: RiskLimits = { ...coreDefaultRisk(), riskPerTrade: 0.01, maxPositionPct: 0.5, minEdgeToCostRatio: 2, maxOpenPositions: 2 };
  const btc: Instrument = { symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "USDT", tickSize: 0.01, lotSize: 0.001, minQty: 0.001, takerFeeRate: 0.001, makerFeeRate: 0.0005, allowShort: false };
  const sig = (o: Partial<Signal> = {}): Signal => ({
    strategyId: "s", horizon: "short", symbol: "BTC/USDT", direction: "long", confidence: 1, expectedEdgeBps: 100,
    entry: { type: "market" }, stopLoss: 99, maxHoldMs: 1000, reason: "", features: {}, ...o,
  });
  const params = (o: Partial<EntryParams> = {}): EntryParams => ({
    signal: sig(), instrument: btc, quote: { ts: NOW, bid: 99.99, ask: 100.01 }, equity: 10_000, available: 10_000, positions: [], riskMultiplier: 1, now: NOW, ...o,
  });
  const mem = () => {
    const kv = new Map<string, unknown>();
    const audits: AuditEvent[] = [];
    const store = { kvGet: (k: string) => kv.get(k), kvSet: (k: string, v: unknown) => void kv.set(k, structuredClone(v)), audit: (e: AuditEvent) => void audits.push(e) } as unknown as Store;
    return { store, audits };
  };

  it("同じ規則 (期待値 ≥ 比率 × コスト) で判定し、満たさなければ risk.reject を残す。理由は `<期待値>bps < コスト <コスト>bps` を含む", () => {
    const { store, audits } = mem();
    const rm = new RiskManager(limits, store, "k");
    const p = params();
    expect(rm.evaluateEntry(p).ok).toBe(true); // 気配のコスト 22bps × 2 ≤ 100
    expect(rm.recheckEdge(p, 40)).toMatchObject({ ok: true, note: expect.stringContaining("実際の見積もり") });
    const r = rm.recheckEdge(p, 80);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("実際の見積もりのコスト 80.0bps で 期待値幅 100.0bps < コスト 80.0bps × 2");
      expect(/([\d.]+)bps < コスト ([\d.]+)bps/.exec(r.reason)?.slice(1)).toEqual(["100.0", "80.0"]);
    }
    expect(audits.filter((a) => a.type === "risk.reject").map((a) => a.data.reason)).toEqual([r.ok ? "" : r.reason]);
  });

  it("コスト控除後の期待値・テンポの規則もそのまま。不正なコストは拒否", () => {
    const rm = new RiskManager(limits);
    // 純期待値: 純 ≥ (2 − 1) × コスト
    expect(rm.recheckEdge(params({ signal: sig({ edgeIsNet: true, expectedEdgeBps: 50 }) }), 49).ok).toBe(true);
    expect(rm.recheckEdge(params({ signal: sig({ edgeIsNet: true, expectedEdgeBps: 50 }) }), 51).ok).toBe(false);
    // テンポ 1 (比率は下限 1 まで緩む): 100 ≥ 1 × 90
    expect(rm.recheckEdge(params({ tempo: 1 }), 90).ok).toBe(true);
    expect(rm.recheckEdge(params(), 90).ok).toBe(false);
    for (const c of [NaN, -1, Infinity]) expect(rm.recheckEdge(params(), c).ok).toBe(false);
  });
});

/** 保有していなければ常に買う (期待値幅 200bps) */
function alwaysLong(id: string): Strategy {
  return {
    id, horizon: "scalp", assetClasses: ["crypto"], regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    primaryTimeframe: "1m", timeframes: ["1m", "1h"], warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.position) return null;
      const px = ctx.market.quote.ask;
      return {
        strategyId: id, horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: "long", confidence: 0.8, expectedEdgeBps: 200,
        entry: { type: "market" }, stopLoss: px * 0.98, maxHoldMs: 30 * MIN, reason: `test ${id}`, features: {},
      };
    },
  };
}

type Hook = (inst: Instrument, side: Side, qty: string, q: Quote) => Promise<EntryQuoteCost | undefined>;

async function run(hook: Hook | undefined, minutes = 3) {
  const calls: { symbol: string; side: Side; qty: string }[] = [];
  const wrapped: Hook | undefined = hook
    ? async (inst, side, qty, q) => {
        calls.push({ symbol: inst.symbol, side, qty });
        return hook(inst, side, qty, q);
      }
    : undefined;
  const { runtime, clock, store } = await buildTestRuntime({
    config: testConfig({ LIMIT_ENTRY: "false", LIMIT_TAKE_PROFIT: "false", BASE_CURRENCY: "JPY", TARGET_ENTRIES_PER_HOUR: "0" }),
    specs: BTC, seed: 3, start: START,
    ...(wrapped ? { assembly: { marketExtras: { venues: ["paper"], liquidityUsd: () => undefined, entryQuoteCost: wrapped } } } : {}),
    opts: { rng: mulberry32(7), strategies: [alwaysLong("q")] },
  });
  let entries = 0;
  for (let now = START; now <= START + minutes * MIN; now += 15_000) {
    clock.t = now;
    entries += (await runtime.engine.tick(now)).entries;
  }
  const skips: Record<string, number> = {};
  await runtime.engine.stop();
  for (const a of store.listAudit({ type: "engine.skip_summary" })) {
    for (const [k, v] of Object.entries((a.data as { reasons: Record<string, { count: number }> }).reasons)) skips[k] = (skips[k] ?? 0) + v.count;
  }
  return { runtime, store, entries, calls, skips };
}

describe("エンジン: 発注前の見積もりのコスト (MarketExtras.entryQuoteCost)", () => {
  it("フックが無い取引先は従来どおり (承認時のコストで発注)", async () => {
    const { entries, store } = await run(undefined);
    expect(entries).toBeGreaterThanOrEqual(1);
    expect(store.listAudit({ type: "risk.reject" }).some((a) => String(a.data.reason).includes("実際の見積もり"))).toBe(false);
  });

  it("見積もりのコストが安ければ発注し、そのコストを entryContext.costBps に記録する (承認 1 件につき呼び出し 1 回)", async () => {
    const { entries, calls, store, runtime } = await run(async () => ({ costBps: 7.5, source: "quote" }));
    expect(entries).toBeGreaterThanOrEqual(1);
    expect(calls).toHaveLength(entries);
    expect(calls.every((c) => c.side === "buy" && Number(c.qty) > 0)).toBe(true);
    const audit = store.listAudit({ type: "engine.entry" });
    expect(audit.length).toBe(entries);
    expect(audit.every((a) => a.data.costBps === 7.5)).toBe(true);
    const pos = runtime.engine.journal.list();
    expect(pos.every((p) => p.entryContext.costBps === 7.5)).toBe(true);
  });

  it("見積もりのコストで期待値が足りなければ発注せず、risk.reject・仮想トレード・見送りの集計に残す", async () => {
    const { entries, calls, store, runtime, skips } = await run(async () => ({ costBps: 150, source: "quote" }));
    expect(entries).toBe(0);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const rej = store.listAudit({ type: "risk.reject" }).map((a) => String(a.data.reason));
    expect(rej).toContain("実際の見積もりのコスト 150.0bps で 期待値幅 200.0bps < コスト 150.0bps × 2");
    expect(Object.keys(skips).some((k) => k.startsWith("risk: 実際の見積もりのコスト"))).toBe(true);
    expect([...runtime.engine.shadow!.list(), ...store.listShadowTrades()].some((t) => t.reason.startsWith("risk: 実際の見積もりのコスト"))).toBe(true);
  });

  it("unavailable・例外は見送り (fail closed)。undefined は承認時のコストのまま発注する", async () => {
    const un = await run(async () => ({ unavailable: "見積もりが取れないため見送り" }));
    expect(un.entries).toBe(0);
    expect(un.store.listAudit({ type: "risk.reject" }).map((a) => a.data.reason)).toContain("見積もりが取れないため見送り");
    expect(un.skips["risk: 見積もりが取れないため見送り"]).toBeGreaterThanOrEqual(1);
    const thrown = await run(async () => {
      throw new Error("boom");
    });
    expect(thrown.entries).toBe(0);
    const pass = await run(async () => undefined);
    expect(pass.entries).toBeGreaterThanOrEqual(1);
    expect(pass.store.listAudit({ type: "engine.entry" }).every((a) => typeof a.data.costBps === "number" && a.data.costBps !== 7.5)).toBe(true);
  });
});
