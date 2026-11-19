import { describe, expect, it } from "vitest";
import type { ParamAdjustment } from "../src/core/types";
import { ParamTuner, type StrategyParamInfo } from "../src/learning/tuner";
import { MemoryStore } from "../src/storage/memory";

const INFO: StrategyParamInfo = {
  defaultParams: { stopAtr: 1.5, tpAtr: 2, lookback: 20 },
  paramBounds: { stopAtr: [1, 3], tpAtr: [4, 1] },
};
const getStrategy = (id: string) => (id === "s1" ? INFO : undefined);
const DAY = 86_400_000;
const NOW = 100 * DAY;

describe("ParamTuner: 保存値のクランプと adjmeta 欠落", () => {
  it("currentParams: 保存値を paramBounds でクランプ (逆順の bounds も可)。bounds の無いキーはそのまま", () => {
    const store = new MemoryStore();
    store.kvSet("params:s1:crypto", { stopAtr: 9, tpAtr: 0.2, lookback: 55 });
    const t = new ParamTuner({ store, getStrategy });
    expect(t.currentParams("s1", "crypto", INFO.defaultParams)).toEqual({ stopAtr: 3, tpAtr: 1, lookback: 55 });
    // bounds を明示した場合はそれを使う
    expect(t.currentParams("s1", "crypto", INFO.defaultParams, { stopAtr: [1, 2] }).stopAtr).toBe(2);
    // 未知の戦略 (bounds 不明) はクランプしない
    store.kvSet("params:zz:crypto", { stopAtr: 9 });
    expect(t.currentParams("zz", "crypto", { stopAtr: 1 }).stopAtr).toBe(9);
  });

  it("adjmeta が欠けた applied の調整で評価待ちが永久に続かない (propose が保留されない)", async () => {
    const store = new MemoryStore();
    const orphan: ParamAdjustment = {
      id: "orphan", strategyId: "s1", assetClass: "crypto", param: "stopAtr", from: 1.4, to: 1.5, reason: "古い調整", status: "applied", createdAt: NOW - 30 * DAY,
    };
    store.saveAdjustment(orphan);
    const t = new ParamTuner({ store, getStrategy, validate: async (_s, _a, p) => ({ score: p.stopAtr, trades: 50 }) });
    const adj = await t.propose({ strategyId: "s1", assetClass: "crypto", param: "stopAtr", direction: "up", reason: "test" }, NOW);
    expect(adj?.status).toBe("applied");
    // 新しい調整はメタを持つので、こちらは評価待ちとして扱われる (次の提案は保留)
    expect(await t.propose({ strategyId: "s1", assetClass: "crypto", param: "tpAtr", direction: "up", reason: "test" }, NOW)).toBeUndefined();
    // reviewApplied もメタ欠落の調整を無視して例外にならない
    expect(t.reviewApplied(NOW)).toEqual([]);
  });
});
