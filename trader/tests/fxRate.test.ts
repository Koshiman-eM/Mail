import { describe, expect, it } from "vitest";
import { createFxConverter, fxApproxReason } from "../src/engine/fx";
import { FX_USDJPY_KV_KEY, parseFrankfurter, UsdJpyRateSource } from "../src/engine/fxRate";
import { MemoryStore } from "../src/storage/memory";
import { createMockFetch, fakeClock } from "./fixtures/jupiter/mockFetch";

const T0 = Date.UTC(2026, 10, 20, 9, 0, 0);
const H = 3_600_000;

describe("USD/JPY の日次のレート (frankfurter.app)", () => {
  it("応答を読む。形が違えば例外", () => {
    expect(parseFrankfurter({ amount: 1, base: "USD", date: "2026-11-20", rates: { JPY: 155.42 } })).toEqual({ rate: 155.42, date: "2026-11-20" });
    expect(() => parseFrankfurter({ rates: {} })).toThrow();
    expect(() => parseFrankfurter({ rates: { JPY: 0 } })).toThrow();
  });

  it("1 時間ごとに取り直し、kv にキャッシュ。換算 (fx.ts) は USD/JPY の気配として使い、paper では古いと扱わない", async () => {
    const clock = fakeClock(T0);
    let rate = 155.5;
    let fail = false;
    const mock = createMockFetch(() => (fail ? { status: 503, body: {} } : { body: { date: "2026-11-20", rates: { JPY: rate } } }), clock.now);
    const store = new MemoryStore();
    const src = new UsdJpyRateSource({ store, fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep });
    const fx = createFxConverter({ baseCurrency: "JPY", getQuote: (s) => src.quote(s) });
    // 取れるまでは概算表
    expect(fx.rateInfo!("USDC", "JPY")).toMatchObject({ rate: 150, source: "fallback" });
    await src.refresh();
    expect(mock.calls[0].url).toBe("https://api.frankfurter.app/latest?from=USD&to=JPY");
    expect(fx.toAccount("USDC")).toBe(155.5);
    expect(fx.rateInfo!("USDC", "JPY").source).toBe("quote");
    expect(store.kvGet(FX_USDJPY_KV_KEY)).toEqual({ rate: 155.5, date: "2026-11-20", fetchedAt: T0 });
    // 1 時間以内は取り直さない
    rate = 156;
    clock.advance(H - 1);
    await src.refresh();
    expect(mock.calls).toHaveLength(1);
    clock.advance(1);
    await src.refresh();
    expect(fx.toAccount("USD")).toBe(156);
    // 失敗しても最後の値を使い続ける
    fail = true;
    clock.advance(H);
    await src.refresh();
    expect(fx.toAccount("USDT")).toBe(156);
    expect(src.status().lastError).toBeDefined();
    // 再起動後も kv の値から始める
    const again = new UsdJpyRateSource({ store, fetchImpl: mock.fetchImpl, now: clock.now });
    expect(again.quote("USD/JPY")?.bid).toBe(156);
    expect(again.quote("EUR/JPY")).toBeUndefined();
    // live の新規エントリーは従来どおり古い (5 分超) 気配を拒否する (paper は fxApproxReason を見ない)
    expect(fxApproxReason(fx, "USDC", "JPY", clock.now())).toMatch(/古い/);
  });
});
