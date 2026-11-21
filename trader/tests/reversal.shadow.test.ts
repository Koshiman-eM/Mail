/** 仮想トレード (見送ったシグナル) の転換で決済: 実際の建玉と同じ src/engine/reversalExit.ts の規則。合成データ (オフライン) */
import { describe, expect, it } from "vitest";
import type { Candle, ShadowTradeRecord, Timeframe } from "../src/core/types";
import { DEFAULT_REVERSAL_SETTINGS, type ReversalSettings } from "../src/engine/reversalExit";
import { ShadowTracker, shadowOpenKey, type ShadowOpen, type ShadowRecordInput } from "../src/learning/shadow";
import { MemoryStore } from "../src/storage/memory";
import { barTs, H, LONG_PROFIT, LONG_PROFIT_BREAK, M, scenarioBars, SYM } from "./helpers/reversalScenario";

/** 転換で決済を無効にした設定 (従来どおり) */
const REVERSAL_DISABLED: Readonly<ReversalSettings> = { ...DEFAULT_REVERSAL_SETTINGS, enabled: false };

const ON: ReversalSettings = { ...DEFAULT_REVERSAL_SETTINGS, strategies: [] };
const TAIL = [102.0, 101.5, 101.0, 100.5, 100.0, 99.0, 98.0];
const BARS = scenarioBars(LONG_PROFIT, TAIL);
const inst = { symbol: SYM, assetClass: "crypto" as const, takerFeeRate: 0.001 };

/** 足 k の開始時刻の気配 (始値 ± 0.01) */
const quoteAt = (k: number) => ({ bid: BARS[k].open - 0.01, ask: BARS[k].open + 0.01 });
/** now までに確定した足 */
const closedBy = (bars: Candle[], tfMs: number, now: number) => bars.filter((b) => b.ts + tfMs <= now);

function input(o: Partial<ShadowRecordInput> = {}, sig: Partial<ShadowRecordInput["signal"]> = {}): ShadowRecordInput {
  return {
    instrument: inst,
    quote: quoteAt(H),
    signal: { strategyId: "scalp_x", direction: "long", confidence: 0.7, expectedEdgeBps: 15, stopLoss: 97, takeProfit: 106, maxHoldMs: 120 * M, horizon: "scalp", ...sig },
    regime: "range",
    reason: "lower_score",
    now: barTs(H) + 1_000,
    exitTimeframe: "1m",
    ...o,
  };
}

const tracker = (reversal: ReversalSettings | undefined, store = new MemoryStore(), closed: ShadowTradeRecord[] = []) =>
  new ShadowTracker({ store, mode: "paper", options: reversal ? { reversal } : {}, onClosed: (t) => closed.push(t) });

/** 足 H+1 〜 last の開始 + 1 秒で順に判定する。決済したら止めて返す */
function runTicks(tr: ShadowTracker, last: number, candlesOf = (_s: string, tf: Timeframe, now: number) => (tf === "1m" ? closedBy(BARS, M, now) : undefined)) {
  for (let k = H + 1; k <= last; k++) {
    const now = barTs(k) + 1_000;
    const out = tr.update(now, () => quoteAt(k), { candlesOf: (s, tf) => candlesOf(s, tf, now) });
    if (out.length) return { k, rec: out[0] };
  }
  return undefined;
}

