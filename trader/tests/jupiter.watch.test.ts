import { describe, expect, it } from "vitest";
import type { Instrument } from "../src/core/types";
import { jupiterSettingsFromEnv, jupiterWatchKey, JupiterWatchManager, resolveFixedTokens, type PersistedWatch } from "../src/engine/jupiterWatch";
import { loadConfig } from "../src/appConfig";
import { JupiterFeed } from "../src/market/feeds/jupiter";
import { JupiterClient } from "../src/market/jupiter/client";
import { DEFAULT_DISCOVERY_SETTINGS } from "../src/market/jupiter/discovery";
import { MemoryStore } from "../src/storage/memory";
import { fakeClock } from "./fixtures/jupiter/mockFetch";
import { BONK, createJupiterMock, JUP, MEMEA, MEMEB, SOL, type MockToken } from "./helpers/jupiterMock";

const T0 = Date.UTC(2026, 10, 20, 0, 0, 0);
const H = 3_600_000;
const memeA: MockToken = { mint: MEMEA, symbol: "SDOG", decimals: 5, price: 0.001, liquidity: 900_000 };
const memeB: MockToken = { mint: MEMEB, symbol: "SCAT", decimals: 6, price: 1.5, liquidity: 50_000 };

function setup(o: { trending: () => MockToken[]; held?: string[] }) {
  const clock = fakeClock(T0);
  const mock = createJupiterMock({ now: clock.now, trending: o.trending, tokens: [
    { mint: SOL, symbol: "SOL", decimals: 9, price: 150, liquidity: 5e7 },
    { mint: JUP, symbol: "JUP", decimals: 6, price: 1, liquidity: 1e7 },
    { mint: BONK, symbol: "BONK", decimals: 5, price: 0.00002, liquidity: 2e6 },
  ] });
  const client = new JupiterClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, ratePerSec: 100, burst: 100, retries: 0 });
  const feed = new JupiterFeed({ client, now: clock.now });
  const store = new MemoryStore();
  const watched: Instrument[] = [];
  const held = new Set(o.held ?? []);
  const settings = jupiterSettingsFromEnv(loadConfig({}).env);
  const mk = async () => {
    const fixed = await resolveFixedTokens(client, ["SOL", "JUP", "BONK"], () => undefined);
    return new JupiterWatchManager({
      client, feed, store, mode: "paper", settings, fixed, now: clock.now,
      onAdd: (i) => void watched.push(i),
      onRemove: (s) => {
        if (held.has(s)) return false;
        const k = watched.findIndex((w) => w.symbol === s);
        if (k >= 0) watched.splice(k, 1);
        return true;
      },
      keepSymbols: () => [...held],
    });
  };
  return { clock, mock, feed, store, watched, held, mk };
}

