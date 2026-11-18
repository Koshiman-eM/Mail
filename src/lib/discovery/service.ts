import { aiConfigured, filterDomesticTitles, translateSearchKeyword } from "../ai/claude";
import { prisma } from "../db/prisma";
import { requestDelayMs } from "../jobs/runner";
import type { PriceTier } from "../profit/types";
import type { PageFetcher } from "../scraper/types";
import { defaultDomesticProviders } from "./domestic";
import { DiscoveryActionError, DiscoveryCooldownError, DiscoveryNotFoundError } from "./errors";
import { MANUAL_COOLDOWN_MS, runDiscovery, type DiscoveryDeps, type DiscoveryRunSummary } from "./run";
import type { SearchPlatform } from "./searchUrl";
import { createPrismaDiscoveryStore, createProductFromItem, toWatchRow } from "./store";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 本番用の依存関係 (DB・国内価格の取得元・Claude) */
export function defaultDiscoveryDeps(opts: { getFetcher: () => Promise<PageFetcher>; shouldStop?: () => boolean; delayMs?: () => number; actor?: string; log?: (m: string) => void }): DiscoveryDeps {
  return {
    store: createPrismaDiscoveryStore(),
    getFetcher: opts.getFetcher,
    providers: defaultDomesticProviders(),
    sleep,
    delayMs: opts.delayMs ?? (() => requestDelayMs()),
    shouldStop: opts.shouldStop,
    translate: (kw, to) => translateSearchKeyword(kw, to),
    filterTitles: aiConfigured() ? (kw, titles) => filterDomesticTitles(kw, titles) : undefined,
    actor: opts.actor,
    log: opts.log ?? ((m) => console.log(m)),
  };
}

/**
 * 「今すぐ探索」: 連打防止 (10 分) を確認して実行中にし、バックグラウンドで 1 件の条件を探索する。
 * 応答はすぐ返し、画面は条件の lastRunStatus (RUNNING → OK 等) をポーリングして結果を表示する。
 * Web プロセスにはブラウザが無いため HTTP 取得を使う。
 */
export async function startManualRun(watchId: string, opts: { actor: string; getFetcher: () => Promise<PageFetcher>; budgetMs?: number }): Promise<{ started: true; promise: Promise<DiscoveryRunSummary | null> }> {
  const w = await prisma.discoveryWatch.findUnique({ where: { id: watchId } });
  if (!w) throw new DiscoveryNotFoundError("探索条件");
  const now = new Date();
  const store = createPrismaDiscoveryStore();
  if (!(await store.claimWatch(watchId, now, MANUAL_COOLDOWN_MS))) {
    const elapsed = w.lastRunAt ? now.getTime() - w.lastRunAt.getTime() : 0;
    throw new DiscoveryCooldownError(Math.round((MANUAL_COOLDOWN_MS - elapsed) / 1000));
  }
  const deadline = Date.now() + (opts.budgetMs ?? 4 * 60_000);
  let fetcher: PageFetcher | undefined;
  const promise = runDiscovery(
    { watchId, claimed: true },
    defaultDiscoveryDeps({
      getFetcher: async () => (fetcher ??= await opts.getFetcher()),
      shouldStop: () => Date.now() >= deadline,
      // 利用者が待っているため間隔は短め (それでも 2〜4 秒 + ジッターは空ける)
      delayMs: () => 2000 + Math.floor(Math.random() * 2000),
      actor: opts.actor,
    }),
  )
    .catch(async (e) => {
      console.error("[discovery] manual run failed", e);
      await prisma.discoveryWatch.update({ where: { id: watchId }, data: { lastRunStatus: "FAILED", lastRunNote: `想定外のエラー: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` } }).catch(() => undefined);
      return null;
    })
    .finally(() => fetcher?.close().catch(() => undefined));
  return { started: true, promise };
}

/** 探索結果を手動で仕入れ候補に追加する (自動追加と同じ経路)。登録済みなら紐付けのみ */
export async function addDiscoveredItem(itemId: string, actor: string) {
  const item = await prisma.discoveredItem.findUnique({ where: { id: itemId }, include: { watch: true } });
  if (!item) throw new DiscoveryNotFoundError();
  if ((item.status === "ADDED" || item.status === "AUTO_ADDED") && item.productId) return { item, productId: item.productId, existed: true };
  if (item.platform === "OTHER") throw new DiscoveryActionError("対応していないサイトの商品です");
  const tiers = item.priceTiers as unknown as PriceTier[];
  if (!Array.isArray(tiers) || !tiers.length) throw new DiscoveryActionError("価格を読み取れなかった商品は追加できません。商品 URL から取り込んでください");
  const r = await createProductFromItem({
    item: {
      platform: item.platform as SearchPlatform,
      externalId: item.externalId,
      url: item.url,
      title: item.title,
      currency: item.currency,
      priceTiers: tiers,
      moq: item.moq,
      supplierName: item.supplierName,
      supplierExternalId: item.supplierExternalId,
      shopUrl: item.shopUrl,
    },
    watch: toWatchRow(item.watch),
    domesticPriceJpy: item.domesticPriceJpy?.toString() ?? null,
    actor,
    action: "discovery.add",
    discoveredItemId: item.id,
  });
  const updated = await prisma.discoveredItem.update({
    where: { id: itemId },
    data: { status: "ADDED", productId: r.productId, statusNote: r.existed ? "登録済みの商品に紐付けました" : "手動で仕入れ候補に追加しました" },
  });
  return { item: updated, productId: r.productId, existed: r.existed };
}

/** 探索結果を除外する (再探索でも復活させない) */
export async function dismissDiscoveredItem(itemId: string, actor: string) {
  const item = await prisma.discoveredItem.findUnique({ where: { id: itemId } });
  if (!item) throw new DiscoveryNotFoundError();
  const [updated] = await prisma.$transaction([
    prisma.discoveredItem.update({ where: { id: itemId }, data: { status: "DISMISSED", statusNote: "除外しました" } }),
    prisma.auditLog.create({ data: { actor, action: "discovery.dismiss", entityType: "DiscoveredItem", entityId: itemId, before: { status: item.status } } }),
  ]);
  return { item: updated };
}
