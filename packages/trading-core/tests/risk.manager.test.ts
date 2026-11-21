import { describe, expect, it } from "vitest";
import { coreDefaultRisk } from "../src/testing/runtime";

const DEFAULT_RISK = coreDefaultRisk();
import { classExposure, costBps, DEFAULT_TEMPO_MIN_EDGE_TO_COST, MAX_SIZE_MULTIPLIER, MIN_STOP_DISTANCE_SPREADS, RiskManager, tempoEdgeRequirement, type EntryParams } from "../src/risk/manager";
import type { AuditEvent, Instrument, RiskLimits, Signal, Store } from "../src/core/types";

const NOW = Date.parse("2025-03-01T12:00:00Z");
const limits: RiskLimits = { ...DEFAULT_RISK, riskPerTrade: 0.01, maxPositionPct: 0.5, minEdgeToCostRatio: 2, maxOpenPositions: 2, memeMinLiquidityUsd: 100_000 };

const btc: Instrument = { symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "USDT", tickSize: 0.01, lotSize: 0.001, minQty: 0.001, minNotional: 10, takerFeeRate: 0.001, makerFeeRate: 0.0005, allowShort: false };
const pepe: Instrument = { ...btc, symbol: "PEPE/USDT", assetClass: "meme", baseCurrency: "PEPE", lotSize: 1, minQty: 1 };
const quote = { ts: NOW, bid: 99.99, ask: 100.01 }; // スプレッド 2bps、手数料往復 20bps → cost ≈ 22bps

const sig = (o: Partial<Signal> = {}): Signal => ({
  strategyId: "s", horizon: "short", symbol: "BTC/USDT", direction: "long", confidence: 1, expectedEdgeBps: 100,
  entry: { type: "market" }, stopLoss: 99, maxHoldMs: 1000, reason: "", features: {}, ...o,
});
const params = (o: Partial<EntryParams> = {}): EntryParams => ({
  signal: sig(), instrument: btc, quote, equity: 10_000, available: 10_000, positions: [], riskMultiplier: 1, now: NOW, ...o,
});

function memStore() {
  const kv = new Map<string, unknown>();
  const audits: AuditEvent[] = [];
  const store = { kvGet: (k: string) => kv.get(k), kvSet: (k: string, v: unknown) => void kv.set(k, structuredClone(v)), audit: (e: AuditEvent) => void audits.push(e) } as unknown as Store;
  return { store, audits };
}

describe("costBps", () => {
  it("往復 taker 手数料 + スプレッド", () => {
    expect(costBps(btc, quote)).toBeCloseTo(20 + 2, 2);
    expect(costBps({ takerFeeRate: 0 }, { bid: 150, ask: 150.015 })).toBeCloseTo(1, 1);
  });
});

