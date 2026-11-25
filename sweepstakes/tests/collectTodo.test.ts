import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureHtmlCollector, parseCampaignListHtml } from "../src/core/collector.js";
import { normalizeUrl } from "../src/core/db.js";
import { collect, history, listCampaigns, mark, todo, type SweepContext } from "../src/core/service.js";
import { buildTodoList, formatSteps } from "../src/core/todo.js";
import { makeTestContext } from "./helpers/context.js";

const LIST = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "campaign_list.html");
const NOW = new Date("2026-11-21T09:00:00+09:00");

let ctx: SweepContext;
afterEach(() => ctx?.store.close());

describe("parseCampaignListHtml", () => {
  it("合成 HTML からキャンペーンを読み取る", async () => {
    const items = await new FixtureHtmlCollector(LIST, "fixture").fetch();
    expect(items).toHaveLength(6);
    const x = items.find((i) => i.kind === "x")!;
    expect(x).toMatchObject({ title: "フォロー&RTで合成グッズが当たる", prizeValueJpy: 10000, winners: 5, participants: 20000, estMinutes: 1 });
    expect(x.conditions.steps).toEqual([
      { action: "follow", target: "@sweep_example" },
      { action: "repost", target: "https://x.com/sweep_example/status/1" },
    ]);
  });

  it("class=campaign 以外の article は無視", () => {
    expect(parseCampaignListHtml('<article class="news"><a href="https://a.example">x</a></article>', "t")).toEqual([]);
  });
});

describe("normalizeUrl", () => {
  it("utm_* とフラグメント、末尾スラッシュを除去", () => {
    expect(normalizeUrl("https://A.example/p/?utm_source=x&id=1#top")).toBe("https://a.example/p?id=1");
  });
});

describe("collect → list → todo → mark → history", () => {
  it("一連の流れ", async () => {
    ctx = makeTestContext({}, { now: () => NOW });
    const s = await collect(ctx, [new FixtureHtmlCollector(LIST, "fixture")]);
    expect(s).toMatchObject({ total: 6, added: 6, updated: 0, excluded: 1, expired: 1 });

    // 再収集しても URL で重複排除される
    const s2 = await collect(ctx, [new FixtureHtmlCollector(LIST, "fixture")]);
    expect(s2).toMatchObject({ added: 0, updated: 6 });
    expect(listCampaigns(ctx)).toHaveLength(6);
    expect(listCampaigns(ctx, { kind: "crypto_quest" })).toHaveLength(2);

    const scam = listCampaigns(ctx, { kind: "crypto_quest" }).find((c) => c.url.includes("uniswap-airdrop"))!;
    expect(scam.status).toBe("excluded");
    expect(scam.riskFlags).toEqual(expect.arrayContaining(["typosquat_domain", "seed_phrase_request", "approval_request"]));

    const t = todo(ctx);
    // web_form・除外・締切切れは含まない。締切が近い順 (crypto 10/31 → instagram 11/30 → x 12/01)
    expect(t.map((i) => i.campaign.kind)).toEqual(["crypto_quest", "instagram", "x"]);
    expect(t[1]!.steps).toEqual([
      "@sweep.example をフォローする",
      "投稿 https://www.instagram.com/p/sweep-example/ にいいねする",
      "投稿 https://www.instagram.com/p/sweep-example/ にコメントする: 「欲しい！」",
    ]);
    expect(t[0]!.steps.at(-1)).toMatch(/シードフレーズ入力は拒否/);

    mark(ctx, t[0]!.campaign.id);
    expect(todo(ctx).map((i) => i.campaign.kind)).toEqual(["instagram", "x"]);
    const h = history(ctx);
    expect(h[0]).toMatchObject({ status: "done_manual", campaignId: t[0]!.campaign.id });
    expect(() => mark(ctx, 9999)).toThrow(/見つかりません/);
  });
});

describe("buildTodoList の並び順", () => {
  it("同じ日の締切ならスコアの高い順", () => {
    const mk = (id: number, deadline: string | null, score: number) => ({
      id,
      kind: "x" as const,
      source: "t",
      title: `#${id}`,
      url: `https://x.com/${id}`,
      prize: "",
      deadline,
      conditions: {},
      riskFlags: [],
      score,
      status: "active" as const,
      createdAt: "",
      updatedAt: "",
    });
    const list = buildTodoList([mk(1, null, 100), mk(2, "2026-11-25", 1), mk(3, "2026-11-25", 5), mk(4, "2026-11-22", 0)], [], NOW);
    expect(list.map((i) => i.campaign.id)).toEqual([4, 3, 2, 1]);
  });

  it("手順がなければ URL を確認するよう促す", () => {
    expect(formatSteps({ kind: "x", conditions: {}, url: "https://x.com/a" })).toEqual(["https://x.com/a を開いて応募条件を確認する"]);
  });
});
