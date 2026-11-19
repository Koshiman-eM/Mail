import { describe, expect, it } from "vitest";
import type { AssetClass, Params, Store, TradeRecord } from "../src/core/types";
import { attributeTrade } from "../src/learning/attribution";
import { ParamTuner, type ParamValidator, type StrategyParamInfo } from "../src/learning/tuner";
import { MemoryStore } from "../src/storage/memory";

const DAY = 86_400_000;
const NOW = 100 * DAY;

const INFO: StrategyParamInfo = {
  defaultParams: { stopAtr: 1.5, tpAtr: 2, trailAtr: 0, entryThreshold: 0.5, maxHoldBars: 10, lookback: 20 },
  paramBounds: {
    stopAtr: [1, 1.6],
    tpAtr: [1, 4],
    trailAtr: [0, 3],
    entryThreshold: [0.1, 1],
    maxHoldBars: [3, 30],
  },
};
const getStrategy = (id: string) => (id === "s1" ? INFO : undefined);

type Kind = "stop_too_tight" | "time_decay" | "good";
let seq = 0;
/** 要因の種類ごとのトレード (ロング 100、ストップ 98) */
function trade(kind: Kind, entryTs: number, r?: number, assetClass: AssetClass = "crypto"): TradeRecord {
  seq++;
  const base = {
    id: `t${seq}`,
    mode: "paper" as const,
    symbol: "BTC/USDT",
    venue: "paper",
    assetClass,
    strategyId: "s1",
    horizon: "scalp" as const,
    direction: "long" as const,
    qty: 1,
    entryTs,
    entryPrice: 100,
    intendedEntryPrice: 100,
    exitTs: entryTs + 60_000,
    initialStop: 98,
    fees: 0,
    maePct: 0.02,
    entryContext: {
      regime: { label: "range" as const, trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
      confidence: 0.5,
      expectedEdgeBps: 30,
      costBps: 10,
      params: {},
      features: {},
      riskMultiplier: 1,
      reason: "t",
    },
  };
  if (kind === "stop_too_tight") {
    // ストップで刈られた後に 2.5% 戻った
    return { ...base, exitPrice: 98, intendedExitPrice: 98, grossPnl: -2, netPnl: -2, returnPct: -0.02, rMultiple: r ?? -1, mfePct: 0.006, exitReason: "stop", postExitMovePct: 0.025 };
  }
  if (kind === "time_decay") {
    return { ...base, exitPrice: 100.2, intendedExitPrice: 100.2, grossPnl: 0.2, netPnl: 0.2, returnPct: 0.002, rMultiple: r ?? 0.1, mfePct: 0.004, exitReason: "time" };
  }
  return { ...base, exitPrice: 103, intendedExitPrice: 103, grossPnl: 3, netPnl: 3, returnPct: 0.03, rMultiple: r ?? 1.5, mfePct: 0.031, exitReason: "take_profit" };
}

function seed(store: Store, kinds: Kind[], startTs = NOW - 10 * DAY, r?: number, assetClass: AssetClass = "crypto") {
  kinds.forEach((k, i) => {
    const t = trade(k, startTs + i * 3_600_000, r, assetClass);
    store.saveTrade(t);
    store.saveAttribution(attributeTrade(t));
  });
}

const many = (k: Kind, n: number) => Array.from({ length: n }, () => k);

/** stopAtr が大きいほど良いスコアを返す検証器 (1.5 → 1.6 で 1.0 → 1.2) */
const favorStop: ParamValidator = async (_s, _a, p: Params) => ({ score: 2 * p.stopAtr - 2, trades: 50 });

describe("ParamTuner", () => {
  it("サンプル不足なら何もしない", async () => {
    const store = new MemoryStore();
    seed(store, many("stop_too_tight", 19));
    const tuner = new ParamTuner({ store, getStrategy, validate: favorStop });
    expect(await tuner.run(NOW)).toEqual([]);
    expect(store.listAdjustments()).toEqual([]);
  });

  it("validator が改善を示せば applied (bounds でクランプ)、監査ログと現行パラメータを更新", async () => {
    const store = new MemoryStore();
    seed(store, many("stop_too_tight", 25));
    const tuner = new ParamTuner({ store, getStrategy, validate: favorStop });
    const [adj, ...rest] = await tuner.run(NOW);
    expect(rest).toEqual([]);
    expect(adj).toMatchObject({ strategyId: "s1", assetClass: "crypto", param: "stopAtr", from: 1.5, to: 1.6, status: "applied", createdAt: NOW });
    expect(adj.validation!.baselineScore).toBeCloseTo(1, 12);
    expect(adj.validation!.candidateScore).toBeCloseTo(1.2, 12);
    expect(adj.validation!.trades).toBe(50);
    expect(adj.reason).toContain("stop_too_tight");
    expect(tuner.currentParams("s1", "crypto", INFO.defaultParams)).toMatchObject({ stopAtr: 1.6, tpAtr: 2 });
    // 資産クラス単位のスコープ
    expect(tuner.currentParams("s1", "fx", INFO.defaultParams).stopAtr).toBe(1.5);
    expect(store.listAdjustments({ status: "applied" })).toHaveLength(1);
    expect(store.listAudit({ type: "learning.param_adjust" })).toHaveLength(1);
    // 評価待ちの間は再調整しない
    seed(store, many("stop_too_tight", 25), NOW + DAY);
    expect(await tuner.run(NOW + 3 * DAY)).toEqual([]);
  });

  it("上限に達していれば調整しない", async () => {
    const store = new MemoryStore();
    store.kvSet("params:paper:s1:crypto", { stopAtr: 1.6 });
    seed(store, many("stop_too_tight", 25));
    const tuner = new ParamTuner({ store, getStrategy, validate: favorStop });
    expect(await tuner.run(NOW)).toEqual([]);
  });

  it("改善が +5% 未満・取引数不足なら rejected でパラメータは変えない", async () => {
    const store = new MemoryStore();
    seed(store, many("stop_too_tight", 25));
    const small: ParamValidator = async (_s, _a, p) => ({ score: p.stopAtr === 1.5 ? 10 : 10.3, trades: 50 });
    const [adj] = await new ParamTuner({ store, getStrategy, validate: small }).run(NOW);
    expect(adj.status).toBe("rejected");
    expect(new ParamTuner({ store, getStrategy }).currentParams("s1", "crypto", INFO.defaultParams).stopAtr).toBe(1.5);

    const store2 = new MemoryStore();
    seed(store2, many("stop_too_tight", 25));
    const few: ParamValidator = async (_s, _a, p) => ({ score: 2 * p.stopAtr - 2, trades: 5 });
    expect((await new ParamTuner({ store: store2, getStrategy, validate: few }).run(NOW))[0].status).toBe("rejected");
  });

  it("validator なし / undefined を返す / 例外なら proposed のまま適用しない", async () => {
    for (const validate of [undefined, (async () => undefined) as ParamValidator, (async () => { throw new Error("bt failed"); }) as ParamValidator]) {
      const store = new MemoryStore();
      seed(store, many("stop_too_tight", 25));
      const tuner = new ParamTuner({ store, getStrategy, validate });
      const [adj] = await tuner.run(NOW);
      expect(adj.status).toBe("proposed");
      expect(adj.validation).toBeUndefined();
      expect(tuner.currentParams("s1", "crypto", INFO.defaultParams).stopAtr).toBe(1.5);
    }
  });

  it("1 回の調整は 1 パラメータずつ (最も多い要因から)", async () => {
    const store = new MemoryStore();
    seed(store, [...many("time_decay", 15), ...many("stop_too_tight", 10)]);
    const all: ParamValidator = async () => ({ score: 1, trades: 50 });
    const res = await new ParamTuner({ store, getStrategy, validate: all }).run(NOW);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ param: "maxHoldBars", from: 10, to: 9 });
  });

  it("適用後に成績が悪化したら reverted で元に戻す", async () => {
    const store = new MemoryStore();
    seed(store, many("stop_too_tight", 25), NOW - 10 * DAY, -0.2);
    const tuner = new ParamTuner({ store, getStrategy, validate: favorStop });
    const [adj] = await tuner.run(NOW);
    expect(adj.status).toBe("applied");
    // 適用後のトレードが少ないうちは評価しない
    seed(store, many("good", 10), NOW + DAY, -1);
    expect(tuner.reviewApplied(NOW + 5 * DAY)).toEqual([]);
    seed(store, many("good", 10), NOW + 2 * DAY, -1);
    const reverted = tuner.reviewApplied(NOW + 5 * DAY);
    expect(reverted).toHaveLength(1);
    expect(reverted[0]).toMatchObject({ id: adj.id, status: "reverted" });
    expect(store.listAdjustments({ status: "reverted" })).toHaveLength(1);
    expect(store.listAdjustments({ status: "applied" })).toHaveLength(0);
    expect(tuner.currentParams("s1", "crypto", INFO.defaultParams).stopAtr).toBe(1.5);
    expect(store.listAudit({ type: "learning.param_revert" })).toHaveLength(1);
    expect(tuner.reviewApplied(NOW + 6 * DAY)).toEqual([]);
  });

  it("適用後に悪化していなければ applied のまま (評価済みになり再評価しない)", async () => {
    const store = new MemoryStore();
    seed(store, many("stop_too_tight", 25), NOW - 10 * DAY, -0.5);
    const tuner = new ParamTuner({ store, getStrategy, validate: favorStop });
    const [adj] = await tuner.run(NOW);
    seed(store, many("good", 20), NOW + DAY, 0.8);
    expect(tuner.reviewApplied(NOW + 5 * DAY)).toEqual([]);
    expect(store.listAdjustments({ status: "applied" }).map((a) => a.id)).toEqual([adj.id]);
    expect(store.kvGet(`adjmeta:paper:${adj.id}`)).toMatchObject({ reviewed: true });
    expect(tuner.currentParams("s1", "crypto", INFO.defaultParams).stopAtr).toBe(1.6);
  });

  it("propose: 外部提案も同じ検証経路を通す。未知の戦略・上下限の無いパラメータは捨てる", async () => {
    const store = new MemoryStore();
    seed(store, many("good", 5));
    const v: ParamValidator = async (_s, _a, p) => ({ score: 10 - 3 * p.tpAtr, trades: 40 });
    const tuner = new ParamTuner({ store, getStrategy, validate: v });
    expect(await tuner.propose({ strategyId: "zzz", assetClass: "crypto", param: "tpAtr", direction: "down", reason: "x" }, NOW)).toBeUndefined();
    expect(await tuner.propose({ strategyId: "s1", assetClass: "crypto", param: "lookback", direction: "up", reason: "x" }, NOW)).toBeUndefined();
    const adj = await tuner.propose({ strategyId: "s1", assetClass: "crypto", param: "tpAtr", direction: "down", reason: "利確が遠すぎる" }, NOW);
    expect(adj).toMatchObject({ param: "tpAtr", from: 2, to: 1.8, status: "applied" });
    expect(adj!.reason).toContain("利確が遠すぎる");
    expect(tuner.currentParams("s1", "crypto", INFO.defaultParams).tpAtr).toBe(1.8);

    // 検証器なしなら proposed のまま
    const store2 = new MemoryStore();
    const t2 = new ParamTuner({ store: store2, getStrategy });
    const p2 = await t2.propose({ strategyId: "s1", assetClass: "fx", param: "entryThreshold", direction: "up", reason: "x" }, NOW);
    expect(p2?.status).toBe("proposed");
    expect(t2.currentParams("s1", "fx", INFO.defaultParams).entryThreshold).toBe(0.5);
  });

  it("run: 直近 7 日以内に同じ rejected / proposed があれば同じ案を作らない (7 日超なら再度作る)", async () => {
    const store = new MemoryStore();
    seed(store, many("stop_too_tight", 25));
    const reject: ParamValidator = async () => ({ score: 1, trades: 50 }); // 改善なし → rejected
    const tuner = new ParamTuner({ store, getStrategy, validate: reject });
    const [first] = await tuner.run(NOW);
    expect(first.status).toBe("rejected");
    // 調整後に同じ傾向のトレードがたまっても、同じ案は作らない
    seed(store, many("stop_too_tight", 25), NOW + 1000);
    const t2 = new ParamTuner({ store, getStrategy, validate: reject });
    expect(await t2.run(NOW + 2 * DAY)).toEqual([]);
    expect(await t2.run(NOW + 6 * DAY)).toEqual([]);
    expect(store.listAdjustments()).toHaveLength(1);
    // 7 日を超えたら再度記録してよい
    const again = await t2.run(NOW + 8 * DAY);
    expect(again).toHaveLength(1);
    expect(store.listAdjustments()).toHaveLength(2);
    // proposed (検証器なし) も同様
    const store2 = new MemoryStore();
    seed(store2, many("stop_too_tight", 25));
    const t3 = new ParamTuner({ store: store2, getStrategy });
    expect((await t3.run(NOW))[0].status).toBe("proposed");
    seed(store2, many("stop_too_tight", 25), NOW + 1000);
    expect(await t3.run(NOW + 2 * DAY)).toEqual([]);
  });

  it("propose: 直近 7 日以内に同じ proposed / rejected があれば作らない。applied や別の値は対象外", async () => {
    const store = new MemoryStore();
    seed(store, many("good", 5));
    const reject: ParamValidator = async () => ({ score: 1, trades: 50 });
    const tuner = new ParamTuner({ store, getStrategy, validate: reject });
    const req = { strategyId: "s1", assetClass: "crypto" as const, param: "tpAtr", direction: "down" as const, reason: "x" };
    expect((await tuner.propose(req, NOW))?.status).toBe("rejected");
    expect(await tuner.propose(req, NOW + DAY)).toBeUndefined();
    // 別の戦略パラメータ・別の資産クラスは対象外
    expect((await tuner.propose({ ...req, param: "entryThreshold", direction: "up" }, NOW + DAY))?.status).toBe("rejected");
    expect((await tuner.propose({ ...req, assetClass: "fx" }, NOW + DAY))?.status).toBe("rejected");
    // 7 日超なら再度作る
    expect((await tuner.propose(req, NOW + 8 * DAY))?.status).toBe("rejected");
    expect(store.listAdjustments()).toHaveLength(4);
    // applied は重複扱いにしない (現行値が変わるので同じ to にはならないが、記録の抑止対象ではない)
    const store2 = new MemoryStore();
    seed(store2, many("good", 5));
    const accept: ParamValidator = async (_s, _a, p) => ({ score: 10 - 3 * p.tpAtr, trades: 40 });
    const t2 = new ParamTuner({ store: store2, getStrategy, validate: accept });
    expect((await t2.propose(req, NOW))?.status).toBe("applied");
  });

  it("nextValue: 10% 刻み・maxHoldBars は整数・0 は範囲幅で動かす・上下限でクランプ", () => {
    const tuner = new ParamTuner({ store: new MemoryStore(), getStrategy });
    expect(tuner.nextValue("stopAtr", 1.5, "up", [1, 3])).toBe(1.65);
    expect(tuner.nextValue("tpAtr", 2, "down", [1, 4])).toBe(1.8);
    expect(tuner.nextValue("maxHoldBars", 10, "down", [3, 30])).toBe(9);
    expect(tuner.nextValue("maxHoldBars", 4, "down", [3, 30])).toBe(3);
    expect(tuner.nextValue("maxHoldBars", 3, "down", [3, 30])).toBeUndefined();
    expect(tuner.nextValue("trailAtr", 0, "up", [0, 3])).toBe(0.3);
    expect(tuner.nextValue("stopAtr", 2.9, "up", [1, 3])).toBe(3);
  });

  it("currentParams: 既定値に無いキーや非数は無視", () => {
    const store = new MemoryStore();
    store.kvSet("params:paper:s1:crypto", { stopAtr: 1.2, unknown: 5, tpAtr: null });
    const tuner = new ParamTuner({ store, getStrategy });
    const p = tuner.currentParams("s1", "crypto", INFO.defaultParams);
    expect(p.stopAtr).toBe(1.2);
    expect(p.tpAtr).toBe(2);
    expect("unknown" in p).toBe(false);
  });
});
