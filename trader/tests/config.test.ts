import { describe, expect, it } from "vitest";
import { DEFAULT_OBSERVE_ONLY_STRATEGIES, DEFAULT_STRUCTURE_STRATEGIES, LIVE_CONFIRM_PHRASE, loadConfig, removedEnvWarnings, resolveMode } from "../src/appConfig";
import { ALL_STRATEGIES } from "../src/strategies/registry";
import { strategyIdListWarnings } from "../src/strategies/retired";
import { observeOnlyWarnings } from "@trading/core/strategies/observeOnly";
import { D, floorToStep } from "../src/core/decimal";
import { effectiveLimitTakeProfit, limitOrdersFromEnv } from "../src/engine/limitOrders";

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
    expect(r.maxExposureByClass).toEqual({ crypto: 0.6, meme: 0.05 });
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
    ["MAX_OPEN_POSITIONS", "0"],
    ["MAX_OPEN_POSITIONS", "2.5"],
  ])("%s=%s は範囲外で起動を止める", (k, v) => {
    expect(() => loadConfig({ [k]: v })).toThrow(new RegExp(`設定が不正です[\\s\\S]*${k}`));
  });
  it("数値でない値も止まる", () => {
    expect(() => loadConfig({ MAX_DRAWDOWN: "abc" })).toThrow(/MAX_DRAWDOWN/);
  });
  it("廃止した設定 (GMO_*・MAX_EXPOSURE_FX/STOCK) は値が不正でも起動を止めず、読まない (警告だけ)", () => {
    const old = {
      GMO_API_KEY: "k", GMO_API_SECRET: "s", GMO_SYMBOLS: "BTC_JPY", GMO_LEVERAGE_FEE_DAILY: "abc", GMO_MAX_EFFECTIVE_LEVERAGE: "9",
      GMO_ALLOW_SPOT_CANDLES: "maybe", MAX_EXPOSURE_FX: "1.01", MAX_EXPOSURE_STOCK: "-1",
    };
    const c = loadConfig(old);
    expect(c.risk.maxExposureByClass).toEqual({ crypto: 0.6, meme: 0.05 });
    expect(Object.keys(c.env).filter((k) => k.startsWith("GMO_") || k.startsWith("MAX_EXPOSURE_FX") || k.startsWith("MAX_EXPOSURE_STOCK"))).toEqual([]);
    const w = removedEnvWarnings({ ...old, GMO_EMPTY: " ", MAX_EXPOSURE_CRYPTO: "0.5" });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("GMO_ALLOW_SPOT_CANDLES, GMO_API_KEY, GMO_API_SECRET, GMO_LEVERAGE_FEE_DAILY, GMO_MAX_EFFECTIVE_LEVERAGE, GMO_SYMBOLS, MAX_EXPOSURE_FX, MAX_EXPOSURE_STOCK");
    expect(w[0]).not.toContain("GMO_EMPTY");
    expect(w[0]).not.toContain("MAX_EXPOSURE_CRYPTO");
    expect(w[0]).not.toMatch(/=k|=s\b/); // 値は出さない
    expect(removedEnvWarnings({ MAX_EXPOSURE_CRYPTO: "0.5" })).toEqual([]);
  });
});