describe("RiskManager.evaluateEntry", () => {
  it("サイジング: equity×risk×conf係数 / 損切り幅", () => {
    const rm = new RiskManager(limits);
    // 10000*0.01*(0.5+0.5*1)=100 / (100.01-99)=1.01 → 99.0099 → cap: maxPositionPct 0.5 → 5000/100.01=49.995 → lot 0.001 で 49.995
    const d = rm.evaluateEntry(params());
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(Number(d.qty)).toBeCloseTo(49.995, 6);
      expect(d.notes.join(" ")).toMatch(/1銘柄上限/);
    }
    // 損切りが遠ければリスク基準が効く: dist=10.01 → 100/10.01=9.99 (conf 0.5 → 75/10.01=7.492)
    const d2 = rm.evaluateEntry(params({ signal: sig({ stopLoss: 90, confidence: 0.5 }) }));
    expect(d2.ok && Number(d2.qty)).toBeCloseTo(7.492, 3);
    const d3 = rm.evaluateEntry(params({ signal: sig({ stopLoss: 90 }), riskMultiplier: 0.5 }));
    expect(d3.ok && Number(d3.qty)).toBeCloseTo(4.995, 3);
  });

  it("コスト比・ショート不可・不正な損切り・flat", () => {
    const rm = new RiskManager(limits);
    expect(rm.evaluateEntry(params({ signal: sig({ expectedEdgeBps: 40 }) }))).toMatchObject({ ok: false, reason: expect.stringContaining("コスト") });
    expect(rm.evaluateEntry(params({ signal: sig({ direction: "short", stopLoss: 101 }) }))).toMatchObject({ ok: false, reason: expect.stringContaining("空売り不可") });
    expect(rm.evaluateEntry(params({ signal: sig({ stopLoss: 101 }) }))).toMatchObject({ ok: false, reason: expect.stringContaining("損切り") });
    expect(rm.evaluateEntry(params({ signal: sig({ direction: "flat" }) })).ok).toBe(false);
  });

  it("ショート可能な銘柄は売りエントリー", () => {
    const rm = new RiskManager(limits);
    const d = rm.evaluateEntry(params({ instrument: { ...btc, allowShort: true }, signal: sig({ direction: "short", stopLoss: 110 }) }));
    expect(d.ok).toBe(true);
  });

  it("最大保有数・1銘柄上限・資産クラス上限・余力", () => {
    const rm = new RiskManager(limits);
    const pos = (symbol: string, qty = 1) => ({ symbol, qty, avgPrice: 100, assetClass: "crypto" as const });
    expect(rm.evaluateEntry(params({ positions: [pos("A/B"), pos("C/D")] }))).toMatchObject({ ok: false, reason: expect.stringContaining("最大保有数") });
    // 既に BTC を 5000 USDT 分 → 上限到達
    expect(rm.evaluateEntry(params({ positions: [pos("BTC/USDT", 50)] }))).toMatchObject({ ok: false, reason: expect.stringContaining("1銘柄上限") });
    // クラス上限 60%: 他銘柄で 5500 使用済み → 残り 500 → qty 4.999
    const d = rm.evaluateEntry(params({ positions: [pos("ETH/USDT", 55)] }));
    expect(d.ok && Number(d.qty)).toBeCloseTo(4.999, 3);
    // 余力 200 → 約 2
    const d2 = rm.evaluateEntry(params({ available: 200 }));
    expect(d2.ok && Number(d2.qty)).toBeCloseTo(1.999, 3);
    expect(rm.evaluateEntry(params({ available: 0 })).ok).toBe(false);
  });

  it("最小数量・最小約定代金", () => {
    const rm = new RiskManager(limits);
    expect(rm.evaluateEntry(params({ equity: 1, available: 1 }))).toMatchObject({ ok: false });
    const d = rm.evaluateEntry(params({ instrument: { ...btc, minNotional: 1e9 } }));
    expect(d).toMatchObject({ ok: false, reason: expect.stringContaining("最小") });
  });

  it("ミームは流動性不足・不明を拒否", () => {
    const rm = new RiskManager(limits);
    const p = params({ instrument: pepe, signal: sig({ symbol: "PEPE/USDT" }) });
    expect(rm.evaluateEntry(p)).toMatchObject({ ok: false, reason: expect.stringContaining("不明") });
    expect(rm.evaluateEntry({ ...p, liquidityUsd: 50_000 })).toMatchObject({ ok: false, reason: expect.stringContaining("流動性") });
    expect(rm.evaluateEntry({ ...p, liquidityUsd: 500_000 }).ok).toBe(true);
  });

  it("1分あたりの発注数上限", () => {
    const rm = new RiskManager({ ...limits, maxOrdersPerMinute: 2 });
    rm.recordOrder(NOW - 10_000);
    rm.recordOrder(NOW - 5_000);
    expect(rm.evaluateEntry(params())).toMatchObject({ ok: false, reason: expect.stringContaining("1分") });
    expect(rm.evaluateEntry(params({ now: NOW + 60_000 })).ok).toBe(true);
  });

  it("口座通貨換算 (JPY 建ての銘柄、USD 口座)", () => {
    const rm = new RiskManager({ ...limits, maxPositionPct: 100, maxExposureByClass: { ...limits.maxExposureByClass, crypto: 100 } });
    const jpy: Instrument = { ...btc, symbol: "XRP/JPY", baseCurrency: "XRP", quoteCurrency: "JPY", lotSize: 1, minQty: 1, minNotional: undefined, takerFeeRate: 0, allowShort: true, contractSize: 1 };
    // 口座 USD 1000, risk 1% = 10 USD, 損切り幅 0.5 JPY = 0.005 USD/単位 → 2000 単位 (10/0.005)
    const d = rm.evaluateEntry({
      ...params({ instrument: jpy, signal: sig({ symbol: "XRP/JPY", stopLoss: 149.5 }), quote: { ts: NOW, bid: 149.99, ask: 150 }, equity: 1000, available: 1e9, toAccount: (c) => (c === "JPY" ? 0.01 : 1) }),
    });
    expect(d.ok && Number(d.qty)).toBe(2000);
  });

  it("廃止した資産クラス (fx / stock) の古い建玉があっても例外にせず、その銘柄の新規は上限が無いので拒否する", () => {
    const rm = new RiskManager({ ...limits, maxPositionPct: 100 });
    const old = { ...btc, symbol: "USD/JPY", assetClass: "fx", quoteCurrency: "JPY", allowShort: true } as unknown as Instrument;
    // 古い fx の建玉は crypto の上限に数えない (別のクラスのキーに積む)
    const ex = classExposure([{ symbol: "USD/JPY", qty: 10, avgPrice: 150, assetClass: "fx" as never }, { symbol: "BTC/USDT", qty: 1, avgPrice: 100, assetClass: "crypto" }], {}, { "USD/JPY": old });
    expect(ex.exposure.crypto!.toNumber()).toBe(100);
    expect(ex.exposure.fx?.toNumber()).toBe(1500);
    // BTC の新規は従来どおり判定できる (fx の建玉があっても落ちない)
    const positions = [{ symbol: "USD/JPY", qty: 10, avgPrice: 150, assetClass: "fx" as never, quoteCurrency: "USDT" }];
    expect(rm.evaluateEntry(params({ positions })).ok).toBe(true);
    // 上限の無いクラスの銘柄の新規は拒否 (fail-closed)
    const d = rm.evaluateEntry(params({ instrument: old, signal: sig({ symbol: "USD/JPY", stopLoss: 149 }), quote: { ts: NOW, bid: 149.99, ask: 150 } }));
    expect(d).toMatchObject({ ok: false, reason: expect.stringContaining("対象外の資産クラス") });
  });
});

