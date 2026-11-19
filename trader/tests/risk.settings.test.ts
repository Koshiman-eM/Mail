import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RISK, loadConfig, RISK_SETTING_KEYS, RISK_SETTING_SPECS } from "../src/core/config";
import type { Instrument, RiskLimits, Signal } from "../src/core/types";
import { RiskManager, type EntryParams } from "../src/risk/manager";
import {
  applyRiskSettingsChange, checkRiskValue, effectiveRiskLimits, readRiskOverride, RISK_LIMITS_AUDIT, RISK_PRESET_IDS, RISK_PRESET_KEYS, RISK_PRESETS,
  RISK_RAISE_CONFIRM, riskLimitsKey, riskOverrideLines, riskValuesOf,
} from "../src/risk/settings";
import { MemoryStore, SqliteStore } from "../src/storage";

const NOW = Date.parse("2026-03-02T12:00:00Z");
const env: RiskLimits = DEFAULT_RISK;

const change = (store: MemoryStore, mode: "paper" | "live", request: unknown, metrics = {}) =>
  applyRiskSettingsChange({ store, mode, envLimits: env, request, metrics, now: NOW });

describe("範囲とプリセットの定義 (config.ts と共有)", () => {
  it("環境変数の検証とダッシュボードの検証が同じ範囲を使う", () => {
    for (const k of RISK_SETTING_KEYS) {
      const s = RISK_SETTING_SPECS[k];
      // 上限ちょうどは通り、少し超えると両方で拒否
      expect(() => loadConfig({ [s.env]: String(s.max) })).not.toThrow();
      expect(checkRiskValue(k, s.max)).toBeUndefined();
      const over = s.kind === "ratio" ? s.max + 0.001 : s.max + 1;
      expect(() => loadConfig({ [s.env]: String(over) })).toThrow(new RegExp(s.env));
      expect(checkRiskValue(k, over)).toBeDefined();
    }
    expect(checkRiskValue("riskPerTrade", 0)).toBeDefined();
    expect(checkRiskValue("maxOpenPositions", 2.5)).toMatch(/整数/);
    expect(checkRiskValue("maxOpenPositions", 0)).toBeDefined();
    // 発注数の上限は .env の値より上げられない
    expect(checkRiskValue("maxOrdersPerMinute", 31, 30)).toMatch(/安全装置/);
    expect(checkRiskValue("maxOrdersPerMinute", 10, 30)).toBeUndefined();
  });

  it("プリセット: 標準 = 既定値、全値が範囲内、発注数の上限は含まない", () => {
    expect(riskValuesOf(DEFAULT_RISK)).toMatchObject(RISK_PRESETS.standard.values);
    expect(RISK_PRESETS.conservative.values).toEqual({
      riskPerTrade: 0.0025, maxDailyLoss: 0.015, maxDrawdown: 0.08, maxPositionPct: 0.1,
      maxExposureCrypto: 0.3, maxExposureMeme: 0.02, maxExposureFx: 0.3, maxExposureStock: 0.3, maxOpenPositions: 4,
    });
    expect(RISK_PRESETS.aggressive.values).toEqual({
      riskPerTrade: 0.01, maxDailyLoss: 0.05, maxDrawdown: 0.25, maxPositionPct: 0.3,
      maxExposureCrypto: 0.8, maxExposureMeme: 0.1, maxExposureFx: 0.8, maxExposureStock: 0.8, maxOpenPositions: 12,
    });
    for (const id of RISK_PRESET_IDS) {
      expect(Object.keys(RISK_PRESETS[id].values)).not.toContain("maxOrdersPerMinute");
      for (const k of RISK_PRESET_KEYS) expect(checkRiskValue(k, RISK_PRESETS[id].values[k])).toBeUndefined();
    }
  });
});

