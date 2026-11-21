import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  FetchBlockedError,
  isAllowedByRobots,
  parseRobotsTxt,
  PoliteFetcher,
  RobotsDisallowedError,
  type FetchLike,
} from "../src/collectors/http.js";
import {
  decideKouboKind,
  KouboCollector,
  parseKouboDetail,
  parseKouboList,
  parseListDeadline,
  resolveStreamedSegments,
  toCampaignInput,
} from "../src/collectors/koubo.js";
import { findAutomationBan } from "../src/core/guards.js";
import { collectFromSources, enter, listCampaigns, type SweepContext } from "../src/core/service.js";
import { makeTestContext } from "./helpers/context.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "koubo");
const LIST_HTML = readFileSync(join(FIX, "present_all.html"), "utf8");
const DETAIL_HTML = readFileSync(join(FIX, "detail_402340.html"), "utf8");
const BASE = "https://koubo.jp";
const ALL_URL = `${BASE}/category/present/all`;
const FOOD_URL = `${BASE}/category/present/food`;
const PET_URL = `${BASE}/category/present/pet`;
// サブカテゴリページ (food) の代わり: カード 1 件は all と重複、1 件は新規
const FOOD_HTML = `<main>
<a href="/contest/402340"><div><div><div><span>クイズ</span><span>食品</span><span>11/30 締切</span></div><div><div><h4> KURU KURAお散歩クイズ</h4></div></div></div></div></a>
<a href="/contest/400001"><div><div><div><span>食品</span><span>12/9 締切</span></div><div><div><h4>合成テスト用 食品プレゼント</h4></div></div></div><div></div><div><div></div><div>合成テスト賞品</div></div></div></a>
</main>`;
const ALLOW_ALL = "User-agent: *\nAllow: /\n";
// 実際の koubo.jp/robots.txt の構造 (Cloudflare 管理部分の後に別の User-Agent: * グループがある) を簡略化したもの
const KOUBO_LIKE_ROBOTS = `User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

User-agent: ClaudeBot
Disallow: /

User-Agent: *
Disallow: /contest/list?*
Disallow: /article/list?*

Sitemap: https://koubo.jp/sitemap/index.xml
`;

/** 詳細フィクスチャ (402340) を書き換えて別パターンを作る */
function detailVariant(
  opts: { method?: string; removeWebTag?: boolean; noOrganizerSite?: boolean; organizerUrl?: string; deadline?: string; extraTerms?: string } = {},
): string {
  let h = DETAIL_HTML;
  if (opts.organizerUrl) h = h.replace(/<a\b([^>]*)href="https:\/\/kurukura\.jp\/campaign\/#goog_rewarded"([^>]*)><span/g, `<a$1href="${opts.organizerUrl}"$2><span`);
  if (opts.method) h = h.replace(">主催者サイトの応募フォーム</dd>", `>${opts.method}</dd>`);
  if (opts.removeWebTag) h = h.replace(">WEB応募可</a>", ">プレゼント</a>");
  if (opts.noOrganizerSite) h = h.replace(/<a\b[^>]*><span[^>]*>主催者サイト<\/span><\/a>/g, "");
  if (opts.deadline) h = h.replace(/2026年11月30日（月）<\/dd>/, `${opts.deadline}</dd>`);
  if (opts.extraTerms) h = h.replace("※ご応募は1人1回までです。", `※ご応募は1人1回までです。\n${opts.extraTerms}`);
  return h;
}

interface MockSite {
  fetch: FetchLike;
  requested: string[];
  headers: Record<string, string>[];
}

function mockSite(routes: Record<string, string | number>): MockSite {
  const requested: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetch: FetchLike = async (url, init) => {
    requested.push(url);
    headers.push(init?.headers ?? {});
    const r = routes[url];
    if (r === undefined) return { status: 404, ok: false, text: async () => "" };
    if (typeof r === "number") return { status: r, ok: r >= 200 && r < 300, text: async () => "" };
    return { status: 200, ok: true, text: async () => r };
  };
  return { fetch, requested, headers };
}

