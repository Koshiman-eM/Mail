import type { DiscoveryStatus } from "@prisma/client";
import type { DomesticPriceProvider, DomesticSample } from "@/lib/discovery/domestic/types";
import type { SearchPlatform } from "@/lib/discovery/searchUrl";
import type { AutoKeywordMap, DiscoveryStore, ItemForProduct, ItemUpsert, WatchRow } from "@/lib/discovery/types";
import type { AutoSettings } from "@/lib/profit";
import type { BlockKind } from "@/lib/scraper/detect";
import type { FetchedPage, PageFetcher } from "@/lib/scraper/types";

export const SETTINGS: AutoSettings = {
  fxBufferPercent: "3",
  localShippingJpy: "0",
  agentFeePercent: "5",
  agentFixedJpy: "0",
  intlRatePerKgJpy: "800",
  intlMinChargeJpy: "0",
  volumetricDivisor: 5000,
  weightStepKg: "0.5",
  fuelSurchargePercent: "0",
  defaultDutyPercent: "5",
  consumptionTaxPercent: "10",
  customsClearanceFeeJpy: "3000",
  japanCustomsRounding: true,
  platformFeePercent: "10",
  platformFixedFeePerUnitJpy: "0",
  domesticShippingPerUnitJpy: "200",
  otherCostsJpy: "0",
};

export function makeWatch(over: Partial<WatchRow> = {}): WatchRow {
  return {
    id: "w1",
    name: "シリコンヘラ",
    keywordJa: "シリコン ヘラ",
    foreignKeywords: { ALIBABA: "silicone spatula", ALIEXPRESS: "silicone spatula", ALI1688: "硅胶铲" },
    autoKeywords: null,
    platforms: ["ALIBABA", "ALIEXPRESS", "ALI1688"],
    enabled: true,
    estWeightKg: "0.1",
    estLengthCm: null,
    estWidthCm: null,
    estHeightCm: null,
    targetQuantity: 100,
    minRoiPercent: "30",
    minProfitJpy: null,
    maxMoq: null,
    maxUnitPriceJpy: null,
    autoAdd: true,
    maxAutoAddPerRun: 5,
    lastRunAt: null,
    ...over,
  };
}

/** DB の代わりのインメモリ実装 (自動探索のテスト用) */
export class FakeDiscoveryStore implements DiscoveryStore {
  watches: WatchRow[] = [];
  items = new Map<string, ItemUpsert & { firstSeenAt: Date }>();
  products = new Map<string, { id: string; platform: string; externalId: string; url: string; action: string; domesticPriceJpy: string | null }>();
  paused = new Set<SearchPlatform>();
  pauses: { platform: SearchPlatform; kind: BlockKind; url: string }[] = [];
  notifications: { title: string; body: string; link: string }[] = [];
  cache = new Map<string, { items: DomesticSample[]; fetchedAt: Date }>();
  finished: { id: string; status: string; note: string }[] = [];
  savedKeywords: AutoKeywordMap[] = [];
  fx: Record<string, string> = { USD: "150", CNY: "21", JPY: "1" };
  claimed: string[] = [];
  failCreate = false;

  key = (w: string, p: string, e: string) => `${w}|${p}|${e}`;

  async listWatches(watchId?: string) {
    return watchId ? this.watches.filter((w) => w.id === watchId) : this.watches.filter((w) => w.enabled);
  }
  async claimWatch(id: string, now: Date, cooldownMs: number) {
    const w = this.watches.find((x) => x.id === id)!;
    if (w.lastRunAt && now.getTime() - w.lastRunAt.getTime() < cooldownMs) return false;
    w.lastRunAt = now;
    this.claimed.push(id);
    return true;
  }
  async finishWatch(id: string, data: { status: string; note: string }) {
    this.finished.push({ id, ...data });
  }
  async saveAutoKeywords(id: string, kw: AutoKeywordMap) {
    this.savedKeywords.push(kw);
    const w = this.watches.find((x) => x.id === id);
    if (w) w.autoKeywords = kw;
  }
  async getSettings() {
    return SETTINGS;
  }
  async resolveFx(currency: string) {
    const rate = this.fx[currency];
    return rate ? { rate, source: "test" } : null;
  }
  async isPlatformPaused(p: SearchPlatform) {
    return this.paused.has(p);
  }
  async pausePlatform(platform: SearchPlatform, kind: BlockKind, url: string) {
    this.paused.add(platform);
    this.pauses.push({ platform, kind, url });
  }
  async findProduct(platform: SearchPlatform, externalId: string, url: string) {
    for (const p of this.products.values()) if ((p.platform === platform && p.externalId === externalId) || p.url === url) return p.id;
    return null;
  }
  async getItem(watchId: string, platform: SearchPlatform, externalId: string) {
    const it = this.items.get(this.key(watchId, platform, externalId));
    return it ? { id: this.key(watchId, platform, externalId), status: it.status, productId: it.productId } : null;
  }
  async upsertItem(d: ItemUpsert, keepStatus: boolean) {
    const k = this.key(d.watchId, d.platform, d.externalId);
    const prev = this.items.get(k);
    if (prev && keepStatus) this.items.set(k, { ...d, status: prev.status, statusNote: prev.statusNote, productId: prev.productId, firstSeenAt: prev.firstSeenAt });
    else this.items.set(k, { ...d, firstSeenAt: prev?.firstSeenAt ?? d.seenAt });
  }
  async getDomesticCache(provider: string, keyword: string, notBefore: Date) {
    const c = this.cache.get(`${provider}|${keyword}`);
    return c && c.fetchedAt >= notBefore ? c : null;
  }
  async setDomesticCache(provider: string, keyword: string, items: DomesticSample[], at: Date) {
    this.cache.set(`${provider}|${keyword}`, { items, fetchedAt: at });
  }
  async createProduct(input: { item: ItemForProduct; watch: WatchRow; domesticPriceJpy: string | null; actor: string; action: string }) {
    if (this.failCreate) throw new Error("db down");
    const existing = await this.findProduct(input.item.platform, input.item.externalId, input.item.url);
    if (existing) return { productId: existing, existed: true };
    const id = `p${this.products.size + 1}`;
    this.products.set(id, { id, platform: input.item.platform, externalId: input.item.externalId, url: input.item.url, action: input.action, domesticPriceJpy: input.domesticPriceJpy });
    return { productId: id, existed: false };
  }
  async notify(n: { title: string; body: string; link: string }) {
    this.notifications.push(n);
  }

  statusOf(watchId: string, platform: SearchPlatform, externalId: string): DiscoveryStatus | undefined {
    return this.items.get(this.key(watchId, platform, externalId))?.status;
  }
}

/** URL のホストごとに返すページを決める取得のモック */
export class FakeFetcher implements PageFetcher {
  calls: string[] = [];
  constructor(private readonly pages: (url: string) => FetchedPage | Error) {}
  async fetch(url: string) {
    this.calls.push(url);
    const p = this.pages(url);
    if (p instanceof Error) throw p;
    return p;
  }
  async close() {}
}

export function fakeProvider(prices: number[] | Error, configured = true): DomesticPriceProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "fake",
    label: "テスト市場",
    calls,
    isConfigured: () => configured,
    statusNote: () => "test",
    async search(kw: string) {
      calls.push(kw);
      if (prices instanceof Error) throw prices;
      return { items: prices.map((p, i) => ({ title: `${kw} ${i}`, priceJpy: String(p), url: `https://item.example.jp/${i}` })) };
    },
  };
}
