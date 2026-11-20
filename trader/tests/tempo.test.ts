/** テンポ (エントリー頻度の目標に対する遅れ) の単体テスト。時刻はすべて引数で渡す (決定的) */
import { describe, expect, it } from "vitest";
import { clampTempo, relaxToward, TEMPO_COST_MULT_FLOOR, TempoController, tempoNetEdgeFloor } from "../src/engine/tempo";

const T = Date.UTC(2025, 0, 1, 12);
const MIN = 60_000;
const at = (m: number) => T + m * MIN;

describe("clampTempo / relaxToward", () => {
  it("テンポは 0〜1 (undefined・NaN は 0)", () => {
    expect(clampTempo(undefined)).toBe(0);
    expect(clampTempo(NaN)).toBe(0);
    expect(clampTempo(-0.5)).toBe(0);
    expect(clampTempo(0.3)).toBe(0.3);
    expect(clampTempo(4)).toBe(1);
    expect(clampTempo(Infinity)).toBe(0);
  });

  it("base から floor へ tempo の割合だけ緩める。floor より下にはしない", () => {
    expect(TEMPO_COST_MULT_FLOOR).toBe(1.5);
    expect(relaxToward(2.5, 1.5, 0)).toBe(2.5);
    expect(relaxToward(2.5, 1.5, undefined)).toBe(2.5);
    expect(relaxToward(2.5, 1.5, NaN)).toBe(2.5);
    expect(relaxToward(2.5, 1.5, 0.5)).toBeCloseTo(2, 12);
    expect(relaxToward(2.5, 1.5, 1)).toBe(1.5);
    expect(relaxToward(2.5, 1.5, 3)).toBe(1.5);
    expect(relaxToward(2.5, 1.5, -1)).toBe(2.5);
    expect(relaxToward(1.5, 1.5, 1)).toBe(1.5);
  });

  it("base が floor 未満なら base のまま (締めも緩めもしない)。NaN は NaN のまま", () => {
    expect(relaxToward(1.2, 1.5, 1)).toBe(1.2);
    expect(relaxToward(0, 1.5, 0.7)).toBe(0);
    expect(relaxToward(NaN, 1.5, 1)).toBeNaN();
    // 0 からの比較でも単調: tempo を上げるほど小さく (緩く) なる
    let prev = Infinity;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const v = relaxToward(3, 1, t);
      expect(v).toBeLessThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(1);
      prev = v;
    }
  });
});

