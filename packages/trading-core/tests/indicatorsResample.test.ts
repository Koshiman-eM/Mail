import { describe, expect, it } from "vitest";
import type { Candle } from "../src/core/types";
import { bucketStart, closedOnly, resample } from "../src/indicators/resample";

const M = 60_000;
const T0 = Date.UTC(2024, 0, 1); // 月曜 00:00Z

function oneMinute(n: number, startTs = T0): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: startTs + i * M,
    open: 100 + i,
    high: 100 + i + 0.5,
    low: 100 + i - 0.5,
    close: 100 + i + 0.2,
    volume: 1 + i,
  }));
}

describe("resample", () => {
  it("1m → 5m を正しく集約する", () => {
    const out = resample(oneMinute(10), "1m", "5m");
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ ts: T0, open: 100, high: 104.5, low: 99.5, close: 104.2, volume: 1 + 2 + 3 + 4 + 5 });
    expect(out[1].ts).toBe(T0 + 5 * M);
    expect(out[1].open).toBe(105);
    expect(out[1].close).toBeCloseTo(109.2);
  });

  it("未確定の最終足を含めない", () => {
    const out = resample(oneMinute(13), "1m", "5m");
    expect(out.length).toBe(2); // 10〜12 分の足はまだ 3 本しかない
    for (const c of out) expect(c.ts + 5 * M).toBeLessThanOrEqual(T0 + 13 * M);
  });

  it("now を渡すと、その時点で終わっていないバケットは返さない", () => {
    const cs = oneMinute(10);
    expect(resample(cs, "1m", "5m", { now: T0 + 9 * M }).length).toBe(1);
    // now より後に始まる (未確定の) 下位足は無視する
    expect(resample(cs, "1m", "5m", { now: T0 + 5 * M }).length).toBe(1);
  });

  it("途中から始まる先頭バケットは捨てる", () => {
    const cs = oneMinute(12, T0 + 3 * M); // 00:03〜00:14
    const out = resample(cs, "1m", "5m");
    expect(out.map((c) => c.ts)).toEqual([T0 + 5 * M, T0 + 10 * M]);
    expect(resample(cs, "1m", "5m", { dropPartialFirst: false }).map((c) => c.ts)).toEqual([T0, T0 + 5 * M, T0 + 10 * M]);
  });

  it("欠損 (取引なし) があっても時間が過ぎたバケットは確定", () => {
    const cs = oneMinute(10).filter((_, i) => i !== 4); // 00:04 欠損
    const out = resample(cs, "1m", "5m");
    expect(out.length).toBe(2);
    expect(out[0].volume).toBe(1 + 2 + 3 + 4);
  });

  it("どの時点で切っても確定足は全期間集約の先頭部分と一致する (先読みなし)", () => {
    const cs = oneMinute(200);
    const full = resample(cs, "1m", "15m");
    for (let i = 0; i < cs.length; i++) {
      const part = resample(cs.slice(0, i + 1), "1m", "15m");
      const now = cs[i].ts + M;
      expect(part).toEqual(full.slice(0, part.length));
      for (const c of part) expect(c.ts + 15 * M).toBeLessThanOrEqual(now);
      // 確定しているはずのバケットは全て含まれる
      expect(part.length).toBe(full.filter((c) => c.ts + 15 * M <= now).length);
    }
  });

  it("不正な変換は例外", () => {
    expect(() => resample(oneMinute(5), "5m", "1m")).toThrow();
    expect(() => resample(oneMinute(5), "1h", "1d")).not.toThrow();
  });

  it("週足は月曜 00:00Z 始まり", () => {
    const wed = Date.UTC(2024, 0, 3, 12);
    expect(bucketStart(wed, "1w")).toBe(Date.UTC(2024, 0, 1));
    expect(bucketStart(wed, "1d")).toBe(Date.UTC(2024, 0, 3));
  });

  it("closedOnly は未確定の末尾足を除く", () => {
    const cs = oneMinute(5);
    expect(closedOnly(cs, "1m", T0 + 4 * M + 30_000).length).toBe(4);
    expect(closedOnly(cs, "1m", T0 + 5 * M).length).toBe(5);
  });
});