describe("OBSERVE_ONLY_STRATEGIES (観測専用の戦略)", () => {
  it("未設定なら既定値 scalp_rebound・short_ema_trend の meme・mid_trend_follow (実データの検証で負けた)", () => {
    expect(loadConfig({}).env.OBSERVE_ONLY_STRATEGIES).toEqual(["scalp_rebound", "short_ema_trend:meme", "mid_trend_follow"]);
    expect(DEFAULT_OBSERVE_ONLY_STRATEGIES).toBe("scalp_rebound,short_ema_trend:meme,mid_trend_follow");
  });
  it("空文字 (空白だけも) なら観測専用なし", () => {
    expect(loadConfig({ OBSERVE_ONLY_STRATEGIES: "" }).env.OBSERVE_ONLY_STRATEGIES).toEqual([]);
    expect(loadConfig({ OBSERVE_ONLY_STRATEGIES: "  " }).env.OBSERVE_ONLY_STRATEGIES).toEqual([]);
  });
  it("古い .env の廃止した戦略 id (long_momentum など) は起動を止めずに読み込み、警告する (未登録の id とは文言を分ける)", () => {
    const ids = ALL_STRATEGIES.map((s) => s.id);
    const env = loadConfig({ OBSERVE_ONLY_STRATEGIES: "scalp_rebound,long_momentum,meme_momentum" }).env;
    expect(env.OBSERVE_ONLY_STRATEGIES).toEqual(["scalp_rebound", "long_momentum", "meme_momentum"]);
    expect(strategyIdListWarnings("OBSERVE_ONLY_STRATEGIES", env.OBSERVE_ONLY_STRATEGIES, ids)).toEqual([
      "OBSERVE_ONLY_STRATEGIES に廃止した戦略 id があります (無視されます): long_momentum, meme_momentum",
    ]);
    // mid_trend_follow は同じ id で戻した (登録している戦略): 古い .env に残っていても警告しない
    const old = loadConfig({ OBSERVE_ONLY_STRATEGIES: "scalp_rebound,mid_trend_follow,long_momentum" }).env;
    expect(old.OBSERVE_ONLY_STRATEGIES).toEqual(["scalp_rebound", "mid_trend_follow", "long_momentum"]);
    expect(strategyIdListWarnings("OBSERVE_ONLY_STRATEGIES", old.OBSERVE_ONLY_STRATEGIES, ids)).toEqual([
      "OBSERVE_ONLY_STRATEGIES に廃止した戦略 id があります (無視されます): long_momentum",
    ]);
    expect(strategyIdListWarnings("OBSERVE_ONLY_STRATEGIES", ["scalp_rebound", "scalp_rebond", "meme_momentum"], ids)).toEqual([
      "OBSERVE_ONLY_STRATEGIES に廃止した戦略 id があります (無視されます): meme_momentum",
      "OBSERVE_ONLY_STRATEGIES に未登録の戦略 id があります (無視されます): scalp_rebond",
    ]);
    expect(observeOnlyWarnings("OBSERVE_ONLY_STRATEGIES", loadConfig({}).env.OBSERVE_ONLY_STRATEGIES, ids)).toEqual([]);
  });
  it("既定の観測専用・構造フィルターの対象はすべて登録している戦略", () => {
    const ids = new Set(ALL_STRATEGIES.map((s) => s.id));
    // 観測専用は `<id>:<資産クラス>` も書ける (id の部分を確かめる)
    for (const id of [...DEFAULT_OBSERVE_ONLY_STRATEGIES.split(",").map((x) => x.split(":")[0]), ...DEFAULT_STRUCTURE_STRATEGIES.split(",")]) expect(ids.has(id)).toBe(true);
  });
  it("カンマ区切り。前後の空白・空要素・重複を除く", () => {
    expect(loadConfig({ OBSERVE_ONLY_STRATEGIES: " scalp_rebound , scalp_micro,,scalp_rebound " }).env.OBSERVE_ONLY_STRATEGIES).toEqual(["scalp_rebound", "scalp_micro"]);
  });
});

describe("テンポ・最大保有 (TARGET_ENTRIES_PER_HOUR ほか)", () => {
  it("既定値: テンポ・最大保有は無効、下限 1・上限の倍率 2・探索のサイズ 0.5・live の探索は不可", () => {
    const c = loadConfig({});
    expect(c.env.TARGET_ENTRIES_PER_HOUR).toBe(0);
    expect(c.env.MAX_HOLD_MINUTES).toBe(0);
    expect(c.env.TEMPO_MIN_EDGE_TO_COST).toBe(1);
    expect(c.env.TEMPO_CAP_MULTIPLIER).toBe(2);
    expect(c.env.TEMPO_EXPLORE_SIZE).toBe(0.5);
    expect(c.env.TEMPO_ALLOW_LIVE_EXPLORE).toBe(false);
    // RiskManager の上限に渡る
    expect(c.risk.tempoMinEdgeToCost).toBe(1);
  });

  it("範囲内の値は読み込める (空文字は既定値)", () => {
    const c = loadConfig({
      TARGET_ENTRIES_PER_HOUR: "6", MAX_HOLD_MINUTES: "30", TEMPO_MIN_EDGE_TO_COST: "1.5", TEMPO_CAP_MULTIPLIER: "3",
      TEMPO_EXPLORE_SIZE: "0.25", TEMPO_ALLOW_LIVE_EXPLORE: "true",
    });
    expect(c.env).toMatchObject({
      TARGET_ENTRIES_PER_HOUR: 6, MAX_HOLD_MINUTES: 30, TEMPO_MIN_EDGE_TO_COST: 1.5, TEMPO_CAP_MULTIPLIER: 3, TEMPO_EXPLORE_SIZE: 0.25, TEMPO_ALLOW_LIVE_EXPLORE: true,
    });
    expect(c.risk.tempoMinEdgeToCost).toBe(1.5);
    for (const [k, v] of [["TARGET_ENTRIES_PER_HOUR", 60], ["MAX_HOLD_MINUTES", 5], ["MAX_HOLD_MINUTES", 1440], ["TEMPO_MIN_EDGE_TO_COST", 10], ["TEMPO_CAP_MULTIPLIER", 1], ["TEMPO_EXPLORE_SIZE", 0.1], ["TEMPO_EXPLORE_SIZE", 1]] as const) {
      expect(loadConfig({ [k]: String(v) }).env[k], `${k}=${v}`).toBe(v);
    }
    expect(loadConfig({ TARGET_ENTRIES_PER_HOUR: " ", MAX_HOLD_MINUTES: "" }).env).toMatchObject({ TARGET_ENTRIES_PER_HOUR: 0, MAX_HOLD_MINUTES: 0 });
  });

  it("範囲外・数値でない値は、キーと値を含む日本語のエラーで止まる", () => {
    const cases: [string, string, RegExp][] = [
      ["TARGET_ENTRIES_PER_HOUR", "61", /TARGET_ENTRIES_PER_HOUR=61 は不正です。0 \(無効\) 以上 60 以下/],
      ["TARGET_ENTRIES_PER_HOUR", "-1", /TARGET_ENTRIES_PER_HOUR=-1 は不正です/],
      ["TARGET_ENTRIES_PER_HOUR", "abc", /TARGET_ENTRIES_PER_HOUR=abc は不正です/],
      ["MAX_HOLD_MINUTES", "3", /MAX_HOLD_MINUTES=3 は不正です。0 \(無効\) か、5 以上 1440 以下の分/],
      ["MAX_HOLD_MINUTES", "1441", /MAX_HOLD_MINUTES=1441 は不正です/],
      ["MAX_HOLD_MINUTES", "-5", /MAX_HOLD_MINUTES=-5 は不正です/],
      ["TEMPO_MIN_EDGE_TO_COST", "0.5", /TEMPO_MIN_EDGE_TO_COST=0\.5 は不正です。1 以上 10 以下/],
      ["TEMPO_MIN_EDGE_TO_COST", "11", /TEMPO_MIN_EDGE_TO_COST=11 は不正です/],
      ["TEMPO_CAP_MULTIPLIER", "0.5", /TEMPO_CAP_MULTIPLIER=0\.5 は不正です。1 以上 5 以下/],
      ["TEMPO_CAP_MULTIPLIER", "6", /TEMPO_CAP_MULTIPLIER=6 は不正です/],
      ["TEMPO_EXPLORE_SIZE", "0.05", /TEMPO_EXPLORE_SIZE=0\.05 は不正です。0\.1 以上 1 以下/],
      ["TEMPO_EXPLORE_SIZE", "50", /TEMPO_EXPLORE_SIZE=50 は不正です/],
      ["TEMPO_ALLOW_LIVE_EXPLORE", "maybe", /TEMPO_ALLOW_LIVE_EXPLORE=maybe は true \/ false で指定してください/],
    ];
    for (const [k, v, re] of cases) {
      expect(() => loadConfig({ [k]: v }), `${k}=${v}`).toThrow(re);
      expect(() => loadConfig({ [k]: v }), `${k}=${v}`).toThrow(/設定が不正です/);
    }
  });
});

