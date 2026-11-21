import { describe, expect, it, vi } from "vitest";
import { loadConfig, LIVE_CONFIRM_PHRASE } from "../src/core/config";
import { createBrokers, LIVE_UNSUPPORTED_MESSAGE } from "../src/execution/router";
import { PaperBroker } from "../src/execution/paper";
import type { Instrument } from "../src/core/types";

const inst = (symbol: string, venue: string, assetClass: Instrument["assetClass"] = "crypto"): Instrument => ({
  symbol, venue, assetClass, baseCurrency: symbol.split("/")[0], quoteCurrency: "JPY", tickSize: 0.01, lotSize: 1, minQty: 1, takerFeeRate: 0, makerFeeRate: 0, allowShort: false,
});
const insts = [inst("BTC/JPY", "ccxt:bitbank"), inst("ETH/USDT", "synthetic"), inst("PEPE/USDT", "synthetic", "meme")];

const liveEnv = { TRADING_MODE: "live", LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE, NODE_ENV: "production", VENUES: "ccxt" };

/** live の判定は NODE_ENV=test では起きないので、その間だけ production にする (実口座アダプターは無いので何も送らない) */
const withProd = (fn: () => void) => {
  const orig = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try { fn(); } finally { process.env.NODE_ENV = orig; }
};

describe("createBrokers", () => {
  it("paper モードは全 venue を PaperBroker で処理 (実アダプターを作らない)", () => {
    const cfg = loadConfig({ TRADING_MODE: "live", VENUES: "ccxt,synthetic" }); // 確認フレーズ無し → paper
    expect(cfg.mode).toBe("paper");
    const set = createBrokers(cfg, insts);
    expect(set.mode).toBe("paper");
    for (const i of insts) {
      const b = set.brokerFor(i.symbol);
      expect(b).toBeInstanceOf(PaperBroker);
      expect(b.mode).toBe("paper");
    }
    expect([...set.brokers.values()].every((b) => b instanceof PaperBroker)).toBe(true);
    expect(() => set.brokerFor("NOPE")).toThrow();
  });

  it("live モード: 実口座アダプターは無いので、二重ロックが揃っていても必ず例外 (fail-closed)", () => {
    const fetchImpl = vi.fn();
    withProd(() => {
      const cfg = loadConfig(liveEnv);
      expect(cfg.mode).toBe("live");
      expect(() => createBrokers(cfg, insts)).toThrow(LIVE_UNSUPPORTED_MESSAGE);
      // 銘柄が無くても live は作らない
      expect(() => createBrokers(cfg, [])).toThrow(/live の発注先は未対応です \(Jupiter の実弾は次の段階で実装予定\)/);
    });
    // NODE_ENV=test の下で mode を live に強制しても同じ
    expect(() => createBrokers({ ...loadConfig(liveEnv), mode: "live" as const }, insts)).toThrow(LIVE_UNSUPPORTED_MESSAGE);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