describe("仮想トレードの転換で決済", () => {
  it("1m: エントリー後の押し安値を終値が割った次の判定で reversal (決済側の気配 − 約定ずれ)。保存は時間足だけ、決済の記録には残さない", () => {
    const store = new MemoryStore();
    const tr = tracker(ON, store);
    expect(tr.record(input())).toBe(true);
    expect(tr.list()[0].reversalTf).toBe("1m");
    tr.flush();
    expect(store.kvGet<ShadowOpen[]>(shadowOpenKey("paper"))?.[0].reversalTf).toBe("1m");
    const hit = runTicks(tr, H + 20);
    expect(hit?.k).toBe(H + LONG_PROFIT_BREAK + 1);
    const r = hit!.rec;
    expect(r.exitReason).toBe("reversal");
    const bid = quoteAt(H + LONG_PROFIT_BREAK + 1).bid;
    expect(r.exitPrice).toBeCloseTo(bid * (1 - 0.0001), 9);
    expect(r.netR).toBeGreaterThan(0);
    expect("reversalTf" in r).toBe(false);
    expect("reversalBarTs" in r).toBe(false);
  });

  it("無効・対象外の戦略・時間足の無い記録は従来どおり (転換で決済しない)", () => {
    for (const [tr, inp] of [
      [tracker(REVERSAL_DISABLED), input()],
      [tracker(undefined), input()],
      [tracker({ ...ON, strategies: ["other"] }), input()],
      [tracker(ON), input({ exitTimeframe: undefined })],
    ] as const) {
      tr.record(inp);
      expect(tr.list()[0].reversalTf).toBeUndefined();
      expect(runTicks(tr, H + LONG_PROFIT_BREAK + 3)).toBeUndefined();
    }
  });

  it("保存済みの古い記録 (reversalTf なし) は有効でも転換で決済しない", () => {
    const store = new MemoryStore();
    const a = tracker(REVERSAL_DISABLED, store);
    a.record(input());
    a.flush();
    const b = tracker(ON, store);
    expect(b.list()[0].reversalTf).toBeUndefined();
    expect(runTicks(b, H + LONG_PROFIT_BREAK + 3)).toBeUndefined();
  });

  it("損切りが先 (同じ判定で損切りにも届けば stop)", () => {
    // r5 の始値 (103.5) で買い。r7 の押し安値 102.55 はエントリー後のスイング。r12 の後の判定 (気配 102.39) で割る
    const at = barTs(H + 5) + 1_000;
    const k = H + LONG_PROFIT_BREAK + 1;
    const step = (stopLoss: number) => {
      const tr = tracker(ON);
      expect(tr.record(input({ now: at, quote: quoteAt(H + 5) }, { stopLoss }))).toBe(true);
      const now = barTs(k) + 1_000;
      return tr.update(now, () => quoteAt(k), { candlesOf: (_s, tf) => (tf === "1m" ? closedBy(BARS, M, now) : undefined) })[0]?.exitReason;
    };
    // 損切り 102.45: 気配 102.39 は損切りにも届く → stop
    expect(step(102.45)).toBe("stop");
    // 損切り 100: 損切りには届かない → reversal
    expect(step(100)).toBe("reversal");
  });

  it("主時間足が 5m なら 5m の確定足で判定する (hub の足をそのまま使う)", () => {
    // 5m 足の台本: LONG_PROFIT の各足を 5m 足とみなし、1m は使わない
    const five = BARS.map((b, i) => ({ ...b, ts: barTs(0) + i * 5 * M }));
    const tr = tracker(ON);
    const entry = barTs(0) + H * 5 * M + 1_000;
    tr.record(input({ exitTimeframe: "5m", now: entry, quote: { bid: 99.99, ask: 100.01 } }));
    expect(tr.list()[0].reversalTf).toBe("5m");
    const asked: string[] = [];
    let exitAt: number | undefined;
    for (let k = H + 1; k <= H + 20 && exitAt === undefined; k++) {
      const now = barTs(0) + k * 5 * M + 1_000;
      const out = tr.update(now, () => ({ bid: five[k].open - 0.01, ask: five[k].open + 0.01 }), {
        candlesOf: (_s, tf) => {
          asked.push(tf);
          return tf === "5m" ? closedBy(five, 5 * M, now) : undefined;
        },
      });
      if (out.length) exitAt = k;
    }
    expect(exitAt).toBe(H + LONG_PROFIT_BREAK + 1);
    expect(new Set(asked)).toEqual(new Set(["5m"]));
  });
});
