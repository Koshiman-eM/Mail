/** 転換で決済 (REVERSAL_EXIT) の純粋な判定と設定。すべて合成データ (オフライン) */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/appConfig";
import type { Candle } from "../src/core/types";
import {
  checkReversal, DEFAULT_REVERSAL_SETTINGS, entryBarIndex, formatReversalSettings, REVERSAL_ATR_WINDOW, reversalAppliesTo, reversalConfigWarnings,
  reversalBacktestTimeframe, reversalLevel, reversalLowerTimeframe, reversalSettingsFromEnv, reversalTimeframeFor,
} from "../src/engine/reversalExit";

const M = 60_000;
const T0 = Date.UTC(2026, 0, 5);
/** エントリーした足 (ここから後のスイングだけを使う) */
const E = 10;

/** 終値の列から足を作る (始値 = 前の終値、高値・安値 = 始値と終値の大きい方・小さい方 ± 0.05) */
function bars(closes: number[]): Candle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { ts: T0 + i * M, open: o, high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05, close: c, volume: 1 };
  });
}

/** エントリー前は 100 で横ばい (E 本)、その後に post を続ける */
const series = (post: number[]) => bars([...Array<number>(E).fill(100), ...post]);
/** エントリーの時刻 (エントリーした足の途中) */
const ENTRY_TS = T0 + E * M + 5_000;

/**
 * 買い: 上昇 → 押し (r7 の安値 102.55 がスイングロー、r10 で確定) → 高値更新 → 下げて r12 の終値 102.4 が押し安値割れ。
 * 利確 (106) の手前・建値 (100) より上 = 含み益で転換
 */
const LONG_PROFIT = [100, 101, 102, 103, 103.5, 103.8, 103.2, 102.6, 103.4, 104.0, 104.4, 103.6, 102.4];
/** 売り: LONG_PROFIT の鏡像 (200 − 価格)。r7 の高値 97.45 が戻り高値、r12 の終値 97.6 が戻り高値超え */
const SHORT_PROFIT = LONG_PROFIT.map((x) => 200 - x);

describe("entryBarIndex", () => {
  const c = series([100, 101, 102]);
  it("エントリーの時刻を含む足。足がエントリーより後からしか無ければ -1、形成中の足なら length", () => {
    expect(entryBarIndex(c, ENTRY_TS, M)).toBe(E);
    expect(entryBarIndex(c, T0 + E * M, M)).toBe(E);
    expect(entryBarIndex(c, T0 - 1, M)).toBe(-1);
    expect(entryBarIndex(c.slice(E + 1), ENTRY_TS, M)).toBe(-1);
    // 最後の確定足の後 (形成中の足) にエントリー
    expect(entryBarIndex(c, T0 + c.length * M + 1_000, M)).toBe(c.length);
    // 足の長さを省略したら間隔から推定する
    expect(entryBarIndex(c, ENTRY_TS)).toBe(E);
    expect(entryBarIndex([], ENTRY_TS, M)).toBe(-1);
  });
});