describe("applyRiskSettingsChange", () => {
  it("範囲外・整数でない・未知の項目・型違いは 400 で何も書かない", () => {
    const store = new MemoryStore();
    for (const values of [{ riskPerTrade: 0.06 }, { maxDrawdown: 0 }, { maxOpenPositions: 2.5 }, { maxOrdersPerMinute: 31 }, { maxExposureMeme: 1.5 }]) {
      const r = change(store, "paper", { action: "set", values });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
    expect(change(store, "paper", { action: "set", values: { nope: 1 } })).toMatchObject({ ok: false, status: 400 });
    expect(change(store, "paper", { action: "set", values: { riskPerTrade: "0.01" } })).toMatchObject({ ok: false, status: 400 });
    expect(change(store, "paper", { action: "drop" })).toMatchObject({ ok: false, status: 400 });
    expect(change(store, "paper", "x")).toMatchObject({ ok: false, status: 400 });
    expect(store.kvGet(riskLimitsKey("paper"))).toBeUndefined();
    expect(store.listAudit({}).filter((e) => e.type === RISK_LIMITS_AUDIT)).toHaveLength(0);
  });

  it("paper: 上げる変更も確認なしで保存し、監査ログに残す", () => {
    const store = new MemoryStore();
    const r = change(store, "paper", { action: "set", values: { riskPerTrade: 0.01 } });
    expect(r).toMatchObject({ ok: true, changed: true, raised: true });
    expect(store.kvGet(riskLimitsKey("paper"))).toMatchObject({ values: { riskPerTrade: 0.01 }, updatedAt: NOW, source: "dashboard" });
    expect(store.kvGet(riskLimitsKey("live"))).toBeUndefined(); // mode 別
    const a = store.listAudit({}).filter((e) => e.type === RISK_LIMITS_AUDIT);
    expect(a).toHaveLength(1);
    expect(a[0].data).toMatchObject({ mode: "paper", source: "dashboard", raised: true, preset: null, before: { riskPerTrade: 0.005 }, after: { riskPerTrade: 0.01 } });
  });

  it("live: 上げる変更は確認語が無ければ 409 (何も書かない)、確認語付きなら成功", () => {
    const store = new MemoryStore();
    const r = change(store, "live", { action: "set", values: { maxOpenPositions: 9, maxDailyLoss: 0.02 } });
    expect(r).toMatchObject({ ok: false, status: 409, needs: ["raise"], raisedKeys: ["maxOpenPositions"], confirmPhrase: RISK_RAISE_CONFIRM });
    expect(change(store, "live", { action: "set", values: { maxOpenPositions: 9 }, confirm: "違う" })).toMatchObject({ ok: false, status: 409 });
    expect(store.kvGet(riskLimitsKey("live"))).toBeUndefined();
    const ok = change(store, "live", { action: "set", values: { maxOpenPositions: 9, maxDailyLoss: 0.02 }, confirm: RISK_RAISE_CONFIRM });
    expect(ok).toMatchObject({ ok: true, changed: true, raised: true });
    const a = store.listAudit({}).filter((e) => e.type === RISK_LIMITS_AUDIT);
    expect(a.at(-1)!.data).toMatchObject({ mode: "live", raised: true, after: { maxOpenPositions: 9, maxDailyLoss: 0.02 } });
  });

  it("live: 下げる変更は確認なしで即時に成功 (raised: false)", () => {
    const store = new MemoryStore();
    const r = change(store, "live", { action: "set", values: { riskPerTrade: 0.0025, maxOrdersPerMinute: 10 } });
    expect(r).toMatchObject({ ok: true, changed: true, raised: false });
    expect(effectiveRiskLimits(env, store, "live").limits).toMatchObject({ riskPerTrade: 0.0025, maxOrdersPerMinute: 10 });
    // 上書き済みの値から比べる: 0.0025 → 0.004 は (.env の 0.005 より低くても) 上げる変更
    expect(change(store, "live", { action: "set", values: { riskPerTrade: 0.004 } })).toMatchObject({ ok: false, status: 409 });
    expect(store.listAudit({}).filter((e) => e.type === RISK_LIMITS_AUDIT).at(-1)!.data).toMatchObject({ raised: false });
  });

  it("最大 DD を現在の DD 以下にする変更は paper でも確認が必要 (acknowledgeDrawdown で保存、警告付き)", () => {
    const store = new MemoryStore();
    const metrics = { drawdownPct: 0.1, dailyLossPct: 0.025, killSwitch: false };
    const r = change(store, "paper", { action: "set", values: { maxDrawdown: 0.08 } }, metrics);
    expect(r).toMatchObject({ ok: false, status: 409, needs: ["drawdown"], drawdownPct: 0.1 });
    // 現在の DD より大きければ確認不要
    expect(change(new MemoryStore(), "paper", { action: "set", values: { maxDrawdown: 0.12 } }, metrics)).toMatchObject({ ok: true });
    // live で上げる + DD の両方が必要なら両方を返す
    const both = change(new MemoryStore(), "live", { action: "set", values: { maxDrawdown: 0.08, riskPerTrade: 0.01 } }, metrics);
    expect(both).toMatchObject({ ok: false, status: 409, needs: ["raise", "drawdown"] });
    const ok = change(store, "paper", { action: "set", values: { maxDrawdown: 0.08, maxDailyLoss: 0.02 }, acknowledgeDrawdown: true }, metrics);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.warnings.join(" ")).toMatch(/キルスイッチ.*[\s\S]*日次/);
    // 既にキルスイッチ作動中なら新たな確認は不要
    expect(change(new MemoryStore(), "paper", { action: "set", values: { maxDrawdown: 0.05 } }, { ...metrics, killSwitch: true })).toMatchObject({ ok: true });
  });

  it("プリセット名は値が一致するときだけ残す", () => {
    const store = new MemoryStore();
    change(store, "paper", { action: "set", values: RISK_PRESETS.conservative.values, preset: "conservative" });
    expect(readRiskOverride(store, "paper", env)?.preset).toBe("conservative");
    change(store, "paper", { action: "set", values: { ...RISK_PRESETS.conservative.values, maxOpenPositions: 5 }, preset: "conservative" });
    expect(readRiskOverride(store, "paper", env)?.preset).toBeUndefined();
  });

  it(".env の値に戻す: 上書きを削除する。live で戻すとリスクが上がるなら確認語が必要", () => {
    const store = new MemoryStore();
    change(store, "live", { action: "set", values: RISK_PRESETS.conservative.values, preset: "conservative" });
    expect(store.kvGet(riskLimitsKey("live"))).toBeDefined();
    expect(change(store, "live", { action: "reset" })).toMatchObject({ ok: false, status: 409, needs: ["raise"] });
    const r = change(store, "live", { action: "reset", confirm: RISK_RAISE_CONFIRM });
    expect(r).toMatchObject({ ok: true, changed: true, raised: true });
    expect(store.kvGet(riskLimitsKey("live"))).toBeUndefined();
    expect(effectiveRiskLimits(env, store, "live").limits).toEqual(env);
    expect(store.listAudit({}).filter((e) => e.type === RISK_LIMITS_AUDIT).at(-1)!.data).toMatchObject({ action: "reset", after: riskValuesOf(env) });
    // 上書きが無ければ変更なし (監査ログも増えない)
    const n = store.listAudit({}).length;
    expect(change(store, "live", { action: "reset" })).toMatchObject({ ok: true, changed: false });
    expect(store.listAudit({}).length).toBe(n);
  });

  it("kv の壊れた値・範囲外は無視し、発注数の上限は .env 以下に頭打ち", () => {
    const store = new MemoryStore();
    store.kvSet(riskLimitsKey("paper"), { values: { riskPerTrade: 0.5, maxDrawdown: "x", maxOpenPositions: 3, maxOrdersPerMinute: 500 }, updatedAt: 1, source: "dashboard" });
    const o = readRiskOverride(store, "paper", env)!;
    expect(o.values).toEqual({ maxOpenPositions: 3, maxOrdersPerMinute: 30 });
    store.kvSet(riskLimitsKey("paper"), "garbage");
    expect(effectiveRiskLimits(env, store, "paper").limits).toEqual(env);
  });

  it("CLI 用の表示: 上書きの有無と実効値", () => {
    const store = new MemoryStore();
    expect(riskOverrideLines(store, "paper", env, String).join("\n")).toMatch(/なし/);
    change(store, "paper", { action: "set", values: { riskPerTrade: 0.0025 } });
    const t = riskOverrideLines(store, "paper", env, String).join("\n");
    expect(t).toMatch(/あり/);
    expect(t).toMatch(/1 トレードのリスク: 実効 0\.25% \(\.env 0\.5%\)/);
  });
});

