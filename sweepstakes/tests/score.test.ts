import { describe, expect, it } from "vitest";
import { checkCryptoScam, checkDomain, evaluateCampaign, registrableDomain, scoreCampaign } from "../src/core/score.js";

const now = new Date("2026-11-21T00:00:00Z");

describe("scoreCampaign", () => {
  it("期待値 = 賞品価値 × 当選数 / 応募者数 ÷ 所要分数", () => {
    const r = scoreCampaign({ kind: "web_form", prizeValueJpy: 30000, winners: 10, participants: 5000, estMinutes: 3, deadline: "2099-01-01" }, now);
    expect(r.excluded).toBe(false);
    expect(r.score).toBeCloseTo((30000 * 10) / 5000 / 3, 2); // 20
  });

  it("応募者数 0 でもゼロ除算しない (max(participants,1))", () => {
    const r = scoreCampaign({ kind: "web_form", prizeValueJpy: 1000, winners: 1, participants: 0, estMinutes: 1 }, now);
    expect(r.score).toBe(1000);
  });

  it("締切切れは除外", () => {
    const r = scoreCampaign({ kind: "web_form", prizeValueJpy: 1000, deadline: "2026-11-20" }, now);
    expect(r).toMatchObject({ excluded: true, expired: true, score: 0 });
  });

  it("リスクフラグで減点、致命的フラグは除外", () => {
    const base = { kind: "crypto_quest" as const, prizeValueJpy: 10000, winners: 10, participants: 100, estMinutes: 10 };
    const clean = scoreCampaign(base, now).score;
    const risky = scoreCampaign({ ...base, riskFlags: ["approval_request"] }, now);
    expect(risky.excluded).toBe(false);
    expect(risky.score).toBeLessThan(clean);
    expect(scoreCampaign({ ...base, riskFlags: ["seed_phrase_request"] }, now).excluded).toBe(true);
  });

  it("賞品価値が高いほど・競争率が低いほど高スコア", () => {
    const a = scoreCampaign({ kind: "x", prizeValueJpy: 10000, winners: 1, participants: 100, estMinutes: 1 }, now).score;
    const b = scoreCampaign({ kind: "x", prizeValueJpy: 10000, winners: 1, participants: 10000, estMinutes: 1 }, now).score;
    expect(a).toBeGreaterThan(b);
  });
});

describe("checkDomain (タイポスクワット)", () => {
  it.each(["app.uniswap.org", "uniswap.org", "metamask.io", "app.galxe.com", "www.binance.com"])("公式: %s", (h) => {
    expect(checkDomain(h).kind).toBe("official");
  });
  it.each([
    ["uniswap.com", "TLD 違い"],
    ["unlswap.org", "紛らわしい"],
    ["metamsk.io", "綴り違い"],
    ["rnetamask.io", "紛らわしい"],
    ["uniswap-airdrop.xyz", "公式名を含む"],
    ["claim-opensea.io", "公式名を含む"],
    ["app.coinbasse.com", "綴り違い"],
  ])("偽物: %s", (h, why) => {
    const v = checkDomain(h);
    expect(v.kind).toBe("typosquat");
    if (v.kind === "typosquat") expect(v.why).toContain(why);
  });
  it.each(["example.com", "sweep.example", "zenn.dev"])("無関係: %s", (h) => {
    expect(checkDomain(h).kind).toBe("unknown");
  });
  it("registrableDomain は co.jp を考慮", () => {
    expect(registrableDomain("www.shop.example.co.jp")).toBe("example.co.jp");
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
  });
});

describe("checkCryptoScam", () => {
  it("シードフレーズ要求は致命的", () => {
    for (const t of ["Enter your seed phrase to claim", "秘密鍵を入力してください", "recovery phrase を入力", "Paste your private key"]) {
      const r = checkCryptoScam({ url: "https://quest.sweep.example", text: t });
      expect(r.flags).toContain("seed_phrase_request");
      expect(r.fatal).toBe(true);
    }
  });

  it("approve / setApprovalForAll は減点 (非致命)", () => {
    const r = checkCryptoScam({ url: "https://app.galxe.com/q", text: "Call setApprovalForAll on the contract" });
    expect(r.flags).toEqual(["approval_request"]);
    expect(r.fatal).toBe(false);
  });

  it("無制限承認は致命的", () => {
    const r = checkCryptoScam({ url: "https://app.galxe.com/q", text: "approve unlimited allowance for the token" });
    expect(r.flags).toContain("unlimited_approval");
    expect(r.fatal).toBe(true);
    expect(checkCryptoScam({ url: "https://app.galxe.com/q", text: "トークンの無制限承認が必要です" }).fatal).toBe(true);
  });

  it("誘導先 URL がタイポスクワットなら致命的", () => {
    const r = checkCryptoScam({ url: "https://app.galxe.com/q", text: "接続してください", linkedUrls: ["https://metamask-wallet.io/connect"] });
    expect(r.flags).toContain("typosquat_domain");
    expect(r.fatal).toBe(true);
  });

  it("問題のないクエストはフラグなし", () => {
    const r = checkCryptoScam({ url: "https://app.galxe.com/quest/1", text: "Follow @project and join Discord" });
    expect(r).toMatchObject({ flags: [], fatal: false });
  });

  it("evaluateCampaign: crypto_quest の致命的リスクは excluded", () => {
    const e = evaluateCampaign(
      {
        kind: "crypto_quest",
        source: "t",
        title: "Airdrop",
        url: "https://uniswap-claim.example/airdrop",
        prize: "UNI",
        prizeValueJpy: 100000,
        conditions: { notes: "seed phrase を入力して受け取り" },
      },
      now,
    );
    expect(e.status).toBe("excluded");
    expect(e.riskFlags).toEqual(expect.arrayContaining(["typosquat_domain", "seed_phrase_request"]));
  });
});
