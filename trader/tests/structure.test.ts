/** 相場構造 (ダウ理論) の純粋関数: ピボット・押し安値 / 戻り高値の状態マシン・方法 2・ちゃぶつき・リペイントしないこと */
import { describe, expect, it } from "vitest";
import { generateCandles } from "../src/backtest/synthetic";
import type { Candle } from "../src/core/types";
import { createRng } from "../src/backtest/synthetic";
import {
  computeStructureSeries, detectPivots, higherCandles, perfectOrderSeries, structureAt, type StructureOptions,
} from "../src/structure";
import { lineBars, path, T0 } from "./helpers/structureBars";

const N2: Partial<StructureOptions> = { pivotN: 2 };

describe("detectPivots", () => {
  it("左右 N 本より厳密に高い (安い) 足だけ。confirmedAt = idx + N", () => {
    const c = lineBars([1, 2, 5, 2, 1, 0, 1, 2]);
    const p = detectPivots(c, 2);
    expect(p).toEqual([
      { idx: 2, ts: c[2].ts, price: 5, type: "SH", confirmedAt: 4 },
      { idx: 5, ts: c[5].ts, price: 0, type: "SL", confirmedAt: 7 },
    ]);
  });

  it("同値の頂・谷は窓内で最も早い足だけがピボット (左は厳密、右は同値を許す)", () => {
    const sh = detectPivots(lineBars([1, 2, 3, 3, 2, 1, 0]), 2).filter((p) => p.type === "SH");
    expect(sh.map((p) => p.idx)).toEqual([2]);
    const sl = detectPivots(lineBars([5, 4, 3, 2, 3, 2, 4, 5]), 2).filter((p) => p.type === "SL");
    expect(sl.map((p) => p.idx)).toEqual([3]);
  });

  it("同値の台地 (高値が 4 本同じ) でもピボットは 1 つだけ (最初の足)。確定は idx + N", () => {
    const c = lineBars([1, 2, 5, 5, 5, 5, 2, 1, 0, 0]);
    const sh = detectPivots(c, 2).filter((p) => p.type === "SH");
    expect(sh).toEqual([{ idx: 2, ts: c[2].ts, price: 5, type: "SH", confirmedAt: 4 }]);
    // 窓より長い台地では、窓ごとの最初の足が出る (左 N 本に同値があると SH にならない)
    const long = detectPivots(lineBars([1, 2, 5, 5, 5, 5, 5, 5, 5, 2, 1]), 2).filter((p) => p.type === "SH");
    expect(long.map((p) => p.idx)).toEqual([2]);
  });

  it("ティック刻みで頂・谷が同値になる系列でもピボットが出る (旧: 厳密な不等号で 0 個)", () => {
    // 高値が 2 本ずつ同じ値になるジグザグ
    const prices = [100, 101, 102, 102, 101, 100, 99, 99, 100, 101, 102, 102, 101, 100, 99, 99, 100, 101];
    const p = detectPivots(lineBars(prices), 2);
    expect(p.filter((x) => x.type === "SH").map((x) => x.idx)).toEqual([2, 10]);
    expect(p.filter((x) => x.type === "SL").map((x) => x.idx)).toEqual([6, 14]);
    // 末尾に足を足しても確定済みのピボットは変わらない
    expect(detectPivots(lineBars(prices.slice(0, 12)), 2)).toEqual(p.filter((x) => x.confirmedAt <= 11));
  });

  it("末尾 N 本はまだ判定しない / HH・LH・HL・LL のラベル", () => {
    const prices = path(100, 110, 104, 114, 107, 112, 101, 105);
    const p = detectPivots(lineBars(prices), 2);
    expect(p.map((x) => `${x.type}${x.price}${x.label ? `:${x.label}` : ""}`)).toEqual([
      "SH110", "SL104", "SH114:HH", "SL107:HL", "SH112:LH", "SL101:LL",
    ]);
    // 最後の 105 (末尾) はピボットにならない。最後の 2 本を足すまで 101 の SL も確定しない
    expect(detectPivots(lineBars(prices.slice(0, -3)), 2).some((x) => x.price === 101)).toBe(false);
  });
});

