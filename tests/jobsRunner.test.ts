import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "@prisma/client";
import { BROWSER_HEADERS, DisallowedUrlError, HTTP_MAX_REDIRECTS, TooManyRedirectsError, createHttpFetcher } from "@/lib/scraper/httpFetcher";
import {
  backoffMs,
  formatSummary,
  parseJobArgs,
  requestDelayMs,
  runPlatformQueue,
  runScheduledScrape,
  scrapeBudgetMinutes,
  scrapeWithRetry,
  selectDueProducts,
  shuffle,
  type DueCandidate,
  type RunnerDeps,
} from "@/lib/jobs/runner";
import type { ScrapeResult } from "@/lib/jobs/scrapeProduct";

/* ------------------------------------------------------------------ */
describe("HTTP 取得 (fetch をモック)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ブラウザ相当のヘッダーで取得し、リダイレクトは自前で追従して最終 URL を返す", async () => {
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      if (url === "https://a.aliexpress.com/_x") return new Response(null, { status: 302, headers: { location: "https://www.aliexpress.com/item/1005001234567890.html" } });
      return new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", mock);
    const page = await createHttpFetcher().fetch("https://a.aliexpress.com/_x");
    expect(page).toMatchObject({ finalUrl: "https://www.aliexpress.com/item/1005001234567890.html", status: 200, html: "<html>ok</html>" });
    expect(mock).toHaveBeenCalledTimes(2);
    const init = mock.mock.calls[0][1]!;
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Windows NT 10\.0.*Chrome\/\d+/);
    expect(headers["Accept-Language"]).toBe("ja,en;q=0.8,zh;q=0.6");
    expect(headers).toEqual(BROWSER_HEADERS);
  });

  it("エラーステータスも例外にせず返す (判定は呼び出し側)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
    const page = await createHttpFetcher().fetch("https://www.alibaba.com/product-detail/x_1600123456789.html");
    expect(page.status).toBe(403);
    expect(page.finalUrl).toBe("https://www.alibaba.com/product-detail/x_1600123456789.html");
  });

  it("タイムアウトで FetchTimeoutError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))),
      ),
    );
    await expect(createHttpFetcher({ timeoutMs: 20 }).fetch("https://detail.1688.com/offer/1.html")).rejects.toMatchObject({ name: "FetchTimeoutError" });
  });

  it("サイズ上限を超えた分は切り捨てて読み込みを止める", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        if (pulled > 100) return ctrl.close();
        ctrl.enqueue(new TextEncoder().encode("a".repeat(1000)));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));
    const page = await createHttpFetcher({ maxBytes: 2500 }).fetch("https://www.alibaba.com/product-detail/x_1600123456789.html");
    expect(page.html.length).toBe(2500);
    expect(page.truncated).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("相対パスの Location を解決して追従する", async () => {
    const mock = vi.fn(async (url: string) =>
      url.endsWith("/old.html")
        ? new Response(null, { status: 301, headers: { location: "/offer/123456789.html" } })
        : new Response("<html>moved</html>", { status: 200 }),
    );
    vi.stubGlobal("fetch", mock);
    const page = await createHttpFetcher().fetch("https://detail.1688.com/old.html");
    expect(page.finalUrl).toBe("https://detail.1688.com/offer/123456789.html");
    expect(mock.mock.calls.map((c) => c[0])).toEqual(["https://detail.1688.com/old.html", "https://detail.1688.com/offer/123456789.html"]);
  });

  it("ログイン画面へのリダイレクトは追従し、最終 URL でブロック検知できる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("https://detail.1688.com")
          ? new Response(null, { status: 302, headers: { location: "https://login.taobao.com/member/login.jhtml?redirect=x" } })
          : new Response("<html>login</html>", { status: 200 }),
      ),
    );
    const page = await createHttpFetcher().fetch("https://detail.1688.com/offer/123456789.html");
    expect(page.finalUrl).toMatch(/^https:\/\/login\.taobao\.com\//);
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/admin",
    "http://localhost/",
    "https://evil.example.com/",
    "file:///etc/passwd",
    "https://www.alibaba.com.evil.example/",
  ])("対応サイト外へのリダイレクト (%s) は追従せず DisallowedUrlError", async (target) => {
    const mock = vi.fn(async () => new Response(null, { status: 302, headers: { location: target } }));
    vi.stubGlobal("fetch", mock);
    await expect(createHttpFetcher().fetch("https://www.alibaba.com/product-detail/x_1600123456789.html")).rejects.toBeInstanceOf(DisallowedUrlError);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("最初の URL が対応サイト外なら一切アクセスしない", async () => {
    const mock = vi.fn(async () => new Response("x"));
    vi.stubGlobal("fetch", mock);
    await expect(createHttpFetcher().fetch("http://10.0.0.5/")).rejects.toBeInstanceOf(DisallowedUrlError);
    expect(mock).not.toHaveBeenCalled();
  });

  it(`リダイレクトは ${HTTP_MAX_REDIRECTS} 回まで (ループは TooManyRedirectsError)`, async () => {
    let n = 0;
    const mock = vi.fn(async () => new Response(null, { status: 302, headers: { location: `https://www.alibaba.com/r${++n}` } }));
    vi.stubGlobal("fetch", mock);
    await expect(createHttpFetcher().fetch("https://www.alibaba.com/start")).rejects.toBeInstanceOf(TooManyRedirectsError);
    expect(mock).toHaveBeenCalledTimes(HTTP_MAX_REDIRECTS + 1);
  });

  it("charset (GBK) を考慮してデコード", async () => {
    // "价格" の GBK バイト列
    const gbk = new Uint8Array([0xbc, 0xdb, 0xb8, 0xf1]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(gbk, { status: 200, headers: { "content-type": "text/html; charset=GBK" } })));
    const page = await createHttpFetcher().fetch("https://detail.1688.com/offer/1.html");
    expect(page.html).toBe("价格");
  });
});