describe("損切りとスプレッド", () => {
  const wide = { ts: NOW, bid: 99, ask: 101 }; // スプレッド 2

  it("ロングの損切りが bid 以上 (スプレッドの内側) なら拒否", () => {
    const rm = new RiskManager({ ...limits, minEdgeToCostRatio: 0 });
    expect(rm.evaluateEntry(params({ quote: wide, signal: sig({ stopLoss: 100 }) }))).toMatchObject({ ok: false, reason: expect.stringContaining("スプレッドの内側") });
    expect(rm.evaluateEntry(params({ quote: wide, signal: sig({ stopLoss: 99 }) }))).toMatchObject({ ok: false, reason: expect.stringContaining("スプレッドの内側") });
  });

  it("ショートの損切りが ask 以下なら拒否", () => {
    const rm = new RiskManager({ ...limits, minEdgeToCostRatio: 0 });
    const inst = { ...btc, allowShort: true };
    expect(rm.evaluateEntry(params({ instrument: inst, quote: wide, signal: sig({ direction: "short", stopLoss: 100.5 }) }))).toMatchObject({
      ok: false, reason: expect.stringContaining("スプレッドの内側"),
    });
    // ask + スプレッド × 2 以上離れていれば可
    expect(rm.evaluateEntry(params({ instrument: inst, quote: wide, signal: sig({ direction: "short", stopLoss: 101 + 2 * MIN_STOP_DISTANCE_SPREADS }) })).ok).toBe(true);
  });

  it("決済側の価格からの距離はスプレッドの 2 倍以上", () => {
    const rm = new RiskManager({ ...limits, minEdgeToCostRatio: 0 });
    expect(MIN_STOP_DISTANCE_SPREADS).toBe(2);
    // bid 99 - stop 95.5 = 3.5 < 2 × 2
    expect(rm.evaluateEntry(params({ quote: wide, signal: sig({ stopLoss: 95.5 }) }))).toMatchObject({ ok: false, reason: expect.stringContaining("近すぎ") });
    expect(rm.evaluateEntry(params({ quote: wide, signal: sig({ stopLoss: 95 }) })).ok).toBe(true);
  });
});

