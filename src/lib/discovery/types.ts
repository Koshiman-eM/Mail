import type { DiscoveryStatus, Platform } from "@prisma/client";
import type { AutoSettings } from "../profit/auto";
import type { PriceTier } from "../profit/types";
import type { BlockKind } from "../scraper/detect";
import type { DomesticSample } from "./domestic/types";
import type { SearchPlatform } from "./searchUrl";

export type KeywordMap = Partial<Record<SearchPlatform, string>>;
export type AutoKeywordMap = Partial<Record<SearchPlatform, { source: string; text: string; stub: boolean }>>;

/** 探索条件 (DB の DiscoveryWatch を文字列化したもの) */
export interface WatchRow {
  id: string;
  name: string;
  keywordJa: string;
  foreignKeywords: KeywordMap;
  autoKeywords: AutoKeywordMap | null;
  platforms: Platform[];
  enabled: boolean;
  estWeightKg: string;
  estLengthCm: string | null;
  estWidthCm: string | null;
  estHeightCm: string | null;
  targetQuantity: number;
  minRoiPercent: string;
  minProfitJpy: string | null;
  maxMoq: number | null;
  maxUnitPriceJpy: string | null;
  autoAdd: boolean;
  maxAutoAddPerRun: number;
  lastRunAt: Date | null;
}

export interface ExistingItemRow {
  id: string;
  status: DiscoveryStatus;
  productId: string | null;
}

/** 商品登録に必要な探索結果の項目 */
export interface ItemForProduct {
  platform: SearchPlatform;
  externalId: string;
  url: string;
  title: string;
  currency: string;
  priceTiers: PriceTier[];
  moq: number | null;
  supplierName: string | null;
  supplierExternalId: string | null;
  shopUrl: string | null;
}

/** 国内価格の根拠 (DiscoveredItem.domesticEvidence に保存し画面に出す) */
export interface DomesticEvidence {
  provider: string;
  providerLabel: string;
  keyword: string;
  fetchedAt: string;
  cached: boolean;
  sampleCount: number;
  usedCount: number;
  medianJpy: string | null;
  lowerQuartileJpy: string | null;
  adoptedJpy: string | null;
  /** 採用価格の決め方 */
  basis: "lower-quartile";
  samples: DomesticSample[];
  aiFilter?: { before: number; after: number } | { error: string };
  notes: string[];
}

export interface ItemUpsert {
  watchId: string;
  platform: SearchPlatform;
  externalId: string;
  url: string;
  title: string;
  imageUrl: string | null;
  currency: string;
  unitPrice: string;
  priceTiers: PriceTier[];
  moq: number;
  supplierName: string | null;
  supplierExternalId: string | null;
  shopUrl: string | null;
  domesticPriceJpy: string | null;
  domesticEvidence: DomesticEvidence | null;
  estProfitJpy: string | null;
  estRoiPercent: string | null;
  estimate: Record<string, unknown> | null;
  status: DiscoveryStatus;
  statusNote: string | null;
  productId: string | null;
  seenAt: Date;
}

/** DB アクセスの抽象 (テストではインメモリ実装に差し替える) */
export interface DiscoveryStore {
  /** watchId 指定時はその 1 件 (無効でも)。未指定なら有効な条件すべて */
  listWatches(watchId?: string): Promise<WatchRow[]>;
  /** 直近 cooldownMs 以内に実行されていなければ実行中にして true (同時実行・連打の防止) */
  claimWatch(id: string, now: Date, cooldownMs: number): Promise<boolean>;
  finishWatch(id: string, data: { status: string; note: string }): Promise<void>;
  saveAutoKeywords(id: string, kw: AutoKeywordMap): Promise<void>;
  getSettings(): Promise<AutoSettings>;
  resolveFx(currency: string): Promise<{ rate: string; source: string } | null>;
  isPlatformPaused(platform: SearchPlatform): Promise<boolean>;
  pausePlatform(platform: SearchPlatform, kind: BlockKind, url: string): Promise<void>;
  /** 同じ商品 (プラットフォーム + 商品 ID、または同じ URL) の登録済み商品 ID */
  findProduct(platform: SearchPlatform, externalId: string, url: string): Promise<string | null>;
  getItem(watchId: string, platform: SearchPlatform, externalId: string): Promise<ExistingItemRow | null>;
  /** keepStatus=true なら status / statusNote / productId は既存のまま (価格・試算・lastSeenAt のみ更新) */
  upsertItem(data: ItemUpsert, keepStatus: boolean): Promise<void>;
  getDomesticCache(provider: string, keyword: string, notBefore: Date): Promise<{ items: DomesticSample[]; fetchedAt: Date } | null>;
  setDomesticCache(provider: string, keyword: string, items: DomesticSample[], at: Date): Promise<void>;
  /** URL 取り込みと同じ経路で商品を登録し、利益を自動計算する */
  createProduct(input: { item: ItemForProduct; watch: WatchRow; domesticPriceJpy: string | null; actor: string; action: string }): Promise<{ productId: string; existed: boolean }>;
  notify(n: { title: string; body: string; link: string }): Promise<void>;
}