describe("状態マシン (方法 1・purist)", () => {
  // 100 → 110 (SH) → 104 (SL) → 114 (SH, HH) → 107 (SL, HL) → 118 (SH, HH) → 100 → 110 (SH, LH) → 95
  const prices = path(100, 110, 104, 114, 107, 118, 100, 110, 95);
  const c = lineBars(prices);
  const s = computeStructureSeries(c, N2);
  const at = (i: number) => s[i];

  it("SH・SL が 2 つずつ確定するまでは none。HH+HL で up、押し安値は 2 つの SH の間の最安の SL", () => {
    expect(at(34).bias).toBe("none"); // SL 107 (idx 33) は idx 35 で確定
    expect(at(35).bias).toBe("up");
    expect(at(35).oshiYasune).toBe(104);
    expect(at(35).modoriTakane).toBeNull();
  });

  it("直近の SH をブレイク (高値更新) → 押し安値 = その SH からブレイクした足までの最安の SL", () => {
    expect(prices[40]).toBe(114);
    expect(at(40).oshiYasune).toBe(104); // 終値 114 はブレイクではない (厳密に超えたら)
    expect(prices[41]).toBe(115);
    expect(at(41).oshiYasune).toBe(107);
  });

  it("押し安値を割ると下目線へ。戻り高値 = 下落の起点の直近の SH。押し安値は無効 (共存しない)", () => {
    expect(prices[55]).toBe(107);
    expect(at(55).bias).toBe("up");
    expect(prices[56]).toBe(106);
    expect(at(56).bias).toBe("down");
    expect(at(56).regime).toBe("down");
    expect(at(56).modoriTakane).toBe(118);
    expect(at(56).oshiYasune).toBeNull();
  });

  it("下目線で直近の SL をブレイク (安値更新) → 戻り高値 = その SL からの最高の SH", () => {
    expect(prices[83]).toBe(99);
    expect(at(82).modoriTakane).toBe(118);
    expect(at(83).modoriTakane).toBe(110);
  });

  it("押し安値と戻り高値は同時に有効にならない", () => {
    for (const x of s) expect(x.oshiYasune !== null && x.modoriTakane !== null).toBe(false);
  });

  it("初期が LH+LL なら down。戻り高値は 2 つの SL の間の最高の SH", () => {
    const p2 = path(120, 110, 116, 106, 113, 100);
    const s2 = computeStructureSeries(lineBars(p2), N2);
    expect(s2[34].bias).toBe("none");
    expect(s2[35].bias).toBe("down");
    expect(s2[35].modoriTakane).toBe(116);
    expect(p2[41]).toBe(105);
    expect(s2[41].modoriTakane).toBe(113);
  });

  it("HH の後に HL が無い (HH+LL など) なら none のまま", () => {
    const s3 = computeStructureSeries(lineBars(path(100, 110, 104, 114, 101, 108)), N2);
    expect(s3.every((x) => x.bias === "none")).toBe(true);
  });

  it("breakMode: close は終値、wick は安値で判定する", () => {
    const base = lineBars(path(100, 110, 104, 114, 107, 118, 110));
    const last = base[base.length - 1];
    const pierce: Candle = { ts: last.ts + 900_000, open: 110, high: 110, low: 105, close: 109, volume: 1 };
    const bars = [...base, pierce];
    expect(structureAt(bars, undefined, { ...N2, breakMode: "close" }).bias).toBe("up");
    const w = structureAt(bars, undefined, { ...N2, breakMode: "wick" });
    expect(w.bias).toBe("down");
    expect(w.modoriTakane).toBe(118);
  });
});

