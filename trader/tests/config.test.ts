import { describe, expect, it } from "vitest";
import { LIVE_CONFIRM_PHRASE, loadConfig, resolveMode } from "../src/core/config";
import { D, floorToStep } from "../src/core/decimal";

describe("安全ガード: 実弾モード", () => {
  it("既定は paper", () => {
    expect(loadConfig({}).mode).toBe("paper");
  });
  it("TRADING_MODE=live だけでは paper のまま", () => {
    const r = resolveMode({ NODE_ENV: "production", TRADING_MODE: "live", LIVE_TRADING_CONFIRM: "" });
    expect(r.mode).toBe("paper");
    expect(r.liveBlockedReason).toBeTruthy();
  });
  it("確認フレーズが揃えば live", () => {
    const r = resolveMode({ NODE_ENV: "production", TRADING_MODE: "live", LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE });
    expect(r.mode).toBe("live");
  });
  it("テスト中は確認フレーズがあっても paper", () => {
    const r = resolveMode({ NODE_ENV: "test", TRADING_MODE: "live", LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE });
    expect(r.mode).toBe("paper");
  });
});

describe("decimal ヘルパー", () => {
  it("刻みへの切り捨てで浮動小数点誤差が出ない", () => {
    expect(floorToStep("0.30000000000000004", "0.1").toString()).toBe("0.3");
    expect(D(0.1).plus(0.2).toString()).toBe("0.3");
  });
});
