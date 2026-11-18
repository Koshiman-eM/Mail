import type { Platform } from "@prisma/client";
import { jitterMs } from "../scraper/policy";
import { isTransientError } from "./common";
import type { ScrapeResult } from "./scrapeProduct";

/**
 * 定期ジョブ (GitHub Actions 等で数時間ごとに 1 回起動) の巡回ロジック。
 * DB やブラウザに依存しない部分をここにまとめ、テスト可能にしている。
 */

export interface DueCandidate {
  id: string;
  platform: Platform;
  watch: boolean;
  lastFetchedAt: Date | null;
}

export interface SelectOptions {
  now: Date;
  minIntervalHours: number;
  paused: Set<Platform>;
  maxProducts?: number;
  rand?: () => number;
}

export function shuffle<T>(arr: T[], rand: () => number = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 巡回対象を選ぶ: watch=true・対応プラットフォーム・停止中でない・最終取得から minIntervalHours 以上経過 (未取得含む)。
 * ランダムな順序に並べ、maxProducts で全体の件数を制限したうえでプラットフォームごとにまとめる。
 */
export function selectDueProducts(products: DueCandidate[], opts: SelectOptions): Map<Platform, DueCandidate[]> {
  const threshold = opts.now.getTime() - opts.minIntervalHours * 3600_000;
  const due = products.filter(
    (p) => p.watch && p.platform !== "OTHER" && !opts.paused.has(p.platform) && (!p.lastFetchedAt || p.lastFetchedAt.getTime() <= threshold),
  );
  let picked = shuffle(due, opts.rand);
  if (opts.maxProducts !== undefined && opts.maxProducts >= 0) picked = picked.slice(0, opts.maxProducts);
  const groups = new Map<Platform, DueCandidate[]>();
  for (const p of picked) groups.set(p.platform, [...(groups.get(p.platform) ?? []), p]);
  return groups;
}

/** リクエスト間の待ち時間: 基本 3〜8 秒 + ジッター (SCRAPE_JITTER_MAX_MS) */
export function requestDelayMs(jitterMax?: number, rand: () => number = Math.random): number {
  return 3000 + Math.floor(rand() * 5000) + jitterMs(jitterMax, rand);
}

/** 指数バックオフ: base, base*2, base*4 ... */
export const backoffMs = (attempt: number, base: number) => base * 2 ** attempt;

export interface RunnerDeps {
  scrape: (productId: string) => Promise<ScrapeResult>;
  sleep: (ms: number) => Promise<void>;
  delayMs: () => number;
  backoffMs: (attempt: number) => number;
  /** 一時的な障害の再試行回数 (既定 2) */
  maxRetries?: number;
  log?: (msg: string) => void;
  /** true を返したら残りの商品を取得せずに打ち切る (実行時間の予算切れ)。再試行の待機前にも確認する */
  shouldStop?: () => boolean;
}

/** 一時的な障害 (5xx・タイムアウト) のみ指数バックオフで再試行する */
export async function scrapeWithRetry(productId: string, deps: RunnerDeps): Promise<{ result: ScrapeResult; attempts: number }> {
  const max = deps.maxRetries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let result: ScrapeResult;
    try {
      result = await deps.scrape(productId);
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e);
      result = { status: "failed", productId, note, retryable: isTransientError(e), parsedFields: [] };
    }
    if (result.status === "failed" && result.retryable && attempt < max && !deps.shouldStop?.()) {
      const wait = deps.backoffMs(attempt);
      deps.log?.(`  retry ${productId} in ${Math.round(wait / 1000)}s (${result.note})`);
      await deps.sleep(wait);
      continue;
    }
    return { result, attempts: attempt + 1 };
  }
}

export interface PlatformSummary {
  platform: Platform;
  total: number;
  ok: number;
  failed: number;
  /** ブロック (CAPTCHA 等) を検知して途中で止めたか */
  blocked: boolean;
  blockNote: string | null;
  /** ブロックにより未処理のまま残った件数 */
  skipped: number;
  /** 実行時間の予算切れで未処理のまま残った件数 */
  budgetSkipped: number;
  failures: { productId: string; note: string }[];
}

