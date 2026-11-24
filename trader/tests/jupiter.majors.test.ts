/**
 * Jupiter の主要銘柄 (crypto) と、主要銘柄の名前を名乗る別のトークン (なりすまし) の除外。オフライン (モック)。
 * 実例: 自動探索で BTC/USDC と表示されたミーム (資産クラス meme・損切り 8%) を取引していた
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/appConfig";
import type { Instrument } from "../src/core/types";
import {
  DEFAULT_JUPITER_TOKENS, jupiterSettingsFromEnv, jupiterWatchKey, JupiterWatchManager, resolveFixedTokens, type PersistedWatch,
} from "../src/engine/jupiterWatch";
import { JupiterFeed } from "../src/market/feeds/jupiter";
import { JupiterClient } from "../src/market/jupiter/client";
import {
  DEFAULT_MAJOR_WATCH_SYMBOLS, isImpersonation, MAJOR_TOKENS, normalizeTokenSymbol, REJECT_CODE_LABELS, screenTokens,
} from "../src/market/jupiter/discovery";
import { isSolanaAddress } from "../src/market/jupiter/parse";
import type { JupiterToken } from "../src/market/jupiter/tokens";
import { MemoryStore } from "../src/storage/memory";
import { fakeClock } from "./fixtures/jupiter/mockFetch";
import { createJupiterMock, JUP, MEMEA, SOL, type MockToken } from "./helpers/jupiterMock";

const T0 = Date.UTC(2026, 10, 20, 0, 0, 0);
const H = 3_600_000;
const DAY = 86_400_000;
const mintOf = (sym: string) => MAJOR_TOKENS.find((t) => t.symbol === sym)!.mint;
/** 本物でない mint (Solana のアドレスの形) */
const FAKE_BTC = "FakeBtcAAAAbbbbCCCCddddEEEEffffGGGGhhhh11";

/** すべての条件を満たすトークン */
const good = (mint: string, symbol: string): JupiterToken => ({
  mint, symbol, liquidity: 1_000_000, holderCount: 10_000, organicScore: 80, isVerified: true, tags: [],
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 20 },
  firstPool: { createdAt: T0 - 10 * DAY }, stats: {},
});
const codes = (t: JupiterToken) => screenTokens([t], {}, T0).rejected[0]?.reasons.map((r) => r.code) ?? [];

describe("主要銘柄 (MAJOR_TOKENS)", () => {
  it("cbBTC・WBTC・WETH・JTO・PYTH・RAY を足した (mint はアドレスの形・すべて check の照合の対象・重複なし)", () => {
    expect(MAJOR_TOKENS.map((t) => t.symbol)).toEqual(["SOL", "USDC", "JUP", "USDT", "cbBTC", "WBTC", "WETH", "JTO", "PYTH", "RAY"]);
    for (const t of MAJOR_TOKENS) {
      expect(isSolanaAddress(t.mint)).toBe(true);
      expect(t.verify).toBe(true);
    }
    expect(new Set(MAJOR_TOKENS.map((t) => t.mint)).size).toBe(MAJOR_TOKENS.length);
    expect(DEFAULT_MAJOR_WATCH_SYMBOLS).toEqual(["SOL", "JUP", "cbBTC", "WBTC", "WETH", "JTO", "PYTH", "RAY"]);
  });

  it("JUPITER_TOKENS の既定は主要銘柄 + 既定のミーム (設定の既定と一致)", () => {
    expect(DEFAULT_JUPITER_TOKENS).toBe("SOL,JUP,cbBTC,WBTC,WETH,JTO,PYTH,RAY,BONK,WIF,POPCAT,MEW");
    expect(loadConfig({}).env.JUPITER_TOKENS).toBe(DEFAULT_JUPITER_TOKENS);
    expect(jupiterSettingsFromEnv(loadConfig({}).env).tokens).toEqual(DEFAULT_JUPITER_TOKENS.split(","));
    expect(jupiterSettingsFromEnv({}).tokens).toEqual(DEFAULT_JUPITER_TOKENS.split(","));
  });

  it("固定の銘柄の解決: 主要銘柄は crypto (シンボルは既定の一覧の名前。API の表示名 ETH ではなく WETH)。トークン情報が無ければ既知の decimals", async () => {
    const clock = fakeClock(T0);
    const tokens: MockToken[] = [
      { mint: SOL, symbol: "SOL", decimals: 9, price: 150, liquidity: 5e7 },
      { mint: JUP, symbol: "JUP", decimals: 6, price: 1, liquidity: 1e7 },
      { mint: mintOf("WETH"), symbol: "ETH", decimals: 8, price: 3000, liquidity: 2e7 },
      { mint: mintOf("JTO"), symbol: "JTO", decimals: 9, price: 2, liquidity: 5e6 },
    ];
    const mock = createJupiterMock({ now: clock.now, tokens });
    const client = new JupiterClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, ratePerSec: 100, burst: 100, retries: 0 });
    const warns: string[] = [];
    const specs = await resolveFixedTokens(client, ["SOL", "JUP", "cbBTC", "WBTC", "WETH", "JTO", "PYTH", "RAY", "BONK"], (m) => void warns.push(m));
    const by = new Map(specs.map((s) => [s.symbol, s]));
    for (const sym of ["SOL", "JUP", "cbBTC", "WBTC", "WETH", "JTO", "PYTH", "RAY"]) {
      expect(by.get(sym)).toMatchObject({ mint: mintOf(sym), assetClass: "crypto", source: "fixed" });
    }
    expect(by.get("BONK")?.assetClass).toBe("meme");
    // 応答に無い銘柄は既知の decimals (要確認の値)
    expect([by.get("cbBTC")?.decimals, by.get("WBTC")?.decimals, by.get("PYTH")?.decimals, by.get("RAY")?.decimals]).toEqual([8, 8, 6, 6]);
    expect(by.get("WETH")?.decimals).toBe(8);
    // 別名 (BTC → cbBTC、ETH → WETH) も既定の一覧で解決する (検索に回さない = なりすましを拾わない)
    const alias = await resolveFixedTokens(client, ["BTC", "ETH"], () => undefined);
    expect(alias.map((s) => [s.symbol, s.mint])).toEqual([["cbBTC", mintOf("cbBTC")], ["WETH", mintOf("WETH")]]);
  });
});

