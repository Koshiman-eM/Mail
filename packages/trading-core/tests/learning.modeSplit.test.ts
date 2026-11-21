/** 学習状態の paper / live 分割と、旧キー (mode なし) からの移行 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ShadowTradeRecord, Store, TradeRecord, TradingMode } from "../src/core/types";
import { armKey } from "../src/learning/allocator";
import { attributeTrade } from "../src/learning/attribution";
import { learningMigrationFlagKey, listLegacyLearningKeys, migrateLearningModeSplit, modeScopedLearningKey } from "../src/learning/migration";
import { computeReflectionStats } from "../src/learning/reflection";
import { LearningService, type StrategyInfo } from "../src/learning/service";
import { isHaltShadowReason } from "../src/learning/shadow";
import { ParamTuner, type ParamValidator } from "../src/learning/tuner";
import { MemoryStore } from "../src/storage/memory";
import { SqliteStore } from "../src/storage/sqlite";
import { stubValidator } from "./helpers/validation";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const KEY = armKey("s1", "range", "crypto");

const INFO: StrategyInfo = {
  defaultParams: { stopAtr: 1.5, tpAtr: 2, trailAtr: 0, entryThreshold: 0.5, maxHoldBars: 10 },
  paramBounds: { stopAtr: [1, 1.6], tpAtr: [1, 4], trailAtr: [0, 3], entryThreshold: [0.1, 1], maxHoldBars: [3, 30] },
};
const getStrategy = (id: string) => (id === "s1" ? INFO : undefined);

/** 旧キー (mode なし) の学習状態 */
const LEGACY_ARM = { key: KEY, alpha: 9, beta: 3, n: 10, sumR: 6, sumR2: 8, ewmaR: 0.6, ewmaVarR: 0.4, updatedAt: NOW - DAY };
const LEGACY_SOURCES = { "rss:a": { source: "rss:a", n: 12, hits: 10, ewmaScore: 0.7, weight: 1.5, updatedAt: NOW - DAY } };
const LEGACY_INFLUENCE = { n: 30, mx: 0, my: 0, vx: 1, vy: 1, cxy: 0.5, corr: 0.5, value: 1.3, updatedAt: NOW - DAY };
const LEGACY_PENDING = [
  { itemId: "n1", source: "rss:a", asset: "BTC", symbol: "BTC/USDT", direction: 1, strength: 0.5, ingestedAt: NOW - 1000, publishedAt: NOW - 2000, mid0: 100, atrPctPerMin: 0, costPct: 0, done: [] },
];

function seedLegacy(store: Store) {
  store.kvSet("arm:index", [KEY]);
  store.kvSet(`arm:${KEY}`, LEGACY_ARM);
  store.kvSet("params:s1:crypto", { stopAtr: 1.6 });
  store.kvSet("adjmeta:adj-old", { preMeanR: -0.5, preN: 25, reviewed: false });
  store.kvSet("intel:sourceReliability", LEGACY_SOURCES);
  store.kvSet("intelInfluence:crypto", LEGACY_INFLUENCE);
  store.kvSet("newsCheck:pending", LEGACY_PENDING);
  store.kvSet("newsCheck:stats", { sources: {}, recorded: 1, droppedCap: 0, droppedUnwatched: 0 });
  store.kvSet("newsCheck:seen", ["n1"]);
  store.kvSet("learning:lastTune", NOW - 1000);
  store.kvSet("learning:lastReflect", NOW - 1000);
  // 列追加前の調整履歴 (mode なし) は paper とみなす
  store.saveAdjustment({ id: "adj-old", strategyId: "s1", assetClass: "crypto", param: "stopAtr", from: 1.5, to: 1.6, reason: "旧", status: "applied", createdAt: NOW - 5 * DAY });
}

const LEGACY_KEYS = [
  "arm:index", `arm:${KEY}`, "params:s1:crypto", "adjmeta:adj-old", "intel:sourceReliability", "intelInfluence:crypto",
  "newsCheck:pending", "newsCheck:stats", "newsCheck:seen", "learning:lastTune", "learning:lastReflect",
];
const snapshotLegacy = (store: Store) => Object.fromEntries(LEGACY_KEYS.map((k) => [k, store.kvGet(k)]));