describe("停止・再開", () => {
  it("NaN・非有限の評価額では状態を更新しない", () => {
    const { store } = memStore();
    const rm = new RiskManager(limits, store);
    rm.onEquity(10_000, NOW);
    const before = rm.state();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = rm.onEquity(bad, NOW + 1000);
      expect(r.killSwitch).toBe(false);
    }
    expect(rm.state()).toEqual(before);
    expect(rm.onEquity(9_000, NOW + 2000).dailyLossPct).toBeCloseTo(0.1, 9);
  });

  it("状態は mode 別のキーに保存し、paper は旧キーを引き継ぐ。live は旧キー・paper の状態を読まない", () => {
    const { store } = memStore();
    store.kvSet("risk:state", { dayStartEquity: 1_000_000, peakEquity: 1_200_000, recentOrderTs: [], killSwitch: { at: 1, reason: "old" } });
    const paper = new RiskManager(limits, store, { mode: "paper" });
    expect(paper.state()).toMatchObject({ peakEquity: 1_200_000, killSwitch: { reason: "old" } });
    const live = new RiskManager(limits, store, { mode: "live" });
    expect(live.state()).toMatchObject({ peakEquity: 0, dayStartEquity: 0 });
    expect(live.state().killSwitch).toBeUndefined();
    // live の初回は現在の評価額で初期化 (paper の基準で kill switch を作動させない)
    expect(live.onEquity(1_000, NOW).killSwitch).toBe(false);
    expect(live.state()).toMatchObject({ peakEquity: 1_000, dayStartEquity: 1_000 });
    expect(store.kvGet("risk:state:live")).toMatchObject({ peakEquity: 1_000 });
    paper.onEquity(1_300_000, NOW);
    expect(store.kvGet("risk:state:paper")).toMatchObject({ peakEquity: 1_300_000 });
    expect(new RiskManager(limits, store, { mode: "live" }).state().peakEquity).toBe(1_000);
  });


  it("日次損失で当日停止、翌日 0:00 UTC に解除。監査ログが残る", () => {
    const { store, audits } = memStore();
    const rm = new RiskManager(limits, store);
    rm.onEquity(10_000, NOW);
    const r = rm.onEquity(9_600, NOW + 1000); // -4% > 3%
    expect(r.halted).toBe(true);
    expect(rm.state().haltedUntil).toBe(Date.parse("2025-03-02T00:00:00Z"));
    expect(rm.evaluateEntry(params({ now: NOW + 2000 }))).toMatchObject({ ok: false, reason: expect.stringContaining("日次損失") });
    expect(audits.map((a) => a.type)).toContain("risk.halt_daily");
    expect(audits.map((a) => a.type)).toContain("risk.reject");
    // 翌日
    const next = Date.parse("2025-03-02T00:00:05Z");
    const r2 = rm.onEquity(9_600, next);
    expect(r2.halted).toBe(false);
    expect(rm.state().dayStartEquity).toBe(9_600);
    expect(rm.evaluateEntry(params({ now: next, equity: 9_600 })).ok).toBe(true);
  });

  it("最大 DD でキルスイッチ → resume まで停止 (翌日でも解除されない)", () => {
    const { store, audits } = memStore();
    const rm = new RiskManager({ ...limits, maxDailyLoss: 0.9 }, store);
    rm.onEquity(10_000, NOW);
    rm.onEquity(11_000, NOW + 1000);
    const r = rm.onEquity(9_000, NOW + 2000); // peak 11000 から -18% > 15%
    expect(r.killSwitch).toBe(true);
    const day2 = NOW + 2 * 86_400_000;
    rm.onEquity(9_000, day2);
    expect(rm.evaluateEntry(params({ now: day2 }))).toMatchObject({ ok: false, reason: expect.stringContaining("キルスイッチ") });
    rm.resume({ now: day2 });
    expect(audits.map((a) => a.type)).toEqual(expect.arrayContaining(["risk.kill_switch", "risk.resume"]));
    // 基準が再設定されるので直後に再発動しない
    expect(rm.onEquity(9_000, day2 + 1000).killSwitch).toBe(false);
    expect(rm.evaluateEntry(params({ now: day2 + 1000 })).ok).toBe(true);
  });

  it("状態は Store に永続化され再生成後も復元される", () => {
    const { store } = memStore();
    const a = new RiskManager(limits, store);
    a.onEquity(10_000, NOW);
    a.onEquity(8_000, NOW + 1000);
    a.recordOrder(NOW);
    const b = new RiskManager(limits, store);
    expect(b.state().killSwitch).toBeDefined();
    expect(b.state().recentOrderTs).toEqual([NOW]);
    expect(b.isHalted(NOW + 2000).halted).toBe(true);
  });
});

