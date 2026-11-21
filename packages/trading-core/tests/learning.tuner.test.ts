import { describe, expect, it } from "vitest";
import type { AssetClass, Params, Store, TradeRecord } from "../src/core/types";
import { attributeTrade } from "../src/learning/attribution";
import {
  compareValidation, fireRules, ParamTuner, TUNER_RULES, type ParamValidator, type StrategyParamInfo, type ValidationRun,
} from "../src/learning/tuner";
import { MemoryStore } from "../src/storage/memory";

const DAY = 86_400_000;
const HOUR = 3_600_000;
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

type Kind = "stop_too_tight" | "time_decay" | "good" | "clean_win" | "loss";
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
  if (kind === "loss") {
    // 計画通りの損切り (戻らない)
    return { ...base, exitPrice: 98, intendedExitPrice: 98, grossPnl: -2, netPnl: -2, returnPct: -0.02, rMultiple: r ?? -1, mfePct: 0.006, exitReason: "stop", postExitMovePct: -0.01 };
  }
  if (kind === "time_decay") {
    return { ...base, exitPrice: 100.2, intendedExitPrice: 100.2, grossPnl: 0.2, netPnl: 0.2, returnPct: 0.002, rMultiple: r ?? 0.1, mfePct: 0.004, exitReason: "time" };
  }
  // good: 利確 (最大含み損はストップ幅いっぱい)。clean_win: 一度もほぼ逆行しなかった利確
  return {
    ...base, exitPrice: 103, intendedExitPrice: 103, grossPnl: 3, netPnl: 3, returnPct: 0.03, rMultiple: r ?? 1.5, mfePct: 0.031, exitReason: "take_profit",
    maePct: kind === "clean_win" ? 0.001 : 0.015,
  };
}

/** kinds を startTs から 1 時間おきに保存する */
function seed(store: Store, kinds: Kind[], startTs = NOW - 10 * DAY, r?: number, assetClass: AssetClass = "crypto") {
  kinds.forEach((k, i) => {
    const t = trade(k, startTs + i * HOUR, r, assetClass);
    store.saveTrade(t);
    store.saveAttribution(attributeTrade(t));
  });
}
const many = (k: Kind, n: number) => Array.from({ length: n }, () => k);
/** 比較対象 (pre) 25 件 + 判断用 25 件 */
function seedPreAndDecision(store: Store, decision: Kind[], pre: Kind[] = many("good", 25), r?: number) {
  seed(store, pre, NOW - 20 * DAY, r);
  seed(store, decision, NOW - 5 * DAY);
}

/** 検証データのトレード (基準比率用)。既定は「計画通りの損切りと利確が半々」 */
const baselineTrades = (kinds: Kind[] = [...many("loss", 30), ...many("good", 30)]) => kinds.map((k, i) => trade(k, i * HOUR));

/** 5 区間の R 合計 (各区間 trades 件) から検証結果を作る */
function run(sumRs: number[], tradesPerFold = 20, trades: TradeRecord[] = baselineTrades(), dataKey = "d1"): ValidationRun {
  return { dataKey, folds: sumRs.map((s, i) => ({ from: i * DAY, to: (i + 1) * DAY, trades: tradesPerFold, sumR: s })), trades };
}

/** 現行パラメータ以外の候補を区間ごとに +delta だけ良く (負なら悪く) 見せる検証器 */
function validatorWith(delta: (p: Params) => number[], o: { tradesPerFold?: number; trades?: TradeRecord[]; dataKey?: (p: Params) => string } = {}): ParamValidator & { calls: Params[] } {
  const calls: Params[] = [];
  const v = (async (_s: string, _a: AssetClass, p: Params) => {
    calls.push(p);
    const d = delta(p);
    return run([1, 2, 0, -1, 3].map((x, i) => x + (d[i] ?? 0)), o.tradesPerFold ?? 20, o.trades ?? baselineTrades(), o.dataKey?.(p) ?? "d1");
  }) as ParamValidator & { calls: Params[] };
  v.calls = calls;
  return v;
}
const isDefault = (p: Params) => Object.entries(INFO.defaultParams).every(([k, v]) => p[k] === v);
/** 既定値以外 (候補) は全区間で +1R */
const favorChange = () => validatorWith((p) => (isDefault(p) ? [] : [1, 1, 1, 1, 1]));

