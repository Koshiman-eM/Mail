import { describe, expect, it } from "vitest";
import {
  incompleteBeta, normalCdf, proportionGreaterPValue, sampleStats, signTestPValue, studentTCdf, welchLessPValue,
} from "../src/learning/stats";

describe("学習の統計検定", () => {
  it("分布関数の既知の値", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.6448536)).toBeCloseTo(0.95, 6);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 6);
    expect(incompleteBeta(0.5, 2, 2)).toBeCloseTo(0.5, 10);
    expect(incompleteBeta(0.3, 1, 1)).toBeCloseTo(0.3, 10);
    expect(studentTCdf(2.228139, 10)).toBeCloseTo(0.975, 5);
    expect(studentTCdf(-1.812461, 10)).toBeCloseTo(0.05, 5);
    expect(studentTCdf(1.959964, 1e7)).toBeCloseTo(0.975, 4);
    expect(studentTCdf(0, 3)).toBeCloseTo(0.5, 12);
  });

  it("符号検定: 二項分布 p = 0.5 の上側確率", () => {
    expect(signTestPValue(5, 0)).toBeCloseTo(1 / 32, 12);
    expect(signTestPValue(4, 1)).toBeCloseTo(6 / 32, 12);
    expect(signTestPValue(4, 0)).toBeCloseTo(1 / 16, 12);
    expect(signTestPValue(0, 5)).toBeCloseTo(1, 12);
    expect(signTestPValue(0, 0)).toBe(1);
  });

  it("Welch の t 検定 (片側): 自由度と p 値。件数不足は 1、分散 0 は平均の大小", () => {
    const r = welchLessPValue({ n: 30, mean: 0, variance: 1 }, { n: 30, mean: 0.5, variance: 1 });
    expect(r.t).toBeCloseTo(-0.5 / Math.sqrt(2 / 30), 10);
    expect(r.df).toBeCloseTo(58, 10);
    expect(r.p).toBeCloseTo(0.0289, 3);
    // 分散が違うと自由度が下がる
    expect(welchLessPValue({ n: 10, mean: 0, variance: 4 }, { n: 40, mean: 0, variance: 1 }).df).toBeLessThan(48);
    expect(welchLessPValue({ n: 1, mean: -5, variance: 0 }, { n: 30, mean: 0, variance: 1 }).p).toBe(1);
    expect(welchLessPValue({ n: 5, mean: -1, variance: 0 }, { n: 5, mean: 0, variance: 0 }).p).toBe(0);
    expect(welchLessPValue({ n: 5, mean: 1, variance: 0 }, { n: 5, mean: 0, variance: 0 }).p).toBe(1);
  });

  it("比率の z 検定 (片側) と標本統計", () => {
    expect(proportionGreaterPValue(20, 25, 10, 60)).toBeLessThan(1e-6);
    expect(proportionGreaterPValue(5, 25, 12, 60)).toBeCloseTo(0.5, 6);
    expect(proportionGreaterPValue(0, 25, 0, 60)).toBe(1);
    expect(proportionGreaterPValue(3, 0, 1, 10)).toBe(1);
    expect(sampleStats([1, 2, 3, Number.NaN])).toEqual({ n: 3, mean: 2, variance: 1 });
    expect(sampleStats([])).toEqual({ n: 0, mean: 0, variance: 0 });
  });
});
