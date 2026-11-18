import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { formatDiscoverySummary, resolveForeignKeywords, runDiscovery, type DiscoveryDeps } from "@/lib/discovery/run";
import type { FetchedPage } from "@/lib/scraper/types";
import { FakeDiscoveryStore, FakeFetcher, fakeProvider, makeWatch } from "./helpers/fakeDiscovery";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const PAGES = { alibaba: fixture("search-alibaba.html"), aliexpress: fixture("search-aliexpress.html"), "1688": fixture("search-1688.html") };
const CAPTCHA = '<html><body><div id="nc_1_n1z">slide to verify</div></body></html>';

function siteOf(url: string): keyof typeof PAGES {
  const h = new URL(url).hostname;
  return h.endsWith("aliexpress.com") ? "aliexpress" : h.endsWith("1688.com") ? "1688" : "alibaba";
}
const okPages = (override: Partial<Record<keyof typeof PAGES, FetchedPage | Error>> = {}) => (url: string) =>
  override[siteOf(url)] ?? { finalUrl: url, status: 200, html: PAGES[siteOf(url)] };

/** 国内の販売例 (採用価格 = 下位 25% 点 = 1,600 円) */
const DOMESTIC = [1500, 1600, 1700, 1800, 1900];

function setup(opts: { pages?: (url: string) => FetchedPage | Error; prices?: number[] | Error; configured?: boolean } = {}) {
  const store = new FakeDiscoveryStore();
  store.watches = [makeWatch()];
  const fetcher = new FakeFetcher(opts.pages ?? okPages());
  const provider = fakeProvider(opts.prices ?? DOMESTIC, opts.configured ?? true);
  const sleep = vi.fn(async () => {});
  const deps: DiscoveryDeps = {
    store,
    getFetcher: async () => fetcher,
    providers: [provider],
    now: () => new Date("2026-11-18T00:00:00Z"),
    sleep,
    delayMs: () => 1234,
  };
  return { store, fetcher, provider, sleep, deps };
}