describe("統計による比較 (compareValidation / fireRules)", () => {
  const O = { signAlpha: 0.1, minImproveR: 0.03, minValidationTrades: 30 };

  it("5 区間すべてで勝ち、改善幅・取引数が十分なら合格", () => {
    const c = compareValidation(run([1, 1, 1, 1, 1]), run([2, 2, 2, 2, 2]), O);
    expect(c).toMatchObject({ comparable: true, wins: 5, losses: 0, ties: 0, accepted: true, baseTrades: 100, candTrades: 100 });
    expect(c.pValue).toBeCloseTo(1 / 32, 12);
    expect(c.improvementR).toBeCloseTo(5 / 100, 12);
  });

  it("4 勝 1 敗 (p = 6/32) は不合格。引き分けの区間は除いて数える", () => {
    const c = compareValidation(run([1, 1, 1, 1, 1]), run([3, 3, 3, 3, 0]), O);
    expect(c).toMatchObject({ wins: 4, losses: 1, accepted: false });
    expect(c.pValue).toBeCloseTo(6 / 32, 12);
    // 4 勝 0 敗 1 分 (p = 1/16 < 0.1) は合格
    const t = compareValidation(run([1, 1, 1, 1, 1]), run([3, 3, 3, 3, 1]), O);
    expect(t).toMatchObject({ wins: 4, losses: 0, ties: 1, accepted: true });
  });

  it("改善が小さい・取引数が少ない・データが違うなら不合格", () => {
    expect(compareValidation(run([1, 1, 1, 1, 1]), run([1.1, 1.1, 1.1, 1.1, 1.1]), O)).toMatchObject({ wins: 5, accepted: false }); // 0.005R/取引
    expect(compareValidation(run([1, 1, 1, 1, 1], 5), run([3, 3, 3, 3, 3], 5), O)).toMatchObject({ wins: 5, accepted: false }); // 25 件
    expect(compareValidation(run([1, 1, 1, 1, 1]), run([3, 3, 3, 3, 3], 20, [], "other"), O)).toMatchObject({ comparable: false, accepted: false });
  });

  it("fireRules: 要因の比率が基準と同程度なら発火しない。有意に高いときだけ発火し p 値の小さい順", () => {
    const o = { causeAlpha: 0.01, minCauseCount: 3 };
    const att = (ts: TradeRecord[]) => ts.map((t) => ({ trade: t, att: attributeTrade(t) }));
    const base = att(baselineTrades([...many("stop_too_tight", 10), ...many("loss", 20), ...many("good", 30)]));
    // ライブも 1/6 程度なら発火しない (旧方式は絶対比率 0.25 で判定していた)
    expect(fireRules(att([...many("stop_too_tight", 4), ...many("loss", 8), ...many("good", 12)].map((k, i) => trade(k, i))), base, o)).toEqual([]);
    // ライブで 20/25 なら発火 (stopAtr を上げる)
    const fired = fireRules(att([...many("stop_too_tight", 20), ...many("good", 5)].map((k, i) => trade(k, i))), base, o);
    expect(fired[0].rule.id).toBe("stop_widen");
    expect(fired[0].liveShare).toBeCloseTo(0.8, 12);
    expect(fired[0].baseShare).toBeCloseTo(1 / 6, 12);
    expect(fired[0].pValue).toBeLessThan(0.01);
  });

  it("各パラメータに上げる・下げるの両方向のルールがある", () => {
    const dirs = new Set<string>();
    // tpAtr を下げるのはトレーリングが無効なとき (有効ならトレーリングを詰める)
    for (const p of [{ ...INFO.defaultParams, trailAtr: 1 }, INFO.defaultParams]) {
      for (const r of TUNER_RULES) {
        const k = r.pick(p);
        if (k) dirs.add(`${k.param}:${k.direction}`);
      }
    }
    for (const param of ["stopAtr", "tpAtr", "trailAtr", "entryThreshold", "maxHoldBars"]) {
      expect(dirs.has(`${param}:up`)).toBe(true);
      expect(dirs.has(`${param}:down`)).toBe(true);
    }
  });
});

