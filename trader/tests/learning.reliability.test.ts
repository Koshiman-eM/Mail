import { describe, expect, it } from "vitest";
import type { AssetClass, IntelBias, TradeRecord } from "../src/core/types";
import { SOURCE_RELIABILITY_KV_KEY, SourceReliabilityTracker } from "../src/learning/reliability";
import { MemoryStore } from "../src/storage/memory";

let seq = 0;
/** move: 価格変化率 (エントリー比)。direction に応じて損益の符号が決まる */
function trade(opts: {
  direction?: "long" | "short";
  move: number;
  contrib?: Record<string, number>;
  sentiment?: number;
  r?: number;
  postExit?: number;
  assetClass?: AssetClass;
  noIntel?: boolean;
}): TradeRecord {
  seq++;
  const direction = opts.direction ?? "long";
  const dir = direction === "long" ? 1 : -1;
  const exitPrice = 100 * (1 + opts.move);
  const gross = dir * (exitPrice - 100);
  const intel: IntelBias = {
    asset: "BTC",
    sentiment: opts.sentiment ?? 0.5,
    confidence: 0.6,
    eventRisk: 0,
    sourceIds: [],
    sourceContrib: opts.contrib ?? {},
  };
  return {
    id: `t${seq}`,
    mode: "paper",
    symbol: "BTC/USDT",
    venue: "paper",
    assetClass: opts.assetClass ?? "crypto",
    strategyId: "s1",
    horizon: "short",
    direction,
    qty: 1,
    entryTs: seq * 1000,
    entryPrice: 100,
    intendedEntryPrice: 100,
    exitTs: seq * 1000 + 500,
    exitPrice,
    intendedExitPrice: exitPrice,
    initialStop: 100 - dir * 2,
    grossPnl: gross,
    fees: 0,
    netPnl: gross,
    returnPct: gross / 100,
    rMultiple: opts.r ?? gross / 2,
    mfePct: 0.01,
    maePct: 0.01,
    exitReason: "signal",
    ...(opts.postExit !== undefined ? { postExitMovePct: opts.postExit } : {}),
    entryContext: {
      regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
      ...(opts.noIntel ? {} : { intel }),
      confidence: 0.5,
      expectedEdgeBps: 30,
      costBps: 5,
      params: {},
      features: {},
      riskMultiplier: 1,
      reason: "t",
    },
  };
}

describe("SourceReliabilityTracker", () => {
  it("的中が続く情報源の weight は上がり、外れが続く情報源は下がる", () => {
    const store = new MemoryStore();
    const tr = new SourceReliabilityTracker(store);
    expect(tr.weight("good")).toBe(1);
    // 価格は上昇。good は強気 (的中)、bad は弱気 (外れ)
    tr.update(trade({ move: 0.01, contrib: { good: 0.5, bad: -0.5 } }));
    const w1 = tr.weight("good");
    expect(w1).toBeGreaterThan(1);
    expect(w1).toBeLessThan(1.3); // 1 件だけなら 1 に寄せる (縮小推定)
    for (let i = 0; i < 19; i++) tr.update(trade({ move: 0.01, contrib: { good: 0.5, bad: -0.5 } }));
    expect(tr.weight("good")).toBeGreaterThan(1.7);
    expect(tr.weight("good")).toBeLessThanOrEqual(2);
    expect(tr.weight("bad")).toBeLessThan(0.3);
    expect(tr.weight("bad")).toBeGreaterThanOrEqual(0.2);
    expect(tr.get("good")).toMatchObject({ source: "good", n: 20, hits: 20 });
    expect(tr.get("bad")).toMatchObject({ n: 20, hits: 0 });
    expect(SOURCE_RELIABILITY_KV_KEY).toBe("intel:sourceReliability");

    // 外れが続くと下がる
    for (let i = 0; i < 15; i++) tr.update(trade({ move: -0.01, contrib: { good: 0.5 } }));
    expect(tr.weight("good")).toBeLessThan(1);

    // 情報収集側が読む集約キーに全体が書かれている
    expect(store.kvGet(SOURCE_RELIABILITY_KV_KEY)).toEqual(tr.all());
    // 永続化: 新しいインスタンスでも同じ
    const tr2 = new SourceReliabilityTracker(store);
    expect(tr2.all()).toEqual(tr.all());
    expect(Object.keys(tr2.all()).sort()).toEqual(["bad", "good"]);
  });

  it("ショートの勝ち = 下落 → 弱気の情報源が的中", () => {
    const tr = new SourceReliabilityTracker(new MemoryStore());
    tr.update(trade({ direction: "short", move: -0.02, contrib: { bear: -0.7, bull: 0.7 } }));
    expect(tr.get("bear")!.hits).toBe(1);
    expect(tr.get("bull")!.hits).toBe(0);
  });

  it("小さい寄与・方向不明・情報なしは判定しない。postExitMovePct を加味する", () => {
    const tr = new SourceReliabilityTracker(new MemoryStore());
    expect(tr.update(trade({ move: 0.01, contrib: { tiny: 0.01 } }))).toEqual([]);
    expect(tr.update(trade({ move: 0, contrib: { x: 0.5 } }))).toEqual([]);
    expect(tr.update(trade({ move: 0.01, contrib: { x: 0.5 }, noIntel: true }))).toEqual([]);
    expect(tr.get("x")).toBeUndefined();
    // ほぼ同値で決済したが、その後 2% 上昇 → 強気が的中
    expect(tr.update(trade({ move: 0, contrib: { x: 0.5 }, postExit: 0.02 }))).toEqual(["x"]);
    expect(tr.get("x")!.hits).toBe(1);
    // ロングで小さく勝ったがその後大きく下落 → 下落と判定
    tr.update(trade({ move: 0.001, contrib: { y: 0.5 }, postExit: -0.02 }));
    expect(tr.get("y")!.hits).toBe(0);
  });

  it("intelInfluence: 情報に沿ったトレードの R が良ければ 1 超、逆なら 1 未満 (既定 1)", () => {
    const store = new MemoryStore();
    const tr = new SourceReliabilityTracker(store);
    expect(tr.intelInfluence("crypto")).toBe(1);
    for (let i = 0; i < 40; i++) {
      const aligned = i % 2 === 0;
      // crypto: 情報と同じ向きに入ると勝ち、逆向きだと負け
      tr.update(trade({ sentiment: aligned ? 0.6 : -0.6, r: aligned ? 1 : -1, move: 0.01 }));
      // meme: 情報に沿うと負ける
      tr.update(trade({ assetClass: "meme", sentiment: aligned ? 0.6 : -0.6, r: aligned ? -1 : 1, move: 0.01 }));
    }
    expect(tr.intelInfluence("crypto")).toBeGreaterThan(1.4);
    expect(tr.intelInfluence("crypto")).toBeLessThanOrEqual(1.5);
    expect(tr.intelInfluence("meme")).toBeLessThan(0.6);
    expect(tr.intelInfluence("meme")).toBeGreaterThanOrEqual(0);
    expect(tr.intelInfluence("fx")).toBe(1);
    expect(store.kvGet("intelInfluence:crypto")).toMatchObject({ n: 40 });
    expect(new SourceReliabilityTracker(store).intelInfluence("crypto")).toBe(tr.intelInfluence("crypto"));
  });
});
