import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISCOVERY_SETTINGS, DEFAULT_MEME_TOKENS, MAJOR_TOKENS, mergeWatchlist, screenTokens, SOL_MINT, USDC_MINT, type RejectCode, type WatchEntry,
} from "../src/market/jupiter/discovery";
import { isSolanaAddress } from "../src/market/jupiter/parse";
import { parseTokenList, type JupiterToken } from "../src/market/jupiter/tokens";
import { loadFixture } from "./fixtures/jupiter/mockFetch";

const DAY = 86_400_000;
const NOW = Date.UTC(2025, 5, 1, 12, 0, 0);

/** すべての条件を満たすトークン */
const good = (mint: string, over: Partial<JupiterToken> = {}): JupiterToken => ({
  mint,
  symbol: mint.slice(0, 4),
  liquidity: 1_000_000,
  holderCount: 10_000,
  organicScore: 80,
  isVerified: true,
  tags: [],
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 20 },
  firstPool: { createdAt: NOW - 10 * DAY },
  stats: {},
  ...over,
});

const codes = (t: JupiterToken, s = {}) => {
  const r = screenTokens([t], s, NOW);
  return r.rejected[0]?.reasons.map((x) => x.code) ?? [];
};

describe("screenTokens: 各条件", () => {
  it("すべて満たせば合格", () => {
    const r = screenTokens([good("A1")], {}, NOW);
    expect(r.accepted.map((t) => t.mint)).toEqual(["A1"]);
    expect(r.rejected).toEqual([]);
  });

  const cases: [string, Partial<JupiterToken>, RejectCode][] = [
    ["流動性不足", { liquidity: 100 }, "liquidity"],
    ["流動性が不明", { liquidity: undefined }, "liquidity"],
    ["保有者数不足", { holderCount: 10 }, "holders"],
    ["保有者数が不明", { holderCount: undefined }, "holders"],
    ["日が浅い", { firstPool: { createdAt: NOW - 3_600_000 } }, "age"],
    ["作成時刻が不明", { firstPool: undefined }, "age"],
    ["オーガニックスコア不足", { organicScore: 10 }, "organic"],
    ["オーガニックスコアが不明", { organicScore: undefined }, "organic"],
    ["ミント権限あり", { audit: { mintAuthorityDisabled: false, freezeAuthorityDisabled: true, topHoldersPercentage: 10 } }, "mint_authority"],
    ["凍結権限が不明", { audit: { mintAuthorityDisabled: true, topHoldersPercentage: 10 } }, "freeze_authority"],
    ["上位保有者の集中", { audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 80 } }, "top_holders"],
    ["上位保有者の比率が不明", { audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } }, "top_holders"],
    ["isSus", { audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 10, isSus: true } }, "sus"],
  ];
  for (const [name, over, code] of cases) {
    it(`${name} → ${code}`, () => {
      expect(codes(good("X1", over))).toEqual([code]);
    });
  }

  it("主要銘柄 (SOL・USDC・JUP) は除く", () => {
    for (const m of MAJOR_TOKENS) expect(codes(good(m.mint))).toEqual(["excluded"]);
  });

  it("verifiedOnly なら未検証・不明を除く (既定は無効)", () => {
    expect(codes(good("V1", { isVerified: false }))).toEqual([]);
    expect(codes(good("V1", { isVerified: false }), { verifiedOnly: true })).toEqual(["unverified"]);
    expect(codes(good("V1", { isVerified: undefined }), { verifiedOnly: true })).toEqual(["unverified"]);
  });

  it("requireAuthoritiesDisabled=false なら権限は見ない、rejectSus=false なら isSus は見ない", () => {
    const t = good("P1", { audit: { mintAuthorityDisabled: false, topHoldersPercentage: 10, isSus: true } });
    expect(codes(t, { requireAuthoritiesDisabled: false, rejectSus: false })).toEqual([]);
  });

  it("不合格の理由は全部、日本語の説明 (値と条件) つき", () => {
    const r = screenTokens([good("Z1", { liquidity: 1000, holderCount: 5, organicScore: undefined })], {}, NOW);
    const reasons = r.rejected[0].reasons;
    expect(reasons.map((x) => x.code)).toEqual(["liquidity", "holders", "organic"]);
    expect(reasons[0].label).toBe("流動性不足: $1,000 < $250,000");
    expect(reasons[1].label).toBe("保有者数不足: 5 < 2000");
    expect(reasons[2].label).toBe("オーガニックスコア不足: オーガニックスコアが不明");
  });

  it("日の浅さの説明は時間・日で", () => {
    const r = screenTokens([good("Y1", { firstPool: { createdAt: NOW - 5 * 3_600_000 } })], {}, NOW);
    expect(r.rejected[0].reasons[0].label).toBe("上場から日が浅い: 5.0 時間 < 3.0 日");
  });

  it("maxTokens を超えた合格は件数の上限で不合格 (入力の順を保つ)。重複の mint は重複", () => {
    const r = screenTokens([good("B1"), good("B2"), good("B1"), good("B3")], { maxTokens: 2 }, NOW);
    expect(r.accepted.map((t) => t.mint)).toEqual(["B1", "B2"]);
    expect(r.rejected.map((x) => [x.token.mint, x.reasons[0].code])).toEqual([["B1", "duplicate"], ["B3", "max_tokens"]]);
  });

  it("フィクスチャの toptrending: 完全な SDOG と文字列の数値の SCAT は合格、不明だらけの RUG と isSus の SUS は不合格", () => {
    const tokens = parseTokenList(loadFixture("tokens_toptrending.json")).tokens;
    const r = screenTokens(tokens, { minAgeMs: 2 * DAY }, NOW);
    expect(r.accepted.map((t) => t.symbol)).toEqual(["SDOG", "SCAT"]);
    const rug = r.rejected.find((x) => x.token.symbol === "RUG")!;
    expect(rug.reasons.map((x) => x.code)).toEqual(["liquidity", "holders", "age", "organic", "mint_authority", "freeze_authority", "top_holders"]);
    const sus = r.rejected.find((x) => x.token.symbol === "SUS")!;
    expect(sus.reasons.map((x) => x.code)).toEqual(["age", "mint_authority", "top_holders", "sus"]);
  });

  it("既定の設定は変更されない (部分指定は合成)", () => {
    screenTokens([good("C1")], { minLiquidityUsd: 1 }, NOW);
    expect(DEFAULT_DISCOVERY_SETTINGS.minLiquidityUsd).toBe(250_000);
  });
});