describe("Jupiter の固定の銘柄と自動探索", () => {
  it("JUPITER_TOKENS: symbol は既定の一覧で mint に、decimals・流動性は tokens/v2/search。SOL・JUP は crypto、ほかは meme", async () => {
    const { mk, feed } = setup({ trending: () => [] });
    const w = await mk();
    const insts = w.restore();
    expect(insts.map((i) => [i.symbol, i.assetClass, i.lotSize])).toEqual([["SOL/USDC", "crypto", 1e-9], ["JUP/USDC", "crypto", 1e-6], ["BONK/USDC", "meme", 1e-5]]);
    expect(feed.liquidityUsd("BONK/USDC")).toBe(2e6);
  });

  it("設定: 未設定の選別の条件はモジュールの既定値、既定で探索は有効・20 分ごと・期限 6 時間", () => {
    const s = jupiterSettingsFromEnv(loadConfig({}).env);
    expect(s.screen).toEqual({ ...DEFAULT_DISCOVERY_SETTINGS });
    expect(s).toMatchObject({ discovery: true, discoveryEveryMs: 20 * 60_000, ttlMs: 6 * H, maxAuto: 10, networkFeeUsd: 0.02, quoteSizeUsd: 50, minNotionalUsd: 5, pollMs: 2500, geckoCallsPerMin: 10 });
    const t = jupiterSettingsFromEnv(loadConfig({ JUPITER_DISCOVERY_MIN_LIQUIDITY_USD: "1000", JUPITER_DISCOVERY_MIN_AGE_DAYS: "1", JUPITER_RPS: "2" }).env);
    expect(t.screen.minLiquidityUsd).toBe(1000);
    expect(t.screen.minAgeMs).toBe(86_400_000);
    expect(t.ratePerSec).toBe(2);
    expect(() => loadConfig({ JUPITER_POLL_MS: "10" })).toThrow(/JUPITER_POLL_MS/);
  });

  it("探索: 合格を加え、kv jupiter:watch:<mode> に保存、監査ログに追加と不合格の理由。期限で外す (理由つき)", async () => {
    let trending = [memeA, memeB];
    const { mk, store, watched, clock } = setup({ trending: () => trending });
    const w = await mk();
    w.restore();
    const r = await w.run();
    expect(r?.added).toEqual(["SDOG/USDC"]);
    expect(watched.map((i) => i.symbol)).toEqual(["SDOG/USDC"]);
    expect(watched[0]).toMatchObject({ assetClass: "meme", venue: "jupiter", lotSize: 1e-5 });
    const saved = store.kvGet<PersistedWatch>(jupiterWatchKey("paper"))!;
    expect(saved.entries.filter((e) => e.source === "discovered").map((e) => [e.symbol, e.decimals, e.expiresAt])).toEqual([["SDOG", 5, T0 + 6 * H]]);
    expect(store.listAudit({ type: "jupiter.watch_add" })[0].data).toMatchObject({ mint: MEMEA, symbol: "SDOG/USDC", liquidityUsd: 900_000 });
    const disc = store.listAudit({ type: "jupiter.discovery" })[0].data as { rejected: { symbol: string; reasons: string[] }[]; rejectedByCode: Record<string, number> };
    expect(disc.rejected[0].symbol).toBe("SCAT");
    expect(disc.rejected[0].reasons.some((x) => x.startsWith("流動性不足"))).toBe(true);
    expect(disc.rejectedByCode.liquidity).toBe(1);
    // 上位の一覧から消えて期限切れ → 外す
    trending = [];
    clock.advance(6 * H + 1);
    const r2 = await w.run();
    expect(r2?.removed).toEqual(["SDOG/USDC"]);
    expect(watched).toEqual([]);
    expect(store.listAudit({ type: "jupiter.watch_remove" })[0].data).toMatchObject({ mint: MEMEA, reason: "expired", rejections: ["上位の一覧 (toptrending / toporganicscore 1h) に無い"] });
  });

  it("保有中の銘柄は期限切れでも外さない。後で選別に落ちたら新規エントリーを止め、再合格で戻す", async () => {
    let a = { ...memeA };
    const { mk, feed, held, clock, store } = setup({ trending: () => [a] });
    const w = await mk();
    w.restore();
    await w.run();
    held.add("SDOG/USDC");
    // 監査の変化: ミント権限が有効に → 選別に落ちる
    a = { ...memeA, mintAuthorityDisabled: false };
    clock.advance(60_000);
    const r = await w.run();
    expect(r?.screenFailed).toEqual(["SDOG/USDC"]);
    expect(feed.entryBlock("SDOG/USDC")).toMatch(/ミント権限あり/);
    expect(store.listAudit({ type: "jupiter.watch_screen_failed" })).toHaveLength(1);
    // 期限切れでも保有中なので外さない
    clock.advance(7 * H);
    const r2 = await w.run();
    expect(r2?.removed).toEqual([]);
    expect(feed.instrumentOf(MEMEA)).toBeDefined();
    a = { ...memeA };
    await w.run();
    expect(feed.entryBlock("SDOG/USDC")).toBeUndefined();
    expect(store.listAudit({ type: "jupiter.watch_screen_ok" })).toHaveLength(1);
  });

  it("再起動: kv の一覧から期限内の自動追加の銘柄を戻す (期限切れは保有中だけ)", async () => {
    const { mk, store, clock } = setup({ trending: () => [memeA] });
    const w = await mk();
    w.restore();
    await w.run();
    const w2 = await mk();
    expect(w2.restore().map((i) => i.symbol)).toContain("SDOG/USDC");
    clock.advance(7 * H);
    const s3 = setup({ trending: () => [] });
    s3.store.kvSet(jupiterWatchKey("paper"), store.kvGet(jupiterWatchKey("paper")));
    s3.clock.set(clock.now());
    const w3 = await s3.mk();
    expect(w3.restore().map((i) => i.symbol)).not.toContain("SDOG/USDC");
    s3.held.add("SDOG/USDC");
    const s4 = await s3.mk();
    expect(s4.restore().map((i) => i.symbol)).toContain("SDOG/USDC");
  });

  it("探索の API が失敗しても例外にしない (監査ログ jupiter.discovery_error、監視銘柄はそのまま)", async () => {
    const { mk, store } = setup({ trending: () => { throw new Error("boom"); } });
    const w = await mk();
    w.restore();
    const r = await w.run();
    expect(r?.error).toBeDefined();
    expect(store.listAudit({ type: "jupiter.discovery_error" })).toHaveLength(1);
  });
});