describe("reversalLevel / checkReversal", () => {
  it("買い: エントリー後に確定したスイングローを終値が割ったら exit (含み益でも)", () => {
    const c = series(LONG_PROFIT);
    const lv = reversalLevel(c, ENTRY_TS, "long", 3, M);
    expect(lv).toEqual({ level: 102.55, pivotTs: T0 + (E + 7) * M, confirmedTs: T0 + (E + 10) * M });
    // r11 の終値 103.6 は押し安値より上 → まだ決済しない
    const before = checkReversal(c.slice(0, -1), ENTRY_TS, "long", { pivotN: 3, tfMs: M });
    expect(before).toMatchObject({ exit: false, level: 102.55, close: 103.6 });
    expect(before.skip).toBeUndefined();
    const r = checkReversal(c, ENTRY_TS, "long", { pivotN: 3, tfMs: M });
    expect(r).toMatchObject({ exit: true, level: 102.55, pivotTs: T0 + (E + 7) * M, close: 102.4, barTs: T0 + (E + 12) * M, threshold: 102.55 });
    expect(r.close).toBeGreaterThan(100);
  });

  it("売り: 鏡像 (エントリー後のスイングハイを終値が越えたら exit)", () => {
    const c = series(SHORT_PROFIT);
    expect(reversalLevel(c, ENTRY_TS, "short", 3, M)).toMatchObject({ level: 97.45, pivotTs: T0 + (E + 7) * M });
    expect(checkReversal(c.slice(0, -1), ENTRY_TS, "short", { pivotN: 3, tfMs: M }).exit).toBe(false);
    expect(checkReversal(c, ENTRY_TS, "short", { pivotN: 3, tfMs: M })).toMatchObject({ exit: true, level: 97.45, close: 97.6 });
    // 買いのスイング (安値) は売りの判定に使わない
    expect(checkReversal(series(LONG_PROFIT), ENTRY_TS, "short", { pivotN: 3, tfMs: M }).exit).toBe(false);
  });

  it("エントリー後にスイングが無ければ決済しない (損切りが守る。REVERSAL_EXIT_FALLBACK の既定 false)", () => {
    // 一方的に下げ続ける (エントリー後にスイングローができない)
    const c = series([100, 99.5, 99, 98.5, 98, 97.5, 97]);
    expect(reversalLevel(c, ENTRY_TS, "long", 3, M)).toBeUndefined();
    const r = checkReversal(c, ENTRY_TS, "long", { pivotN: 3, tfMs: M });
    expect(r).toMatchObject({ exit: false, skip: "no_swing" });
    expect(r.level).toBeUndefined();
    expect(checkReversal(c, ENTRY_TS, "long", { pivotN: 3, tfMs: M, fallback: false })).toMatchObject({ exit: false, skip: "no_swing" });
  });

  it("フォールバック (fallback: true): スイングが無ければエントリーした足の安値 (買い) / 高値 (売り) を水準にする", () => {
    // エントリーした足 (100 → 100) の安値 99.95
    const c = series([100, 99.5, 99, 98.5, 98, 97.5, 97]);
    expect(reversalLevel(c, ENTRY_TS, "long", 3, M, true)).toEqual({ level: 99.95, pivotTs: T0 + E * M, confirmedTs: T0 + E * M, fallback: true });
    const r = checkReversal(c, ENTRY_TS, "long", { pivotN: 3, tfMs: M, fallback: true });
    expect(r).toMatchObject({ exit: true, level: 99.95, pivotTs: T0 + E * M, fallback: true, close: 97 });
    expect(r.skip).toBeUndefined();
    // エントリーした足だけ (後の確定足が無い): 終値は安値を下回れないので決済しない
    expect(checkReversal(c.slice(0, E + 1), ENTRY_TS, "long", { pivotN: 3, tfMs: M, fallback: true })).toMatchObject({ exit: false, level: 99.95, fallback: true });
    // 売り: 一方的に上げ続ける → エントリーした足の高値 100.05 を終値が越えたら決済
    const up = series([100, 100.5, 101, 101.5, 102, 102.5, 103]);
    expect(checkReversal(up, ENTRY_TS, "short", { pivotN: 3, tfMs: M, fallback: true })).toMatchObject({ exit: true, level: 100.05, fallback: true });
    // スイングが確定していれば fallback は付かない
    expect(checkReversal(series(LONG_PROFIT), ENTRY_TS, "long", { pivotN: 3, tfMs: M, fallback: true })).toMatchObject({ exit: true, level: 102.55 });
    expect(checkReversal(series(LONG_PROFIT), ENTRY_TS, "long", { pivotN: 3, tfMs: M, fallback: true }).fallback).toBeUndefined();
    // エントリーした足がまだ形成中なら水準なし (no_swing)
    expect(checkReversal(c.slice(0, E), ENTRY_TS, "long", { pivotN: 3, tfMs: M, fallback: true })).toMatchObject({ exit: false, skip: "no_swing" });
    // 確定のラグの間 (スイングの確定前) はフォールバックの水準。エントリー前のスイングは使わない
    expect(reversalLevel(series(LONG_PROFIT).slice(0, E + 10), ENTRY_TS, "long", 3, M, true)).toMatchObject({ level: 99.95, fallback: true });
    const pre = [100, 100, 99, 98.5, 98, 99, 99.5, 100, 100, 100];
    expect(checkReversal(bars([...pre, 100, 99, 97.5]), ENTRY_TS, "long", { pivotN: 3, tfMs: M, fallback: true })).toMatchObject({ exit: true, level: 99.95, fallback: true });
  });

  it("エントリーより前のスイングローは使わない", () => {
    // エントリー前に 97.95 のスイングロー (足 4)。エントリー後は 98 まで下げるがスイングは無い
    const pre = [100, 100, 99, 98.5, 98, 99, 99.5, 100, 100, 100];
    const c = bars([...pre, 100, 99.5, 99, 98.5, 98]);
    expect(reversalLevel(c.slice(0, E), T0 + 9 * M, "long", 3, M)).toBeUndefined();
    // エントリーを足 3 にすれば同じスイングを使う (確認)
    expect(reversalLevel(c, T0 + 3 * M, "long", 3, M)).toMatchObject({ level: 97.95, pivotTs: T0 + 4 * M });
    // 足 10 でエントリー: 終値 97.5 はエントリー前の押し安値 97.95 を割っているが、エントリー前のスイングなので使わない
    const r = checkReversal(bars([...pre, 100, 99, 97.5]), ENTRY_TS, "long", { pivotN: 3, tfMs: M });
    expect(r.level).toBeUndefined();
    expect(r).toMatchObject({ exit: false, skip: "no_swing" });
  });

  it("ヒゲ (安値) だけが押し安値を割っても決済しない (終値で判定)", () => {
    const c = series(LONG_PROFIT.slice(0, -1));
    const last = c[c.length - 1];
    // 次の足は安値 101 (押し安値 102.55 を下回る) まで下げるが、終値は 102.6 (上)
    c.push({ ts: last.ts + M, open: last.close, high: last.close, low: 101, close: 102.6, volume: 1 });
    expect(checkReversal(c, ENTRY_TS, "long", { pivotN: 3, tfMs: M })).toMatchObject({ exit: false, level: 102.55, close: 102.6 });
    // 終値がちょうど押し安値なら決済しない (下回ったときだけ)
    c[c.length - 1] = { ...c[c.length - 1], close: 102.55 };
    expect(checkReversal(c, ENTRY_TS, "long", { pivotN: 3, tfMs: M }).exit).toBe(false);
  });

  it("バッファ: 終値が押し安値 − バッファ × ATR より下のときだけ決済。ATR は最後の窓の足から", () => {
    const c = series(LONG_PROFIT);
    const r0 = checkReversal(c, ENTRY_TS, "long", { pivotN: 3, tfMs: M });
    expect(Number.isFinite(r0.atr)).toBe(true);
    // 閾値 = 102.55 − 0.15 強 (102.4 より少し下) → 終値 102.4 は閾値より大きく下回っていない
    const buf = (0.15 / r0.atr) * 1.001;
    const r1 = checkReversal(c, ENTRY_TS, "long", { pivotN: 3, bufferAtr: buf, tfMs: M });
    expect(r1.exit).toBe(false);
    expect(r1.threshold).toBeCloseTo(102.4, 3);
    expect(r1.threshold!).toBeLessThan(102.4);
    // 小さいバッファなら決済 (閾値 102.415)
    expect(checkReversal(c, ENTRY_TS, "long", { pivotN: 3, bufferAtr: (0.135 / r0.atr), tfMs: M }).exit).toBe(true);
    // ATR は最後の REVERSAL_ATR_WINDOW 本だけで計算する (それより前に足を足しても同じ値)
    const flatBefore = (n: number) => bars(Array<number>(n).fill(100)).map((b) => ({ ...b, ts: b.ts - n * M }));
    const a300 = checkReversal([...flatBefore(300), ...c], ENTRY_TS, "long", { pivotN: 3, tfMs: M });
    const a600 = checkReversal([...flatBefore(600), ...c], ENTRY_TS, "long", { pivotN: 3, tfMs: M });
    expect(a600.atr).toBe(a300.atr);
    expect(a300).toMatchObject({ exit: true, level: 102.55 });
    expect(REVERSAL_ATR_WINDOW).toBe(100);
  });

  it("確定のラグ (リペイントしない): スイングは N 本後の足が確定してから使い、足を足しても過去の判定は変わらない", () => {
    const c = series(LONG_PROFIT);
    const pivotIdx = E + 7;
    // 確定の 1 本前 (r9) まででは水準が無い
    expect(reversalLevel(c.slice(0, pivotIdx + 3), ENTRY_TS, "long", 3, M)).toBeUndefined();
    expect(reversalLevel(c.slice(0, pivotIdx + 4), ENTRY_TS, "long", 3, M)?.pivotTs).toBe(T0 + pivotIdx * M);
    // 各時点 (その時点までの確定足だけを渡す): 水準は確定 (r10) の後からだけ使い、確定した足は判定した足より前。決済は r12 だけ
    for (let k = E + 1; k <= c.length; k++) {
      const prefix = c.slice(0, k);
      const a = checkReversal(prefix, ENTRY_TS, "long", { pivotN: 3, tfMs: M });
      const lv = reversalLevel(prefix, ENTRY_TS, "long", 3, M);
      if (k <= pivotIdx + 3) expect(a.level).toBeUndefined();
      else {
        expect(a.level).toBe(102.55);
        expect(lv!.confirmedTs).toBeLessThanOrEqual(prefix[prefix.length - 1].ts);
      }
      expect(a.exit).toBe(k === c.length);
    }
  });

  it("エントリーした足そのもののスイングローも使う", () => {
    // エントリーした足 (r0) の安値 99.45 がスイングロー (エントリー前は 100 の横ばい、後は上昇)
    const pre = Array<number>(E).fill(100);
    const c = bars([...pre, 99.5, 100.5, 101, 101.5, 99.3]);
    // r0: 始値 100 → 終値 99.5 (安値 99.45)。r1 は 99.5 → 100.5 (安値 99.45) で右側は >= で可
    expect(reversalLevel(c, ENTRY_TS, "long", 3, M)).toMatchObject({ level: 99.45, pivotTs: T0 + E * M, confirmedTs: T0 + (E + 3) * M });
    expect(checkReversal(c, ENTRY_TS, "long", { pivotN: 3, tfMs: M })).toMatchObject({ exit: true, level: 99.45, close: 99.3 });
    // エントリーが 1 本後の足なら、そのスイングはエントリーより前の足なので使わない
    expect(reversalLevel(c, ENTRY_TS + M, "long", 3, M)).toBeUndefined();
    // フォールバックなら、エントリーした足 r1 の安値
    expect(reversalLevel(c, ENTRY_TS + M, "long", 3, M, true)).toMatchObject({ level: 99.45, pivotTs: T0 + (E + 1) * M, fallback: true });
  });

  it("最も新しい確定したスイングを使う (押し安値の切り上げに付いていく)", () => {
    // r7 (102.55) の後、r13 (103.55) に 2 つ目のスイングロー → 水準は 103.55
    const c = series([...LONG_PROFIT.slice(0, 11), 105, 104.6, 103.6, 104.5, 105.2, 105.5]);
    expect(reversalLevel(c, ENTRY_TS, "long", 3, M)).toMatchObject({ level: 103.55, pivotTs: T0 + (E + 13) * M });
  });

  it("足がエントリーより新しい (履歴が足りない) なら no_history で決済しない", () => {
    const c = series(LONG_PROFIT).slice(E + 2);
    expect(checkReversal(c, ENTRY_TS, "long", { pivotN: 3, tfMs: M })).toMatchObject({ exit: false, skip: "no_history" });
    expect(checkReversal([], ENTRY_TS, "long", { pivotN: 3, tfMs: M })).toMatchObject({ exit: false, skip: "no_bars" });
  });

  it("N を変えると使うスイングが変わる (N=2 なら早く確定する)", () => {
    const c = series(LONG_PROFIT.slice(0, 10));
    expect(reversalLevel(c, ENTRY_TS, "long", 3, M)).toBeUndefined();
    expect(reversalLevel(c, ENTRY_TS, "long", 2, M)).toEqual({ level: 102.55, pivotTs: T0 + (E + 7) * M, confirmedTs: T0 + (E + 9) * M });
  });
});