describe("既定の銘柄", () => {
  it("mint は Solana のアドレスの形で、すべて check での照合の対象", () => {
    for (const t of [...MAJOR_TOKENS, ...DEFAULT_MEME_TOKENS]) {
      expect(isSolanaAddress(t.mint)).toBe(true);
      expect(t.verify).toBe(true);
    }
    expect(SOL_MINT).toBe("So11111111111111111111111111111111111111112");
    expect(USDC_MINT).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(DEFAULT_MEME_TOKENS.map((t) => t.symbol)).toEqual(expect.arrayContaining(["BONK", "WIF", "POPCAT"]));
    expect(new Set(DEFAULT_MEME_TOKENS.map((t) => t.mint)).size).toBe(DEFAULT_MEME_TOKENS.length);
  });
});

describe("mergeWatchlist", () => {
  const H = 3_600_000;
  const fixed = [{ mint: "F1", symbol: "BONK" }, { mint: "F2", symbol: "WIF" }];

  it("固定 → 自動追加 (新しい順)。固定の銘柄は自動追加にしない", () => {
    const r = mergeWatchlist(fixed, [], [{ mint: "D1", symbol: "AAA" }, { mint: "F1", symbol: "BONK" }], NOW, { ttlMs: 6 * H });
    expect(r.entries).toEqual([
      { mint: "F1", symbol: "BONK", source: "fixed" },
      { mint: "F2", symbol: "WIF", source: "fixed" },
      { mint: "D1", symbol: "AAA", source: "discovered", addedAt: NOW, lastSeenAt: NOW, expiresAt: NOW + 6 * H },
    ]);
    expect(r.added).toEqual(["D1"]);
  });

  it("再び合格すれば期限を延ばし、合格しなくなったら ttl で外す", () => {
    const prev: WatchEntry[] = [
      { mint: "D1", source: "discovered", addedAt: NOW - 10 * H, lastSeenAt: NOW - 5 * H, expiresAt: NOW + H },
      { mint: "D2", source: "discovered", addedAt: NOW - 10 * H, lastSeenAt: NOW - 7 * H, expiresAt: NOW - H },
    ];
    const r = mergeWatchlist(fixed, prev, [{ mint: "D1" }], NOW, { ttlMs: 6 * H });
    expect(r.refreshed).toEqual(["D1"]);
    expect(r.expired).toEqual(["D2"]);
    const d1 = r.entries.find((e) => e.mint === "D1")!;
    expect(d1).toMatchObject({ addedAt: NOW - 10 * H, lastSeenAt: NOW, expiresAt: NOW + 6 * H });
    // 合格しないまま期限が来れば外れる
    const later = mergeWatchlist(fixed, r.entries, [], NOW + 6 * H, { ttlMs: 6 * H });
    expect(later.expired).toEqual(["D1"]);
    expect(later.entries.map((e) => e.mint)).toEqual(["F1", "F2"]);
  });

  it("期限の無い古い記録は lastSeenAt + ttl で判定する", () => {
    const prev: WatchEntry[] = [{ mint: "D3", source: "discovered", lastSeenAt: NOW - 2 * H }];
    expect(mergeWatchlist([], prev, [], NOW, { ttlMs: H }).expired).toEqual(["D3"]);
    expect(mergeWatchlist([], prev, [], NOW, { ttlMs: 3 * H }).entries[0].expiresAt).toBe(NOW + H);
  });

  it("保有中 (keepMints) は期限切れ・上限でも外さない", () => {
    const prev: WatchEntry[] = [{ mint: "D4", source: "discovered", lastSeenAt: NOW - 100 * H, expiresAt: NOW - 50 * H }];
    const r = mergeWatchlist([], prev, [{ mint: "N1" }], NOW, { ttlMs: H, maxAuto: 1, keepMints: ["D4"] });
    expect(r.expired).toEqual([]);
    expect(r.entries.map((e) => e.mint).sort()).toEqual(["D4", "N1"]);
  });

  it("自動追加の上限: 最後に合格したのが古い順に外す", () => {
    const prev: WatchEntry[] = [
      { mint: "O1", source: "discovered", lastSeenAt: NOW - 3 * H, expiresAt: NOW + 3 * H },
      { mint: "O2", source: "discovered", lastSeenAt: NOW - 1 * H, expiresAt: NOW + 5 * H },
    ];
    const r = mergeWatchlist([], prev, [{ mint: "N1" }], NOW, { ttlMs: 6 * H, maxAuto: 2 });
    expect(r.entries.map((e) => e.mint)).toEqual(["N1", "O2"]);
    expect(r.evicted).toEqual(["O1"]);
    expect(r.added).toEqual(["N1"]);
  });

  it("前回の一覧の固定の記録・重複は無視し、固定の一覧の重複も 1 件", () => {
    const prev: WatchEntry[] = [{ mint: "F1", source: "fixed" }, { mint: "D5", source: "discovered", lastSeenAt: NOW, expiresAt: NOW + H }, { mint: "D5", source: "discovered", lastSeenAt: NOW - H }];
    const r = mergeWatchlist([...fixed, fixed[0]], prev, [], NOW, { ttlMs: 6 * H });
    expect(r.entries.map((e) => e.mint)).toEqual(["F1", "F2", "D5"]);
  });
});