describe("TempoController", () => {
  it("エントリーが無いときは、起点から interval (60 / 目標) 分は 0、その後 interval 分かけて 1 まで上がる", () => {
    const tc = new TempoController({ targetPerHour: 6, now: T });
    expect(tc.level(at(0))).toBe(0);
    expect(tc.level(at(10))).toBe(0);
    expect(tc.level(at(15))).toBeCloseTo(0.5, 12);
    expect(tc.level(at(20))).toBe(1);
    expect(tc.level(at(90))).toBe(1);
    expect(tc.capped(at(90))).toBe(false);
  });

  it("エントリー直後は 0。窓の中の回数が足りない分 (deficit) × 待ち時間の割合", () => {
    const tc = new TempoController({ targetPerHour: 6, now: T });
    tc.recordEntry(at(20));
    expect(tc.level(at(20))).toBe(0);
    expect(tc.level(at(30))).toBe(0);
    // n = 1 → deficit 5/6、since 15 分 → wait 0.5
    expect(tc.level(at(35))).toBeCloseTo((5 / 6) * 0.5, 12);
    expect(tc.level(at(40))).toBeCloseTo(5 / 6, 12);
    // 窓 (60 分) を過ぎるとエントリーは数えない → deficit 1
    expect(tc.level(at(81))).toBe(1);
    const snap = tc.snapshot(at(81));
    expect(snap).toMatchObject({ target: 6, entriesInWindow: 0, tempo: 1, capped: false, intervalMin: 10 });
    expect(snap.minutesSinceLastEntry).toBeCloseTo(61, 9);
  });

  it("目標の回数に達していれば、間が空いても 0。古いエントリーが窓から外れると上がる", () => {
    const tc = new TempoController({ targetPerHour: 6, now: T });
    for (let m = 0; m < 6; m++) tc.recordEntry(at(m));
    expect(tc.level(at(40))).toBe(0);
    expect(tc.snapshot(at(40)).entriesInWindow).toBe(6);
    // at(0) だけが窓から外れる (now - 60 分以下は捨てる) → n = 5、since = 55.5 分
    expect(tc.level(at(60.5))).toBeCloseTo(1 / 6, 12);
    // at(61) では at(1) も外れる → n = 4
    expect(tc.level(at(61))).toBeCloseTo(2 / 6, 12);
  });

  it("窓の中の回数が ceil(目標 × capMultiplier) に達したら capped", () => {
    const tc = new TempoController({ targetPerHour: 6, now: T });
    for (let m = 0; m < 11; m++) tc.recordEntry(at(m * 2));
    expect(tc.capped(at(22))).toBe(false);
    tc.recordEntry(at(22));
    expect(tc.capped(at(22))).toBe(true);
    expect(tc.snapshot(at(22))).toMatchObject({ entriesInWindow: 12, capAt: 12, capped: true, tempo: 0 });
    // 古いものが窓から外れれば解除
    expect(tc.capped(at(61))).toBe(false);
    // 端数は切り上げ: 2.5 × 2 = 5
    const tc2 = new TempoController({ targetPerHour: 2.5, capMultiplier: 2, now: T });
    for (let m = 0; m < 4; m++) tc2.recordEntry(at(m));
    expect(tc2.capped(at(5))).toBe(false);
    tc2.recordEntry(at(5));
    expect(tc2.capped(at(5))).toBe(true);
    // capMultiplier を変える
    const tc3 = new TempoController({ targetPerHour: 6, capMultiplier: 1, now: T });
    for (let m = 0; m < 6; m++) tc3.recordEntry(at(m));
    expect(tc3.capped(at(6))).toBe(true);
  });

  it("seed: 再起動時に過去のエントリーを取り込む (非有限は無視、窓の外は数えないが最後の時刻には使う)", () => {
    const tc = new TempoController({ targetPerHour: 6, now: T });
    tc.seed([at(-50), at(-40), NaN, Infinity]);
    // n = 2 → deficit 4/6、since 40 分 → wait 1
    expect(tc.level(T)).toBeCloseTo(4 / 6, 12);
    expect(tc.snapshot(T).entriesInWindow).toBe(2);
    const old = new TempoController({ targetPerHour: 6, now: T });
    old.seed([at(-180)]);
    expect(old.snapshot(T)).toMatchObject({ entriesInWindow: 0, tempo: 1 });
    expect(old.snapshot(T).minutesSinceLastEntry).toBeCloseTo(180, 9);
    // 空の seed は何もしない
    const none = new TempoController({ targetPerHour: 6, now: T });
    none.seed([]);
    expect(none.level(T)).toBe(0);
    expect(none.snapshot(T).minutesSinceLastEntry).toBeNull();
  });

  it("起点を省略すると、最初に渡された時刻を起点にする", () => {
    const tc = new TempoController({ targetPerHour: 6 });
    expect(tc.level(at(100))).toBe(0);
    expect(tc.level(at(115))).toBeCloseTo(0.5, 12);
    expect(tc.level(at(120))).toBe(1);
  });

  it("windowMs を変えると、目標の回数は窓の長さに換算する", () => {
    const tc = new TempoController({ targetPerHour: 6, windowMs: 30 * MIN, now: T });
    const snap = tc.snapshot(T);
    expect(snap.targetInWindow).toBeCloseTo(3, 12);
    expect(snap.capAt).toBe(6);
    tc.recordEntry(at(0));
    // n = 1 / 3 → deficit 2/3、since 20 分 → wait 1
    expect(tc.level(at(20))).toBeCloseTo(2 / 3, 12);
  });

  it("目標が 0 以下・非有限なら無効 (常に 0、capped にならない)", () => {
    for (const target of [0, -3, NaN, Infinity]) {
      const tc = new TempoController({ targetPerHour: target, now: T });
      for (let m = 0; m < 50; m++) tc.recordEntry(at(m));
      expect(tc.enabled).toBe(false);
      expect(tc.level(at(500))).toBe(0);
      expect(tc.capped(at(50))).toBe(false);
      expect(tc.snapshot(at(50))).toMatchObject({ tempo: 0, capped: false });
    }
  });

  it("決定的: 同じ記録と時刻なら同じ結果 (実時間に依存しない)", () => {
    const run = () => {
      const tc = new TempoController({ targetPerHour: 4, now: T });
      tc.recordEntry(at(3));
      tc.recordEntry(at(1)); // 順不同でもよい
      return [tc.level(at(10)), tc.level(at(25)), tc.level(at(40)), tc.capped(at(40)), tc.snapshot(at(40))];
    };
    expect(run()).toEqual(run());
    const tc = new TempoController({ targetPerHour: 4, now: T });
    tc.recordEntry(at(3));
    tc.recordEntry(at(1));
    // 最後のエントリー (at(3)) から interval 15 分 + 7.5 分 → wait 0.5、n = 2 / 4 → deficit 0.5
    expect(tc.level(at(25.5))).toBeCloseTo(0.25, 12);
    // 非有限の時刻は 0
    expect(tc.level(NaN)).toBe(0);
    tc.recordEntry(NaN);
    expect(tc.snapshot(at(25.5)).entriesInWindow).toBe(2);
  });
});

describe("tempoNetEdgeFloor (探索の期待値の下限)", () => {
  it("explore が false なら minNetEdgeBps そのもの (tempo・コストによらない)", () => {
    expect(tempoNetEdgeFloor(0, 1, 20, false)).toBe(0);
    expect(tempoNetEdgeFloor(3, 0.5, 20, false)).toBe(3);
    expect(tempoNetEdgeFloor(-Infinity, 1, 20, false)).toBe(-Infinity);
  });

  it("explore が true なら minNetEdgeBps - clamp(tempo) × costBps。コストが非有限・負なら下げない", () => {
    expect(tempoNetEdgeFloor(0, 1, 20, true)).toBe(-20);
    expect(tempoNetEdgeFloor(0, 0.5, 20, true)).toBe(-10);
    expect(tempoNetEdgeFloor(2, 0, 20, true)).toBe(2);
    expect(tempoNetEdgeFloor(0, undefined, 20, true)).toBe(0);
    expect(tempoNetEdgeFloor(0, 5, 20, true)).toBe(-20);
    expect(tempoNetEdgeFloor(0, NaN, 20, true)).toBe(0);
    expect(tempoNetEdgeFloor(0, 1, NaN, true)).toBe(0);
    expect(tempoNetEdgeFloor(0, 1, -5, true)).toBe(0);
  });
});