describe("状態マシン (conservative)", () => {
  const cons: Partial<StructureOptions> = { ...N2, reversalMode: "conservative" };

  it("押し安値割れで weakeningUp (bias は up のまま)。安値 2 を割ったら down、戻り高値は安値 2 の後の戻りの高値", () => {
    const prices = path(100, 110, 104, 114, 107, 118, 100, 110, 95);
    const s = computeStructureSeries(lineBars(prices), cons);
    expect(s[56].regime).toBe("weakeningUp");
    expect(s[56].bias).toBe("up");
    expect(s[56].oshiYasune).toBeNull();
    expect(s[56].modoriTakane).toBeNull();
    expect(s[56].reversalRef).toEqual({ invalidation: 118, confirmation: null });
    // 安値 2 (100, idx 62) は idx 64 で確定
    expect(s[64].reversalRef).toEqual({ invalidation: 118, confirmation: 100 });
    expect(prices[82]).toBe(100);
    expect(s[82].regime).toBe("weakeningUp");
    expect(prices[83]).toBe(99);
    expect(s[83].regime).toBe("down");
    expect(s[83].bias).toBe("down");
    expect(s[83].modoriTakane).toBe(110);
    expect(s[83].reversalRef).toBeNull();
  });

  it("だまし: weakeningUp で天井 (high1) を超えたら up に戻り、押し安値は high1 の位置から計算し直す", () => {
    const prices = path(100, 110, 104, 114, 107, 118, 100, 120);
    const s = computeStructureSeries(lineBars(prices), cons);
    expect(s[56].regime).toBe("weakeningUp");
    expect(prices[80]).toBe(118);
    expect(s[80].regime).toBe("weakeningUp");
    expect(prices[81]).toBe(119);
    expect(s[81].regime).toBe("up");
    expect(s[81].oshiYasune).toBe(100);
    // 目線は一度も down にならない (反転なし)
    expect(s.some((x) => x.bias === "down")).toBe(false);
    expect(s[81].flips).toBe(0);
    // 同じ値動きで purist は down → up と 2 回反転する
    const p = computeStructureSeries(lineBars(prices), { ...N2, chopM: 100, chopR: 2 });
    expect(p[56].bias).toBe("down");
    expect(p[81].bias).toBe("up");
    expect(p[81].oshiYasune).toBe(100);
    expect(p[81].flips).toBe(2);
    expect(p[81].choppy).toBe(true);
  });

  it("下降側も対称 (weakeningDown → 戻り高値の後の高値 2 を超えたら up)", () => {
    const prices = path(120, 110, 116, 106, 113, 102, 120, 110, 125);
    const s = computeStructureSeries(lineBars(prices), cons);
    const firstWeak = s.findIndex((x) => x.regime === "weakeningDown");
    expect(firstWeak).toBeGreaterThan(0);
    expect(s[firstWeak].bias).toBe("down");
    const firstUp = s.findIndex((x) => x.regime === "up");
    expect(firstUp).toBeGreaterThan(firstWeak);
    expect(prices[firstUp]).toBe(121); // 高値 2 (120) を超えた足
    expect(s[firstUp].oshiYasune).toBe(110);
  });
});

