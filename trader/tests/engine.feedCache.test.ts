import { describe, expect, it, vi } from "vitest";
import { ClosedCandleCacheFeed } from "../src/engine/feedCache";
import { SyntheticFeed } from "../src/market/feeds/synthetic";

const T0 = Date.UTC(2026, 0, 5, 0, 0, 30);
const mkClock = () => ({ t: T0, now() { return this.t; } });

describe("ClosedCandleCacheFeed", () => {
  it("確定足だけを返し、内容は内側の feed と一致する", async () => {
    const clock = mkClock();
    const inner = new SyntheticFeed({ clock, seed: 5, historyMs: 2 * 86_400_000 });
    const feed = new ClosedCandleCacheFeed(inner, { clock });
    const cached = await feed.fetchCandles("BTC/USDT", "15m", 50);
    const direct = (await inner.fetchCandles("BTC/USDT", "15m", 51)).filter((c) => c.ts + 900_000 <= clock.now());
    expect(cached).toEqual(direct.slice(-50));
    expect(cached.every((c) => c.ts + 900_000 <= clock.now())).toBe(true);
    expect(feed.venue).toBe(inner.venue);
    expect(typeof feed.fetchOrderBook).toBe("function");
  });

  it("新しい足が確定したときだけ内側へ問い合わせる", async () => {
    const clock = mkClock();
    const inner = new SyntheticFeed({ clock, seed: 5, historyMs: 2 * 86_400_000 });
    const spy = vi.spyOn(inner, "fetchCandles");
    const feed = new ClosedCandleCacheFeed(inner, { clock });
    await feed.fetchCandles("ETH/USDT", "1h", 300);
    expect(spy).toHaveBeenCalledTimes(1);
    // 同じ時間内は問い合わせない (履歴の先頭まで取得済みなので古い範囲も取り直さない)
    for (let i = 0; i < 10; i++) {
      clock.t += 60_000;
      expect((await feed.fetchCandles("ETH/USDT", "1h", 5)).length).toBe(5);
    }
    expect(spy).toHaveBeenCalledTimes(1);
    // 1 時間進むと 1 回だけ取りに行き、確定した足が増える
    const before = (await feed.fetchCandles("ETH/USDT", "1h", 1))[0].ts;
    clock.t += 3_600_000;
    const after = await feed.fetchCandles("ETH/USDT", "1h", 1);
    expect(after[0].ts).toBe(before + 3_600_000);
    expect(spy).toHaveBeenCalledTimes(2);
    const ref = (await inner.fetchCandles("ETH/USDT", "1h", 2))[0];
    expect(after[0]).toEqual(ref);
  });
});