describe("自動探索の実行 runDiscovery (偽の取得・取得元・DB)", () => {
  it("各サイトの検索結果 1 ページを間隔を空けて取得し、判定・保存・自動追加・通知 (1 回) を行う", async () => {
    const { store, fetcher, provider, sleep, deps } = setup();
    const s = await runDiscovery({}, deps);

    expect(fetcher.calls).toEqual([
      "https://www.alibaba.com/trade/search?SearchText=silicone+spatula",
      "https://www.aliexpress.com/w/wholesale-silicone-spatula.html?SearchText=silicone+spatula",
      "https://s.1688.com/selloffer/offer_search.htm?keywords=%B9%E8%BD%BA%B2%F9",
    ]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1234);
    // 上限を超えた場合は ROI の低いものが残る (ROI の高い順に自動追加)
    const left = [...store.items.values()].filter((i) => i.status === "QUALIFIED");
    expect(left).toHaveLength(1);
    const addedRois = [...store.items.values()].filter((i) => i.status === "AUTO_ADDED").map((i) => Number(i.estRoiPercent));
    expect(Math.min(...addedRois)).toBeGreaterThan(Number(left[0].estRoiPercent));
    expect(provider.calls).toEqual(["シリコン ヘラ"]);
    expect(store.claimed).toEqual(["w1"]);

    expect(store.items.size).toBe(7);
    expect(store.statusOf("w1", "ALIBABA", "1600333333333")).toBe("ERROR");
    const added = [...store.items.values()].filter((i) => i.status === "AUTO_ADDED");
    expect(added.length).toBeGreaterThan(0);
    expect(added.length).toBeLessThanOrEqual(5);
    for (const a of added) {
      expect(a.productId).toBeTruthy();
      expect(a.domesticPriceJpy).toBe("1600");
      expect(Number(a.estRoiPercent)).toBeGreaterThanOrEqual(30);
      expect(a.domesticEvidence).toMatchObject({ providerLabel: "テスト市場", sampleCount: 5, usedCount: 5, adoptedJpy: "1600", medianJpy: "1700", basis: "lower-quartile", cached: false });
    }
    expect([...store.products.values()].every((p) => p.action === "discovery.auto_add" && p.domesticPriceJpy === "1600")).toBe(true);
    expect(s.autoAddedTotal).toBe(added.length);

    expect(store.notifications).toHaveLength(1);
    expect(store.notifications[0]).toMatchObject({ title: `自動探索: ${added.length} 件を仕入れ候補に追加しました`, link: "/discover" });
    expect(store.finished).toEqual([{ id: "w1", status: "OK", note: expect.stringContaining("国内価格: テスト市場 ¥1,600") }]);
    expect(formatDiscoverySummary(s)).toContain("自動探索 [シリコンヘラ] OK");
  });

  it("再実行: 除外した結果は復活させず、追加済みもそのまま。国内価格はキャッシュを使い、商品は重複登録しない", async () => {
    const { store, provider, deps } = setup();
    await runDiscovery({}, deps);
    // 上限 (5 件) で追加されなかった条件達成の 1 件を除外する → 再実行でも自動追加されない
    const dismissedKey = [...store.items.entries()].find(([, v]) => v.status === "QUALIFIED")![0];
    const d = store.items.get(dismissedKey)!;
    store.items.set(dismissedKey, { ...d, status: "DISMISSED", statusNote: "除外しました", productId: null });
    const productsBefore = store.products.size;
    const autoBefore = [...store.items.entries()].filter(([, v]) => v.status === "AUTO_ADDED").map(([k]) => k);

    store.watches[0].lastRunAt = null; // 連打防止の判定を外す
    const later = new Date("2026-11-18T05:00:00Z");
    const s2 = await runDiscovery({}, { ...deps, now: () => later });

    expect(store.items.get(dismissedKey)!.status).toBe("DISMISSED");
    expect(store.items.get(dismissedKey)!.seenAt).toEqual(later);
    for (const k of autoBefore) expect(store.items.get(k)!.status).toBe("AUTO_ADDED");
    expect(store.products.size).toBe(productsBefore);
    expect(provider.calls).toHaveLength(1); // 24 時間キャッシュ
    expect(store.items.get(autoBefore[0])!.domesticEvidence).toMatchObject({ cached: true });
    expect(s2.autoAddedTotal).toBe(0);
  });

  it("登録済みの商品は DUPLICATE にして自動追加しない", async () => {
    const { store, deps } = setup();
    store.products.set("existing", { id: "existing", platform: "ALI1688", externalId: "712345678901", url: "x", action: "product.import", domesticPriceJpy: null });
    await runDiscovery({}, deps);
    const it = store.items.get(store.key("w1", "ALI1688", "712345678901"))!;
    expect(it.status).toBe("DUPLICATE");
    expect(it.productId).toBe("existing");
  });

  it("1 回の自動追加の上限を守り、超過分は QUALIFIED のまま理由を残す", async () => {
    const { store, deps } = setup();
    store.watches = [makeWatch({ maxAutoAddPerRun: 1, minRoiPercent: "0" })];
    const s = await runDiscovery({}, deps);
    const all = [...store.items.values()];
    expect(all.filter((i) => i.status === "AUTO_ADDED")).toHaveLength(1);
    const q = all.filter((i) => i.status === "QUALIFIED");
    expect(q.length).toBeGreaterThan(0);
    expect(q[0].statusNote).toContain("上限 1 件");
    expect(s.qualifiedTotal).toBe(q.length);
    expect(store.notifications).toHaveLength(1);
  });

  it("自動追加オフなら追加せず QUALIFIED。条件未達は理由付きで BELOW_THRESHOLD", async () => {
    const { store, deps } = setup();
    store.watches = [makeWatch({ autoAdd: false, minRoiPercent: "0", maxMoq: 100 })];
    await runDiscovery({}, deps);
    expect(store.products.size).toBe(0);
    expect(store.statusOf("w1", "ALIBABA", "1600111111111")).toBe("BELOW_THRESHOLD"); // MOQ 1000
    expect(store.items.get(store.key("w1", "ALIBABA", "1600111111111"))!.statusNote).toContain("MOQ 1000 > 100");
    expect(store.statusOf("w1", "ALI1688", "712345678901")).toBe("QUALIFIED");
    expect(store.notifications[0].title).toContain("条件を満たす商品が");
  });

  it("CAPTCHA を検知したらそのプラットフォームを停止し (自動突破しない)、他のサイトは続ける。同じ実行の他の条件でも検索しない", async () => {
    const { store, fetcher, deps } = setup({ pages: okPages({ aliexpress: { finalUrl: "https://www.aliexpress.com/punish?x5secdata=1", status: 200, html: CAPTCHA } }) });
    store.watches = [makeWatch(), makeWatch({ id: "w2", name: "2 件目" })];
    const s = await runDiscovery({}, deps);
    expect(store.pauses).toEqual([{ platform: "ALIEXPRESS", kind: "captcha", url: "https://www.aliexpress.com/punish?x5secdata=1" }]);
    expect(fetcher.calls.filter((u) => u.includes("aliexpress"))).toHaveLength(1);
    expect(fetcher.calls).toHaveLength(5); // w1: 3 回, w2: AliExpress 以外の 2 回
    expect(s.blocked).toEqual(["ALIEXPRESS"]);
    expect(store.finished.map((f) => f.status)).toEqual(["PARTIAL", "PARTIAL"]);
    expect(store.finished[0].note).toContain("CAPTCHAを検知したため巡回を停止しました");
    expect([...store.items.keys()].some((k) => k.includes("ALIEXPRESS"))).toBe(false);
  });

  it("停止中のプラットフォームは検索しない", async () => {
    const { store, fetcher, deps } = setup();
    store.paused.add("ALIBABA");
    await runDiscovery({}, deps);
    expect(fetcher.calls.some((u) => u.includes("alibaba.com"))).toBe(false);
    expect(store.finished[0].note).toContain("巡回停止中");
  });

  it("取得失敗・HTTP エラー・読み取れないページは理由を残して続ける", async () => {
    const { store, deps } = setup({
      pages: okPages({ alibaba: new Error("fetch failed"), aliexpress: { finalUrl: "https://www.aliexpress.com/x", status: 503, html: "" }, "1688": { finalUrl: "https://s.1688.com/x", status: 200, html: "<html>empty</html>" } }),
    });
    const s = await runDiscovery({}, deps);
    expect(s.watches[0].status).toBe("FAILED");
    expect(store.finished[0].note).toMatch(/取得できませんでした \(fetch failed\)[\s\S]*HTTP 503[\s\S]*読み取れませんでした/);
    expect(store.notifications).toHaveLength(0);
  });

  it("実行時間の予算切れで残りの取得・条件を打ち切る", async () => {
    const { store, fetcher, deps } = setup();
    store.watches = [makeWatch(), makeWatch({ id: "w2", name: "2 件目" })];
    let n = 0;
    const s = await runDiscovery({}, { ...deps, shouldStop: () => fetcher.calls.length >= 1 && ++n > 0 });
    expect(fetcher.calls).toHaveLength(1);
    expect(s.stoppedByBudget).toBe(true);
    expect(s.watches.map((w) => w.status)).toEqual(["PARTIAL", "SKIPPED"]);
    expect(store.finished[0].note).toContain("時間切れ");
  });

  it("国内価格の取得元が未設定・エラーなら NO_DOMESTIC_PRICE (自動追加しない)", async () => {
    for (const opts of [{ configured: false }, { prices: new Error("楽天 API の認証に失敗しました") }, { prices: [1000, 1100] }]) {
      const { store, deps } = setup(opts);
      await runDiscovery({}, deps);
      const statuses = new Set([...store.items.values()].map((i) => i.status));
      expect([...statuses].sort()).toEqual(["ERROR", "NO_DOMESTIC_PRICE"]);
      expect(store.products.size).toBe(0);
      expect(store.notifications).toHaveLength(0);
    }
    const { store, deps } = setup({ prices: new Error("楽天 API の認証に失敗しました") });
    await runDiscovery({}, deps);
    expect(store.items.get(store.key("w1", "ALI1688", "712345678901"))!.statusNote).toBe("テスト市場: 楽天 API の認証に失敗しました");
  });

  it("定期実行では直近に実行した条件を飛ばす (claimed 指定時は飛ばさない)", async () => {
    const { store, fetcher, deps } = setup();
    store.watches[0].lastRunAt = new Date("2026-11-17T23:50:00Z");
    const s = await runDiscovery({}, deps);
    expect(s.watches[0]).toMatchObject({ status: "SKIPPED" });
    expect(fetcher.calls).toHaveLength(0);
    await runDiscovery({ watchId: "w1", claimed: true }, deps);
    expect(fetcher.calls).toHaveLength(3);
  });

  it("商品登録に失敗しても止めず QUALIFIED として理由を残す", async () => {
    const { store, deps } = setup();
    store.failCreate = true;
    const s = await runDiscovery({}, deps);
    const q = [...store.items.values()].filter((i) => i.status === "QUALIFIED");
    expect(q.length).toBeGreaterThan(0);
    expect(q[0].statusNote).toContain("自動追加に失敗: db down");
    expect(s.autoAddedTotal).toBe(0);
  });

  it("AI による国内の販売例の絞り込み (任意)", async () => {
    const { store, deps } = setup({ prices: [1500, 1600, 1700, 1800, 1900, 300] });
    const filterTitles = vi.fn(async (_kw: string, titles: string[]) => titles.map((_, i) => i).filter((i) => i !== 5));
    await runDiscovery({}, { ...deps, filterTitles });
    expect(filterTitles).toHaveBeenCalledTimes(1);
    const any = [...store.items.values()][0];
    expect(any.domesticEvidence).toMatchObject({ aiFilter: { before: 6, after: 5 }, usedCount: 5 });
  });
});