describe("方法 2 (trendConfirmed) とちゃぶつき", () => {
  it("HH+HL で up、LH か LL が出たら none、LH+LL で down", () => {
    const prices = path(100, 110, 104, 114, 107, 118, 100, 110, 95);
    const s = computeStructureSeries(lineBars(prices), N2);
    expect(s[35].trendConfirmed).toBe("up");
    expect(s[63].trendConfirmed).toBe("up");
    expect(s[64].labels).toEqual({ sh: "HH", sl: "LL" });
    expect(s[64].trendConfirmed).toBe("none"); // LL (100) が確定 → 上昇終了
    expect(s[74].labels).toEqual({ sh: "LH", sl: "LL" });
    expect(s[74].trendConfirmed).toBe("down");
    // 方法 1 はこの時点で既に down (押し安値割れは idx 56)。方法 2 は LL の確定 (idx 64) で上昇終了とみなす
    expect(s[56].bias).toBe("down");
    expect(s[56].trendConfirmed).toBe("up");
  });

  it("直近 M 本で R 回以上反転したら choppy (M 本を過ぎたら解除)", () => {
    const prices = path(100, 110, 104, 114, 107, 118, 100, 120, 99, 125);
    const opts = { ...N2, chopM: 60, chopR: 3 };
    const s = computeStructureSeries(lineBars(prices), opts);
    const flipsAt = s.map((x) => x.flips);
    const firstChoppy = s.findIndex((x) => x.choppy);
    expect(firstChoppy).toBeGreaterThan(0);
    expect(flipsAt[firstChoppy]).toBe(3);
    expect(s.slice(0, firstChoppy).every((x) => !x.choppy)).toBe(true);
    // 平坦な足を足して M 本経てば反転の数が減る
    const tail = Array.from({ length: 80 }, () => prices[prices.length - 1]);
    const s2 = computeStructureSeries(lineBars([...prices, ...tail]), opts);
    expect(s2[s2.length - 1].choppy).toBe(false);
  });
});

describe("パーフェクトオーダー", () => {
  it("短期 > 中期 > 長期 で up、逆で down (SMA / EMA)", () => {
    const up = Array.from({ length: 80 }, (_, i) => 100 + i);
    expect(perfectOrderSeries(up, { type: "sma", periods: [5, 20, 50] }).at(-1)).toBe("up");
    expect(perfectOrderSeries(up.map((x) => 300 - x), { type: "ema", periods: [5, 20, 50] }).at(-1)).toBe("down");
    expect(perfectOrderSeries(up, { type: "sma", periods: [5, 20, 50] })[10]).toBe("none"); // 計算できない
    const s = computeStructureSeries(lineBars(up), { ...N2, perfectOrder: { type: "ema", periods: [5, 20, 50] } });
    expect(s.at(-1)!.perfectOrder).toBe("up");
  });
});

describe("上位足 (MTF)", () => {
  it("view に無い上位足は確定分だけ集約する (形成中の週は使わない)", () => {
    // 1d を 20 日分 (2026-01-05 は月曜)。now は 20 日目の終わり = 3 週目の途中
    const d = lineBars(Array.from({ length: 20 }, (_, i) => 100 + i), "1d");
    const now = d[19].ts + 86_400_000;
    const w = higherCandles({ candles: { "1d": d }, now }, "1d", "1w");
    expect(w.map((x) => x.ts)).toEqual([T0, T0 + 7 * 86_400_000]);
    expect(w[1]).toMatchObject({ open: 107, high: 113, low: 107, close: 113 });
    // view にあれば確定足だけを使う
    const own = lineBars([1, 2, 3], "1w");
    expect(higherCandles({ candles: { "1d": d, "1w": own }, now: own[1].ts + 7 * 86_400_000 }, "1d", "1w")).toHaveLength(2);
  });
});

describe("上位足 (MTF): 1d → 1w の集約は直近 300 本に固定", () => {
  it("1d の入力が 300 本でも 450 本でも、1w から作った構造は同じ", () => {
    const DAY = 86_400_000;
    // 週の境目がずれないよう、月曜始まりの 450 日分 (T0 は月曜)。ジグザグ + ドリフトで構造が変わる系列
    const prices = Array.from({ length: 450 }, (_, i) => 100 + i * 0.3 + 15 * Math.sin(i / 9));
    const all = lineBars(prices, "1d");
    const now = all[449].ts + DAY;
    const a = higherCandles({ candles: { "1d": all.slice(150) }, now }, "1d", "1w"); // 300 本
    const b = higherCandles({ candles: { "1d": all }, now }, "1d", "1w"); // 450 本
    const c = higherCandles({ candles: { "1d": all.slice(60) }, now }, "1d", "1w"); // 390 本
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(structureAt(b, undefined, { pivotN: 2 })).toEqual(structureAt(a, undefined, { pivotN: 2 }));
    // 形成中の週と、先頭の欠けた週は入らない
    expect(a[a.length - 1].ts + 7 * DAY).toBeLessThanOrEqual(now);
    expect(a[0].ts).toBeGreaterThanOrEqual(all[150].ts);
  });
});

