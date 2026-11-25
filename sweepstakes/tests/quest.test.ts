import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../src/collectors/http.js";
import { loadConfig } from "../src/core/config.js";
import { extractQuestPageInfo, questValueJpy, sortQuests } from "../src/core/quest.js";
import { checkCryptoScam, FCFS_OVERFLOW_FACTOR, questMetrics, scoreCampaign } from "../src/core/score.js";
import { addQuest, listQuests, mark, todo, updateQuest, type SweepContext } from "../src/core/service.js";
import { CRYPTO_SAFETY_NOTES, formatSteps } from "../src/core/todo.js";
import type { QuestMeta } from "../src/core/types.js";
import { formatQuestMetrics, parseQuestAddArgs, parseQuestUpdateArgs, runQuestCommand } from "../src/questCli.js";
import { makeTestContext } from "./helpers/context.js";

const NOW = new Date("2026-11-21T09:00:00+09:00");
const GALXE = "https://app.galxe.com/quest/sweep-example/GCtest";

let ctx: SweepContext;
afterEach(() => ctx?.store.close());

function mkCtx(usdJpy: number | null = 150): SweepContext {
  ctx = makeTestContext({ usdJpy }, { now: () => NOW, random: () => 0 });
  return ctx;
}

const meta = (m: Partial<QuestMeta> = {}): QuestMeta => ({
  rewardType: "stablecoin",
  valueSource: "direct",
  distribution: "raffle",
  requiresOnchainTx: false,
  ...m,
});

function mockSite(routes: Record<string, string | number>) {
  const requested: string[] = [];
  const fetch: FetchLike = async (url) => {
    requested.push(url);
    const r = routes[url];
    if (r === undefined) return { status: 404, ok: false, text: async () => "" };
    if (typeof r === "number") return { status: r, ok: r >= 200 && r < 300, text: async () => "" };
    return { status: 200, ok: true, text: async () => r };
  };
  return { fetch, requested };
}

describe("config: SWEEP_USDJPY", () => {
  it("未設定・不正値は null、正の数ならその値", () => {
    expect(loadConfig({}).usdJpy).toBeNull();
    expect(loadConfig({ SWEEP_USDJPY: "abc" }).usdJpy).toBeNull();
    expect(loadConfig({ SWEEP_USDJPY: "0" }).usdJpy).toBeNull();
    expect(loadConfig({ SWEEP_USDJPY: "151.5" }).usdJpy).toBe(151.5);
  });
});

describe("questValueJpy (円換算)", () => {
  it("USD/USDT/USDC は SWEEP_USDJPY で換算", () => {
    for (const cur of ["USD", "usdt", "USDC"]) {
      expect(questValueJpy({ rewardType: "stablecoin", rewardAmount: 10, rewardCurrency: cur }, 150)).toMatchObject({ valueJpy: 1500, source: "usdjpy" });
    }
  });
  it("SWEEP_USDJPY 未設定なら換算不能 (null + 警告)", () => {
    const v = questValueJpy({ rewardType: "stablecoin", rewardAmount: 10, rewardCurrency: "USDC" }, null);
    expect(v.valueJpy).toBeNull();
    expect(v.warnings.join()).toMatch(/SWEEP_USDJPY/);
  });
  it("JPY はそのまま、直接指定は最優先", () => {
    expect(questValueJpy({ rewardType: "other", rewardAmount: 500, rewardCurrency: "JPY" }, null).valueJpy).toBe(500);
    expect(questValueJpy({ rewardType: "token", rewardAmount: 10, rewardCurrency: "ARB", rewardValueJpy: 1200 }, null)).toMatchObject({ valueJpy: 1200, source: "direct" });
  });
  it("その他トークン・points/nft/whitelist は価値不明 (0 ではなく null)", () => {
    expect(questValueJpy({ rewardType: "token", rewardAmount: 10, rewardCurrency: "ARB" }, 150).valueJpy).toBeNull();
    for (const t of ["points", "nft", "whitelist"] as const) {
      expect(questValueJpy({ rewardType: t, rewardAmount: 100, rewardCurrency: "USD" }, 150).valueJpy).toBeNull();
    }
  });
});

