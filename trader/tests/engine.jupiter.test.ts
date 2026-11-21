import { describe, expect, it } from "vitest";
import { unconfiguredVenuePositionWarnings, configCompatWarnings } from "../src/cli";
import { loadConfig } from "../src/core/config";
import type { AssetClass, Signal, Strategy, StrategyContext } from "../src/core/types";
import { PAPER_SNAPSHOT_KEY } from "../src/engine/engine";
import { buildRuntime } from "../src/engine/setup";
import { armKeyOf } from "../src/learning/allocator";
import { TradeJournal } from "../src/learning/journal";
import { mulberry32 } from "../src/market/feeds/synthetic";
import { JupiterClient } from "../src/market/jupiter/client";
import { GeckoTerminalClient } from "../src/market/jupiter/gecko";
import { MemoryStore } from "../src/storage/memory";
import { ALL_STRATEGIES } from "../src/strategies/registry";
import { BONK, createJupiterMock, MEMEA, SOL, type MockToken } from "./helpers/jupiterMock";

const MIN = 60_000;
const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 20, 0, 0, 0);

/** 常に同じ向きで入るテスト用の戦略 (保有中は何もしない。期限で決済) */
function fixed(id: string, classes: AssetClass[], direction: "long" | "short"): Strategy {
  return {
    id, horizon: "scalp", assetClasses: classes, regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    primaryTimeframe: "1m", timeframes: ["1m"], warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.position) return null;
      const px = direction === "long" ? ctx.market.quote.ask : ctx.market.quote.bid;
      return {
        strategyId: id, horizon: "scalp", symbol: ctx.market.instrument.symbol, direction, confidence: 0.8, expectedEdgeBps: 5_000,
        entry: { type: "market" }, stopLoss: direction === "long" ? px * 0.97 : px * 1.03, maxHoldMs: 20 * MIN, reason: `test ${id}`, features: {},
      };
    },
  };
}

const sol: MockToken = { mint: SOL, symbol: "SOL", decimals: 9, price: 150, liquidity: 5e7, amp: 0.004, drift: 0.002 };
const memeA: MockToken = { mint: MEMEA, symbol: "SDOG", decimals: 5, price: 0.001, liquidity: 900_000, amp: 0.03 };

async function jupiterRuntime(o: { bonkLiquidity: number; env?: Record<string, string>; store?: MemoryStore; strategies?: Strategy[] }) {
  const clock = { t: T0, now() { return this.t; } };
  const now = () => clock.t;
  const bonk: MockToken = { mint: BONK, symbol: "BONK", decimals: 5, price: 0.00002, liquidity: o.bonkLiquidity, amp: 0.02 };
  const mock = createJupiterMock({ now, tokens: [sol, bonk], trending: () => (clock.t >= T0 + 30 * MIN ? [memeA] : []), usdJpy: 155.5 });
  const client = new JupiterClient({ fetchImpl: mock.fetchImpl, now, ratePerSec: 1000, burst: 1000, retries: 0 });
  const gecko = new GeckoTerminalClient({ fetchImpl: mock.fetchImpl, now, callsPerMinute: 60_000, burst: 1000, retries: 0 });
  // VENUES は既定 (jupiter)。LIMIT_ENTRY は既定 (true) のままでも Jupiter は成行
  const config = loadConfig({ NODE_ENV: "test", DB_PATH: "memory", BASE_CURRENCY: "JPY", JUPITER_TOKENS: "SOL,BONK", ...(o.env ?? {}) });
  const rt = await buildRuntime(config, {
    clock, store: o.store ?? new MemoryStore(), intelSources: [], ai: null, rng: mulberry32(3),
    jupiter: { client, gecko, fetchImpl: mock.fetchImpl },
    ...(o.strategies ? { strategies: o.strategies } : {}),
  });
  return { rt, clock, mock, store: rt.store as MemoryStore };
}

function skipCounts(store: MemoryStore): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of store.listAudit({ type: "engine.skip_summary" })) {
    for (const [k, v] of Object.entries((a.data as { reasons: Record<string, { count: number }> }).reasons)) out[k] = (out[k] ?? 0) + v.count;
  }
  return out;
}

