/** 読みの管理 (src/engine/thesis.ts) の純粋な判定 */
import { describe, expect, it } from "vitest";
import { coreConfig as loadConfig } from "../src/testing/runtime";
import {
  activeThesisMs, advancePeak, breakevenPrice, thesisGrossR, decideThesis, DEFAULT_THESIS_SETTINGS, formatThesisSettings, initialRiskPerUnit, resolveThesisMs, THESIS_DISABLED,
  thesisNetR, thesisOutcomeOf, thesisSettingsFromEnv, thesisTrailStop, tighterStop, type ThesisInput, type ThesisPricing, type ThesisSettings,
} from "../src/engine/thesis";

const MIN = 60_000;
const S: ThesisSettings = { ...DEFAULT_THESIS_SETTINGS };
/** 判定の入力 (値動きだけの R は省略時 純 R と同じ) */
const at = (elapsedMin: number, netR: number, o: Partial<ThesisInput> = {}): ThesisInput => ({
  elapsedMs: elapsedMin * MIN, maxHoldMs: 10 * MIN, extended: false, netR, grossR: netR, ...o,
});

describe("設定", () => {
  it("既定値: 有効 / 最低 0.1R / 途中 0.5R / 延長 4 倍 / トレーリング 0.5R", () => {
    const env = loadConfig({}).env;
    expect(thesisSettingsFromEnv(env)).toEqual({ enabled: true, minR: 0.1, earlyCutR: 0.5, extendMult: 4, trailR: 0.5 });
    // 手組みの設定 (未設定) も config の既定値と同じ
    expect(thesisSettingsFromEnv({})).toEqual(DEFAULT_THESIS_SETTINGS);
    expect(thesisSettingsFromEnv(loadConfig({ THESIS_EXIT: "false", THESIS_EXTEND_MULT: "1" }).env)).toMatchObject({ enabled: false, extendMult: 1 });
    expect(formatThesisSettings(THESIS_DISABLED)).toContain("無効");
    expect(formatThesisSettings(S)).toContain("期限 × 4");
  });

  it.each([
    ["THESIS_MIN_R", "2.5", /THESIS_MIN_R=2\.5 は不正です/],
    ["THESIS_MIN_R", "-0.1", /THESIS_MIN_R/],
    ["THESIS_EARLY_CUT_R", "1.5", /THESIS_EARLY_CUT_R=1\.5 は不正です/],
    ["THESIS_EXTEND_MULT", "0.5", /THESIS_EXTEND_MULT=0\.5 は不正です.*1 以上 20 以下/],
    ["THESIS_EXTEND_MULT", "21", /THESIS_EXTEND_MULT/],
    ["THESIS_TRAIL_R", "0", /THESIS_TRAIL_R=0 は不正です/],
    ["THESIS_EXIT", "maybe", /THESIS_EXIT=maybe は true \/ false/],
  ])("範囲外は日本語のエラーで起動を止める: %s=%s", (k, v, re) => {
    expect(() => loadConfig({ [k]: v })).toThrow(re);
  });
});