function defaultRoutes(): Record<string, string | number> {
  return {
    [`${BASE}/robots.txt`]: ALLOW_ALL,
    [ALL_URL]: LIST_HTML,
    [FOOD_URL]: FOOD_HTML,
    // PET_URL は 404 (その一覧だけ飛ばす)
    [`${BASE}/contest/402340`]: DETAIL_HTML,
    [`${BASE}/contest/402766`]: detailVariant({
      method: "X(旧Twitter)で公式アカウントをフォローし、対象投稿をリポスト",
      organizerUrl: "https://x.com/example/status/1",
      deadline: "2027年1月31日（日）",
    }),
    [`${BASE}/contest/402997`]: detailVariant({ deadline: "2026年11月23日（月）" }),
    [`${BASE}/contest/395119`]: detailVariant({ deadline: "2026年11月22日（日）" }),
    [`${BASE}/contest/409206`]: detailVariant({ method: "官製はがきに必要事項を記入して郵送", removeWebTag: true, deadline: "2026年11月25日（水）" }),
    [`${BASE}/contest/397323`]: detailVariant({ noOrganizerSite: true, deadline: "2027年1月12日（火）" }),
    [`${BASE}/contest/400001`]: detailVariant({ organizerUrl: "https://example.com/food-campaign", deadline: "2026年12月9日（水）" }),
  };
}

// 2026-11-24 時点: 402997 (11/23 締切)・395119 (11/22 締切) は締切切れ
const NOW = new Date("2026-11-24T10:00:00+09:00");
const LIST_PATHS = ["/category/present/all", "/category/present/food", "/category/present/pet"];

describe("parseKouboList (カテゴリページ)", () => {
  it("カードから id・タイトル・タグ・締切・応募方法・賞品を読み取り、同じ id は統合する", () => {
    const items = parseKouboList(LIST_HTML, { now: NOW });
    // /contest/list?c=13 (もっと見る) や /article/ へのリンクは含まない
    expect(items.map((i) => i.id)).toEqual(["402766", "402997", "395119", "402340", "409206", "397323"]);
    const quiz = items.find((i) => i.id === "402340")!;
    expect(quiz).toEqual({
      id: "402340",
      detailUrl: "https://koubo.jp/contest/402340",
      title: "KURU KURAお散歩クイズ",
      tags: ["クイズ", "食品"],
      keywords: ["WEB応募可"],
      deadline: "2026-11-30",
      prize: "アンド ザ フリット「MINI 12-PACK GIFT BOX」",
    });
    // 1 枠目 (賞品なし) と 2 枠目 (賞品あり) を統合
    expect(items[0]).toMatchObject({ title: "「フジッコ大感謝祭」Xフォロー＆リポストキャンペーン", tags: ["豪華賞品"], deadline: "2027-01-31", keywords: [], prize: "周年記念純金カード" });
    expect(items[2]).toMatchObject({ tags: ["金券・Amazonギフトカード・図書カード"], deadline: "2026-11-22", prize: "えらべるPay 1万円分" });
    // &#x27; などのエンティティを復号。投稿日 (2026/11/19) は賞品にしない
    expect(items[4]).toMatchObject({ title: "AGE20'S「11月プレゼントキャンペーン」", prize: "No.1美容液ファンデUVリップセット（豪華3点セット）" });
    expect(items[5]!.deadline).toBe("2027-01-12");
  });

  it("年のない締切は now の年 (180 日以上前なら翌年) とみなす", () => {
    expect(parseListDeadline("11/30 締切", NOW)).toBe("2026-11-30");
    expect(parseListDeadline("11/22 締切", NOW)).toBe("2026-11-22");
    expect(parseListDeadline("1/15 締切", NOW)).toBe("2027-01-15");
    expect(parseListDeadline("2027/1/31 締切", NOW)).toBe("2027-01-31");
    expect(parseListDeadline("2026/11/19", NOW)).toBeNull();
  });

  it("ストリーミング差し込みを解決する", () => {
    const html = '<dl><template id="P:a"></template></dl><div hidden id="S:a"><dd>賞品X</dd></div><script>$RS("S:a","P:a")</script>';
    expect(resolveStreamedSegments(html)).toContain("<dl><dd>賞品X</dd></dl>");
  });
});

describe("parseKouboDetail", () => {
  it("締切・主催者・賞・応募資格・主催者サイト・募集内容を読み取る", () => {
    const d = parseKouboDetail(DETAIL_HTML);
    expect(d).toMatchObject({
      title: "KURU KURAお散歩クイズ",
      deadline: "2026-11-30",
      organizer: "株式会社JAFメディアワークス",
      prize: "アンド ザ フリット「MINI 12-PACK GIFT BOX」",
      prizeDetail: "フレンチフライ専門店のドライフリット（12袋入り）を5名様にプレゼント",
      eligibility: "資格不問",
      organizerUrl: "https://kurukura.jp/campaign/#goog_rewarded",
      applyMethod: "主催者サイトの応募フォーム",
      keywords: ["WEB応募可"],
    });
    expect(d.content).toContain("【賞品について】");
    expect(d.summary).toContain("クイズに答えてプレゼントをゲットしよう");
    expect(d.fields.map((f) => f.label)).toEqual(expect.arrayContaining(["作品規定", "応募時の会員登録", "結果発表"]));
  });

  it("主催者サイトのリンクがなければ organizerUrl は null", () => {
    expect(parseKouboDetail(detailVariant({ noOrganizerSite: true })).organizerUrl).toBeNull();
  });
});