describe("questMetrics (distribution 別期待値・ガス・時給)", () => {
  it("raffle: value × winners / max(participants, 1)", () => {
    const m = questMetrics({ prizeValueJpy: 15000, winners: 10, participants: 1000, estMinutes: 10, quest: meta() });
    expect(m.expectedValueJpy).toBe(150);
    expect(m.hourlyJpy).toBe(900); // 150 / 10 分 × 60
    expect(questMetrics({ prizeValueJpy: 1000, winners: 1, participants: 0, estMinutes: 1, quest: meta() }).expectedValueJpy).toBe(1000);
  });
  it("fcfs: 参加者 < 枠なら満額、超えていればほぼ 0", () => {
    const under = questMetrics({ prizeValueJpy: 1000, winners: 100, participants: 50, estMinutes: 5, quest: meta({ distribution: "fcfs" }) });
    expect(under.expectedValueJpy).toBe(1000);
    const over = questMetrics({ prizeValueJpy: 1000, winners: 100, participants: 500, estMinutes: 5, quest: meta({ distribution: "fcfs" }) });
    expect(over.expectedValueJpy).toBe(1000 * FCFS_OVERFLOW_FACTOR);
  });
  it("all: 満額、leaderboard: 不明", () => {
    expect(questMetrics({ prizeValueJpy: 800, participants: 99999, estMinutes: 5, quest: meta({ distribution: "all" }) }).expectedValueJpy).toBe(800);
    const lb = questMetrics({ prizeValueJpy: 800, estMinutes: 5, quest: meta({ distribution: "leaderboard" }) });
    expect(lb).toMatchObject({ expectedValueJpy: null, hourlyJpy: null, valueUnknown: true });
  });
  it("ガス代を差し引き、時給は正味 ÷ 分 × 60 (赤字もそのまま)", () => {
    const m = questMetrics({ prizeValueJpy: 1500, estMinutes: 30, quest: meta({ distribution: "all", requiresOnchainTx: true, gasCostJpy: 300 }) });
    expect(m).toMatchObject({ expectedValueJpy: 1500, netValueJpy: 1200, hourlyJpy: 2400, gasCostJpy: 300 });
    const loss = questMetrics({ prizeValueJpy: 100, estMinutes: 10, quest: meta({ distribution: "all", gasCostJpy: 400 }) });
    expect(loss.netValueJpy).toBe(-300);
    expect(loss.hourlyJpy).toBe(-1800);
  });
  it("価値不明 (null) は score 0 で「価値不明」理由付き", () => {
    const r = scoreCampaign({ kind: "crypto_quest", prizeValueJpy: null, estMinutes: 5, quest: meta({ rewardType: "points" }) }, NOW);
    expect(r.score).toBe(0);
    expect(r.questMetrics?.valueUnknown).toBe(true);
    expect(r.reasons.join()).toMatch(/価値不明/);
    expect(formatQuestMetrics(r.questMetrics!)).toMatch(/価値不明/);
  });
  it("quest がある場合の score = 正味期待値 / 分 (リスク減点込み)", () => {
    const r = scoreCampaign({ kind: "crypto_quest", prizeValueJpy: 1000, estMinutes: 10, quest: meta({ distribution: "all", gasCostJpy: 200 }) }, NOW);
    expect(r.score).toBe(80);
    const p = scoreCampaign({ kind: "crypto_quest", prizeValueJpy: 1000, estMinutes: 10, riskFlags: ["unknown_platform"], quest: meta({ distribution: "all", gasCostJpy: 200 }) }, NOW);
    expect(p.score).toBeCloseTo(56, 2);
  });
});

describe("詐欺チェック: unknown_platform", () => {
  it.each(["https://app.galxe.com/q/1", "https://zealy.io/cw/x", "https://app.layer3.xyz/quests/a", "https://www.taskon.xyz/quest/1", "https://www.intract.io/q", "https://quest3.xyz/q", "https://app.questn.com/q"])(
    "正規プラットフォームはフラグなし: %s",
    (u) => {
      expect(checkCryptoScam({ url: u, text: "Follow and join" }).flags).toEqual([]);
    },
  );
  it("許可リスト外は unknown_platform (減点のみ・非致命)", () => {
    const r = checkCryptoScam({ url: "https://quests.sweep.example/campaign/1", text: "Follow and join" });
    expect(r.flags).toEqual(["unknown_platform"]);
    expect(r.fatal).toBe(false);
  });
  it("偽ドメインは typosquat (unknown_platform は重ねない)", () => {
    const r = checkCryptoScam({ url: "https://app.ga1xe.com/quest/1", text: "" });
    expect(r.flags).toContain("typosquat_domain");
    expect(r.flags).not.toContain("unknown_platform");
    expect(r.fatal).toBe(true);
  });
});

