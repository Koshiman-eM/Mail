/** 情報収集サービス: 全情報源取得 → 保存 → 分析 → ブリーフ保存 */
import type { AiOptions } from "../core/ai";
import { createLogger, type Logger } from "../core/logger";
import type { EconEvent, IntelItem, MarketBrief, SourceReliability, Store, TradingMode } from "../core/types";
import { SOURCE_RELIABILITY_KV_KEY, sourceReliabilityKey } from "../learning/reliability";
import { analyzeIntelDetailed } from "./analyzer";
import type { TagOptions } from "./assetTagger";
import { createCoinGeckoSource } from "./sources/coingecko";
import type { FetchJsonFn, FetchTextFn, IntelSource } from "./sources/common";
import { createCryptoPanicSource } from "./sources/cryptopanic";
import { createDexScreenerSource } from "./sources/dexscreener";
import { createEconCalendarSource } from "./sources/econCalendar";
import { createFearGreedSource } from "./sources/fearGreed";
import { createRssSources } from "./sources/rss";

const EVENTS_KV_KEY = "intel:events";

export interface IntelServiceOptions {
  store: Store;
  sources: IntelSource[];
  ai?: AiOptions;
  /** 既定は store.kvGet (mode があれば学習側と同じ mode 別キー `intel:sourceReliability:<mode>`、無ければ旧キー SOURCE_RELIABILITY_KV_KEY) */
  getReliability?: () => Record<string, SourceReliability>;
  /** 情報源の信頼度を読む mode (学習状態は mode 別) */
  mode?: TradingMode;
  /** 分析対象にする過去の範囲 (既定 24 時間) */
  lookbackMs?: number;
  halfLifeMs?: number;
  logger?: Logger;
}

/** AI 分析結果のキャッシュの最大件数 */
const AI_CACHE_MAX = 2000;

export class IntelService {
  private readonly log: Logger;
  private events: EconEvent[];
  /** LLM 分析済み項目のキャッシュ (再分析によるコスト増を避ける) */
  private readonly aiCache = new Map<string, Pick<IntelItem, "sentiment" | "importance" | "assets">>();
  /** 直近の refresh で分析した項目 (sentiment / assets 反映済み。ニュースと値動きの答え合わせに使う) */
  private lastAnalyzed: IntelItem[] = [];

  constructor(private readonly opts: IntelServiceOptions) {
    this.log = opts.logger ?? createLogger("intel.service");
    this.events = opts.store.kvGet<EconEvent[]>(EVENTS_KV_KEY) ?? [];
  }

  async refresh(now: number = Date.now()): Promise<MarketBrief> {
    const { store, sources } = this.opts;
    const results = await Promise.allSettled(sources.map((s) => s.fetch(now)));
    const fetched: IntelItem[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.push(...r.value);
      else this.log.warn("情報源の取得に失敗", { source: sources[i].id, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    });
    // 成功した情報源の経済指標で更新 (失敗時は前回分を保持)
    sources.forEach((s, i) => {
      if (results[i].status === "fulfilled" && s.events) {
        const ev = s.events();
        if (ev.length > 0) this.events = ev;
      }
    });
    if (this.events.length > 0) store.kvSet(EVENTS_KV_KEY, this.events);

    const unique = [...new Map(fetched.map((it) => [it.id, it])).values()];
    if (unique.length > 0) store.saveIntel(unique);

    const lookback = this.opts.lookbackMs ?? 24 * 3_600_000;
    const stored = store.listIntel({ since: now - lookback, limit: 1000 });
    const merged = [...new Map([...stored, ...unique].map((it) => [it.id, it])).values()].map((it) => {
      const c = this.aiCache.get(it.id);
      return c ? { ...it, ...c } : it;
    });

    const reliabilityKey = this.opts.mode ? sourceReliabilityKey(this.opts.mode) : SOURCE_RELIABILITY_KV_KEY;
    const reliability = this.opts.getReliability?.() ?? store.kvGet<Record<string, SourceReliability>>(reliabilityKey) ?? {};
    const lessons = store.listLessons({ status: "active", limit: 50 });
    const { brief, items, aiAnalyzedIds } = await analyzeIntelDetailed(merged, {
      now,
      reliability,
      lessons,
      ai: this.opts.ai,
      events: this.events,
      halfLifeMs: this.opts.halfLifeMs,
    });
    this.lastAnalyzed = items;
    const analyzed = new Map(items.map((i) => [i.id, i]));
    for (const id of aiAnalyzedIds) {
      const it = analyzed.get(id);
      if (it) {
        this.aiCache.delete(id); // 挿入順を最新にする
        this.aiCache.set(id, { sentiment: it.sentiment, importance: it.importance, assets: it.assets });
      }
    }
    // 上限を超えたら古い順に捨てる (捨てても次回の分析で再計算されるだけ)
    while (this.aiCache.size > AI_CACHE_MAX) {
      const oldest = this.aiCache.keys().next().value;
      if (oldest === undefined) break;
      this.aiCache.delete(oldest);
    }
    store.saveBrief(brief);
    return brief;
  }

  /** 直近の refresh で分析した項目 (複製) */
  lastItems(): IntelItem[] {
    return this.lastAnalyzed.map((it) => ({ ...it, assets: [...(it.assets ?? [])] }));
  }

  latestBrief(): MarketBrief | undefined {
    return this.opts.store.latestBrief();
  }

  latestEvents(): EconEvent[] {
    return this.events;
  }
}

/** 既定の情報源一式 (CRYPTOPANIC_TOKEN 未設定なら cryptopanic は含まれない) */
export function createDefaultSources(
  opts: { env?: Record<string, string | undefined>; fetchText?: FetchTextFn; fetchJson?: FetchJsonFn; tag?: TagOptions } = {},
): IntelSource[] {
  const env = opts.env ?? process.env;
  const list: (IntelSource | undefined)[] = [
    ...createRssSources({ env: env.NEWS_RSS_FEEDS, fetchText: opts.fetchText, tag: opts.tag }),
    createFearGreedSource({ fetchJson: opts.fetchJson }),
    createCryptoPanicSource({ token: env.CRYPTOPANIC_TOKEN, fetchJson: opts.fetchJson }),
    createDexScreenerSource({ fetchJson: opts.fetchJson }),
    createCoinGeckoSource({ fetchJson: opts.fetchJson }),
    createEconCalendarSource({ fetchJson: opts.fetchJson }),
  ];
  return list.filter((s): s is IntelSource => Boolean(s));
}