describe("decideKouboKind", () => {
  it.each([
    [{ applyMethod: "主催者サイトの応募フォーム" }, "web_form"],
    [{ applyMethod: "", keywords: ["WEB応募可"] }, "web_form"],
    [{ applyMethod: "X(旧Twitter)でフォロー＆リポスト" }, "x"],
    [{ applyMethod: "公式Twitterをフォローしてリツイート" }, "x"],
    [{ applyMethod: "Instagramで公式アカウントをフォローしていいね" }, "instagram"],
    [{ applyMethod: "官製はがきで応募" }, "postal_only"],
    [{ applyMethod: "レシートを貼って郵送" }, "postal_only"],
    [{ applyMethod: "はがき、またはWEBの応募フォーム" }, "web_form"],
    [{ applyMethod: "", title: "「フジッコ大感謝祭」Xフォロー＆リポストキャンペーン" }, "x"],
    [{ applyMethod: "主催者サイトの応募フォーム", url: "https://x.com/example/status/1" }, "x"],
    [{ applyMethod: "", url: "https://www.instagram.com/p/abc/" }, "instagram"],
    [{ applyMethod: "店頭で" }, "web_form"],
  ] as const)("%o → %s", (input, kind) => {
    expect(decideKouboKind(input)).toBe(kind);
  });
});

describe("toCampaignInput", () => {
  const item = parseKouboList(LIST_HTML, { now: NOW }).find((i) => i.id === "402340")!;

  it("主催者サイトを url に、掲載ページを sourceUrl に保存。タグ・募集内容も保持", () => {
    const c = toCampaignInput(item, parseKouboDetail(DETAIL_HTML))!;
    expect(c).toMatchObject({
      kind: "web_form",
      source: "koubo",
      title: "KURU KURAお散歩クイズ",
      url: "https://kurukura.jp/campaign/#goog_rewarded",
      deadline: "2026-11-30",
      winners: 5,
      prizeValueJpy: null,
    });
    expect(c.riskFlags).toBeUndefined();
    expect(c.conditions.sourceUrl).toBe("https://koubo.jp/contest/402340");
    expect(c.conditions.tags).toEqual(["クイズ", "食品", "WEB応募可"]);
    expect(c.conditions.terms).toContain("募集内容: 【賞品について】");
    expect(c.conditions.notes).toContain("主催者: 株式会社JAFメディアワークス");
  });

  it("主催者サイトが取れなければ掲載ページを url にして要確認フラグ", () => {
    const c = toCampaignInput(item, parseKouboDetail(detailVariant({ noOrganizerSite: true })))!;
    expect(c.url).toBe("https://koubo.jp/contest/402340");
    expect(c.riskFlags).toEqual(["entry_url_unverified"]);
  });

  it("はがき・郵送のみは収集しない", () => {
    // 一覧側にも「WEB応募可」が付いていない項目 (409206) で確認する
    const noWeb = parseKouboList(LIST_HTML, { now: NOW }).find((i) => i.id === "409206")!;
    expect(noWeb.keywords).toEqual([]);
    expect(toCampaignInput(noWeb, parseKouboDetail(detailVariant({ method: "官製はがきで応募", removeWebTag: true })))).toBeNull();
  });

  it("募集内容の自動応募禁止文が terms に入り、既存ガードに掛かる", () => {
    const c = toCampaignInput(item, parseKouboDetail(detailVariant({ extraTerms: "※自動応募ツールを使用した応募は無効とします。" })))!;
    expect(findAutomationBan(c.conditions.terms!)).toContain("自動応募ツール");
  });
});

