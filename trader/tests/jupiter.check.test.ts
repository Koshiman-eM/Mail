import { describe, expect, it } from "vitest";
import { runJupiterCheck } from "../src/market/jupiter/check";
import { JupiterClient } from "../src/market/jupiter/client";
import { DEFAULT_MEME_TOKENS, MAJOR_TOKENS } from "../src/market/jupiter/discovery";
import { GeckoTerminalClient } from "../src/market/jupiter/gecko";
import { createMockFetch, fakeClock, loadFixture, type RecordedCall } from "./fixtures/jupiter/mockFetch";

const KNOWN = [...MAJOR_TOKENS, ...DEFAULT_MEME_TOKENS];
const BONK = DEFAULT_MEME_TOKENS[0].mint;

/** すべて想定どおりに答えるモック (mint の照合は wrongSymbol の mint だけ違う symbol) */
function jupiterRoute(o: { wrongSymbol?: string; badPrice?: boolean } = {}) {
  return (c: RecordedCall) => {
    if (c.path === "/price/v3") {
      const ids = (c.query.get("ids") ?? "").split(",");
      if (o.badPrice) return { body: [1, 2, 3] };
      return { body: Object.fromEntries(ids.map((id) => [id, { usdPrice: id === MAJOR_TOKENS[0].mint ? 150.25 : 1 }])) };
    }
    if (c.path === "/tokens/v2/search") {
      return { body: KNOWN.map((k) => ({ id: k.mint, symbol: k.mint === o.wrongSymbol ? "FAKE" : k.symbol })) };
    }
    if (c.path.startsWith("/tokens/v2/")) return { body: loadFixture("tokens_toptrending.json") };
    if (c.path === "/swap/v1/quote" || c.path === "/ultra/v1/order") return { body: loadFixture(c.path === "/swap/v1/quote" ? "swap_quote.json" : "ultra_order.json") };
    return { status: 404, text: "unexpected" };
  };
}

function geckoRoute(c: RecordedCall) {
  if (c.path.endsWith("/pools")) {
    const pools = loadFixture<{ data: { relationships?: { base_token: { data: { id: string } } } }[] }>("gecko_pools.json");
    // BONK を base にした合成のプール
    for (const p of pools.data) if (p.relationships?.base_token.data.id === "solana_MemeAAAAbbbbCCCCddddEEEEffffGGGGhhhh1111") p.relationships.base_token.data.id = `solana_${BONK}`;
    return { body: pools };
  }
  if (c.path.includes("/ohlcv/")) return { body: loadFixture("gecko_ohlcv.json") };
  return { status: 404, text: "unexpected" };
}

function setup(o: { wrongSymbol?: string; badPrice?: boolean; apiKey?: string } = {}) {
  const clk = fakeClock(1_750_000_000_000);
  const jm = createMockFetch(jupiterRoute(o), clk.now);
  const gm = createMockFetch(geckoRoute, clk.now);
  const client = new JupiterClient({ fetchImpl: jm.fetchImpl, now: clk.now, sleep: clk.sleep, ...(o.apiKey ? { apiKey: o.apiKey } : {}) });
  const gecko = new GeckoTerminalClient({ fetchImpl: gm.fetchImpl, now: clk.now, sleep: clk.sleep });
  const lines: string[] = [];
  return { client, gecko, jm, gm, lines, out: (s: string) => lines.push(s), clk };
}

describe("runJupiterCheck", () => {
  it("各エンドポイントを 1 回ずつ読み取りだけで呼ぶ (swap・execute は呼ばない)", async () => {
    const s = setup();
    const r = await runJupiterCheck(s.client, s.gecko, { out: s.out, now: s.clk.now, includeUltra: true });
    expect(s.lines.filter((l) => l.includes("NG"))).toEqual([]);
    expect(r.ok).toBe(true);
    expect(s.jm.calls.map((c) => c.path)).toEqual([
      "/price/v3", "/tokens/v2/search", "/tokens/v2/tag", "/tokens/v2/toptrending/1h", "/tokens/v2/recent", "/swap/v1/quote", "/ultra/v1/order",
    ]);
    expect(s.jm.calls.some((c) => /swap\/v1\/swap|execute/.test(c.path))).toBe(false);
    expect(s.jm.calls.find((c) => c.path === "/ultra/v1/order")!.query.has("taker")).toBe(false);
    expect(s.gm.calls.map((c) => c.path)).toEqual([
      `/api/v2/networks/solana/tokens/${BONK}/pools`,
      "/api/v2/networks/solana/pools/PooLCCCCddddEEEEffffGGGGhhhhJJJJkkkk3333/ohlcv/minute",
    ]);
    expect(r.tokenVerification.every((v) => v.ok)).toBe(true);
    expect(s.lines.join("\n")).toContain("公式資料・実際の応答と未照合の前提");
    expect(s.lines.join("\n")).toContain("結果: すべて想定どおり");
    // 見積もりの行に参照価格から計算した影響と応答の priceImpactPct を並べる (単位の確認用)
    expect(s.lines.find((l) => l.includes("swap/v1/quote"))).toMatch(/影響 29\.95bps \(応答の priceImpactPct = 0\.0002\)/);
  });

  it("既定の銘柄の symbol が違えば NG と照合の結果に出す", async () => {
    const wrong = DEFAULT_MEME_TOKENS[1].mint;
    const s = setup({ wrongSymbol: wrong });
    const r = await runJupiterCheck(s.client, s.gecko, { out: s.out, now: s.clk.now });
    expect(r.ok).toBe(false);
    const v = r.tokenVerification.find((x) => x.mint === wrong)!;
    expect(v).toMatchObject({ ok: false, actual: "FAKE", expected: DEFAULT_MEME_TOKENS[1].symbol });
    expect(s.lines.some((l) => l.includes("symbol が FAKE"))).toBe(true);
  });

  it("形が違う応答は NG として続ける (例外にしない)。キーは表示しない", async () => {
    const s = setup({ badPrice: true, apiKey: "super-secret-key-value" });
    const r = await runJupiterCheck(s.client, undefined, { out: s.out, now: s.clk.now });
    expect(r.steps.find((x) => x.name === "price/v3")?.ok).toBe(false);
    expect(r.steps.length).toBeGreaterThan(4);
    const text = s.lines.join("\n");
    expect(text).toContain("応答の形が想定と違います");
    expect(text).toContain("API キー: あり (表示しません)");
    expect(text).not.toContain("super-secret-key-value");
    expect(text).toContain("GeckoTerminal: クライアントが無いので省略");
  });
});