describe("指値 (maker) の設定", () => {
  it("既定は LIMIT_ENTRY=true・LIMIT_TAKE_PROFIT=false", () => {
    const c = loadConfig({});
    expect(c.env.LIMIT_ENTRY).toBe(true);
    expect(c.env.LIMIT_TAKE_PROFIT).toBe(false);
    expect(limitOrdersFromEnv(c.env, "paper")).toEqual({ entry: true, takeProfit: false });
  });
  it("利確の指値は paper 専用: live では LIMIT_TAKE_PROFIT=true でも無効 (バックテスト・検証の前提も同じ)", () => {
    const env = loadConfig({ LIMIT_TAKE_PROFIT: "true", LIMIT_ENTRY_TIMEOUT_MS: "30000" }).env;
    expect(effectiveLimitTakeProfit(env, "paper")).toBe(true);
    expect(effectiveLimitTakeProfit(env, "live")).toBe(false);
    expect(limitOrdersFromEnv(env, "paper")).toEqual({ entry: true, takeProfit: true, entryTimeoutMs: 30_000 });
    expect(limitOrdersFromEnv(env, "live")).toEqual({ entry: true, takeProfit: false, entryTimeoutMs: 30_000 });
    // 手組みの設定で未設定なら既定値と同じ
    expect(limitOrdersFromEnv({}, "paper")).toEqual({ entry: true, takeProfit: false });
  });
});

describe("status: 観測専用の設定の表示", () => {
  it("解釈した設定の行と、戦略ごとの範囲 (全クラス / meme のみ) を出す", async () => {
    const { strategyStatusLines } = await import("../src/cli");
    const lines = strategyStatusLines(loadConfig({ NODE_ENV: "test", DB_PATH: "memory" }));
    expect(lines).toContain("観測専用 (OBSERVE_ONLY_STRATEGIES): scalp_rebound (全クラス), mid_trend_follow (全クラス), short_ema_trend (meme のみ)");
    expect(lines.find((l) => l.includes("[short_ema_trend]"))).toContain("観測専用 (meme のみ)");
    expect(lines.find((l) => l.includes("[scalp_rebound]"))).toMatch(/観測専用(?! \()/);
    const none = strategyStatusLines(loadConfig({ NODE_ENV: "test", DB_PATH: "memory", OBSERVE_ONLY_STRATEGIES: "" }));
    expect(none).toContain("観測専用 (OBSERVE_ONLY_STRATEGIES): なし");
    expect(none.some((l) => l.includes(" / 観測専用"))).toBe(false);
  });
});