describe("robots.txt", () => {
  it("同じ User-agent: * のグループを統合し、最長一致で判定する", () => {
    const r = parseRobotsTxt(KOUBO_LIKE_ROBOTS);
    expect(isAllowedByRobots(r, "/contest/list?c=13&p=0")).toBe(false);
    expect(isAllowedByRobots(r, "/contest/402340")).toBe(true);
    expect(isAllowedByRobots(r, "/category/present/all")).toBe(true);
    // 個別に拒否されているボットは全拒否
    expect(isAllowedByRobots(r, "/contest/402340", "ClaudeBot")).toBe(false);
  });

  it("$ による末尾一致と、同じ長さなら Allow 優先", () => {
    const r = parseRobotsTxt("User-agent: *\nDisallow: /*.pdf$\nDisallow: /a\nAllow: /a\n");
    expect(isAllowedByRobots(r, "/x/file.pdf")).toBe(false);
    expect(isAllowedByRobots(r, "/x/file.pdf?v=1")).toBe(true);
    expect(isAllowedByRobots(r, "/a")).toBe(true);
  });
});

describe("PoliteFetcher", () => {
  it("正直な User-Agent を送り、リクエスト間に 3〜6 秒 (注入した sleep) 待つ", async () => {
    const site = mockSite({ [`${BASE}/robots.txt`]: ALLOW_ALL, [`${BASE}/a`]: "A", [`${BASE}/b`]: "B" });
    const waits: number[] = [];
    const f = new PoliteFetcher({ fetch: site.fetch, sleep: async (ms) => void waits.push(ms), random: () => 0.5 });
    expect(await f.get(`${BASE}/a`)).toBe("A");
    expect(await f.get(`${BASE}/b`)).toBe("B");
    expect(site.requested).toEqual([`${BASE}/robots.txt`, `${BASE}/a`, `${BASE}/b`]);
    expect(waits).toEqual([4500, 4500]);
    expect(site.headers[1]!["User-Agent"]).toBe("sweepstakes-collector/0.1 (+personal use)");
  });

  it("robots.txt が 404 なら制限なし、5xx なら全拒否", async () => {
    const ok = new PoliteFetcher({ fetch: mockSite({ [`${BASE}/a`]: "A" }).fetch, sleep: async () => undefined });
    expect(await ok.get(`${BASE}/a`)).toBe("A");
    const ng = new PoliteFetcher({ fetch: mockSite({ [`${BASE}/robots.txt`]: 503, [`${BASE}/a`]: "A" }).fetch, sleep: async () => undefined });
    await expect(ng.get(`${BASE}/a`)).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it("429 を受けたら FetchBlockedError", async () => {
    const f = new PoliteFetcher({ fetch: mockSite({ [`${BASE}/robots.txt`]: ALLOW_ALL, [`${BASE}/a`]: 429 }).fetch, sleep: async () => undefined });
    await expect(f.get(`${BASE}/a`)).rejects.toBeInstanceOf(FetchBlockedError);
  });
});

describe("KouboCollector", () => {
  const instant = { sleep: async () => undefined, random: () => 0, now: () => NOW, listPaths: LIST_PATHS };

  it("既定の一覧は /category/present/all → 各サブカテゴリ (クエリ付き URL は使わない)", () => {
    const urls = new KouboCollector().listUrls();
    expect(urls[0]).toBe(ALL_URL);
    expect(urls).toHaveLength(10);
    expect(urls.every((u) => u.startsWith(`${BASE}/category/present/`) && !u.includes("?"))).toBe(true);
  });

  it("all → サブカテゴリの順に一覧を取得し、id で重複排除して詳細を取得・変換する", async () => {
    const site = mockSite(defaultRoutes());
    const waits: number[] = [];
    const col = new KouboCollector({ ...instant, sleep: async (ms) => void waits.push(ms), fetch: site.fetch });
    const items = await col.fetch();
    expect(items.map((i) => [i.conditions.sourceUrl, i.kind, i.deadline, i.url, i.riskFlags ?? []])).toEqual([
      ["https://koubo.jp/contest/402766", "x", "2027-01-31", "https://x.com/example/status/1", []],
      ["https://koubo.jp/contest/402340", "web_form", "2026-11-30", "https://kurukura.jp/campaign/#goog_rewarded", []],
      ["https://koubo.jp/contest/397323", "web_form", "2027-01-12", "https://koubo.jp/contest/397323", ["entry_url_unverified"]],
      ["https://koubo.jp/contest/400001", "web_form", "2026-12-09", "https://example.com/food-campaign", []],
    ]);
    // 一覧は all → food → pet (404 は飛ばす)。締切切れ (402997, 395119) は詳細を取りに行かない。402340 の詳細は 1 回だけ
    expect(site.requested.filter((u) => u.includes("/category/"))).toEqual([ALL_URL, FOOD_URL, PET_URL]);
    expect(site.requested).not.toContain(`${BASE}/contest/402997`);
    expect(site.requested).not.toContain(`${BASE}/contest/395119`);
    expect(site.requested.filter((u) => u === `${BASE}/contest/402340`)).toHaveLength(1);
    expect(site.requested.some((u) => u.includes("/contest/list"))).toBe(false);
    expect(col.lastStats).toMatchObject({ listPages: 2, listFailed: 1, listed: 7, expired: 2, postalOnly: 1, detailFetched: 5, returned: 4 });
    // 最初の robots.txt 以外は毎回 3 秒 (random=0 → 下限) 待つ
    expect(waits).toHaveLength(site.requested.length - 1);
    expect(waits.every((w) => w === 3000)).toBe(true);
  });

  it("詳細取得は maxDetails 件まで。上限に達したら残りのサブカテゴリも取りに行かない", async () => {
    const site = mockSite(defaultRoutes());
    const col = new KouboCollector({ ...instant, fetch: site.fetch, maxDetails: 1 });
    const items = await col.fetch();
    expect(items).toHaveLength(1);
    expect(site.requested.filter((u) => /\/contest\/\d+$/.test(u))).toEqual([`${BASE}/contest/402766`]);
    expect(site.requested).not.toContain(FOOD_URL);
  });

  it("403 を受けたらその回の収集を中止してエラー", async () => {
    const routes = defaultRoutes();
    routes[`${BASE}/contest/402340`] = 403;
    const site = mockSite(routes);
    const col = new KouboCollector({ ...instant, fetch: site.fetch });
    await expect(col.fetch()).rejects.toBeInstanceOf(FetchBlockedError);
    // 403 以降は何も取りに行かない
    expect(site.requested.at(-1)).toBe(`${BASE}/contest/402340`);
    expect(site.requested).not.toContain(`${BASE}/contest/409206`);
  });

  it("一覧で 429 を受けても中止", async () => {
    const routes = defaultRoutes();
    routes[FOOD_URL] = 429;
    const site = mockSite(routes);
    await expect(new KouboCollector({ ...instant, fetch: site.fetch }).fetch()).rejects.toBeInstanceOf(FetchBlockedError);
    expect(site.requested.at(-1)).toBe(FOOD_URL);
  });

  it("実際の koubo.jp と同じ robots.txt ではカテゴリページ・詳細ページは許可される", async () => {
    const routes = defaultRoutes();
    routes[`${BASE}/robots.txt`] = KOUBO_LIKE_ROBOTS;
    const items = await new KouboCollector({ ...instant, fetch: mockSite(routes).fetch }).fetch();
    expect(items).toHaveLength(4);
  });

  it("robots.txt で一覧が Disallow なら一覧も取得せずに中止", async () => {
    const routes = defaultRoutes();
    routes[`${BASE}/robots.txt`] = "User-agent: *\nDisallow: /category/\n";
    const site = mockSite(routes);
    const col = new KouboCollector({ ...instant, fetch: site.fetch });
    await expect(col.fetch()).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(site.requested).toEqual([`${BASE}/robots.txt`]);
  });
});

describe("collectFromSources (service)", () => {
  let ctx: SweepContext;
  afterEach(() => ctx?.store.close());

  it("収集して保存。要確認は enter で自動応募しない。再収集は URL で重複排除", async () => {
    const routes = defaultRoutes();
    ctx = makeTestContext({}, { now: () => NOW });
    const s = await collectFromSources(ctx, ["koubo"], { fetch: mockSite(routes).fetch, listPaths: LIST_PATHS });
    expect(s).toMatchObject({ total: 4, added: 4, errors: [] });
    const review = listCampaigns(ctx).find((c) => c.url === "https://koubo.jp/contest/397323")!;
    expect(review.riskFlags).toEqual(["entry_url_unverified"]);
    expect(review.conditions.sourceUrl).toBe("https://koubo.jp/contest/397323");
    const r = await enter(ctx, review.id, { submit: true });
    expect(r).toMatchObject({ status: "skipped", recorded: false });

    const s2 = await collectFromSources(ctx, ["koubo"], { fetch: mockSite(routes).fetch, listPaths: LIST_PATHS });
    expect(s2).toMatchObject({ added: 0, updated: 4 });
  });

  it("403 は errors に入る", async () => {
    const routes = defaultRoutes();
    routes[ALL_URL] = 403;
    ctx = makeTestContext({}, { now: () => NOW });
    const s = await collectFromSources(ctx, ["koubo"], { fetch: mockSite(routes).fetch });
    expect(s.total).toBe(0);
    expect(s.errors[0]).toMatch(/^koubo: .*403/);
  });
});