describe("期限・リスク・純 R", () => {
  it("期限は expectedMs (> 0) を優先し、無ければ maxHoldMs。どちらも無ければ undefined", () => {
    expect(resolveThesisMs(5 * MIN, 10 * MIN)).toBe(5 * MIN);
    expect(resolveThesisMs(undefined, 10 * MIN)).toBe(10 * MIN);
    expect(resolveThesisMs(0, 10 * MIN)).toBe(10 * MIN);
    expect(resolveThesisMs(undefined, 0)).toBeUndefined();
    expect(resolveThesisMs(Number.NaN, undefined)).toBeUndefined();
  });

  it("当初のリスクが 0 以下なら読みの管理を使わない (従来の時間切れに戻す)", () => {
    expect(initialRiskPerUnit(100, 98)).toBe(2);
    expect(initialRiskPerUnit(100, 102)).toBe(2);
    expect(initialRiskPerUnit(100, 100)).toBe(0);
    expect(activeThesisMs(S, undefined, 10 * MIN, 0)).toBeUndefined();
    expect(activeThesisMs(S, undefined, 10 * MIN, Number.NaN)).toBeUndefined();
    expect(activeThesisMs(THESIS_DISABLED, undefined, 10 * MIN, 2)).toBeUndefined();
    expect(activeThesisMs(S, undefined, 10 * MIN, 2)).toBe(10 * MIN);
    // リスク 0 の建玉は純 R が NaN → 判定は従来の時間切れ
    const p: ThesisPricing = { direction: "long", entryPrice: 100, risk: 0 };
    expect(thesisNetR(p, 101)).toBeNaN();
    expect(decideThesis(at(10, thesisNetR(p, 101)), S)).toEqual({ exit: { reason: "time" } });
    expect(decideThesis(at(9, thesisNetR(p, 101)), S)).toEqual({});
  });

  it("純 R は往復の手数料 (実際のエントリー手数料 + 決済の taker 手数料率 × 決済できる価格) を引く (買い・売り)", () => {
    const long: ThesisPricing = { direction: "long", entryPrice: 100, risk: 2, entryFeePerUnit: 0.1, takerFeeRate: 0.001 };
    // (100.49 − 100 − 0.1 − 0.10049) / 2
    expect(thesisNetR(long, 100.49)).toBeCloseTo((0.49 - 0.1 - 0.10049) / 2, 12);
    expect(thesisNetR({ ...long, entryFeePerUnit: 0, takerFeeRate: 0 }, 102)).toBeCloseTo(1, 12);
    const short: ThesisPricing = { direction: "short", entryPrice: 100, risk: 2, entryFeePerUnit: 0.1, takerFeeRate: 0.001 };
    expect(thesisNetR(short, 99)).toBeCloseTo((1 - 0.1 - 0.099) / 2, 12);
    expect(thesisNetR(short, 101)).toBeCloseTo((-1 - 0.1 - 0.101) / 2, 12);
    // maker の受け取り (負の手数料) は純 R を増やす
    expect(thesisNetR({ ...long, entryFeePerUnit: -0.05, takerFeeRate: 0 }, 100)).toBeCloseTo(0.025, 12);
  });

  it("建値 (手数料込み) は、そこで決済すると純 R ≈ 0 になる価格", () => {
    const long: ThesisPricing = { direction: "long", entryPrice: 100, risk: 2, entryFeePerUnit: 0.1, takerFeeRate: 0.001 };
    const short: ThesisPricing = { ...long, direction: "short" };
    expect(breakevenPrice(long)).toBeCloseTo(100.1 / 0.999, 12);
    expect(breakevenPrice(short)).toBeCloseTo(99.9 / 1.001, 12);
    expect(thesisNetR(long, breakevenPrice(long))).toBeCloseTo(0, 12);
    expect(thesisNetR(short, breakevenPrice(short))).toBeCloseTo(0, 12);
    expect(breakevenPrice({ direction: "long", entryPrice: 100 })).toBe(100);
  });
});