describe("設定 (REVERSAL_*)", () => {
  it("既定: 有効・N=3・バッファ 0・全戦略", () => {
    const env = loadConfig({}).env;
    expect(env.REVERSAL_EXIT).toBe(true);
    expect(env.REVERSAL_EXIT_PIVOT_N).toBe(3);
    expect(env.REVERSAL_EXIT_BUFFER_ATR).toBe(0);
    expect(env.REVERSAL_EXIT_STRATEGIES).toEqual([]);
    expect(env.REVERSAL_EXIT_TF).toBe("lower");
    expect(env.REVERSAL_EXIT_FALLBACK).toBe(false);
    expect(DEFAULT_REVERSAL_SETTINGS.fallback).toBe(false);
    expect(DEFAULT_REVERSAL_SETTINGS.timeframe).toBe("lower");
    expect(reversalSettingsFromEnv(env)).toEqual({ ...DEFAULT_REVERSAL_SETTINGS, strategies: [] });
    // 手組みの設定 (項目なし) も既定と同じ
    expect(reversalSettingsFromEnv({})).toEqual({ ...DEFAULT_REVERSAL_SETTINGS, strategies: [] });
  });

  it("値の読み込みと範囲外の日本語のエラー", () => {
    const env = loadConfig({
      REVERSAL_EXIT: "off", REVERSAL_EXIT_PIVOT_N: "5", REVERSAL_EXIT_BUFFER_ATR: "0.25", REVERSAL_EXIT_STRATEGIES: " a, b ,a", REVERSAL_EXIT_TF: "same",
      REVERSAL_EXIT_FALLBACK: "true",
    }).env;
    expect(reversalSettingsFromEnv(env)).toEqual({ enabled: false, pivotN: 5, bufferAtr: 0.25, strategies: ["a", "b"], timeframe: "same", fallback: true });
    expect(() => loadConfig({ REVERSAL_EXIT_FALLBACK: "maybe" })).toThrow(/REVERSAL_EXIT_FALLBACK/);
    expect(() => loadConfig({ REVERSAL_EXIT_TF: "higher" })).toThrow(/REVERSAL_EXIT_TF/);
    expect(() => loadConfig({ REVERSAL_EXIT_PIVOT_N: "1" })).toThrow(/REVERSAL_EXIT_PIVOT_N=1 は不正です。2 以上 10 以下の整数/);
    expect(() => loadConfig({ REVERSAL_EXIT_PIVOT_N: "11" })).toThrow(/REVERSAL_EXIT_PIVOT_N/);
    expect(() => loadConfig({ REVERSAL_EXIT_PIVOT_N: "2.5" })).toThrow(/整数/);
    expect(() => loadConfig({ REVERSAL_EXIT_BUFFER_ATR: "1.5" })).toThrow(/REVERSAL_EXIT_BUFFER_ATR=1.5 は不正です。0 以上 1 以下/);
    expect(() => loadConfig({ REVERSAL_EXIT_BUFFER_ATR: "-0.1" })).toThrow(/REVERSAL_EXIT_BUFFER_ATR/);
    expect(() => loadConfig({ REVERSAL_EXIT: "maybe" })).toThrow(/REVERSAL_EXIT=maybe は true \/ false/);
  });

  it("対象の戦略 (空 = すべて)・未登録の id と STRUCTURE_EXIT_ON_REVERSAL との併用の警告・1 行表示", () => {
    const all = { ...DEFAULT_REVERSAL_SETTINGS, strategies: [] };
    expect(reversalAppliesTo(all, "anything")).toBe(true);
    expect(reversalAppliesTo({ ...all, strategies: ["a"] }, "a")).toBe(true);
    expect(reversalAppliesTo({ ...all, strategies: ["a"] }, "b")).toBe(false);
    expect(reversalAppliesTo({ ...all, enabled: false }, "a")).toBe(false);
    expect(reversalAppliesTo(undefined, "a")).toBe(false);
    expect(reversalConfigWarnings({ ...all, strategies: ["a", "zzz"] }, ["a", "b"])).toEqual([
      "REVERSAL_EXIT_STRATEGIES に未登録の戦略 id があります (無視されます): zzz",
    ]);
    expect(reversalConfigWarnings(all, ["a"], true)[0]).toMatch(/STRUCTURE_EXIT_ON_REVERSAL=true と REVERSAL_EXIT=true を併用/);
    expect(reversalConfigWarnings({ ...all, enabled: false, strategies: ["zzz"] }, ["a"], true)).toEqual([]);
    expect(formatReversalSettings(all)).toBe(
      "有効 (戦略の主時間足の 1 つ下の時間足のスイング 左右 3 本 / 終値が水準を越えたら決済 / 対象 すべての戦略)",
    );
    expect(formatReversalSettings({ ...all, fallback: true })).toContain("左右 3 本 (無ければエントリーした足の安値・高値) /");
    expect(formatReversalSettings({ ...all, timeframe: "same" })).toMatch(/^有効 \(戦略の主時間足のスイング 左右 3 本/);
    expect(formatReversalSettings({ ...all, bufferAtr: 0.2, strategies: ["a"] })).toContain("0.2 ATR より大きく越えたら決済 / 対象 a");
    expect(formatReversalSettings({ ...all, enabled: false })).toBe("無効 (従来どおり)");
  });
});

describe("判定の時間足 (REVERSAL_EXIT_TF)", () => {
  it("lower: 主時間足の 1 つ下 (1m→1m, 5m→1m, 15m→5m, 1h→15m, 4h→1h, 1d→4h)。same: 主時間足", () => {
    const map = { "1m": "1m", "5m": "1m", "15m": "5m", "1h": "15m", "4h": "1h", "1d": "4h" } as const;
    for (const [p, lower] of Object.entries(map)) {
      expect(reversalLowerTimeframe(p as keyof typeof map)).toBe(lower);
      expect(reversalTimeframeFor({ timeframe: "lower" }, p as keyof typeof map)).toBe(lower);
      expect(reversalTimeframeFor({ timeframe: "same" }, p as keyof typeof map)).toBe(p);
    }
    // 設定が無ければ既定 (lower)
    expect(reversalTimeframeFor(undefined, "15m")).toBe("5m");
  });

  it("バックテスト: 基準足から lower の時間足が作れなければ same (主時間足) に戻す", () => {
    expect(reversalBacktestTimeframe({ timeframe: "lower" }, "15m", "1m")).toBe("5m");
    expect(reversalBacktestTimeframe({ timeframe: "lower" }, "15m", "5m")).toBe("5m");
    expect(reversalBacktestTimeframe({ timeframe: "lower" }, "15m", "15m")).toBe("15m");
    expect(reversalBacktestTimeframe({ timeframe: "lower" }, "1h", "5m")).toBe("15m");
    expect(reversalBacktestTimeframe({ timeframe: "lower" }, "1d", "1h")).toBe("4h");
    expect(reversalBacktestTimeframe({ timeframe: "same" }, "1h", "1m")).toBe("1h");
  });
});
