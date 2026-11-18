import { describe, expect, it } from "vitest";
import type { RegimeLabel, Store, TradeRecord } from "../src/core/types";
import { attributeTrade } from "../src/learning/attribution";
import { computeReflectionStats, reflect } from "../src/learning/reflection";
import { MemoryStore } from "../src/storage/memory";

const DAY = 86_400_000;
const NOW = 200 * DAY;

let seq = 0;
function trade(strategyId: string, regime: RegimeLabel, r: number, ts: number, withIntel = false): TradeRecord {
  seq++;
  const exitPrice = 100 + 2 * r; // ストップ幅 2 なので R = 価格差 / 2
  const pnl = exitPrice - 100;
  return {
    id: `t${seq}`,
    mode: "paper",
    symbol: "BTC/USDT",
    venue: "paper",
    assetClass: "crypto",
    strategyId,
    horizon: "scalp",
    direction: "long",
    qty: 1,
    entryTs: ts,
    entryPrice: 100,
    intendedEntryPrice: 100,
    exitTs: ts + 60_000,
    exitPrice,
    intendedExitPrice: exitPrice,
    initialStop: 98,
    grossPnl: pnl,
    fees: 0,
    netPnl: pnl,
    returnPct: pnl / 100,
    rMultiple: r,
    mfePct: r > 0 ? pnl / 100 + 0.001 : 0.001,
    maePct: r > 0 ? 0.002 : -pnl / 100,
    exitReason: r > 0 ? "take_profit" : "signal",
    entryContext: {
      regime: { label: regime, trend: 0.5, trendStrength: 30, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
      ...(withIntel
        ? {
            intel: {
              asset: "BTC",
              sentiment: 0.8,
              confidence: 0.6,
              eventRisk: 0.1,
              sourceIds: ["n1", "n2"],
              sourceContrib: { "rss:x": 0.6, "fng:alt": -0.1 },
            },
          }
        : {}),
      confidence: 0.6,
      expectedEdgeBps: 40,
      costBps: 10,
      params: {},
      features: {},
      riskMultiplier: 1,
      reason: "t",
    },
  };
}

const regimes: Record<string, RegimeLabel[]> = { scalp_vwap_revert: ["range"], trend_follow: ["range", "trend_up"] };

function seed(store: Store) {
  for (let i = 0; i < 25; i++) {
    const t = trade("scalp_vwap_revert", "trend_up", -0.4, NOW - 3 * DAY + i * 3_600_000, true);
    store.saveTrade(t);
    store.saveAttribution(attributeTrade(t, { strategyRegimes: regimes }));
  }
  for (let i = 0; i < 12; i++) {
    const t = trade("trend_follow", "range", 0.8, NOW - 2 * DAY + i * 3_600_000);
    store.saveTrade(t);
    store.saveAttribution(attributeTrade(t, { strategyRegimes: regimes }));
  }
  // 古いトレード (対象期間外)
  store.saveTrade(trade("trend_follow", "range", -1, NOW - 30 * DAY));
  store.saveIntel([
    { id: "n1", source: "rss:x", kind: "news", title: "BTC 急騰の見通し", publishedAt: NOW - 4 * DAY, fetchedAt: NOW - 4 * DAY, assets: ["BTC"] },
    { id: "n2", source: "fng:alt", kind: "metric", title: "Fear & Greed 72", publishedAt: NOW - 4 * DAY, fetchedAt: NOW - 4 * DAY, assets: ["BTC"] },
  ]);
}

describe("reflect (ルールベース)", () => {
  it("戦略×レジーム×資産クラスで集計し、教訓を保存する", async () => {
    const store = new MemoryStore();
    seed(store);
    const res = await reflect({ store, now: NOW, windowMs: 7 * DAY, strategyRegimes: regimes, ai: { apiKey: "", model: "x" } });
    expect(res.origin).toBe("rule");
    expect(res.proposals).toEqual([]);
    expect(res.stats.total.n).toBe(37);

    const g = res.stats.groups.find((x) => x.key === "scalp_vwap_revert|trend_up|crypto")!;
    expect(g).toMatchObject({ n: 25, wins: 0, losses: 25, winRate: 0 });
    expect(g.avgR).toBeCloseTo(-0.4, 10);
    expect(g.causes.wrong_direction).toBe(25);
    expect(g.causes.regime_mismatch).toBe(25);
    expect(res.stats.misledSources).toEqual({ "rss:x": 25 });

    const texts = res.lessons.map((l) => `${l.scope} ${l.text}`);
    expect(texts).toContain(
      "strategy:scalp_vwap_revert scalp_vwap_revert は trend_up (crypto) で 25 件 平均 −0.40R → このレジームでは停止推奨",
    );
    expect(texts.some((t) => t.startsWith("strategy:trend_follow trend_follow は range (crypto) で 12 件 平均 +0.80R と好調"))).toBe(true);
    expect(texts.some((t) => t.startsWith("strategy:scalp_vwap_revert scalp_vwap_revert の損失 25 件中 25 件"))).toBe(true);
    expect(res.lessons.some((l) => l.scope === "source:rss:x")).toBe(true);
    expect(res.lessons.some((l) => l.scope === "global" && l.text.includes("37 件"))).toBe(true);
    for (const l of res.lessons) {
      expect(l).toMatchObject({ origin: "rule", status: "active", createdAt: NOW });
      expect(l.evidence.length).toBeGreaterThan(0);
    }
    expect(store.listLessons({ status: "active" })).toHaveLength(res.lessons.length);
    expect(store.listAudit({ type: "learning.reflect" })).toHaveLength(1);
  });

  it("損失上位トレードにエントリー時に参照した情報の見出しを添える", () => {
    const store = new MemoryStore();
    seed(store);
    const stats = computeReflectionStats({ store, now: NOW, windowMs: 7 * DAY, strategyRegimes: regimes });
    expect(stats.lossSamples).toHaveLength(5);
    expect(stats.lossSamples[0].intel?.headlines).toEqual(["BTC 急騰の見通し", "Fear & Greed 72"]);
    expect(stats.lossSamples[0].causes.some((c) => c.startsWith("wrong_direction"))).toBe(true);
  });

  it("再実行すると同じ scope の古い教訓は retired になる", async () => {
    const store = new MemoryStore();
    seed(store);
    const first = await reflect({ store, now: NOW, windowMs: 7 * DAY, strategyRegimes: regimes });
    const second = await reflect({ store, now: NOW + DAY, windowMs: 7 * DAY, strategyRegimes: regimes });
    const active = store.listLessons({ status: "active" });
    expect(active.map((l) => l.id).sort()).toEqual(second.lessons.map((l) => l.id).sort());
    expect(store.listLessons({ status: "retired" })).toHaveLength(first.lessons.length);
  });

  it("期間内にトレードが無ければ何もしない", async () => {
    const store = new MemoryStore();
    seed(store);
    const res = await reflect({ store, now: NOW + 100 * DAY, windowMs: DAY });
    expect(res.origin).toBe("none");
    expect(res.lessons).toEqual([]);
    expect(store.listLessons()).toEqual([]);
  });
});