describe("検索キーワードの決定", () => {
  const w = { keywordJa: "シリコン ヘラ", foreignKeywords: { ALIBABA: "spatula" }, autoKeywords: null };

  it("指定があればそれを使い、無ければ翻訳 (言語ごとに 1 回) して保存する", async () => {
    const translate = vi.fn(async (_kw: string, to: "en" | "zh") => ({ text: to === "zh" ? "硅胶铲" : "silicone spatula", stub: false }));
    const r = await resolveForeignKeywords(w, ["ALIBABA", "ALIEXPRESS", "ALI1688"], translate);
    expect(r.keywords).toEqual({ ALIBABA: { text: "spatula", note: null }, ALIEXPRESS: { text: "silicone spatula", note: null }, ALI1688: { text: "硅胶铲", note: null } });
    expect(translate).toHaveBeenCalledTimes(2);
    expect(r.changed).toBe(true);
    // 保存した翻訳は次回再利用 (日本語キーワードが同じ間)
    const again = vi.fn();
    const r2 = await resolveForeignKeywords({ ...w, autoKeywords: r.autoKeywords }, ["ALIEXPRESS", "ALI1688"], again);
    expect(again).not.toHaveBeenCalled();
    expect(r2.keywords.ALI1688?.text).toBe("硅胶铲");
    // 日本語キーワードを変えたら翻訳し直す
    await resolveForeignKeywords({ ...w, keywordJa: "別の商品", autoKeywords: r.autoKeywords }, ["ALI1688"], translate);
    expect(translate).toHaveBeenCalledTimes(3);
  });

  it("API キー未設定 (スタブ) や失敗時は日本語のまま検索し、理由を残す", async () => {
    const stub = await resolveForeignKeywords(w, ["ALIEXPRESS"], async (kw) => ({ text: kw, stub: true }));
    expect(stub.keywords.ALIEXPRESS).toEqual({ text: "シリコン ヘラ", note: expect.stringContaining("ANTHROPIC_API_KEY 未設定") });
    expect(stub.changed).toBe(false);
    const fail = await resolveForeignKeywords(w, ["ALI1688"], async () => Promise.reject(new Error("overloaded")));
    expect(fail.keywords.ALI1688).toEqual({ text: "シリコン ヘラ", note: expect.stringContaining("翻訳に失敗") });
  });
});