describe("なりすまし (主要銘柄の名前を名乗る別のトークン)", () => {
  it("正規化 (先頭の $ を除き大文字) で主要銘柄の symbol・別名と完全一致し、mint が違えば impersonation", () => {
    expect(normalizeTokenSymbol(" $btc ")).toBe("BTC");
    for (const s of ["BTC", "$BTC", "btc", "ETH", "SOL", "$sol", "JUP", "USDC", "USDT", "cbBTC", "CBBTC", "WBTC", "WETH", "JTO", "PYTH", "RAY"]) {
      expect(isImpersonation(FAKE_BTC, s)).toBe(true);
      expect(codes(good(FAKE_BTC, s))).toEqual(["impersonation"]);
    }
    // 完全一致だけ (前後に文字を足した名前・先頭の W / cb を外した比較はしない)
    for (const s of ["BTC2", "XBTC", "SOLANA", "BONK", undefined]) expect(isImpersonation(FAKE_BTC, s)).toBe(false);
    // 本物の mint は対象外 (主要銘柄として excluded)。別名の表示名 (WETH の "ETH") も本物
    expect(isImpersonation(mintOf("WETH"), "ETH")).toBe(false);
    expect(codes(good(mintOf("WETH"), "ETH"))).toEqual(["excluded"]);
    expect(codes(good(mintOf("cbBTC"), "BTC"))).toEqual(["excluded"]);
    expect(REJECT_CODE_LABELS.impersonation).toBe("主要銘柄の名前を名乗る別のトークン");
  });

  function setup(o: { trending: () => MockToken[]; held?: string[]; store?: MemoryStore }) {
    const clock = fakeClock(T0);
    const mock = createJupiterMock({ now: clock.now, trending: o.trending, tokens: [{ mint: SOL, symbol: "SOL", decimals: 9, price: 150, liquidity: 5e7 }] });
    const client = new JupiterClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, ratePerSec: 100, burst: 100, retries: 0 });
    const feed = new JupiterFeed({ client, now: clock.now });
    const store = o.store ?? new MemoryStore();
    const watched: Instrument[] = [];
    const held = new Set(o.held ?? []);
    const mk = async () => {
      const fixed = await resolveFixedTokens(client, ["SOL"], () => undefined);
      return new JupiterWatchManager({
        client, feed, store, mode: "paper", settings: jupiterSettingsFromEnv(loadConfig({}).env), fixed, now: clock.now,
        onAdd: (i) => void watched.push(i),
        onRemove: (s) => !held.has(s),
        keepSymbols: () => [...held],
      });
    };
    return { clock, feed, store, watched, mk };
  }

  it("自動探索: BTC を名乗る別の mint は選別で落ち、監視に加えない (監査ログの集計に impersonation)", async () => {
    const fake: MockToken = { mint: FAKE_BTC, symbol: "BTC", decimals: 8, price: 0.01, liquidity: 900_000 };
    const real: MockToken = { mint: MEMEA, symbol: "SDOG", decimals: 5, price: 0.001, liquidity: 900_000 };
    const { mk, store, watched } = setup({ trending: () => [fake, real] });
    const w = await mk();
    w.restore();
    const r = await w.run();
    expect(r?.added).toEqual(["SDOG/USDC"]);
    expect(watched.map((i) => i.symbol)).toEqual(["SDOG/USDC"]);
    const disc = store.listAudit({ type: "jupiter.discovery" })[0].data as { rejectedByCode: Record<string, number>; rejected: { symbol: string; reasons: string[] }[] };
    expect(disc.rejectedByCode.impersonation).toBe(1);
    expect(disc.rejected.find((x) => x.symbol === "BTC")?.reasons[0]).toMatch(/主要銘柄の名前を名乗る別のトークン/);
  });

  it("監視中のなりすまし (更新前に自動追加・保有中): 起動時から新規エントリーを止め (screen_failed)、建玉のある銘柄は外さない", async () => {
    const store = new MemoryStore();
    const saved: PersistedWatch = {
      updatedAt: T0 - H,
      entries: [{ mint: FAKE_BTC, symbol: "BTC", source: "discovered", decimals: 8, instSymbol: "BTC/USDC", addedAt: T0 - 2 * H, lastSeenAt: T0 - H, expiresAt: T0 + 5 * H }],
    };
    store.kvSet(jupiterWatchKey("paper"), saved);
    const { mk, feed, clock } = setup({ trending: () => [], held: ["BTC/USDC"], store });
    const w = await mk();
    const insts = w.restore();
    expect(insts.map((i) => [i.symbol, i.assetClass])).toContainEqual(["BTC/USDC", "meme"]);
    expect(feed.entryBlock("BTC/USDC")).toMatch(/主要銘柄の名前を名乗る別のトークン/);
    const audits = store.listAudit({ type: "jupiter.watch_screen_failed" });
    expect(audits).toHaveLength(1);
    expect(audits[0].data).toMatchObject({ mint: FAKE_BTC, codes: ["impersonation"] });
    expect(store.kvGet<PersistedWatch>(jupiterWatchKey("paper"))!.entries.find((e) => e.mint === FAKE_BTC)?.screenBlock?.codes).toEqual(["impersonation"]);
    // 探索 (トークン情報なし) でも止めたまま。期限切れでも保有中なので外さない
    clock.advance(6 * H);
    const r = await w.run();
    expect(r?.screenFailed).toEqual(["BTC/USDC"]);
    expect(r?.removed).toEqual([]);
    expect(feed.entryBlock("BTC/USDC")).toMatch(/主要銘柄の名前/);
    // 監査ログは理由の組が変わったときだけ
    expect(store.listAudit({ type: "jupiter.watch_screen_failed" })).toHaveLength(1);
    // 再起動しても止めたまま (監査ログは増やさない)
    const again = setup({ trending: () => [], held: ["BTC/USDC"], store });
    const w2 = await again.mk();
    w2.restore();
    expect(again.feed.entryBlock("BTC/USDC")).toMatch(/主要銘柄の名前/);
    expect(store.listAudit({ type: "jupiter.watch_screen_failed" })).toHaveLength(1);
  });

  it("監視中のなりすまし: トークン情報があっても (流動性などの条件を満たしても) 止める", async () => {
    const store = new MemoryStore();
    store.kvSet(jupiterWatchKey("paper"), {
      updatedAt: T0, entries: [{ mint: FAKE_BTC, symbol: "BTC", source: "discovered", decimals: 8, instSymbol: "BTC/USDC", addedAt: T0, lastSeenAt: T0, expiresAt: T0 + 5 * H }],
    } satisfies PersistedWatch);
    const fake: MockToken = { mint: FAKE_BTC, symbol: "BTC", decimals: 8, price: 0.01, liquidity: 900_000 };
    const { mk, feed } = setup({ trending: () => [fake], held: ["BTC/USDC"], store });
    const w = await mk();
    w.restore();
    const r = await w.run();
    expect(r?.screenFailed).toEqual(["BTC/USDC"]);
    expect(feed.entryBlock("BTC/USDC")).toMatch(/主要銘柄の名前/);
  });
});
