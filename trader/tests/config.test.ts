import { describe, expect, it } from "vitest";
import { DEFAULT_OBSERVE_ONLY_STRATEGIES, LIVE_CONFIRM_PHRASE, loadConfig, resolveMode } from "../src/core/config";
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

describe("リスク値の範囲検証", () => {
  it("既定値は範囲内で、そのまま読み込める", () => {
    const r = loadConfig({}).risk;
    expect(r.riskPerTrade).toBe(0.005);
    expect(r.maxDailyLoss).toBe(0.03);
    expect(r.maxDrawdown).toBe(0.15);
    expect(r.maxPositionPct).toBe(0.2);
    expect(r.maxExposureByClass).toEqual({ crypto: 0.6, meme: 0.05, fx: 0.6, stock: 0.6 });
    expect(r.maxOpenPositions).toBe(8);
    expect(r.maxOrdersPerMinute).toBe(30);
  });
  it("上限ちょうどは通る", () => {
    const r = loadConfig({ RISK_PER_TRADE: "0.05", MAX_DAILY_LOSS: "0.2", MAX_DRAWDOWN: "0.5", MAX_EXPOSURE_CRYPTO: "1", MAX_POSITION_PCT: "1" }).risk;
    expect(r.riskPerTrade).toBe(0.05);
  });
  it("単位の取り違え (0.5 = 50%) は分かりやすいエラーで止まる", () => {
    expect(() => loadConfig({ RISK_PER_TRADE: "0.5" })).toThrow(/0\.5 は 50% の意味です.*0\.5% なら 0\.005/);
  });
  it("パーセント表記の数字 (3 = 300%) も止まる", () => {
    expect(() => loadConfig({ MAX_DAILY_LOSS: "3" })).toThrow(/MAX_DAILY_LOSS=3 は 300% の意味です.*0\.03/);
  });
  it.each([
    ["RISK_PER_TRADE", "0.06"],
    ["RISK_PER_TRADE", "0"],
    ["RISK_PER_TRADE", "-0.01"],
    ["MAX_DAILY_LOSS", "0.25"],
    ["MAX_DRAWDOWN", "0.6"],
    ["MAX_POSITION_PCT", "1.5"],
    ["MAX_EXPOSURE_CRYPTO", "2"],
    ["MAX_EXPOSURE_MEME", "0"],
    ["MAX_EXPOSURE_FX", "1.01"],
    ["MAX_EXPOSURE_STOCK", "-1"],
    ["MAX_OPEN_POSITIONS", "0"],
    ["MAX_OPEN_POSITIONS", "2.5"],
  ])("%s=%s は範囲外で起動を止める", (k, v) => {
    expect(() => loadConfig({ [k]: v })).toThrow(new RegExp(`設定が不正です[\\s\\S]*${k}`));
  });
  it("数値でない値も止まる", () => {
    expect(() => loadConfig({ MAX_DRAWDOWN: "abc" })).toThrow(/MAX_DRAWDOWN/);
  });
});

describe("OBSERVE_ONLY_STRATEGIES (観測専用の戦略)", () => {
  it("未設定なら既定値 scalp_rebound", () => {
    expect(loadConfig({}).env.OBSERVE_ONLY_STRATEGIES).toEqual(["scalp_rebound"]);
    expect(DEFAULT_OBSERVE_ONLY_STRATEGIES).toBe("scalp_rebound");
  });
  it("空文字 (空白だけも) なら観測専用なし", () => {
    expect(loadConfig({ OBSERVE_ONLY_STRATEGIES: "" }).env.OBSERVE_ONLY_STRATEGIES).toEqual([]);
    expect(loadConfig({ OBSERVE_ONLY_STRATEGIES: "  " }).env.OBSERVE_ONLY_STRATEGIES).toEqual([]);
  });
  it("カンマ区切り。前後の空白・空要素・重複を除く", () => {
    expect(loadConfig({ OBSERVE_ONLY_STRATEGIES: " scalp_rebound , scalp_micro,,scalp_rebound " }).env.OBSERVE_ONLY_STRATEGIES).toEqual(["scalp_rebound", "scalp_micro"]);
  });
});
