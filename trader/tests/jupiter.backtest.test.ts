import { describe, expect, it } from "vitest";
import { parseBacktestArgs, main } from "../src/cli";
import { fetchCandlesPaged, runBacktestCommand } from "../src/engine/backtestCommand";
import { GeckoHistoryFeed } from "../src/market/feeds/geckoHistory";
import { jupiterInstrument } from "../src/market/feeds/jupiter";
import { GeckoTerminalClient } from "../src/market/jupiter/gecko";
import { scalpPullback } from "../src/strategies/scalpPullback";
import { createMockFetch, fakeClock } from "./fixtures/jupiter/mockFetch";
import { BONK, createJupiterMock, poolOf } from "./helpers/jupiterMock";

const T0 = Date.UTC(2026, 10, 20, 0, 0, 0);

describe("backtest --source jupiter (GeckoTerminal の足)", () => {
  it("引数: --source jupiter は --token (既定 SOL)。--token は jupiter 以外では拒否", () => {
    expect(parseBacktestArgs({ strategy: "all", source: "jupiter" })).toMatchObject({ source: "jupiter", token: "SOL" });
    expect(parseBacktestArgs({ strategy: "all", source: "jupiter", token: "BONK" }).token).toBe("BONK");
    expect(() => parseBacktestArgs({ strategy: "all", token: "BONK" })).toThrow(/--source jupiter/);
    expect(() => parseBacktestArgs({ strategy: "all", source: "jupiter", symbol: "X" })).toThrow(/--token/);
  });

  it("GeckoTerminal の足を since までさかのぼって取り、運用と同じ銘柄定義 (コスト = 代わりのモデル + ネットワーク手数料) で回す", async () => {
    const clock = fakeClock(T0);
    const mock = createJupiterMock({ now: clock.now });
    const gecko = new GeckoTerminalClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, callsPerMinute: 600, burst: 100, retries: 0 });
    const inst = jupiterInstrument({ mint: BONK, symbol: "BONK", decimals: 5, assetClass: "meme", liquidityUsd: 2e6, source: "fixed" }, { quoteSizeUsd: 50, networkFeeUsd: 0.02, minNotionalUsd: 5 });
    const feed = new GeckoHistoryFeed(gecko, inst, poolOf(BONK), clock.now);
    const rows = await runBacktestCommand({ strategy: scalpPullback.id, days: 2, source: "jupiter", seed: 1, feed, symbol: inst.symbol, now: T0, strategies: [scalpPullback] });
    expect(rows).toHaveLength(1);
    expect(rows[0].bars).toBeGreaterThan(2 * 1440);
    const ohlcv = mock.calls.filter((c) => c.path.includes("/ohlcv/minute"));
    expect(ohlcv.length).toBeGreaterThanOrEqual(3);
    if (rows[0].metrics && rows[0].metrics.trades > 0) expect(rows[0].metrics.fees).toBeGreaterThan(0);
  });

  it("7 日分の 1m を全部返す (クライアントの足のキャッシュ (3000 本) で切り詰めない)。履歴が短ければ警告して取れた分を返す", async () => {
    const clock = fakeClock(T0);
    const mock = createJupiterMock({ now: clock.now });
    const gecko = new GeckoTerminalClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, callsPerMinute: 6000, burst: 100, retries: 0 });
    const inst = jupiterInstrument({ mint: BONK, symbol: "BONK", decimals: 5, assetClass: "meme", liquidityUsd: 2e6, source: "fixed" }, { quoteSizeUsd: 50, networkFeeUsd: 0.02, minNotionalUsd: 5 });
    const feed = new GeckoHistoryFeed(gecko, inst, poolOf(BONK), clock.now);
    const from = T0 - 7 * 86_400_000;
    const got = await fetchCandlesPaged(feed, inst.symbol, "1m", from, T0);
    expect(got.length).toBe(7 * 1440);
    expect(got[0].ts).toBe(from);
    expect(got.at(-1)!.ts).toBe(T0 - 60_000);
    // 履歴の先頭が 2 日前のプール
    const short = createMockFetch(async (call) => {
      const r = await mock.fetchImpl(call.url);
      const body = (await r.json()) as { data: { attributes: { ohlcv_list: number[][] } } };
      body.data.attributes.ohlcv_list = body.data.attributes.ohlcv_list.filter((row) => row[0] * 1000 >= T0 - 2 * 86_400_000);
      return { body };
    }, clock.now);
    const g2 = new GeckoTerminalClient({ fetchImpl: short.fetchImpl, now: clock.now, sleep: clock.sleep, callsPerMinute: 6000, burst: 100, retries: 0 });
    const warns: string[] = [];
    const f2 = new GeckoHistoryFeed(g2, inst, poolOf(BONK), clock.now, undefined, (m) => warns.push(m));
    const part = await fetchCandlesPaged(f2, inst.symbol, "1m", from, T0);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/履歴が要求より短い/);
    expect(warns[0]).toContain("取れた分だけで計算します");
    expect(part).toHaveLength(2 * 1440);
    expect(part[0].ts).toBe(T0 - 2 * 86_400_000);
    // 1 本も無ければ例外
    const none = createMockFetch(async (call) => {
      const r = await mock.fetchImpl(call.url);
      const body = (await r.json()) as { data: { attributes: { ohlcv_list: number[][] } } };
      body.data.attributes.ohlcv_list = [];
      return { body };
    }, clock.now);
    const g3 = new GeckoTerminalClient({ fetchImpl: none.fetchImpl, now: clock.now, sleep: clock.sleep, callsPerMinute: 6000, burst: 100, retries: 0 });
    await expect(fetchCandlesPaged(new GeckoHistoryFeed(g3, inst, poolOf(BONK), clock.now), inst.symbol, "1m", from, T0)).rejects.toThrow(/履歴を取得できません/);
  });

  it("jupiter check の引数 (サブコマンドは check だけ)", async () => {
    const err: string[] = [];
    const code = await main(["jupiter", "nope"], { out: () => undefined, err: (s) => err.push(s) });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("jupiter check");
  });
});