describe("延長後の保護ストップ", () => {
  const long: ThesisPricing = { direction: "long", entryPrice: 100, risk: 2, entryFeePerUnit: 0.1, takerFeeRate: 0.001 };
  const short: ThesisPricing = { ...long, direction: "short" };

  it("建値より下には置かない。極値が進むと 極値 − trailR × R へ上がる (買い)", () => {
    const be = breakevenPrice(long);
    expect(thesisTrailStop(long, 100.5, 0.5)).toBeCloseTo(be, 12); // 100.5 − 1 < 建値
    expect(thesisTrailStop(long, 103, 0.5)).toBeCloseTo(102, 12);
    expect(thesisTrailStop(long, 104, 1)).toBeCloseTo(102, 12);
  });

  it("極値が進むほど有利な側へ動くだけ (下げない)", () => {
    let prev = -Infinity;
    let peak = 100;
    for (const px of [100.2, 100.8, 101.5, 101.1, 102.4, 101.9, 103]) {
      peak = Math.max(peak, px); // 保有中の高値 (下がっても戻らない)
      const s = thesisTrailStop(long, peak, 0.5)!;
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it("売りは逆: 建値より上には置かず、安値 + trailR × R へ下がる", () => {
    const be = breakevenPrice(short);
    expect(thesisTrailStop(short, 99.5, 0.5)).toBeCloseTo(be, 12);
    expect(thesisTrailStop(short, 97, 0.5)).toBeCloseTo(98, 12);
  });

  it("延長後の極値: 延長した時点の決済できる価格から始め、買いは高い方・売りは低い方へだけ進む", () => {
    expect(advancePeak("long", undefined, 100.5)).toBe(100.5);
    expect(advancePeak("long", 100.5, 100.2)).toBe(100.5);
    expect(advancePeak("long", 100.5, 101)).toBe(101);
    expect(advancePeak("short", 99.5, 99.8)).toBe(99.5);
    expect(advancePeak("short", 99.5, 99.1)).toBe(99.1);
    expect(advancePeak("long", 100.5, Number.NaN)).toBe(100.5);
    // 延長した瞬間 (peak = 決済できる価格) のストップは max(建値, 価格 − trailR × R) で、価格より厳しくならない
    const mark = 100.6;
    expect(thesisTrailStop(long, advancePeak("long", undefined, mark)!, 0.5)).toBeCloseTo(Math.max(breakevenPrice(long), mark - 1), 12);
    expect(thesisTrailStop(long, mark, 0.5)!).toBeLessThan(mark);
  });

  it("きつい方: 買いは高い方、売りは低い方 (undefined は無視)", () => {
    expect(tighterStop("long", 98, 100.2)).toBe(100.2);
    expect(tighterStop("short", 102, 99.8)).toBe(99.8);
    expect(tighterStop("long", undefined, 99)).toBe(99);
    expect(tighterStop("long", undefined, undefined)).toBeUndefined();
  });

  it("リスク 0 なら undefined", () => {
    expect(thesisTrailStop({ ...long, risk: 0 }, 103, 0.5)).toBeUndefined();
  });
});

describe("decideThesis", () => {
  it("途中で読み外れは値動きだけの R (grossR) で判定する: コストで純 R が −0.5 を下回っても、値動きが浅ければ切らない", () => {
    // タイトな損切りのスキャルピング: 動いていなくても往復コストで純 R ≈ −0.6
    expect(decideThesis(at(6, -0.6, { grossR: -0.05 }), S)).toEqual({});
    expect(decideThesis(at(6, -0.6, { grossR: -0.5 }), S)).toEqual({ exit: { reason: "thesis_failed", netR: -0.6 } });
    // grossR が求まらなければ途中では切らない (期限の判定は純 R)
    expect(decideThesis(at(6, -0.9, { grossR: Number.NaN }), S)).toEqual({});
    expect(decideThesis(at(10, 0.05, { grossR: 0.5 }), S).exit?.reason).toBe("thesis_timeout");
    // 値動きだけの R = 方向 × (仲値 − 建値) / 当初のリスク
    expect(thesisGrossR({ direction: "long", entryPrice: 100.01, risk: 2 }, 99.01)).toBeCloseTo(-0.5, 12);
    expect(thesisGrossR({ direction: "short", entryPrice: 100, risk: 2 }, 101)).toBeCloseTo(-0.5, 12);
    expect(thesisGrossR({ direction: "long", entryPrice: 100, risk: 0 }, 99)).toBeNaN();
  });

  it("途中で読み外れ: 期限の半分を過ぎて grossR ≤ −earlyCutR なら thesis_failed (半分より前・浅い逆行は持つ)", () => {
    expect(decideThesis(at(4.9, -0.8), S)).toEqual({});
    expect(decideThesis(at(5, -0.49), S)).toEqual({});
    expect(decideThesis(at(5, -0.5), S)).toEqual({ exit: { reason: "thesis_failed", netR: -0.5 } });
    expect(decideThesis(at(8, -0.9), S).exit?.reason).toBe("thesis_failed");
    // earlyCutR = 0 で途中の決済なし
    expect(decideThesis(at(8, -0.9), { ...S, earlyCutR: 0 })).toEqual({});
  });

  it("期限で読み外れ: 純R < minR なら thesis_timeout", () => {
    expect(decideThesis(at(10, 0.05), S)).toEqual({ exit: { reason: "thesis_timeout", netR: 0.05 } });
    expect(decideThesis(at(10, -0.9), S).exit?.reason).toBe("thesis_timeout");
  });

  it("期限で読み当たり: 純R ≥ minR なら延長 (決済しない)。延長後は途中・期限の判定をしない", () => {
    expect(decideThesis(at(10, 0.1), S)).toEqual({ extend: { netR: 0.1 } });
    expect(decideThesis(at(12, -0.9, { extended: true }), S)).toEqual({});
    expect(decideThesis(at(39.9, 0.3, { extended: true }), S)).toEqual({});
  });

  it("延長の上限: 期限 × extendMult で thesis_cap。extendMult = 1 なら期限で延長と同時に上限", () => {
    expect(decideThesis(at(40, 0.3, { extended: true }), S)).toEqual({ exit: { reason: "thesis_cap", netR: 0.3 } });
    expect(decideThesis(at(10, 0.3), { ...S, extendMult: 1 })).toEqual({ extend: { netR: 0.3 }, exit: { reason: "thesis_cap", netR: 0.3 } });
    expect(decideThesis(at(10, 0.05), { ...S, extendMult: 1 }).exit?.reason).toBe("thesis_timeout");
    // 停止していて期限 × 倍率を過ぎてから初めて判定した場合も、読み当たりなら延長 → 上限
    expect(decideThesis(at(50, 0.3), S)).toEqual({ extend: { netR: 0.3 }, exit: { reason: "thesis_cap", netR: 0.3 } });
  });

  it("expectedMs があれば maxHoldMs ではなくそれが期限", () => {
    expect(decideThesis(at(5, 0.05, { expectedMs: 5 * MIN }), S).exit?.reason).toBe("thesis_timeout");
    expect(decideThesis(at(2.5, -0.6, { expectedMs: 5 * MIN }), S).exit?.reason).toBe("thesis_failed");
    expect(decideThesis(at(20, 0.3, { expectedMs: 5 * MIN, extended: true }), S).exit?.reason).toBe("thesis_cap");
  });

  it("無効なら従来どおり maxHoldMs で time (純 R によらない)。期限の無い建玉は何もしない", () => {
    expect(decideThesis(at(9.9, -0.9), THESIS_DISABLED)).toEqual({});
    expect(decideThesis(at(10, 5), THESIS_DISABLED)).toEqual({ exit: { reason: "time" } });
    expect(decideThesis(at(100, 0, { maxHoldMs: undefined }), S)).toEqual({});
    expect(decideThesis(at(100, 0, { maxHoldMs: 0 }), THESIS_DISABLED)).toEqual({});
  });

  it("答え合わせの結果", () => {
    expect(thesisOutcomeOf("thesis_failed", false)).toBe("failed_early");
    expect(thesisOutcomeOf("thesis_timeout", false)).toBe("timeout");
    expect(thesisOutcomeOf("trailing", true)).toBe("extended");
    expect(thesisOutcomeOf("thesis_cap", true)).toBe("extended");
    expect(thesisOutcomeOf("take_profit", false)).toBe("none");
    expect(thesisOutcomeOf("stop", false)).toBe("none");
  });
});