/** 1 プラットフォーム分を順番に処理する。ブロックされたらその時点で打ち切る */
export async function runPlatformQueue(platform: Platform, productIds: string[], deps: RunnerDeps): Promise<PlatformSummary> {
  const s: PlatformSummary = { platform, total: productIds.length, ok: 0, failed: 0, blocked: false, blockNote: null, skipped: 0, budgetSkipped: 0, failures: [] };
  for (let i = 0; i < productIds.length; i++) {
    if (i > 0) await deps.sleep(deps.delayMs());
    if (deps.shouldStop?.()) {
      s.budgetSkipped = productIds.length - i;
      deps.log?.(`[${platform}] time budget exceeded: ${s.budgetSkipped} product(s) skipped`);
      break;
    }
    const { result } = await scrapeWithRetry(productIds[i], deps);
    if (result.status === "ok") s.ok++;
    else if (result.status === "failed") {
      s.failed++;
      s.failures.push({ productId: productIds[i], note: result.note });
    } else {
      s.blocked = true;
      s.blockNote = result.note;
      s.skipped = productIds.length - i - (result.kind === "paused" ? 0 : 1);
      if (result.kind !== "paused") {
        s.failed++;
        s.failures.push({ productId: productIds[i], note: result.note });
      }
      deps.log?.(`[${platform}] stopped: ${result.note}`);
      break;
    }
  }
  return s;
}

/** プラットフォームごとに並行 (各プラットフォーム内は逐次) で巡回する */
export async function runScheduledScrape(groups: Map<Platform, DueCandidate[]>, deps: RunnerDeps): Promise<PlatformSummary[]> {
  return Promise.all(
    [...groups.entries()].map(async ([platform, items], idx) => {
      // 開始時刻もずらす
      if (idx > 0) await deps.sleep(Math.floor(deps.delayMs() / 2));
      return runPlatformQueue(
        platform,
        items.map((p) => p.id),
        deps,
      );
    }),
  );
}

export function formatSummary(summaries: PlatformSummary[]): string {
  if (!summaries.length) return "巡回対象の商品はありませんでした";
  return summaries
    .map((s) => {
      const budget = s.budgetSkipped ? `, 時間切れのため未処理 ${s.budgetSkipped} 件 (次回の実行で取得)` : "";
      const head = `${s.platform}: ${s.ok}/${s.total} 件取得, 失敗 ${s.failed} 件${budget}${s.blocked ? `, 停止 (未処理 ${s.skipped} 件): ${s.blockNote}` : ""}`;
      const fails = s.failures.slice(0, 10).map((f) => `  - ${f.productId}: ${f.note}`);
      return [head, ...fails].join("\n");
    })
    .join("\n");
}

/** 取得に使える時間 (分)。`JOBS_SCRAPE_BUDGET_MIN` (既定 18 分。ワークフローの 40 分制限内で自動探索・再計算・通知送信まで終えるため) */
export function scrapeBudgetMinutes(raw: string | undefined = process.env.JOBS_SCRAPE_BUDGET_MIN): number {
  const n = Number(raw);
  return raw && raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : 18;
}

/** `npm run jobs:once -- --max-products 20 --skip-recalc` の引数解析 */
export function parseJobArgs(argv: string[]): { maxProducts?: number; skipRecalc: boolean } {
  const out: { maxProducts?: number; skipRecalc: boolean } = { skipRecalc: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip-recalc") out.skipRecalc = true;
    else if (a === "--max-products" || a.startsWith("--max-products=")) {
      const v = a.includes("=") ? a.split("=")[1] : argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new Error(`--max-products には 0 以上の整数を指定してください: ${v}`);
      out.maxProducts = n;
    }
  }
  return out;
}