describe("エンジン統合: Jupiter (モックの API・仮想時計)", () => {
  it("既定の VENUES は jupiter。数時間の paper: 成行のスワップで約定・空売りなし・ミームの流動性はトークン情報・実行中の自動探索・USD/JPY は日次のレート", async () => {
    const strategies = [...ALL_STRATEGIES, fixed("t_long", ["crypto", "meme"], "long"), fixed("t_short", ["crypto"], "short")];
    const { rt, clock, store } = await jupiterRuntime({ bonkLiquidity: 100_000, strategies });
    expect(loadConfig({}).env.VENUES).toBe("jupiter");
    expect(rt.venues).toEqual(["jupiter"]);
    expect(rt.instruments.map((i) => [i.symbol, i.assetClass, i.venue])).toEqual([["SOL/USDC", "crypto", "jupiter"], ["BONK/USDC", "meme", "jupiter"]]);
    expect(rt.instruments.every((i) => i.simulatedShort !== true)).toBe(true);
    expect(rt.brokerSet.paper!.capabilities.marketOnlyVenues).toEqual(["jupiter"]);

    const end = T0 + 4 * H;
    for (; clock.t <= end; clock.t += 15_000) await rt.engine.advance(clock.t);
    await rt.jupiter!.feed.idle();

    // USD/JPY は frankfurter のレート (概算表 150 ではない)
    expect(rt.fx.toAccount("USDC")).toBe(155.5);
    const trades = store.listTrades({ mode: "paper" });
    expect(trades.length).toBeGreaterThan(0);
    expect(trades.every((t) => t.venue === "jupiter")).toBe(true);
    // 成行だけ (LIMIT_ENTRY=true でも指値にしない)。空売りなし (取引所で不可・paper でも再現しない)
    expect(trades.every((t) => t.entryOrderType === "market")).toBe(true);
    expect(trades.every((t) => t.direction === "long" && t.simulatedShort !== true)).toBe(true);
    // 手数料 (クオート通貨建て) = ネットワーク手数料 0.02 USD × 2 回 (経路の手数料は見積もりの価格に含まれる)
    for (const t of trades) expect(t.fees).toBeCloseTo(0.04, 9);
    const skips = skipCounts(store);
    expect(Object.keys(skips).some((k) => k.includes("空売り不可"))).toBe(true);
    // BONK はトークン情報の流動性 $100,000 < MEME_MIN_LIQUIDITY_USD ($250,000) なので入らない
    expect(trades.some((t) => t.symbol === "BONK/USDC")).toBe(false);
    expect(Object.keys(skips).some((k) => k.includes("流動性"))).toBe(true);
    // 実行中の自動探索で SDOG が加わり (流動性 $900,000)、ミームとして取引される
    expect(rt.hub.watched().map((i) => i.symbol)).toContain("SDOG/USDC");
    expect(store.listAudit({ type: "jupiter.watch_add" }).map((a) => a.data.symbol)).toEqual(["SDOG/USDC"]);
    expect(trades.some((t) => t.symbol === "SDOG/USDC" && t.assetClass === "meme")).toBe(true);
    // 腕のキーは資産クラスを含む (ミームの学習は crypto と分かれる)
    const arms = trades.map((t) => armKeyOf(t));
    expect(arms.some((k) => k.startsWith("t_long|") && k.includes("|meme"))).toBe(true);
    expect(arms.some((k) => k.startsWith("t_long|") && k.includes("|crypto"))).toBe(true);
    // GeckoTerminal の履歴で上位足も揃う
    const v = rt.hub.getView("SOL/USDC", clock.t)!;
    expect(v.candles["1h"]!.length).toBeGreaterThanOrEqual(250);
    expect(v.candles["4h"]!.length).toBeGreaterThanOrEqual(250);
    expect(store.listEquity({ mode: "paper" }).length).toBeGreaterThan(100);
    await rt.engine.stop();
    rt.close();
  }, 120_000);

  it("ミームの流動性が足りていれば BONK も取引する (流動性はトークン情報から、出来高の推定は使わない)", async () => {
    const { rt, clock, store } = await jupiterRuntime({ bonkLiquidity: 2_000_000, strategies: [fixed("t_long", ["meme"], "long")], env: { JUPITER_DISCOVERY: "false" } });
    for (const end = T0 + 40 * MIN; clock.t <= end; clock.t += 15_000) await rt.engine.advance(clock.t);
    const trades = store.listTrades({ mode: "paper" });
    expect(trades.some((t) => t.symbol === "BONK/USDC")).toBe(true);
    expect(store.listAudit({ type: "jupiter.discovery" })).toHaveLength(0);
    rt.close();
  }, 60_000);
});

