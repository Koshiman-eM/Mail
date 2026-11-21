import { describe, expect, it } from "vitest";
import { CORE_ENV_KEYS, defineAppConfig, envHelpers, LIVE_CONFIRM_PHRASE, z } from "../src/core/config";
import { enabledAssetClasses } from "../src/core/assetClasses";

describe("defineAppConfig (コアとアプリの設定の分離)", () => {
  it("アプリの shape はコアの環境変数 (実弾の二重ロックを含む) を再定義できない", () => {
    for (const key of ["TRADING_MODE", "LIVE_TRADING_CONFIRM", "NODE_ENV", "MAX_EXPOSURE_CRYPTO", "MAX_EXPOSURE_FX", "RISK_PER_TRADE"]) {
      expect(CORE_ENV_KEYS).toContain(key);
      expect(() => defineAppConfig({ assetClasses: enabledAssetClasses(), shape: { [key]: envHelpers.str("live") } })).toThrow(/再定義できません/);
    }
  });
  it("defaults で実弾の二重ロックの鍵・未知のキーは上書きできない", () => {
    expect(() => defineAppConfig({ assetClasses: enabledAssetClasses(), shape: {}, defaults: { TRADING_MODE: "live" } })).toThrow(/上書きできない/);
    expect(() => defineAppConfig({ assetClasses: enabledAssetClasses(), shape: {}, defaults: { LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE } })).toThrow(/上書きできない/);
    expect(() => defineAppConfig({ assetClasses: enabledAssetClasses(), shape: {}, defaults: { FOO: "1" } as never })).toThrow(/上書きできない/);
  });
  it("1 プロセスで別の資産クラスの組には変えられない", () => {
    expect(() => defineAppConfig({ assetClasses: ["fx"], shape: {} })).toThrow(/既に/);
  });
  it("アプリのキー・コアの既定値の上書き・クラス別の上限の環境変数", () => {
    const d = defineAppConfig({
      assetClasses: enabledAssetClasses(),
      shape: { APP_TOKEN: envHelpers.str("x"), APP_N: envHelpers.ranged("APP_N", 3, 1, 5) },
      defaults: { DB_PATH: "./data/app.db", DASHBOARD_PORT: "8790" },
    });
    const c = d.loadConfig({ APP_N: "4", MAX_EXPOSURE_MEME: "0.04" });
    expect(c.env.APP_TOKEN).toBe("x");
    expect(c.env.APP_N).toBe(4);
    expect(c.env.DB_PATH).toBe("./data/app.db");
    expect(c.env.DASHBOARD_PORT).toBe(8790);
    expect(d.loadConfig({ DB_PATH: "./x.db" }).env.DB_PATH).toBe("./x.db");
    expect(c.risk.maxExposureByClass).toEqual({ crypto: 0.6, meme: 0.04 });
    expect(c.assetClasses).toEqual(["crypto", "meme"]);
    expect(d.unusedClassEnvKeys).toEqual(["MAX_EXPOSURE_FX", "MAX_EXPOSURE_STOCK"]);
    // 実弾の二重ロックはコアの判定のまま (TRADING_MODE だけでは paper、テスト中は常に paper)
    expect(d.loadConfig({ NODE_ENV: "production", TRADING_MODE: "live" }).mode).toBe("paper");
    expect(d.loadConfig({ NODE_ENV: "test", TRADING_MODE: "live", LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE }).mode).toBe("paper");
    expect(() => d.loadConfig({ APP_N: "9" })).toThrow(/APP_N/);
  });
  it("z はコアと同じ zod の実体", () => {
    expect(typeof z.object).toBe("function");
  });
});