const svc = (store: Store, mode: TradingMode) => new LearningService({ store, mode, getStrategy });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 再起動を模すため、Sqlite はファイルに保存して開き直す */
const STORES: [string, () => { open: () => Store }][] = [
  [
    "MemoryStore",
    () => {
      const s = new MemoryStore();
      return { open: () => s };
    },
  ],
  [
    "SqliteStore",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "trader-modesplit-"));
      dirs.push(dir);
      const path = join(dir, "t.db");
      let cur: Store | undefined;
      return {
        open: () => {
          cur?.close();
          cur = new SqliteStore(path);
          return cur;
        },
      };
    },
  ],
];

describe.each(STORES)("学習状態の移行 (%s)", (_name, make) => {
  it("旧キーだけある DB: paper 起動で引き継ぎ、live 起動は初期状態。旧キーは残り、2 回目はコピーし直さない", () => {
    const db = make();
    let store = db.open();
    seedLegacy(store);
    const before = snapshotLegacy(store);

    // 1. paper 起動: 旧キーの値がそのまま使われる
    const paper = svc(store, "paper");
    expect(paper.allocator.get(KEY)).toMatchObject({ alpha: 9, beta: 3, n: 10 });
    expect(paper.allocator.keys()).toEqual([KEY]);
    expect(paper.paramsFor("s1", "crypto")?.stopAtr).toBe(1.6);
    expect(paper.sourceReliability()).toEqual(LEGACY_SOURCES);
    expect(paper.intelInfluence("crypto")).toBe(1.3);
    expect(paper.news.listPending()).toHaveLength(1);
    expect(store.kvGet("adjmeta:paper:adj-old")).toEqual({ preMeanR: -0.5, preN: 25, reviewed: false });
    expect(store.kvGet("learning:paper:lastTune")).toBe(NOW - 1000);
    expect(store.listAdjustments({ mode: "paper" }).map((a) => a.id)).toEqual(["adj-old"]);
    expect(store.listAdjustments({ mode: "live" })).toEqual([]);
    expect(store.kvGet(learningMigrationFlagKey("paper"))).toBeDefined();
    expect(store.listAudit({ type: "learning.migrated" })).toHaveLength(1);
    expect(store.listAudit({ type: "learning.migrated" })[0].data).toMatchObject({ mode: "paper", legacyKeys: LEGACY_KEYS.length, copied: LEGACY_KEYS.length });
    // 旧キーは消さない
    expect(snapshotLegacy(store)).toEqual(before);

    // 2. live 起動: paper の学習を持ち込まない (事前分布・コードの既定値)
    store = db.open();
    const live = svc(store, "live");
    expect(live.allocator.get(KEY)).toBeUndefined();
    expect(live.allocator.keys()).toEqual([]);
    expect(live.allocator.weight(KEY)).toBe(1);
    expect(live.paramsFor("s1", "crypto")).toEqual(INFO.defaultParams);
    expect(live.sourceReliability()).toEqual({});
    expect(live.intelInfluence("crypto")).toBe(1);
    expect(live.news.listPending()).toEqual([]);
    expect(live.snapshot({ now: NOW }).adjustments).toEqual([]);
    expect(store.kvGet(learningMigrationFlagKey("live"))).toBeDefined();
    expect(store.listAudit({ type: "learning.migrated" }).map((e) => e.data.mode)).toEqual(["paper", "live"]);
    expect(snapshotLegacy(store)).toEqual(before);
    // live の学習は paper のキーに混ざらない
    live.allocator.update(trade("live", 2));
    expect(live.allocator.get(KEY)).toMatchObject({ n: 1 });

    // 3. paper の 2 回目の起動: 学習が進んだ paper の値を旧キーで上書きしない
    store = db.open();
    const paper2a = svc(store, "paper");
    paper2a.allocator.update(trade("paper", 1));
    expect(paper2a.allocator.get(KEY)!.n).toBe(11);
    store.kvSet("params:paper:s1:crypto", { stopAtr: 1.2 });
    store = db.open();
    const paper2 = svc(store, "paper");
    expect(paper2.allocator.get(KEY)!.n).toBe(11);
    expect(paper2.paramsFor("s1", "crypto")?.stopAtr).toBe(1.2);
    expect(store.listAudit({ type: "learning.migrated" })).toHaveLength(2); // paper 1 回 + live 1 回
    expect(svc(store, "live").allocator.get(KEY)).toMatchObject({ n: 1 });
    expect(snapshotLegacy(store)).toEqual(before);
    store.close();
  });

  it("旧キーが無い DB では監査ログを残さず、フラグだけ書く", () => {
    const store = make().open();
    svc(store, "paper");
    expect(store.listAudit({ type: "learning.migrated" })).toEqual([]);
    expect(store.kvGet(learningMigrationFlagKey("paper"))).toBeDefined();
    store.close();
  });

  it("途中まで移行済み (フラグ無し・一部の新キーあり) なら、既存の新キーは残して残りをコピーする", () => {
    const store = make().open();
    seedLegacy(store);
    store.kvSet("params:paper:s1:crypto", { stopAtr: 1.1 });
    const r = migrateLearningModeSplit(store, "paper", NOW);
    expect(r.ran).toBe(true);
    expect(r.keptExisting).toEqual(["params:paper:s1:crypto"]);
    expect(r.copied).toHaveLength(LEGACY_KEYS.length - 1);
    expect(store.kvGet("params:paper:s1:crypto")).toEqual({ stopAtr: 1.1 });
    expect(store.kvGet(`arm:paper:${KEY}`)).toEqual(LEGACY_ARM);
    expect(migrateLearningModeSplit(store, "paper", NOW).ran).toBe(false);
    store.close();
  });
});