describe("古い .env・取引先の切り替えの互換", () => {
  it("いまの VENUES に無い取引先の建玉 (bitbank の BTC/JPY): 起動は止めず、警告・監査ログ。status は paper reset を勧める", async () => {
    const store = new MemoryStore();
    new TradeJournal({ store, mode: "paper" }).open({
      mode: "paper", symbol: "BTC/JPY", venue: "ccxt:bitbank", assetClass: "crypto", strategyId: "scalp_pullback", horizon: "scalp", direction: "long",
      qty: 0.01, entryTs: T0 - H, entryPrice: 10_000_000, intendedEntryPrice: 10_000_000, initialStop: 9_900_000,
      entryContext: { regime: { label: "range", trend: 0, trendStrength: 0, volatility: 0, volatilityPercentile: 0.5, spreadBps: 0 }, confidence: 0.5, expectedEdgeBps: 10, costBps: 1, params: {}, features: {}, riskMultiplier: 1, reason: "" },
    });
    // paper のスナップショットにも bitbank の建玉 (ccxt の銘柄定義つき) がある (VENUES=ccxt で動かしていた口座)
    store.kvSet(PAPER_SNAPSHOT_KEY, {
      version: 1, cash: "900000", realizedPnl: "0", seq: 1, resting: [], results: {}, quotes: {},
      positions: [{ symbol: "BTC/JPY", qty: "0.01", avg: "10000000", openedAt: T0 - H }],
      instruments: [{ symbol: "BTC/JPY", venue: "ccxt:bitbank", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "JPY", tickSize: 1, lotSize: 0.0001, minQty: 0.0001, takerFeeRate: 0.0012, makerFeeRate: -0.0002, allowShort: false }],
    });
    const { rt, clock } = await jupiterRuntime({ bonkLiquidity: 2e6, store, env: { JUPITER_DISCOVERY: "false" } });
    await rt.engine.advance(clock.t);
    expect(store.listAudit({ type: "engine.unwatched_positions" })[0].data).toEqual({ positions: ["BTC/JPY (ccxt:bitbank)"] });
    expect(rt.engine.journal.list().map((p) => p.symbol)).toEqual(["BTC/JPY"]);
    const w = unconfiguredVenuePositionWarnings(rt.config, rt.engine.journal.list());
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("BTC/JPY (ccxt:bitbank)");
    expect(w[0]).toContain("paper reset --equity 100000 --confirm");
    // VENUES=ccxt のままなら警告しない (同じ取引先の銘柄)
    expect(unconfiguredVenuePositionWarnings(loadConfig({ VENUES: "ccxt" }), [{ symbol: "BTC/JPY", venue: "ccxt:bitbank" }])).toEqual([]);
    // 合成データの銘柄 (venue paper) は synthetic
    expect(unconfiguredVenuePositionWarnings(loadConfig({ VENUES: "synthetic" }), [{ symbol: "BTC/USDT", venue: "paper" }])).toEqual([]);
    rt.close();
  });

  it("VENUES=jupiter の status は警告なし。廃止した取引先だけの古い .env は従来どおり ccxt に落とす", () => {
    expect(configCompatWarnings(loadConfig({ VENUES: "jupiter" }), { VENUES: "jupiter" })).toEqual([]);
    expect(configCompatWarnings(loadConfig({}), {})).toEqual([]);
    const w = configCompatWarnings(loadConfig({ VENUES: "gmo" }), { VENUES: "gmo" });
    expect(w.join("\n")).toContain("ccxt (CCXT_EXCHANGE) の相場で動かします");
  });
});
