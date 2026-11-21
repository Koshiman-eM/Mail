import { describe, expect, it, vi } from "vitest";
import { loadConfig, LIVE_CONFIRM_PHRASE } from "../src/core/config";
import { createBrokers } from "../src/execution/router";
import { GmoBroker } from "../src/execution/gmoBroker";
import { PaperBroker } from "../src/execution/paper";
import type { Instrument } from "../src/core/types";

const inst = (symbol: string, venue: string, assetClass: Instrument["assetClass"] = "crypto"): Instrument => ({
  symbol, venue, assetClass, baseCurrency: symbol.split("/")[0], quoteCurrency: "JPY", tickSize: 0.01, lotSize: 1, minQty: 1, takerFeeRate: 0, makerFeeRate: 0, allowShort: true,
});
const gmoBtc = inst("BTC/JPY", "gmo");
const insts = [inst("BTC/JPY", "ccxt:bitbank"), inst("USD/JPY", "synthetic", "fx"), inst("AAPL", "synthetic", "stock")];

const liveEnv = {
  TRADING_MODE: "live", LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE, NODE_ENV: "production",
  VENUES: "gmo", GMO_API_KEY: "k", GMO_API_SECRET: "s",
};

/** live の判定は NODE_ENV=test では起きないので、その間だけ production にする (実口座アダプターは fetch をモックし、送信しない) */
const withProd = (fn: () => void) => {
  const orig = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try { fn(); } finally { process.env.NODE_ENV = orig; }
};

describe("createBrokers", () => {
  it("paper モードは全 venue を PaperBroker で処理 (実アダプターを作らない)", () => {
    const fetchImpl = vi.fn();
    const cfg = loadConfig({ TRADING_MODE: "live", VENUES: "ccxt,gmo,synthetic", GMO_API_KEY: "k", GMO_API_SECRET: "s" }); // 確認フレーズ無し → paper
    expect(cfg.mode).toBe("paper");
    const set = createBrokers(cfg, [...insts, { ...gmoBtc, symbol: "ETH/JPY" }], { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(set.mode).toBe("paper");
    for (const i of insts) {
      const b = set.brokerFor(i.symbol);
      expect(b).toBeInstanceOf(PaperBroker);
      expect(b.mode).toBe("paper");
    }
    expect([...set.brokers.values()].every((b) => b instanceof PaperBroker)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => set.brokerFor("NOPE")).toThrow();
  });

  it("live モード: NODE_ENV=test 下では実アダプター生成が必ず失敗する", () => {
    const cfg = { ...loadConfig(liveEnv), mode: "live" as const }; // resolveMode を迂回して強制
    expect(() => createBrokers(cfg, [gmoBtc], { fetchImpl: vi.fn() as any })).toThrow(/NODE_ENV=test/);
  });

  it("live モード: 発注できるのは GMO だけ。ccxt などほかの取引先の銘柄があれば例外 (fail-closed)", () => {
    withProd(() => {
      const cfg = loadConfig({ ...liveEnv, VENUES: "gmo,ccxt" });
      expect(cfg.mode).toBe("live");
      expect(() => createBrokers(cfg, [gmoBtc, insts[0]], {})).toThrow(/ccxt:bitbank: live 用の発注アダプターがありません/);
      // paper venue (合成データ) も live では扱えない
      expect(() => createBrokers(loadConfig({ ...liveEnv, VENUES: "paper" }), [inst("X/Y", "paper")], {})).toThrow(/アダプターがありません/);
    });
  });

  it("live モード: GMO のキーが無ければエラー。揃えば GmoBroker を作り、VENUES で有効化していなければ brokerFor でエラー", () => {
    withProd(() => {
      expect(() => createBrokers(loadConfig({ ...liveEnv, GMO_API_SECRET: "" }), [gmoBtc], {})).toThrow(/GMO_API_KEY/);
      const set = createBrokers(loadConfig(liveEnv), [gmoBtc], { fetchImpl: vi.fn() as any });
      expect(set.mode).toBe("live");
      expect(set.brokerFor("BTC/JPY")).toBeInstanceOf(GmoBroker);
      expect(set.brokerFor("BTC/JPY").mode).toBe("live");
      const off = createBrokers(loadConfig({ ...liveEnv, VENUES: "synthetic" }), [gmoBtc], {});
      expect(() => off.brokerFor("BTC/JPY")).toThrow(/有効化されていません/);
    });
  });
});