// ───────── RiskManager への反映 ─────────

const btc: Instrument = { symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "USDT", tickSize: 0.01, lotSize: 0.001, minQty: 0.001, minNotional: 10, takerFeeRate: 0.001, makerFeeRate: 0.0005, allowShort: false };
const quote = { ts: NOW, bid: 99.99, ask: 100.01 };
const sig: Signal = {
  strategyId: "s", horizon: "short", symbol: "BTC/USDT", direction: "long", confidence: 1, expectedEdgeBps: 100,
  entry: { type: "market" }, stopLoss: 99, maxHoldMs: 1000, reason: "", features: {},
};
const params = (o: Partial<EntryParams> = {}): EntryParams => ({
  signal: sig, instrument: btc, quote, equity: 10_000, available: 10_000, positions: [], riskMultiplier: 1, now: NOW, ...o,
});
const qtyOf = (d: ReturnType<RiskManager["evaluateEntry"]>) => (d.ok ? Number(d.qty) : NaN);

describe("RiskManager: 上書き値の反映", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("次の評価から新しい値を使う (キャッシュ 0) / 既定のキャッシュでも onEquity (毎ティック) で読み直す", () => {
    const store = new MemoryStore();
    const rm = new RiskManager(env, store, { mode: "paper", overrideCacheMs: 0 });
    const before = qtyOf(rm.evaluateEntry(params()));
    // 既定では 1 銘柄上限 20% で頭打ち (≒ 20)。10% に下げると半分になる
    change(store, "paper", { action: "set", values: { riskPerTrade: 0.0025, maxPositionPct: 0.1 } });
    const after = qtyOf(rm.evaluateEntry(params()));
    expect(before).toBeGreaterThan(19);
    expect(after).toBeCloseTo(before / 2, 2);
    expect(rm.limits.riskPerTrade).toBe(0.0025);
    expect(rm.baseLimits.riskPerTrade).toBe(0.005);

    const rm2 = new RiskManager(env, store, { mode: "paper" }); // 既定 2 秒キャッシュ
    expect(rm2.limits.maxOpenPositions).toBe(8);
    change(store, "paper", { action: "set", values: { riskPerTrade: 0.0025, maxOpenPositions: 1 } });
    rm2.onEquity(10_000, NOW); // エンジンは毎ティック呼ぶ
    const d = rm2.evaluateEntry(params({ positions: [{ symbol: "ETH/USDT", qty: 1, avgPrice: 10, assetClass: "crypto" }] }));
    expect(d).toMatchObject({ ok: false, reason: expect.stringMatching(/最大保有数 1/) });
  });

  it("日次損失・DD の判定は新しい実効値で行う (DD 上限を下げるとキルスイッチ)", () => {
    const store = new MemoryStore();
    const rm = new RiskManager(env, store, { mode: "live" });
    rm.onEquity(10_000, NOW);
    expect(rm.onEquity(9_000, NOW + 1).killSwitch).toBe(false); // DD 10% < 15%
    change(store, "live", { action: "set", values: { maxDrawdown: 0.08 } }, { drawdownPct: 0.1 }); // 確認なし → 409
    expect(rm.onEquity(9_000, NOW + 2).killSwitch).toBe(false);
    change(store, "live", { action: "set", values: { maxDrawdown: 0.08 }, acknowledgeDrawdown: true }, { drawdownPct: 0.1 });
    expect(rm.onEquity(9_000, NOW + 3).killSwitch).toBe(true);
    expect(store.listAudit({}).some((e) => e.type === "risk.kill_switch")).toBe(true);

    const rm2 = new RiskManager(env, new MemoryStore(), { mode: "paper" });
    const s2 = (rm2 as unknown as { store: MemoryStore }).store;
    rm2.onEquity(10_000, NOW);
    expect(rm2.onEquity(9_800, NOW + 1).halted).toBe(false); // 日次 2% < 3%
    change(s2, "paper", { action: "set", values: { maxDailyLoss: 0.015 } });
    expect(rm2.onEquity(9_800, NOW + 2).halted).toBe(true);
  });

  it("再起動 (新しい RiskManager・DB の開き直し) 後も上書きが効き、.env に戻すと元の値", () => {
    const dir = mkdtempSync(join(tmpdir(), "risk-settings-"));
    dirs.push(dir);
    const path = join(dir, "t.db");
    let store = new SqliteStore(path);
    expect(applyRiskSettingsChange({ store, mode: "paper", envLimits: env, request: { action: "set", values: { maxOpenPositions: 3 } }, metrics: {}, now: NOW }).ok).toBe(true);
    store.close();
    store = new SqliteStore(path);
    const rm = new RiskManager(env, store, { mode: "paper" });
    expect(rm.limits.maxOpenPositions).toBe(3);
    expect(new RiskManager(env, store, { mode: "live" }).limits.maxOpenPositions).toBe(8); // live には持ち込まない
    expect(new RiskManager(env, store, "custom:key").limits.maxOpenPositions).toBe(8); // 文字列キー指定では読まない
    applyRiskSettingsChange({ store, mode: "paper", envLimits: env, request: { action: "reset" }, metrics: {}, now: NOW + 1 });
    expect(rm.refreshLimits().maxOpenPositions).toBe(8);
    store.close();
  });
});
