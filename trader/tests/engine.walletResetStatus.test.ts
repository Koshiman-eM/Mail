/** エンジン: paper の口座リセット (paper reset) 後の status と、テンポの復元から除く取引 (合成データ、オフライン) */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config";
import type { Clock, TradeRecord } from "../src/core/types";
import { buildRuntime } from "../src/engine/setup";
import { PAPER_RESETS_KEY } from "../src/paper/walletReset";
import { MemoryStore } from "../src/storage/memory";

const MIN = 60_000;
const START = Date.UTC(2026, 0, 5);

async function setup(env: Record<string, string>, seed: (store: MemoryStore) => void) {
  const clock: Clock & { t: number } = { t: START, now() { return this.t; } };
  const store = new MemoryStore();
  seed(store);
  const rt = await buildRuntime(
    loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY", ...env }),
    { clock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, strategies: [] },
  );
  return { rt, store, clock };
}

describe("口座リセット後の status", () => {
  it("当初の評価額はリセット後の評価額、評価額の推移はリセット以降だけ", async () => {
    const resetAt = START - 2 * 3_600_000;
    const { rt } = await setup({ PAPER_INITIAL_EQUITY: "1000000" }, (store) => {
      store.kvSet(PAPER_RESETS_KEY, [{ at: resetAt - 86_400_000, toEquity: 800_000, closedCount: 0 }, { at: resetAt, fromEquity: 900_000, toEquity: 500_000, closedCount: 1 }]);
      store.saveEquity({ ts: resetAt - 3_600_000, equity: 900_000, mode: "paper" });
      store.saveEquity({ ts: resetAt + 60_000, equity: 500_000, mode: "paper" });
      store.saveEquity({ ts: resetAt + 3_600_000, equity: 510_000, mode: "paper" });
    });
    const st = await rt.engine.status();
    expect(st.equity.initial).toBe(500_000);
    expect(st.equityHistory.map((p) => p.ts)).toEqual([resetAt + 60_000, resetAt + 3_600_000]);
    await rt.engine.stop();
    rt.close();
  });

  it("リセットが無ければ従来どおり (PAPER_INITIAL_EQUITY・全期間)", async () => {
    const { rt } = await setup({ PAPER_INITIAL_EQUITY: "1000000" }, (store) => {
      store.saveEquity({ ts: START - 3_600_000, equity: 990_000, mode: "paper" });
    });
    const st = await rt.engine.status();
    expect(st.equity.initial).toBe(1_000_000);
    expect(st.equityHistory).toHaveLength(1);
    await rt.engine.stop();
    rt.close();
  });
});

describe("テンポの復元 (seedTempo)", () => {
  it("学習・成績から除く取引 (wallet_reset) はエントリー数に数えない", async () => {
    const trade = (id: string, entryTs: number, extra: Partial<TradeRecord> = {}) =>
      ({
        id, mode: "paper", symbol: "BTC/USDT", venue: "synthetic", assetClass: "crypto", strategyId: "x", horizon: "scalp", direction: "long",
        qty: 1, entryPrice: 100, entryTs, exitPrice: 100, exitTs: entryTs + MIN, exitReason: "time", fees: 0, grossPnl: 0, netPnl: 0,
        initialStop: 99, ...extra,
      }) as unknown as TradeRecord;
    const { rt } = await setup({ TARGET_ENTRIES_PER_HOUR: "6" }, (store) => {
      store.saveTrade(trade("a", START - 10 * MIN));
      store.saveTrade(trade("b", START - 20 * MIN, { exitReason: "wallet_reset" as TradeRecord["exitReason"] }));
      store.saveTrade(trade("c", START - 30 * MIN, { learningExcluded: true }));
    });
    await rt.engine.init();
    expect(rt.engine.tempo!.snapshot(START).entriesInWindow).toBe(1);
    await rt.engine.stop();
    rt.close();
  });
});