/* ------------------------------------------------------------------ */
const NOW = new Date("2026-11-18T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const cand = (id: string, platform: Platform, last: Date | null, watch = true): DueCandidate => ({ id, platform, watch, lastFetchedAt: last });

describe("巡回対象の選択", () => {
  const products = [
    cand("a1", "ALIBABA", null),
    cand("a2", "ALIBABA", hoursAgo(7)),
    cand("a3", "ALIBABA", hoursAgo(1)), // 間隔未満
    cand("b1", "ALI1688", hoursAgo(24)),
    cand("c1", "ALIEXPRESS", hoursAgo(10)),
    cand("c2", "ALIEXPRESS", hoursAgo(10), false), // watch=false
    cand("o1", "OTHER", null), // 対象外
  ];

  it("watch・経過時間・停止中・OTHER を考慮してプラットフォーム別にまとめる", () => {
    const g = selectDueProducts(products, { now: NOW, minIntervalHours: 6, paused: new Set(["ALI1688"]), rand: () => 0 });
    expect([...g.keys()].sort()).toEqual(["ALIBABA", "ALIEXPRESS"]);
    expect(g.get("ALIBABA")!.map((p) => p.id).sort()).toEqual(["a1", "a2"]);
    expect(g.get("ALIEXPRESS")!.map((p) => p.id)).toEqual(["c1"]);
  });

  it("maxProducts で全体の件数を制限", () => {
    const g = selectDueProducts(products, { now: NOW, minIntervalHours: 6, paused: new Set(), maxProducts: 2 });
    expect([...g.values()].flat()).toHaveLength(2);
    const none = selectDueProducts(products, { now: NOW, minIntervalHours: 6, paused: new Set(), maxProducts: 0 });
    expect(none.size).toBe(0);
  });

  it("順序はランダム (シャッフル)", () => {
    const seq = [0.1, 0.9, 0.5, 0.3];
    let i = 0;
    const rand = () => seq[i++ % seq.length];
    const out = shuffle([1, 2, 3, 4, 5], rand);
    expect(out.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(shuffle([1, 2, 3, 4, 5], () => 0)).not.toEqual([1, 2, 3, 4, 5]);
  });

  it("待ち時間: 基本 3〜8 秒 + ジッター、バックオフは指数", () => {
    expect(requestDelayMs(10_000, () => 0)).toBe(3000);
    expect(requestDelayMs(10_000, () => 0.999)).toBe(3000 + 4995 + 9990);
    expect([0, 1, 2].map((a) => backoffMs(a, 1000))).toEqual([1000, 2000, 4000]);
  });

  it("CLI 引数", () => {
    expect(parseJobArgs([])).toEqual({ skipRecalc: false });
    expect(parseJobArgs(["--max-products", "20", "--skip-recalc"])).toEqual({ maxProducts: 20, skipRecalc: true });
    expect(parseJobArgs(["--max-products=5"])).toEqual({ maxProducts: 5, skipRecalc: false });
    expect(() => parseJobArgs(["--max-products", "x"])).toThrow();
  });
});

/* ------------------------------------------------------------------ */
const ok = (id: string): ScrapeResult => ({ status: "ok", productId: id, events: 0, auto: "OK", parsedFields: [], note: null });
const fail = (id: string, retryable: boolean): ScrapeResult => ({ status: "failed", productId: id, note: `fail ${id}`, retryable, parsedFields: [] });
const blocked = (id: string): ScrapeResult => ({ status: "blocked", productId: id, kind: "captcha", note: "CAPTCHA", paused: true });

function deps(scrape: RunnerDeps["scrape"]) {
  const sleeps: number[] = [];
  const d: RunnerDeps = { scrape, sleep: async (ms) => void sleeps.push(ms), delayMs: () => 5000, backoffMs: (a) => 1000 * 2 ** a, maxRetries: 2 };
  return { d, sleeps };
}

describe("巡回の実行", () => {
  it("一時的な障害は最大 2 回まで指数バックオフで再試行", async () => {
    const scrape = vi.fn(async (id: string) => fail(id, true));
    const { d, sleeps } = deps(scrape);
    const r = await scrapeWithRetry("p1", d);
    expect(r.attempts).toBe(3);
    expect(r.result.status).toBe("failed");
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("再試行で成功すればそこで終わる / 恒久的な失敗は再試行しない", async () => {
    let n = 0;
    const { d } = deps(async (id) => (n++ === 0 ? fail(id, true) : ok(id)));
    expect((await scrapeWithRetry("p1", d)).attempts).toBe(2);
    const permanent = vi.fn(async (id: string) => fail(id, false));
    expect((await scrapeWithRetry("p2", deps(permanent).d)).attempts).toBe(1);
  });

  it("想定外の例外も失敗として扱い、処理を続ける", async () => {
    const { d } = deps(async (id) => {
      if (id === "p1") throw new Error("boom");
      return ok(id);
    });
    const s = await runPlatformQueue("ALIBABA", ["p1", "p2"], d);
    expect(s).toMatchObject({ ok: 1, failed: 1, blocked: false });
  });

  it("ブロックされたらそのプラットフォームは打ち切り、間隔をあけて逐次処理", async () => {
    const calls: string[] = [];
    const { d, sleeps } = deps(async (id) => {
      calls.push(id);
      return id === "p2" ? blocked(id) : ok(id);
    });
    const s = await runPlatformQueue("ALI1688", ["p1", "p2", "p3", "p4"], d);
    expect(calls).toEqual(["p1", "p2"]);
    expect(s).toMatchObject({ total: 4, ok: 1, failed: 1, blocked: true, skipped: 2, blockNote: "CAPTCHA" });
    expect(sleeps).toEqual([5000]);
  });

  it("時間の予算を超えたら残りを取得せず、未処理件数をまとめに出す", async () => {
    const calls: string[] = [];
    let stop = false;
    const { d } = deps(async (id) => {
      calls.push(id);
      if (id === "p2") stop = true; // p2 の処理中に予算切れ
      return ok(id);
    });
    d.shouldStop = () => stop;
    const s = await runPlatformQueue("ALIBABA", ["p1", "p2", "p3", "p4"], d);
    expect(calls).toEqual(["p1", "p2"]);
    expect(s).toMatchObject({ total: 4, ok: 2, failed: 0, blocked: false, budgetSkipped: 2 });
    expect(formatSummary([s])).toContain("時間切れのため未処理 2 件");
  });

  it("予算切れなら一時的な障害でも再試行の待機をしない", async () => {
    const { d, sleeps } = deps(async (id) => fail(id, true));
    d.shouldStop = () => true;
    const r = await scrapeWithRetry("p1", d);
    expect(r.attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("JOBS_SCRAPE_BUDGET_MIN の解釈 (既定 18 分)", () => {
    expect(scrapeBudgetMinutes(undefined)).toBe(18);
    expect(scrapeBudgetMinutes("")).toBe(18);
    expect(scrapeBudgetMinutes("abc")).toBe(18);
    expect(scrapeBudgetMinutes("-1")).toBe(18);
    expect(scrapeBudgetMinutes("10")).toBe(10);
    expect(scrapeBudgetMinutes("0")).toBe(0);
  });

  it("プラットフォームごとに独立して処理 (片方のブロックは他方に影響しない)", async () => {
    const groups = new Map<Platform, DueCandidate[]>([
      ["ALIBABA", [cand("a1", "ALIBABA", null), cand("a2", "ALIBABA", null)]],
      ["ALIEXPRESS", [cand("c1", "ALIEXPRESS", null), cand("c2", "ALIEXPRESS", null)]],
    ]);
    const { d } = deps(async (id) => (id === "a1" ? blocked(id) : ok(id)));
    const out = await runScheduledScrape(groups, d);
    expect(out.find((s) => s.platform === "ALIBABA")).toMatchObject({ blocked: true, ok: 0, skipped: 1 });
    expect(out.find((s) => s.platform === "ALIEXPRESS")).toMatchObject({ blocked: false, ok: 2 });
    expect(formatSummary(out)).toContain("ALIEXPRESS: 2/2 件取得");
    expect(formatSummary([])).toBe("巡回対象の商品はありませんでした");
  });
});