describe("addQuest / updateQuest", () => {
  it("kind=crypto_quest, source=manual で登録し、USD を円換算して採点", async () => {
    mkCtx(150);
    const r = await addQuest(ctx, {
      url: GALXE,
      title: "Sweep Example Quest",
      rewardType: "stablecoin",
      rewardAmount: 100,
      rewardCurrency: "USDC",
      winners: 50,
      participants: 5000,
      distribution: "raffle",
      estMinutes: 10,
      deadline: "2026-12-01",
      requiresOnchainTx: true,
      gasCostJpy: 30,
      notes: "Discord 参加が必要",
    });
    expect(r.created).toBe(true);
    expect(r.campaign).toMatchObject({ kind: "crypto_quest", source: "manual", status: "active", prizeValueJpy: 15000, winners: 50, participants: 5000 });
    expect(r.campaign.conditions.quest).toMatchObject({ rewardType: "stablecoin", rewardCurrency: "USDC", usdJpy: 150, valueSource: "usdjpy", requiresOnchainTx: true, gasCostJpy: 30 });
    // 15000 × 50 / 5000 = 150 円、ガス 30 円を引いて 120 円、10 分で 720 円/時
    expect(r.metrics).toMatchObject({ expectedValueJpy: 150, netValueJpy: 120, hourlyJpy: 720 });
    expect(r.campaign.score).toBe(12);
    expect(r.warnings).toEqual([]);
  });

  it("SWEEP_USDJPY 未設定なら prizeValueJpy=null + 警告", async () => {
    mkCtx(null);
    const r = await addQuest(ctx, { url: GALXE, rewardType: "stablecoin", rewardAmount: 100, rewardCurrency: "USDT", distribution: "all" });
    expect(r.campaign.prizeValueJpy).toBeNull();
    expect(r.metrics?.valueUnknown).toBe(true);
    expect(r.warnings.join()).toMatch(/SWEEP_USDJPY/);
  });

  it("url は必須・値の検証", async () => {
    mkCtx();
    await expect(addQuest(ctx, { url: "" })).rejects.toThrow(/url/);
    await expect(addQuest(ctx, { url: "ftp://x.example" })).rejects.toThrow(/http/);
    await expect(addQuest(ctx, { url: GALXE, rewardType: "cash" as never })).rejects.toThrow(/rewardType/);
    await expect(addQuest(ctx, { url: GALXE, winners: -1 })).rejects.toThrow(/winners/);
    await expect(addQuest(ctx, { url: GALXE, deadline: "来週" })).rejects.toThrow(/deadline/);
  });

  it("致命フラグ付きは登録するが excluded にして理由を返す (todo にも出ない)", async () => {
    mkCtx();
    const r = await addQuest(ctx, { url: "https://galxe-airdrop.example/claim", rewardType: "token", rewardValueJpy: 50000, notes: "Enter your seed phrase to claim" });
    expect(r.campaign.status).toBe("excluded");
    expect(r.campaign.riskFlags).toEqual(expect.arrayContaining(["typosquat_domain", "seed_phrase_request"]));
    expect(r.excludedReason).toMatch(/シードフレーズ/);
    expect(r.reasons.join()).toMatch(/致命的リスク/);
    expect(todo(ctx)).toHaveLength(0);
  });

  it("許可リスト外ドメインは unknown_platform で減点のみ", async () => {
    mkCtx();
    const r = await addQuest(ctx, { url: "https://quest.sweep.example/c/1", rewardType: "other", rewardValueJpy: 1000, distribution: "all", estMinutes: 10 });
    expect(r.campaign.status).toBe("active");
    expect(r.campaign.riskFlags).toEqual(["unknown_platform"]);
    expect(r.campaign.score).toBe(70); // 100 円/分 × 0.7
  });

  it("updateQuest: 部分更新・null で消去・再採点、entered は保持", async () => {
    mkCtx(150);
    const a = await addQuest(ctx, { url: GALXE, rewardType: "stablecoin", rewardAmount: 10, rewardCurrency: "USD", distribution: "all", estMinutes: 10, notes: "メモ" });
    expect(a.campaign.prizeValueJpy).toBe(1500);
    const u = updateQuest(ctx, a.campaign.id, { rewardAmount: 20, gasCostJpy: 500, requiresOnchainTx: true, notes: null });
    expect(u.created).toBe(false);
    expect(u.campaign.id).toBe(a.campaign.id);
    expect(u.campaign.prizeValueJpy).toBe(3000);
    expect(u.metrics).toMatchObject({ netValueJpy: 2500, hourlyJpy: 15000 });
    expect(u.campaign.conditions.notes).toBeUndefined();
    // 円換算額の直接指定 → 消去で換算に戻る
    expect(updateQuest(ctx, a.campaign.id, { rewardValueJpy: 9999 }).campaign.prizeValueJpy).toBe(9999);
    expect(updateQuest(ctx, a.campaign.id, { rewardValueJpy: null }).campaign.prizeValueJpy).toBe(3000);
    // 詐欺っぽい記述を追記すると除外、消すと戻る
    expect(updateQuest(ctx, a.campaign.id, { notes: "approve unlimited allowance" }).campaign.status).toBe("excluded");
    expect(updateQuest(ctx, a.campaign.id, { notes: null }).campaign.status).toBe("active");
    mark(ctx, a.campaign.id);
    expect(updateQuest(ctx, a.campaign.id, { winners: 3 }).campaign.status).toBe("entered");
    expect(() => updateQuest(ctx, 9999, {})).toThrow(/見つかりません/);
    expect(() => updateQuest(ctx, a.campaign.id, { url: "https://x.example" } as never)).toThrow(/URL/);
  });

  it("updateQuest は SWEEP_USDJPY が後で未設定でも登録時のレートで換算", async () => {
    mkCtx(150);
    const a = await addQuest(ctx, { url: GALXE, rewardType: "stablecoin", rewardAmount: 10, rewardCurrency: "USD" });
    ctx.config.usdJpy = null;
    expect(updateQuest(ctx, a.campaign.id, { winners: 5 }).campaign.prizeValueJpy).toBe(1500);
  });

  it("web_form には updateQuest できない", async () => {
    mkCtx();
    const { campaign } = ctx.store.upsertCampaign({
      kind: "web_form", source: "t", title: "w", url: "https://w.example/", prize: "", conditions: {}, riskFlags: [], score: 0, status: "active",
    });
    expect(() => updateQuest(ctx, campaign.id, { winners: 1 })).toThrow(/仮想通貨クエストではありません/);
  });
});