/** 乱数の合成の足 (同値が出やすいよう価格を丸める) */
function randomBars(seed: number, n: number, tick: number): Candle[] {
  const rng = createRng(seed);
  let p = 1000;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = p;
    p = Math.max(1, Math.round((p + rng.normal() * 4) / tick) * tick);
    const h = Math.round((Math.max(o, p) + Math.abs(rng.normal()) * 2) / tick) * tick;
    const l = Math.round((Math.min(o, p) - Math.abs(rng.normal()) * 2) / tick) * tick;
    out.push({ ts: T0 + i * 60_000, open: o, high: h, low: l, close: p, volume: 1 });
  }
  return out;
}

describe("リペイントしない (性質テスト)", () => {
  const configs: Partial<StructureOptions>[] = [
    {},
    { pivotN: 3, breakMode: "wick" },
    { pivotN: 4, reversalMode: "conservative" },
    { pivotN: 6, reversalMode: "conservative", breakMode: "wick", chopM: 30, chopR: 2, perfectOrder: { type: "ema", periods: [5, 20, 50] } },
    { pivotN: 10, perfectOrder: { type: "sma", periods: [5, 20, 50] } },
  ];
  const datasets: { name: string; candles: Candle[] }[] = [
    ...[1, 2, 3].map((seed) => ({ name: `GBM seed ${seed}`, candles: generateCandles({ seed, bars: 900, timeframe: "1m", vol: 0.002 }) })),
    ...[11, 12, 13, 14].map((seed) => ({ name: `丸めた乱歩 seed ${seed}`, candles: randomBars(seed, 700, seed % 2 === 0 ? 1 : 5) })),
  ];

  for (const d of datasets) {
    for (const cfg of configs) {
      it(`${d.name} / ${JSON.stringify(cfg)}: k までで計算した状態 = 全期間の k 時点`, () => {
        const full = computeStructureSeries(d.candles, cfg);
        expect(full).toHaveLength(d.candles.length);
        const pivotsFull = detectPivots(d.candles, cfg.pivotN ?? 6);
        const rng = createRng(d.candles.length + (cfg.pivotN ?? 6));
        const ks = new Set<number>([0, 1, 5, d.candles.length - 1]);
        while (ks.size < 60) ks.add(Math.floor(rng.next() * d.candles.length));
        for (const k of ks) {
          const prefix = d.candles.slice(0, k + 1);
          expect(structureAt(prefix, undefined, cfg)).toEqual(full[k]);
          expect(structureAt(d.candles, k, cfg)).toEqual(full[k]);
          // ピボットも、k までで判定できたものは全期間の結果と同じ (confirmedAt <= k)
          expect(detectPivots(prefix, cfg.pivotN ?? 6)).toEqual(pivotsFull.filter((p) => p.confirmedAt <= k));
        }
        // 共存禁止と、押し安値は up のときだけ・戻り高値は down のときだけ
        for (const x of full) {
          expect(x.oshiYasune !== null && x.modoriTakane !== null).toBe(false);
          if (x.oshiYasune !== null) expect(x.regime).toBe("up");
          if (x.modoriTakane !== null) expect(x.regime).toBe("down");
        }
      });
    }
  }

  it("末尾に足を足しても、それより前の状態は変わらない", () => {
    const c = randomBars(99, 500, 1);
    const a = computeStructureSeries(c.slice(0, 400));
    const b = computeStructureSeries(c);
    expect(b.slice(0, 400)).toEqual(a);
  });
});