describe("classExposure", () => {
  it("資産クラス別の建玉額 (通貨換算・契約サイズ込み)", () => {
    const m = new Map<string, Instrument>([["BTC/USDT", btc], ["ETH/USDT:USDT", { ...btc, symbol: "ETH/USDT:USDT", contractSize: 0.01 }]]);
    const { exposure: e, unknown } = classExposure(
      [{ symbol: "BTC/USDT", qty: 2, avgPrice: 100 }, { symbol: "ETH/USDT:USDT", qty: -100, avgPrice: 10 }, { symbol: "PEPE", qty: 1, avgPrice: 1, assetClass: "meme" }, { symbol: "X", qty: 1, avgPrice: 1 }],
      { "BTC/USDT": 110 }, m, (c) => (c === "USDT" ? 2 : 1),
    );
    expect(e.crypto!.toNumber()).toBeCloseTo(2 * 110 * 2 + 100 * 10 * 0.01 * 2, 6);
    expect(e.meme!.toNumber()).toBe(1);
    expect(unknown.crypto).toBeUndefined();
  });
});

describe("為替・非有限値で上限判定を素通りさせない", () => {
  const eth: Instrument = { ...btc, symbol: "ETH/BTC", baseCurrency: "ETH", quoteCurrency: "BTC" };
  const insts = new Map<string, Instrument>([["BTC/USDT", btc], ["ETH/BTC", eth]]);
  // USDT は 1、BTC は換算できない (NaN)
  const toAccount = (c: string) => (c === "USDT" ? 1 : NaN);

  it("換算できない建玉があるクラスは「不明」(NaN を合計に混ぜない)", () => {
    const pos = [{ symbol: "BTC/USDT", qty: 1, avgPrice: 100 }, { symbol: "ETH/BTC", qty: 10, avgPrice: 0.05 }];
    const d = classExposure(pos, {}, insts, toAccount);
    expect(d.exposure.crypto!.toNumber()).toBe(100);
    expect(d.unknown.crypto).toEqual(["ETH/BTC"]);
    expect(d.exposure.meme!.toNumber()).toBe(0);
    expect(d.unknown.meme).toBeUndefined();
    // 価格が NaN の建玉も不明
    expect(classExposure([{ symbol: "BTC/USDT", qty: 1, avgPrice: NaN }], {}, insts).unknown.crypto).toEqual(["BTC/USDT"]);
  });

  it("再現: 換算できない ETH/BTC 建玉 1 件 + 上限超過のエントリーは拒否する (以前は ok:true)", () => {
    const rm = new RiskManager(limits);
    // crypto 上限 60% = 6000 を既に超える建玉 (ETH/BTC) があるが、為替が NaN
    const d = rm.evaluateEntry(params({ positions: [{ symbol: "ETH/BTC", qty: 1000, avgPrice: 0.05 }], instruments: insts, toAccount }));
    expect(d).toMatchObject({ ok: false, reason: expect.stringContaining("エクスポージャーが不明") });
    if (!d.ok) expect(d.reason).toContain("ETH/BTC");
    // 別クラス (meme) へのエントリーは影響しない
    const m = rm.evaluateEntry(params({ instrument: pepe, signal: sig({ symbol: "PEPE/USDT" }), liquidityUsd: 1e6, positions: [{ symbol: "ETH/BTC", qty: 1000, avgPrice: 0.05 }], instruments: insts, toAccount }));
    expect(m.ok).toBe(true);
  });

  it("エントリー銘柄の為替・評価額・余力・倍率が非有限なら拒否", () => {
    const rm = new RiskManager(limits);
    expect(rm.evaluateEntry(params({ toAccount: () => NaN }))).toMatchObject({ ok: false, reason: expect.stringContaining("換算できない") });
    expect(rm.evaluateEntry(params({ toAccount: () => Infinity })).ok).toBe(false);
    expect(rm.evaluateEntry(params({ equity: NaN })).ok).toBe(false);
    expect(rm.evaluateEntry(params({ equity: Infinity })).ok).toBe(false);
    expect(rm.evaluateEntry(params({ available: NaN })).ok).toBe(false);
    expect(rm.evaluateEntry(params({ available: Infinity })).ok).toBe(false);
    expect(rm.evaluateEntry(params({ riskMultiplier: Infinity })).ok).toBe(false);
    expect(rm.evaluateEntry(params({ riskMultiplier: NaN })).ok).toBe(false);
    // 既存の同じ銘柄の建玉の価格が NaN → 1 銘柄上限を確認できない
    expect(rm.evaluateEntry(params({ positions: [{ symbol: "BTC/USDT", qty: 1, avgPrice: NaN, assetClass: "crypto" }] }))).toMatchObject({
      ok: false, reason: expect.stringContaining("1銘柄上限を確認できません"),
    });
    expect(rm.evaluateEntry(params({ instrument: { ...btc, contractSize: NaN } })).ok).toBe(false);
  });

  it("サイズ倍率は RiskManager でも上限 1.5 に制限する", () => {
    const rm = new RiskManager({ ...limits, maxPositionPct: 1, maxExposureByClass: { ...limits.maxExposureByClass, crypto: 1 } });
    // 損切りが遠いのでリスク基準の数量が効く: 10000*0.01*m / 10.01
    const at = (m: number) => {
      const d = rm.evaluateEntry(params({ signal: sig({ stopLoss: 90 }), riskMultiplier: m }));
      return d.ok ? Number(d.qty) : NaN;
    };
    expect(MAX_SIZE_MULTIPLIER).toBe(1.5);
    expect(at(1.5)).toBeCloseTo(14.985, 3);
    expect(at(5)).toBeCloseTo(at(1.5), 9);
    const d = rm.evaluateEntry(params({ signal: sig({ stopLoss: 90 }), riskMultiplier: 3 }));
    expect(d.ok && d.notes.join(" ")).toMatch(/上限 1.5 に制限/);
  });
});