describe("addQuest --fetch (モック fetch)", () => {
  const ORIGIN = "https://app.galxe.com";
  const PAGE = `<!doctype html><html><head><title>Fallback Title</title>
    <meta property="og:title" content="Sweep Example &amp; Friends Quest">
    <meta property="og:description" content="Complete tasks to win 100 USDC"></head>
    <body><script>var x = "seed phrase";</script><h1>Quest</h1><p>Follow us and join Discord</p></body></html>`;

  it("og:title でタイトル補完、本文を詐欺チェックにかける (script は無視)", async () => {
    mkCtx();
    const site = mockSite({ [`${ORIGIN}/robots.txt`]: "User-agent: *\nAllow: /\n", [GALXE]: PAGE });
    const r = await addQuest(ctx, { url: GALXE, rewardType: "points" }, { fetch: true, fetchImpl: site.fetch });
    expect(site.requested).toEqual([`${ORIGIN}/robots.txt`, GALXE]);
    expect(r.campaign.title).toBe("Sweep Example & Friends Quest");
    expect(r.campaign.conditions.terms).toMatch(/Follow us and join Discord/);
    expect(r.campaign.conditions.quest?.fetchedAt).toBe(NOW.toISOString());
    expect(r.campaign.riskFlags).toEqual([]);
    expect(r.campaign.status).toBe("active");
  });

  it("明示したタイトルは上書きしない。本文にシードフレーズ要求があれば除外", async () => {
    mkCtx();
    const bad = PAGE.replace("Follow us and join Discord", "Enter your secret recovery phrase to verify");
    const site = mockSite({ [`${ORIGIN}/robots.txt`]: "", [GALXE]: bad });
    const r = await addQuest(ctx, { url: GALXE, title: "自分で付けた名前" }, { fetch: true, fetchImpl: site.fetch });
    expect(r.campaign.title).toBe("自分で付けた名前");
    expect(r.campaign.status).toBe("excluded");
    expect(r.campaign.riskFlags).toContain("seed_phrase_request");
  });

  it.each([
    ["robots Disallow", { [`${ORIGIN}/robots.txt`]: "User-agent: *\nDisallow: /quest\n", [GALXE]: PAGE }, /robots/],
    ["403", { [`${ORIGIN}/robots.txt`]: "", [GALXE]: 403 }, /403/],
    ["429", { [`${ORIGIN}/robots.txt`]: "", [GALXE]: 429 }, /429/],
  ])("%s なら取得を中止し、取得なしで登録して警告", async (_n, routes, re) => {
    mkCtx();
    const site = mockSite(routes as Record<string, string | number>);
    const r = await addQuest(ctx, { url: GALXE }, { fetch: true, fetchImpl: site.fetch });
    expect(r.created).toBe(true);
    expect(r.campaign.conditions.terms).toBeUndefined();
    expect(r.warnings.join()).toMatch(re);
    expect(site.requested.filter((u) => u === GALXE).length).toBeLessThanOrEqual(1);
  });

  it("--fetch なしでは通信しない", async () => {
    mkCtx();
    const site = mockSite({});
    await addQuest(ctx, { url: GALXE }, { fetchImpl: site.fetch });
    expect(site.requested).toEqual([]);
  });

  it("extractQuestPageInfo: og:title がなければ <title>", () => {
    expect(extractQuestPageInfo("<html><head><title> A &amp; B </title></head><body>x</body></html>")).toEqual({ title: "A & B", description: null, text: "x" });
  });
});