describe("学習状態の移行: トランザクション", () => {
  it("SqliteStore: 移行の途中で失敗したら何も書かず、次の起動でやり直せる", () => {
    const store = new SqliteStore(":memory:");
    seedLegacy(store);
    const audit = store.audit.bind(store);
    store.audit = () => {
      throw new Error("boom");
    };
    expect(() => migrateLearningModeSplit(store, "paper", NOW)).toThrow("boom");
    expect(store.kvGet(`arm:paper:${KEY}`)).toBeUndefined();
    expect(store.kvGet("intel:sourceReliability:paper")).toBeUndefined();
    expect(store.kvGet(learningMigrationFlagKey("paper"))).toBeUndefined();
    store.audit = audit;
    expect(migrateLearningModeSplit(store, "paper", NOW).ran).toBe(true);
    expect(store.kvGet(`arm:paper:${KEY}`)).toEqual(LEGACY_ARM);
    store.close();
  });

  it("旧キー判定: mode 別の新キーは旧キーとみなさない", () => {
    expect(modeScopedLearningKey("arm:index", "paper")).toBe("arm:paper:index");
    expect(modeScopedLearningKey(`arm:${KEY}`, "live")).toBe(`arm:live:${KEY}`);
    expect(modeScopedLearningKey("arm:paper:index", "paper")).toBeUndefined();
    expect(modeScopedLearningKey("params:live:s1:crypto", "paper")).toBeUndefined();
    expect(modeScopedLearningKey("intel:sourceReliability", "live")).toBe("intel:sourceReliability:live");
    expect(modeScopedLearningKey("intel:sourceReliability:paper", "paper")).toBeUndefined();
    expect(modeScopedLearningKey("newsCheck:seen", "paper")).toBe("newsCheck:paper:seen");
    expect(modeScopedLearningKey("risk:state", "paper")).toBeUndefined();
    const store = new MemoryStore();
    seedLegacy(store);
    svc(store, "paper");
    expect(listLegacyLearningKeys(store).sort()).toEqual([...LEGACY_KEYS].sort());
  });
});