describe("ParamTuner.run", () => {
  it("検証器なし・判断用の取引不足・比較対象不足なら何もしない (記録もしない)", async () => {
    const s1 = new MemoryStore();
    seedPreAndDecision(s1, many("stop_too_tight", 25));
    expect(await new ParamTuner({ store: s1, getStrategy }).run(NOW)).toEqual([]);

    const s2 = new MemoryStore();
    seedPreAndDecision(s2, many("stop_too_tight", 25), many("good", 10)); // 35 件: 判断 20 件・比較対象 15 件
    expect(await new ParamTuner({ store: s2, getStrategy, validate: favorChange() }).run(NOW)).toEqual([]);
    expect(s2.listAdjustments()).toEqual([]);

    const s3 = new MemoryStore();
    seed(s3, many("stop_too_tight", 19));
    expect(await new ParamTuner({ store: s3, getStrategy, validate: favorChange() }).run(NOW)).toEqual([]);
  });

  it("基準より有意に多い要因からルールを発火 → 区間検証で有意に良ければ applied (メタに比較対象の統計)", async () => {
    const store = new MemoryStore();
    seedPreAndDecision(store, many("stop_too_tight", 25), many("good", 25), 0.5);
    const v = favorChange();
    const tuner = new ParamTuner({ store, getStrategy, validate: v });
    const [adj, ...rest] = await tuner.run(NOW);
    expect(rest).toEqual([]);
    expect(adj).toMatchObject({ strategyId: "s1", assetClass: "crypto", param: "stopAtr", from: 1.5, to: 1.6, status: "applied", createdAt: NOW });
    expect(adj.reason).toContain("rule:stop_widen");
    expect(adj.reason).toContain("符号検定");
    expect(adj.validation).toEqual({ baselineScore: 5, candidateScore: 10, trades: 100 });
    expect(v.calls.map((p) => p.stopAtr)).toEqual([1.5, 1.6]);
    expect(tuner.currentParams("s1", "crypto", INFO.defaultParams)).toMatchObject({ stopAtr: 1.6, tpAtr: 2 });
    expect(tuner.currentParams("s1", "meme", INFO.defaultParams).stopAtr).toBe(1.5);
    // 50 件のうち古い 20 件 (good, 0.5R) を比較対象に取り置き、残り 30 件で判断する
    expect(adj.reason).toContain("直近 30 件");
    const meta = store.kvGet<Record<string, number>>(`adjmeta:paper:${adj.id}`)!;
    expect(meta).toMatchObject({ preMeanR: 0.5, preN: 20, preVar: 0, reviewed: false, reviewDeadline: NOW + 14 * DAY });
    expect(meta.preTo).toBeLessThan(meta.decisionFrom);
    expect(store.listAudit({ type: "learning.param_adjust" })[0].data).toMatchObject({ wins: 5, losses: 0 });
    // 評価待ちの間は再調整しない
    seed(store, many("stop_too_tight", 25), NOW + DAY);
    expect(await tuner.run(NOW + 3 * DAY)).toEqual([]);
  });

  it("検証データでも同じ比率で出る要因では発火しない (期待値ゼロでも出る要因で偏らない)", async () => {
    const store = new MemoryStore();
    seedPreAndDecision(store, many("stop_too_tight", 25), many("stop_too_tight", 25));
    const v = validatorWith(() => [1, 1, 1, 1, 1], { trades: baselineTrades(many("stop_too_tight", 60)) });
    expect(await new ParamTuner({ store, getStrategy, validate: v }).run(NOW)).toEqual([]);
    expect(store.listAdjustments()).toEqual([]);
  });

  it("逆方向のルール: 勝ち取引がほとんど逆行していなければ stopAtr を下げる", async () => {
    const store = new MemoryStore();
    seedPreAndDecision(store, many("clean_win", 25), many("loss", 25));
    const v = validatorWith((p) => (p.stopAtr < 1.5 ? [1, 1, 1, 1, 1] : []));
    const [adj] = await new ParamTuner({ store, getStrategy, validate: v }).run(NOW);
    expect(adj).toMatchObject({ param: "stopAtr", from: 1.5, to: 1.35, status: "applied" });
    expect(adj.reason).toContain("rule:stop_tighten");
  });

  it("区間の勝ち負けが揃わない・改善が小さい候補は rejected (パラメータは変えない)", async () => {
    const store = new MemoryStore();
    seedPreAndDecision(store, many("stop_too_tight", 25));
    const mixed = validatorWith((p) => (isDefault(p) ? [] : [2, 2, 2, 2, -1]));
    const [adj] = await new ParamTuner({ store, getStrategy, validate: mixed }).run(NOW);
    expect(adj.status).toBe("rejected");
    expect(adj.reason).toContain("負け 1");
    expect(new ParamTuner({ store, getStrategy }).currentParams("s1", "crypto", INFO.defaultParams).stopAtr).toBe(1.5);

    const store2 = new MemoryStore();
    seedPreAndDecision(store2, many("stop_too_tight", 25));
    const tiny = validatorWith((p) => (isDefault(p) ? [] : [0.1, 0.1, 0.1, 0.1, 0.1]));
    expect((await new ParamTuner({ store: store2, getStrategy, validate: tiny }).run(NOW))[0].status).toBe("rejected");
  });

  it("基準の検証ができなければ記録せずスキップ。候補だけ検証できない・データが変わったら proposed", async () => {
    const store = new MemoryStore();
    seedPreAndDecision(store, many("stop_too_tight", 25));
    for (const validate of [(async () => undefined) as ParamValidator, (async () => { throw new Error("fetch failed"); }) as ParamValidator]) {
      expect(await new ParamTuner({ store, getStrategy, validate }).run(NOW)).toEqual([]);
    }
    expect(store.listAdjustments()).toEqual([]);

    const onlyBase: ParamValidator = async (s, a, p) => (isDefault(p) ? favorChange()(s, a, p) : undefined);
    const [adj] = await new ParamTuner({ store, getStrategy, validate: onlyBase }).run(NOW);
    expect(adj.status).toBe("proposed");
    expect(adj.validation).toBeUndefined();

    const store2 = new MemoryStore();
    seedPreAndDecision(store2, many("stop_too_tight", 25));
    const moved = validatorWith((p) => (isDefault(p) ? [] : [5, 5, 5, 5, 5]), { dataKey: (p) => (isDefault(p) ? "old" : "new") });
    const [adj2] = await new ParamTuner({ store: store2, getStrategy, validate: moved }).run(NOW);
    expect(adj2.status).toBe("proposed");
    expect(adj2.reason).toContain("比較できない");
  });

  it("直近 7 日以内に同じ rejected があれば同じ案を作らない (7 日超なら再度作る)", async () => {
    const store = new MemoryStore();
    seedPreAndDecision(store, many("stop_too_tight", 25));
    const reject = validatorWith(() => []);
    const tuner = new ParamTuner({ store, getStrategy, validate: reject });
    expect((await tuner.run(NOW))[0].status).toBe("rejected");
    seed(store, many("stop_too_tight", 25), NOW + 1000);
    expect(await tuner.run(NOW + 2 * DAY)).toEqual([]);
    expect(store.listAdjustments()).toHaveLength(1);
    seed(store, many("stop_too_tight", 25), NOW + 7 * DAY);
    expect(await tuner.run(NOW + 9 * DAY)).toHaveLength(1);
    expect(store.listAdjustments()).toHaveLength(2);
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

describe("ParamTuner.reviewApplied (Welch の t 検定・期限)", () => {
  /** 比較対象 R が平均 0.5・ばらつきありで stopAtr 1.6 を適用した状態 */
  async function applied() {
    const store = new MemoryStore();
    const pre = many("good", 25);
    pre.forEach((k, i) => {
      const t = trade(k, NOW - 20 * DAY + i * HOUR, i % 2 === 0 ? 1.5 : -0.5);
      store.saveTrade(t);
      store.saveAttribution(attributeTrade(t));
    });
    seed(store, many("stop_too_tight", 25), NOW - 5 * DAY);
    const tuner = new ParamTuner({ store, getStrategy, validate: favorChange() });
    const [adj] = await tuner.run(NOW);
    expect(adj.status).toBe("applied");
    return { store, tuner, adj };
  }
  /** 適用後の取引 (R を交互に a / b) */
  function post(store: Store, n: number, a: number, b: number, start = NOW + DAY) {
    for (let i = 0; i < n; i++) {
      const t = trade("good", start + i * HOUR, i % 2 === 0 ? a : b);
      store.saveTrade(t);
      store.saveAttribution(attributeTrade(t));
    }
  }

  it("適用後の平均 R が有意に悪化したら reverted で元に戻す (件数がたまるまでは評価しない)", async () => {
    const { store, tuner, adj } = await applied();
    post(store, 20, -0.5, -1.5);
    expect(tuner.reviewApplied(NOW + 3 * DAY)).toEqual([]);
    post(store, 10, -0.5, -1.5, NOW + 2 * DAY);
    const reverted = tuner.reviewApplied(NOW + 4 * DAY);
    expect(reverted).toHaveLength(1);
    expect(reverted[0]).toMatchObject({ id: adj.id, status: "reverted" });
    expect(reverted[0].reason).toContain("Welch");
    expect(tuner.currentParams("s1", "crypto", INFO.defaultParams).stopAtr).toBe(1.5);
    expect(store.listAudit({ type: "learning.param_revert" })).toHaveLength(1);
    expect(store.kvGet(`adjmeta:paper:${adj.id}`)).toMatchObject({ reviewed: true, outcome: "reverted", postN: 30, closedAt: NOW + 4 * DAY });
    expect(tuner.reviewApplied(NOW + 6 * DAY)).toEqual([]);
  });

  it("差が有意でなければ applied のまま (kept)", async () => {
    const { store, tuner, adj } = await applied();
    post(store, 30, 1.2, -0.6); // 平均 0.3 (比較対象 0.5 より少し低いが有意ではない)
    expect(tuner.reviewApplied(NOW + 4 * DAY)).toEqual([]);
    expect(store.listAdjustments({ status: "applied" }).map((a) => a.id)).toEqual([adj.id]);
    const meta = store.kvGet<{ outcome: string; pValue: number }>(`adjmeta:paper:${adj.id}`)!;
    expect(meta.outcome).toBe("kept");
    expect(meta.pValue).toBeGreaterThan(0.1);
    expect(tuner.currentParams("s1", "crypto", INFO.defaultParams).stopAtr).toBe(1.6);
  });

  it("期限までに件数が足りなければ判定不能で評価を終え、調整を止め続けない", async () => {
    const { store, tuner, adj } = await applied();
    post(store, 5, -2, -2);
    const req = { strategyId: "s1", assetClass: "crypto" as const, param: "tpAtr", direction: "up" as const, reason: "x" };
    // 期限前は評価待ち (提案も保留)
    expect(tuner.reviewApplied(NOW + 13 * DAY)).toEqual([]);
    expect(await tuner.propose(req, NOW + 13 * DAY)).toBeUndefined();
    // 期限後の取引は事後評価に数えない。期限を過ぎたら評価待ちとみなさない (reviewApplied の前でも止まらない)
    post(store, 45, 0.5, 0.5, NOW + 14.5 * DAY);
    expect(await tuner.propose(req, NOW + 17 * DAY)).toBeDefined(); // 保留されずに検証まで進む
    expect(tuner.reviewApplied(NOW + 17 * DAY)).toEqual([]);
    expect(store.kvGet(`adjmeta:paper:${adj.id}`)).toMatchObject({ reviewed: true, outcome: "inconclusive", postN: 5 });
    expect(store.listAudit({ type: "learning.param_review_expired" })).toHaveLength(1);
    expect(tuner.currentParams("s1", "crypto", INFO.defaultParams).stopAtr).toBe(1.6);
  });

  it("旧形式のメタ (分散なし) は適用後の分散で代用して検定する", async () => {
    const store = new MemoryStore();
    store.saveAdjustment({ id: "old", strategyId: "s1", assetClass: "crypto", param: "stopAtr", from: 1.5, to: 1.6, reason: "旧", status: "applied", createdAt: NOW, mode: "paper" });
    store.kvSet("adjmeta:paper:old", { preMeanR: 0.5, preN: 20, reviewed: false });
    store.kvSet("params:paper:s1:crypto", { stopAtr: 1.6 });
    post(store, 30, -0.5, -1.5);
    const tuner = new ParamTuner({ store, getStrategy });
    expect(tuner.reviewApplied(NOW + 3 * DAY).map((a) => a.id)).toEqual(["old"]);
  });
});

describe("ParamTuner.propose", () => {
  it("同じ検証経路を通す。未知の戦略・上下限の無いパラメータ・件数不足は捨てる", async () => {
    const store = new MemoryStore();
    const tuner = new ParamTuner({ store, getStrategy, validate: favorChange() });
    const req = { strategyId: "s1", assetClass: "crypto" as const, param: "tpAtr", direction: "down" as const, reason: "利確が遠すぎる" };
    expect(await tuner.propose({ ...req, strategyId: "zzz" }, NOW)).toBeUndefined();
    expect(await tuner.propose({ ...req, param: "lookback" }, NOW)).toBeUndefined();
    // 件数不足 (最低件数が無いと少数の取引で LLM の提案が通ってしまう)
    seed(store, many("good", 5), NOW - 5 * DAY);
    expect(await tuner.propose(req, NOW)).toBeUndefined();
    seed(store, many("good", 20), NOW - 4 * DAY);
    expect(await tuner.propose(req, NOW, { decisionFrom: NOW - 7 * DAY })).toBeUndefined(); // 判断期間より前の取引が無い
    seed(store, many("good", 25), NOW - 25 * DAY);
    const adj = await tuner.propose(req, NOW, { decisionFrom: NOW - 7 * DAY });
    expect(adj).toMatchObject({ param: "tpAtr", from: 2, to: 1.8, status: "applied" });
    expect(adj!.reason).toContain("利確が遠すぎる");
    expect(tuner.currentParams("s1", "crypto", INFO.defaultParams).tpAtr).toBe(1.8);
    // 比較対象は判断期間 (直近 7 日) より前
    const meta = store.kvGet<{ preTo: number; preN: number }>(`adjmeta:paper:${adj!.id}`)!;
    expect(meta.preTo).toBeLessThan(NOW - 7 * DAY);
  });

  it("判断・比較対象の取引は前回の適用以降に限る (以前のパラメータの取引を混ぜない)", async () => {
    const store = new MemoryStore();
    // 古いパラメータでの取引 50 件
    seed(store, many("good", 50), NOW - 28 * DAY, 3);
    store.saveAdjustment({ id: "prev", strategyId: "s1", assetClass: "crypto", param: "stopAtr", from: 1.4, to: 1.5, reason: "前回", status: "applied", createdAt: NOW - 20 * DAY, mode: "paper" });
    store.kvSet("adjmeta:paper:prev", { preMeanR: 0, preN: 20, preVar: 1, reviewed: true, outcome: "kept" });
    const tuner = new ParamTuner({ store, getStrategy, validate: favorChange() });
    const req = { strategyId: "s1", assetClass: "crypto" as const, param: "tpAtr", direction: "up" as const, reason: "x" };
    // 適用以降の取引が無いので提案しない
    expect(await tuner.propose(req, NOW)).toBeUndefined();
    seed(store, many("good", 45), NOW - 15 * DAY, -0.2);
    const adj = await tuner.propose(req, NOW);
    expect(adj?.status).toBe("applied");
    expect(store.kvGet<{ preMeanR: number }>(`adjmeta:paper:${adj!.id}`)!.preMeanR).toBeCloseTo(-0.2, 12);
  });

  it("検証器なしなら proposed のまま。直近 7 日以内に同じ rejected があれば作らない", async () => {
    const store = new MemoryStore();
    seed(store, many("good", 50));
    const t2 = new ParamTuner({ store, getStrategy });
    const p2 = await t2.propose({ strategyId: "s1", assetClass: "meme", param: "entryThreshold", direction: "up", reason: "x" }, NOW);
    expect(p2).toBeUndefined(); // meme の取引は無い
    const p3 = await t2.propose({ strategyId: "s1", assetClass: "crypto", param: "entryThreshold", direction: "up", reason: "x" }, NOW);
    expect(p3?.status).toBe("proposed");
    expect(t2.currentParams("s1", "crypto", INFO.defaultParams).entryThreshold).toBe(0.5);

    const store2 = new MemoryStore();
    seed(store2, many("good", 50));
    const tuner = new ParamTuner({ store: store2, getStrategy, validate: validatorWith(() => []) });
    const req = { strategyId: "s1", assetClass: "crypto" as const, param: "tpAtr", direction: "down" as const, reason: "x" };
    expect((await tuner.propose(req, NOW))?.status).toBe("rejected");
    expect(await tuner.propose(req, NOW + DAY)).toBeUndefined();
    expect((await tuner.propose({ ...req, param: "entryThreshold", direction: "up" }, NOW + DAY))?.status).toBe("rejected");
  });
});