describe("todo の安全注意", () => {
  it("crypto_quest の手順の先頭に固定の注意、requiresOnchainTx ならガス代", async () => {
    mkCtx();
    const a = await addQuest(ctx, { url: GALXE, title: "Q1", rewardValueJpy: 1000, distribution: "all", requiresOnchainTx: true, gasCostJpy: 120, deadline: "2026-11-30" });
    await addQuest(ctx, { url: "https://zealy.io/cw/sweep/q", title: "Q2", rewardType: "points", deadline: "2026-12-30" });
    const t = todo(ctx);
    expect(t.map((i) => i.campaign.title)).toEqual(["Q1", "Q2"]);
    expect(t[0]!.steps.slice(0, 3)).toEqual([...CRYPTO_SAFETY_NOTES]);
    expect(t[0]!.steps.join("\n")).toMatch(/懸賞専用/);
    expect(t[0]!.steps.join("\n")).toMatch(/シードフレーズ.*絶対に入力しない/);
    expect(t[0]!.steps.join("\n")).toMatch(/approve.*無制限承認.*拒否/);
    expect(t[0]!.steps[3]).toMatch(/ガス代.*120 円/);
    expect(t[0]!.questMetrics?.netValueJpy).toBe(880);
    expect(t[1]!.steps.some((s) => s.includes("ガス代"))).toBe(false);
    mark(ctx, a.campaign.id);
    expect(todo(ctx).map((i) => i.campaign.title)).toEqual(["Q2"]);
  });

  it("ガス代不明なら不明と表示、X には注意を付けない", () => {
    const steps = formatSteps({ kind: "crypto_quest", url: GALXE, conditions: { quest: meta({ requiresOnchainTx: true }) } });
    expect(steps[3]).toMatch(/ガス代不明/);
    expect(formatSteps({ kind: "x", url: "https://x.com/a", conditions: {} })).toEqual(["https://x.com/a を開いて応募条件を確認する"]);
  });
});

describe("listQuests / sortQuests", () => {
  it("時給順、価値不明は末尾、除外はその後", async () => {
    mkCtx(150);
    await addQuest(ctx, { url: "https://zealy.io/q/unknown", title: "unknown", rewardType: "points" });
    await addQuest(ctx, { url: "https://zealy.io/q/low", title: "low", rewardValueJpy: 100, distribution: "all", estMinutes: 10 });
    await addQuest(ctx, { url: "https://zealy.io/q/high", title: "high", rewardValueJpy: 1000, distribution: "all", estMinutes: 10 });
    await addQuest(ctx, { url: "https://zealy.io/q/scam", title: "scam", rewardValueJpy: 99999, distribution: "all", notes: "秘密鍵を入力" });
    await addQuest(ctx, { url: "https://zealy.io/q/loss", title: "loss", rewardValueJpy: 100, gasCostJpy: 500, distribution: "all", estMinutes: 10 });
    expect(listQuests(ctx).map((i) => i.campaign.title)).toEqual(["high", "low", "loss", "unknown", "scam"]);
    expect(sortQuests([])).toEqual([]);
  });
});