describe("SqliteStore: adjustments の mode 列の追加 (既存行は paper)", () => {
  it("mode 列の無い旧スキーマの DB を開くと列を追加し、既存行を paper として扱う (行は消さない)", () => {
    const dir = mkdtempSync(join(tmpdir(), "trader-adjmode-"));
    dirs.push(dir);
    const path = join(dir, "old.db");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE adjustments (id TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, strategyId TEXT NOT NULL, assetClass TEXT NOT NULL,
      param TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)`);
    const old = { id: "a1", strategyId: "s1", assetClass: "crypto", param: "stopAtr", from: 1.5, to: 1.6, reason: "r", status: "applied", createdAt: 1 };
    db.prepare("INSERT INTO adjustments VALUES (?, ?, ?, ?, ?, ?, ?)").run("a1", 1, "s1", "crypto", "stopAtr", "applied", JSON.stringify(old));
    db.close();

    const s = new SqliteStore(path);
    expect(s.listAdjustments()).toEqual([{ ...old, mode: "paper" }]);
    expect(s.listAdjustments({ mode: "paper" }).map((a) => a.id)).toEqual(["a1"]);
    expect(s.listAdjustments({ mode: "live" })).toEqual([]);
    s.saveAdjustment({ ...old, id: "a2", createdAt: 2, mode: "live" } as never);
    s.close();
    // 開き直しても冪等
    const s2 = new SqliteStore(path);
    expect(s2.listAdjustments({ mode: "live" }).map((a) => a.id)).toEqual(["a2"]);
    expect(s2.listAdjustments().map((a) => a.id)).toEqual(["a1", "a2"]);
    s2.close();
  });
});

// ───────── 集計対象: 現在の mode かつ推定約定でない取引 ─────────

let seq = 0;
function trade(mode: TradingMode, r: number, over: Partial<TradeRecord> = {}): TradeRecord {
  seq++;
  const entryTs = NOW - 10 * DAY + seq * 3_600_000;
  return {
    id: `t${seq}`, mode, symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", strategyId: "s1", horizon: "scalp", direction: "long",
    qty: 1, entryTs, entryPrice: 100, intendedEntryPrice: 100, exitTs: entryTs + 60_000, exitPrice: 98, intendedExitPrice: 98,
    initialStop: 98, grossPnl: -2, fees: 0, netPnl: -2, returnPct: -0.02, rMultiple: r, mfePct: 0.006, maePct: 0.02, exitReason: "stop",
    postExitMovePct: 0.025,
    entryContext: {
      regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
      confidence: 0.5, expectedEdgeBps: 30, costBps: 10, params: {}, features: {}, riskMultiplier: 1, reason: "t",
    },
    ...over,
  };
}
function seedTrades(store: Store, n: number, mode: TradingMode, over: Partial<TradeRecord> = {}) {
  for (let i = 0; i < n; i++) {
    const t = trade(mode, -1, over);
    store.saveTrade(t);
    store.saveAttribution(attributeTrade(t));
  }
}
const favorStop: ParamValidator = stubValidator((p) => (p.stopAtr === 1.5 ? 0 : 1));

describe("ParamTuner / reflection: 現在の mode かつ estimated でない取引だけを集計する", () => {
  it("live の取引・推定約定の取引では paper の tuner は調整しない", async () => {
    const store = new MemoryStore();
    // 判断用 + 事後評価の比較対象 (計 45 件) が要る
    seedTrades(store, 45, "live");
    seedTrades(store, 45, "paper", { estimated: true });
    const paper = new ParamTuner({ store, getStrategy, validate: favorStop, mode: "paper" });
    expect(await paper.run(NOW)).toEqual([]);
    // live の tuner は live の取引で調整し、調整履歴とパラメータは live 側に記録する
    const live = new ParamTuner({ store, getStrategy, validate: favorStop, mode: "live" });
    const [adj] = await live.run(NOW);
    expect(adj).toMatchObject({ status: "applied", mode: "live", param: "stopAtr" });
    expect(store.kvGet("params:live:s1:crypto")).toEqual({ stopAtr: 1.6 });
    expect(store.kvGet("params:paper:s1:crypto")).toBeUndefined();
    expect(store.kvGet(`adjmeta:live:${adj.id}`)).toMatchObject({ reviewed: false });
    expect(store.listAdjustments({ mode: "paper" })).toEqual([]);
    expect(paper.currentParams("s1", "crypto", INFO.defaultParams).stopAtr).toBe(1.5);
    // paper 側は live の評価待ちに影響されない
    expect(paper.reviewApplied(NOW + 5 * DAY)).toEqual([]);
  });

  it("propose の事前集計・reviewApplied の事後集計も推定約定を除く", async () => {
    const store = new MemoryStore();
    const tuner = new ParamTuner({ store, getStrategy, validate: favorStop, mode: "paper" });
    seedTrades(store, 45, "paper");
    seedTrades(store, 10, "paper", { estimated: true, rMultiple: 10 });
    const adj = await tuner.propose({ strategyId: "s1", assetClass: "crypto", param: "stopAtr", direction: "up", reason: "t" }, NOW);
    expect(adj?.status).toBe("applied");
    expect(store.kvGet(`adjmeta:paper:${adj!.id}`)).toMatchObject({ preMeanR: -1, preN: 20 });
  });

  it("computeReflectionStats は mode と estimated で絞る", () => {
    const store = new MemoryStore();
    seedTrades(store, 3, "paper");
    seedTrades(store, 2, "paper", { estimated: true });
    seedTrades(store, 4, "live");
    const base = { store, now: NOW, windowMs: 30 * DAY };
    expect(computeReflectionStats({ ...base, mode: "paper" }).total.n).toBe(3);
    expect(computeReflectionStats({ ...base, mode: "live" }).total.n).toBe(4);
    expect(computeReflectionStats(base).total.n).toBe(7);
  });
});

// ───────── 停止中に記録された仮想トレードは腕の更新に使わない ─────────

const shadowRec = (over: Partial<ShadowTradeRecord> = {}): ShadowTradeRecord => ({
  id: `sh-${Math.random()}`, mode: "paper", symbol: "BTC/USDT", assetClass: "crypto", strategyId: "s1", horizon: "scalp", regime: "range",
  direction: "long", reason: "direction_bias", confidence: 0.6, expectedEdgeBps: 20, entryTs: NOW, entryPrice: 100.1, entryMid: 100, entrySpread: 0.2,
  stopLoss: 98.1, maxHoldMs: 600_000, takerFeeRate: 0.001, slippageBps: 2, exitTs: NOW + 60_000, exitPrice: 102, exitReason: "take_profit",
  grossR: 1, costR: 0, netR: 1, mfeR: 0, maeR: 0, ...over,
});

describe("LearningService.onShadowClosed: 停止中・別 mode の仮想トレード", () => {
  it("halted / order_unknown / risk の停止理由は保存するが腕を更新しない", () => {
    const store = new MemoryStore();
    const s = svc(store, "paper");
    s.onShadowClosed(shadowRec({ id: "h", reason: "halted" }));
    s.onShadowClosed(shadowRec({ id: "o", reason: "order_unknown" }));
    s.onShadowClosed(shadowRec({ id: "k", reason: "risk: キルスイッチ作動中 (最大ドローダウン超過 #%)" }));
    s.onShadowClosed(shadowRec({ id: "d", reason: "risk: 日次損失上限により #-#-#T#Z まで停止中" }));
    expect(store.listShadowTrades().map((t) => t.id).sort()).toEqual(["d", "h", "k", "o"]);
    expect(s.allocator.get(KEY)).toBeUndefined();
    // 停止系以外の見送り (risk の他の理由を含む) は使う
    s.onShadowClosed(shadowRec({ id: "a", reason: "arm_disabled" }));
    s.onShadowClosed(shadowRec({ id: "r", reason: "risk: 最大保有数 # に到達" }));
    expect(s.allocator.get(KEY)).toMatchObject({ shadowN: 2 });
  });

  it("別の mode の仮想トレードでは腕を更新しない", () => {
    const store = new MemoryStore();
    const s = svc(store, "live");
    s.onShadowClosed(shadowRec({ id: "p", mode: "paper" }));
    expect(s.allocator.get(KEY)).toBeUndefined();
    s.onShadowClosed(shadowRec({ id: "l", mode: "live" }));
    expect(s.allocator.get(KEY)).toMatchObject({ shadowN: 1 });
  });

  it("isHaltShadowReason", () => {
    expect(isHaltShadowReason("halted")).toBe(true);
    expect(isHaltShadowReason("order_unknown")).toBe(true);
    expect(isHaltShadowReason("risk: キルスイッチ作動中 (x)")).toBe(true);
    expect(isHaltShadowReason("direction_bias")).toBe(false);
    expect(isHaltShadowReason("risk: 期待値幅 #bps < コスト")).toBe(false);
    expect(isHaltShadowReason(undefined)).toBe(false);
  });
});

describe("LearningService.onTradeClosed: 推定約定は学習しない", () => {
  it("estimated の取引は保存するが腕・要因分析を更新しない", () => {
    const store = new MemoryStore();
    const s = svc(store, "paper");
    s.onTradeClosed(trade("paper", 1, { estimated: true }));
    expect(store.listTrades()).toHaveLength(1);
    expect(store.listAttributions()).toEqual([]);
    expect(s.allocator.get(KEY)).toBeUndefined();
  });
});
