/** 廃止した GMOコイン・FX・株式の古い設定と、live の発注先が無いときの CLI の挙動 (ネットに出ない) */
import { afterEach, describe, expect, it, vi } from "vitest";
import { configCompatWarnings, main } from "../src/cli";
import { LIVE_CONFIRM_PHRASE, loadConfig } from "../src/appConfig";

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) }, out, err };
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CLI: 廃止した設定の互換", () => {
  it("status の警告: 廃止した取引先・資産クラス・環境変数を知らせる (値は出さない)", () => {
    const env = {
      VENUES: "gmo", WATCHLIST: "gmo|BTC/JPY,synthetic|USD/JPY|fx,ccxt|BTC/JPY", GMO_API_KEY: "secret-key", GMO_LEVERAGE_FEE_DAILY: "bad", MAX_EXPOSURE_STOCK: "0.6",
    };
    const w = configCompatWarnings(loadConfig(env), env).join("\n");
    expect(w).toContain("VENUES の gmo は廃止した取引先のため無視します");
    expect(w).toContain("VENUES に使える取引先が無いため ccxt (CCXT_EXCHANGE) の相場で動かします");
    expect(w).toContain('WATCHLIST の "synthetic|USD/JPY|fx" は廃止した資産クラス (fx) のため無視します');
    expect(w).toContain("WATCHLIST の gmo|BTC/JPY は廃止した取引先の銘柄のため無視します");
    expect(w).toContain(".env の GMO_API_KEY, GMO_LEVERAGE_FEE_DAILY, MAX_EXPOSURE_STOCK は廃止した設定のため読みません");
    expect(w).not.toContain("secret-key");
    expect(w).not.toContain("起動しません");
    // 今の設定だけなら警告なし
    expect(configCompatWarnings(loadConfig({ VENUES: "ccxt" }), { VENUES: "ccxt" })).toEqual([]);
  });

  it("status の警告: live (二重ロックが揃った) ならエンジンが起動しない旨を出す", () => {
    const live = { ...loadConfig({ VENUES: "ccxt" }), mode: "live" as const };
    expect(configCompatWarnings(live, {}).join("\n")).toMatch(/live の発注先は未対応です \(Jupiter の実弾は次の段階で実装予定\).*このままではエンジンが起動しません/);
  });

  it("gmo コマンドと --source gmo は廃止した旨のエラー (終了コード 2)", async () => {
    const a = io();
    expect(await main(["gmo", "check"], a.io)).toBe(2);
    expect(a.err.join("\n")).toContain("gmo コマンド (gmo check) は廃止しました");
    const b = io();
    expect(await main(["backtest", "--strategy", "all", "--source", "gmo"], b.io)).toBe(2);
    expect(b.err.join("\n")).toContain("--source gmo は廃止しました");
  });

  it("run: live なら DB・ロック・相場に触れる前に終了コード 1 で止まる (実弾の警告文は出さない)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRADING_MODE", "live");
    vi.stubEnv("LIVE_TRADING_CONFIRM", LIVE_CONFIRM_PHRASE);
    vi.stubEnv("VENUES", "gmo");
    vi.stubEnv("DB_PATH", "/nonexistent-dir-for-test/trader.db");
    const a = io();
    expect(await main(["run"], a.io)).toBe(1);
    expect(a.out).toContain("モード: 実弾 (live)");
    expect(a.err.join("\n")).toContain("エラー: live の発注先は未対応です (Jupiter の実弾は次の段階で実装予定)。TRADING_MODE=paper にしてください");
    expect(a.err.join("\n")).not.toContain("実際の資金で発注します");
  });
});