describe("CLI 引数パース", () => {
  it("quest add", () => {
    const r = parseQuestAddArgs([
      GALXE, "--title", "T", "--reward-type", "stablecoin", "--amount", "1,000", "--currency", "usdc", "--winners", "10",
      "--participants", "200", "--distribution", "fcfs", "--minutes", "7.5", "--deadline", "2026-12-01", "--onchain", "--gas-jpy", "50", "--notes", "n", "--fetch",
    ]);
    expect(r).toEqual({
      fetch: true,
      input: {
        url: GALXE, title: "T", rewardType: "stablecoin", rewardAmount: 1000, rewardCurrency: "usdc", winners: 10, participants: 200,
        distribution: "fcfs", estMinutes: 7.5, deadline: "2026-12-01", requiresOnchainTx: true, gasCostJpy: 50, notes: "n",
      },
    });
    expect(parseQuestAddArgs([GALXE, "--value-jpy", "300"])).toEqual({ fetch: false, input: { url: GALXE, rewardValueJpy: 300 } });
  });

  it("quest add のエラー", () => {
    expect(() => parseQuestAddArgs([])).toThrow(/URL/);
    expect(() => parseQuestAddArgs([GALXE, "--reward-type", "cash"])).toThrow(/reward-type/);
    expect(() => parseQuestAddArgs([GALXE, "--distribution", "lottery"])).toThrow(/distribution/);
    expect(() => parseQuestAddArgs([GALXE, "--winners", "1.5"])).toThrow(/整数/);
    expect(() => parseQuestAddArgs([GALXE, "--amount=-1"])).toThrow(/0 以上/);
    expect(() => parseQuestAddArgs([GALXE, "--unknown-opt"])).toThrow();
    expect(() => parseQuestAddArgs([GALXE, "--clear", "notes"])).toThrow(/update/);
  });

  it("quest update (--no-onchain / --clear)", () => {
    expect(parseQuestUpdateArgs(["3", "--no-onchain", "--participants", "800", "--clear", "gas-jpy,notes"])).toEqual({
      id: 3,
      patch: { requiresOnchainTx: false, participants: 800, gasCostJpy: null, notes: null },
    });
    expect(() => parseQuestUpdateArgs(["x", "--winners", "1"])).toThrow(/ID/);
    expect(() => parseQuestUpdateArgs(["3"])).toThrow(/変更する項目/);
    expect(() => parseQuestUpdateArgs(["3", "--clear", "url"])).toThrow(/--clear/);
    expect(() => parseQuestUpdateArgs(["3", "--notes", "a", "--clear", "notes"])).toThrow(/同時/);
    expect(() => parseQuestUpdateArgs(["3", "--fetch"])).toThrow(/add/);
  });

  it("runQuestCommand: add → update → list の出力", async () => {
    mkCtx(150);
    const out: string[] = [];
    const log = (s: string) => void out.push(s);
    expect(await runQuestCommand(ctx, ["add", GALXE, "--title", "CLI Quest", "--reward-type", "stablecoin", "--amount", "10", "--currency", "USDC", "--distribution", "all", "--minutes", "5"], log)).toBe(0);
    expect(out.join("\n")).toMatch(/#1 を登録しました: CLI Quest/);
    expect(out.join("\n")).toMatch(/期待値: 1,500円 \/ 時給: 18,000円\/時/);
    expect(await runQuestCommand(ctx, ["update", "1", "--gas-jpy", "500", "--onchain"], log)).toBe(0);
    expect(out.join("\n")).toMatch(/− ガス 500円 = 1,000円/);
    await runQuestCommand(ctx, ["add", "https://zealy.io/q/p", "--reward-type", "nft"], log);
    out.length = 0;
    expect(await runQuestCommand(ctx, ["list"], log)).toBe(0);
    expect(out[0]).toMatch(/#1/);
    expect(out.join("\n")).toMatch(/期待値: 価値不明/);
    expect(await runQuestCommand(ctx, ["bogus"], log)).toBe(1);
  });
});