describe("RiskManager.evaluateEntry: テンポのモード (EntryParams.tempo)", () => {
  // cost = 往復手数料 20bps + スプレッド 2bps = 22bps、minEdgeToCostRatio = 2
  const COST = 22;
  const net = (edge: number) => sig({ expectedEdgeBps: edge, edgeIsNet: true });
  const reasonOf = (d: ReturnType<RiskManager["evaluateEntry"]>) => (d.ok ? "" : d.reason);

  it("tempo を渡さなくても edgeIsNet はコストを二重に数えない (純 ≥ (比率 − 1) × コスト かつ > 0)。控除前の期待値は従来どおり", () => {
    const rm = new RiskManager(limits);
    // edgeIsNet: (2 − 1) × 22 = 22bps 以上
    const ok = rm.evaluateEntry(params({ signal: net(23) }));
    expect(ok.ok && ok.notes[0]).toBe(`edge 23.0bps (net) / cost ${COST.toFixed(1)}bps`);
    const low = rm.evaluateEntry(params({ signal: net(21) }));
    expect(reasonOf(low)).toBe(`期待値 (コスト控除後) 21.0bps < コスト ${COST.toFixed(1)}bps × (2 - 1)`);
    for (const e of [0, -5, NaN]) expect(reasonOf(rm.evaluateEntry(params({ signal: net(e) }))), String(e)).toMatch(/コスト控除後.*0 以下/);
    // tempo 0 と同じ結果 (テンポの有無によらない)
    for (const e of [21, 23, 40]) expect(rm.evaluateEntry(params({ signal: net(e) })).ok, String(e)).toBe(rm.evaluateEntry(params({ signal: net(e), tempo: 0 })).ok);
    // 控除前の期待値 (edgeIsNet なし) は従来どおり 比率 × コスト
    const old = rm.evaluateEntry(params({ signal: sig({ expectedEdgeBps: 40 }) }));
    expect(reasonOf(old)).toBe(`期待値幅 40.0bps < コスト ${COST.toFixed(1)}bps × 2`);
    const ok2 = rm.evaluateEntry(params({ signal: sig({ expectedEdgeBps: 44.5 }) }));
    expect(ok2.ok && ok2.notes[0]).toBe(`edge 44.5bps / cost ${COST.toFixed(1)}bps`);
    // 比率が 1 以下なら edgeIsNet は > 0 だけ
    const loose = new RiskManager({ ...limits, minEdgeToCostRatio: 0.8 });
    expect(loose.evaluateEntry(params({ signal: net(0.1) })).ok).toBe(true);
    expect(loose.evaluateEntry(params({ signal: net(0) })).ok).toBe(false);
  });

  it("tempo 0: edgeIsNet はコストを二重に数えない (比率 - 1)。控除前の期待値は従来どおり", () => {
    const rm = new RiskManager(limits);
    expect(rm.evaluateEntry(params({ signal: net(23), tempo: 0 })).ok).toBe(true);
    const r = rm.evaluateEntry(params({ signal: net(21), tempo: 0 }));
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toMatch(/テンポ 0\.00: 期待値 \(コスト控除後\) 21\.0bps < コスト 22\.0bps × \(2\.00 - 1\)/);
    // edgeIsNet でないシグナルは 2 × コストのまま
    expect(rm.evaluateEntry(params({ signal: sig({ expectedEdgeBps: 40 }), tempo: 0 }))).toMatchObject({ ok: false, reason: expect.stringContaining("テンポ") });
    expect(rm.evaluateEntry(params({ signal: sig({ expectedEdgeBps: 44.5 }), tempo: 0 })).ok).toBe(true);
  });

  it("tempo 1: 比率を下限 1.0 まで緩める。edgeIsNet は > 0 だけ、それ以外は 1 × コスト", () => {
    const rm = new RiskManager(limits);
    const d = rm.evaluateEntry(params({ signal: net(0.5), tempo: 1 }));
    expect(d.ok).toBe(true);
    expect(d.ok && d.notes[0]).toMatch(/\(net\).*テンポ 1\.00 \(比率 1\.00\)/);
    for (const e of [0, -5, NaN]) {
      const x = rm.evaluateEntry(params({ signal: net(e), tempo: 1 }));
      expect(x.ok, String(e)).toBe(false);
      expect(reasonOf(x)).toMatch(/テンポ.*0 以下/);
    }
    expect(rm.evaluateEntry(params({ signal: sig({ expectedEdgeBps: 23 }), tempo: 1 })).ok).toBe(true);
    expect(rm.evaluateEntry(params({ signal: sig({ expectedEdgeBps: 21 }), tempo: 1 }))).toMatchObject({ ok: false, reason: expect.stringContaining("テンポ 1.00") });
    expect(rm.evaluateEntry(params({ signal: sig({ expectedEdgeBps: NaN }), tempo: 1 })).ok).toBe(false);
  });

  it("tempo 0.5: 比率 1.5 (edgeIsNet は 0.5 × コスト)。範囲外の tempo は 0〜1 に収める", () => {
    const rm = new RiskManager(limits);
    expect(rm.evaluateEntry(params({ signal: net(11.5), tempo: 0.5 })).ok).toBe(true);
    expect(rm.evaluateEntry(params({ signal: net(10.5), tempo: 0.5 })).ok).toBe(false);
    expect(rm.evaluateEntry(params({ signal: net(0.5), tempo: 5 })).ok).toBe(true);
    expect(rm.evaluateEntry(params({ signal: net(21), tempo: -1 })).ok).toBe(false);
  });

  it("tempoMinEdgeToCost で下限を上げられる (1.0 未満・非有限は 1.0)", () => {
    expect(DEFAULT_TEMPO_MIN_EDGE_TO_COST).toBe(1);
    const strict = new RiskManager({ ...limits, tempoMinEdgeToCost: 1.5 });
    expect(strict.evaluateEntry(params({ signal: net(10.5), tempo: 1 })).ok).toBe(false);
    expect(strict.evaluateEntry(params({ signal: net(11.5), tempo: 1 })).ok).toBe(true);
    for (const v of [0.3, NaN]) {
      const rm = new RiskManager({ ...limits, tempoMinEdgeToCost: v });
      expect(rm.evaluateEntry(params({ signal: net(0.5), tempo: 1 })).ok, String(v)).toBe(true);
      expect(rm.evaluateEntry(params({ signal: sig({ expectedEdgeBps: 21 }), tempo: 1 })).ok, String(v)).toBe(false);
    }
  });

  it("minEdgeToCostRatio が下限より低ければ設定のまま (締めない)", () => {
    const rm = new RiskManager({ ...limits, minEdgeToCostRatio: 0.8 });
    // 0.8 × 22 = 17.6
    expect(rm.evaluateEntry(params({ signal: sig({ expectedEdgeBps: 18 }), tempo: 1 })).ok).toBe(true);
    expect(rm.evaluateEntry(params({ signal: sig({ expectedEdgeBps: 17 }), tempo: 1 })).ok).toBe(false);
    expect(rm.evaluateEntry(params({ signal: net(0.1), tempo: 0 })).ok).toBe(true);
    expect(tempoEdgeRequirement({ minEdgeToCostRatio: 0.8 }, 1, COST, false)).toEqual({ ratio: 0.8, minEdgeBps: 0.8 * COST, requirePositive: false });
    expect(tempoEdgeRequirement({ minEdgeToCostRatio: 0.8 }, 1, COST, true)).toEqual({ ratio: 0.8, minEdgeBps: 0, requirePositive: true });
  });

  it("コスト比以外の判定は変えない (空売り不可・停止中・損切り・サイズ)", () => {
    const rm = new RiskManager(limits);
    expect(rm.evaluateEntry(params({ signal: sig({ direction: "short", stopLoss: 101, edgeIsNet: true }), tempo: 1 }))).toMatchObject({ ok: false, reason: expect.stringContaining("空売り不可") });
    expect(rm.evaluateEntry(params({ signal: sig({ stopLoss: 101, expectedEdgeBps: 5, edgeIsNet: true }), tempo: 1 }))).toMatchObject({ ok: false, reason: expect.stringContaining("損切り") });
    expect(rm.evaluateEntry(params({ signal: sig({ stopLoss: 99.995, expectedEdgeBps: 5, edgeIsNet: true }), tempo: 1 }))).toMatchObject({ ok: false, reason: expect.stringContaining("損切り") });
    // サイズはテンポの有無で同じ
    const a = rm.evaluateEntry(params({ signal: sig({ stopLoss: 90, expectedEdgeBps: 100, edgeIsNet: true }) }));
    const b = rm.evaluateEntry(params({ signal: sig({ stopLoss: 90, expectedEdgeBps: 100, edgeIsNet: true }), tempo: 1 }));
    expect(a.ok && b.ok && a.qty === b.qty).toBe(true);
    rm.trip("test", NOW);
    expect(rm.evaluateEntry(params({ signal: net(100), tempo: 1 }))).toMatchObject({ ok: false, reason: expect.stringContaining("キルスイッチ") });
  });

  it("探索 (tempoExplore): edgeIsNet は「> 0」を外し、下限を tempo × コスト下げる。NaN は拒否", () => {
    const rm = new RiskManager(limits);
    // tempo 1: 比率 1.0 → 下限 0 - 1 × 22 = -22
    expect(tempoEdgeRequirement(limits, 1, COST, true, true)).toEqual({ ratio: 1, minEdgeBps: -COST, requirePositive: false });
    const ok = rm.evaluateEntry(params({ signal: net(-21), tempo: 1, tempoExplore: true }));
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.notes[0]).toMatch(/テンポ 1\.00 \(探索\)/);
    expect(rm.evaluateEntry(params({ signal: net(0), tempo: 1, tempoExplore: true })).ok).toBe(true);
    const ng = rm.evaluateEntry(params({ signal: net(-23), tempo: 1, tempoExplore: true }));
    expect(ng.ok).toBe(false);
    expect(reasonOf(ng)).toMatch(/探索.*< コスト 22\.0bps × \(1\.00 - 1 - 1\.00\)/);
    expect(rm.evaluateEntry(params({ signal: net(NaN), tempo: 1, tempoExplore: true })).ok).toBe(false);
    // tempo 0.5: 比率 1.5 → 下限 0.5 × 22 - 0.5 × 22 = 0 (「> 0」は外れるので 0 は通る)
    expect(tempoEdgeRequirement(limits, 0.5, COST, true, true)).toEqual({ ratio: 1.5, minEdgeBps: 0, requirePositive: false });
    expect(rm.evaluateEntry(params({ signal: net(0), tempo: 0.5, tempoExplore: true })).ok).toBe(true);
    expect(rm.evaluateEntry(params({ signal: net(-0.1), tempo: 0.5, tempoExplore: true })).ok).toBe(false);
    // tempo 0: 探索でも下限は (比率 - 1) × コストのまま
    expect(rm.evaluateEntry(params({ signal: net(21), tempo: 0, tempoExplore: true })).ok).toBe(false);
    expect(rm.evaluateEntry(params({ signal: net(23), tempo: 0, tempoExplore: true })).ok).toBe(true);
  });

  it("探索でも控除前の期待値のシグナルは変えない。tempoExplore が false・tempo 無しなら従来どおり", () => {
    const rm = new RiskManager(limits);
    expect(tempoEdgeRequirement(limits, 1, COST, false, true)).toEqual(tempoEdgeRequirement(limits, 1, COST, false));
    expect(rm.evaluateEntry(params({ signal: sig({ expectedEdgeBps: 21 }), tempo: 1, tempoExplore: true })).ok).toBe(false);
    expect(rm.evaluateEntry(params({ signal: sig({ expectedEdgeBps: -5 }), tempo: 1, tempoExplore: true })).ok).toBe(false);
    expect(rm.evaluateEntry(params({ signal: net(-5), tempo: 1, tempoExplore: false })).ok).toBe(false);
    // tempo が無ければ tempoExplore は無視 (従来の比率 × コスト)
    const old = rm.evaluateEntry(params({ signal: net(40) }));
    expect(rm.evaluateEntry(params({ signal: net(40), tempoExplore: true }))).toEqual(old);
    expect(rm.evaluateEntry(params({ signal: net(-5), tempoExplore: true })).ok).toBe(false);
  });
});
