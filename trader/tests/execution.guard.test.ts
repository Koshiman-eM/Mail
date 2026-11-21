import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, LIVE_CONFIRM_PHRASE, resolveMode } from "../src/core/config";
import { assertLive, LiveModeRequiredError } from "../src/execution/guard";

/**
 * 実口座アダプターの安全ガード (assertLive) と二重ロック (resolveMode)。
 * いまは実口座アダプターが無いが、次の段階の Jupiter の実弾のアダプターはコンストラクタでこのガードを呼ぶ
 */
describe("assertLive (実口座アダプターの生成ガード)", () => {
  const orig = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = orig;
  });

  it("mode が live でなければ (paper / backtest / 未指定) 生成を拒否する", () => {
    process.env.NODE_ENV = "production";
    expect(() => assertLive("jupiter", { mode: "paper" })).toThrow(LiveModeRequiredError);
    expect(() => assertLive("jupiter", { mode: "backtest" })).toThrow(/mode=backtest/);
    expect(() => assertLive("jupiter", undefined)).toThrow(/mode=未指定/);
  });

  it("NODE_ENV=test では live でも拒否する (テストは完全オフライン)", () => {
    process.env.NODE_ENV = "test";
    expect(() => assertLive("jupiter", { mode: "live" })).toThrow(/NODE_ENV=test/);
  });

  it("live かつ NODE_ENV≠test のときだけ通す", () => {
    process.env.NODE_ENV = "production";
    expect(() => assertLive("jupiter", { mode: "live" })).not.toThrow();
  });
});

describe("二重ロック (TRADING_MODE=live と LIVE_TRADING_CONFIRM)", () => {
  it("両方が揃ったときだけ live。片方だけ・テスト中は paper", () => {
    expect(resolveMode({ NODE_ENV: "production", TRADING_MODE: "live", LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE }).mode).toBe("live");
    expect(resolveMode({ NODE_ENV: "production", TRADING_MODE: "live", LIVE_TRADING_CONFIRM: "" })).toMatchObject({ mode: "paper", liveBlockedReason: expect.stringContaining("LIVE_TRADING_CONFIRM") });
    expect(resolveMode({ NODE_ENV: "production", TRADING_MODE: "paper", LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE }).mode).toBe("paper");
    expect(resolveMode({ NODE_ENV: "test", TRADING_MODE: "live", LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE }).mode).toBe("paper");
    expect(loadConfig({ TRADING_MODE: "live" }).mode).toBe("paper");
  });
});
