/**
 * ニュースと値動きの答え合わせ。取引が無くても情報源の信頼度を更新する。
 *
 * 1. 取り込み (ingest): sentiment があり |sentiment| ≥ minAbsSentiment、assets のどれかが監視銘柄のベース通貨と一致し、
 *    publishedAt が取り込み時刻から maxAgeMs 以内の情報を、(id, 情報源, 資産, 銘柄, 向き, 強さ, 時刻, 仲値) として保存する。
 *    同じ id は 1 回だけ。
 * 2. 判定 (evaluate): 取り込みから 15 分・1 時間・4 時間 (horizonsMs) 後の価格と比べる。
 *    ノイズの範囲 = max(1 分足 ATR 比 × √分数 × noiseAtrMult, 往復コスト比) 未満の動きは判定しない (数えない)。
 *    当たり・外れを SourceReliabilityTracker.observeNews に反映する。1 記事あたりの合計の重みが newsWeight (既定 0.3) になるよう、
 *    1 判定の重みは newsWeight ÷ (時間の数 × その記事で判定する資産の数)。ノイズ・期限切れの判定の分は使わない (合計 ≤ 0.3)。
 * 3. 判定待ちは最大 maxPending 件 (古い順に捨てる)。kv に保存し再起動後も続ける。監視をやめた銘柄の分は捨てる。
 * 4. 状態 (判定待ち・集計・取り込み済み id) は mode 別のキー `newsCheck:<mode>:*` に保存する (情報源の信頼度が mode 別のため)。
 */
import type { Instrument, IntelItem, Store, TradingMode } from "../core/types";
import type { PriceAt } from "./journal";
import type { SourceReliabilityTracker } from "./reliability";

export interface NewsCheckOptions {
  /** 判定する時間 (ミリ秒) */
  horizonsMs: number[];
  minAbsSentiment: number;
  /** publishedAt がこれより古い情報は対象外 (後から取り込んだ古い記事) */
  maxAgeMs: number;
  maxPending: number;
  /** ノイズの範囲 = ATR 比 (1 分あたり) × √分数 × noiseAtrMult */
  noiseAtrMult: number;
  /** 判定時刻を過ぎてもこの時間内なら現在の仲値で判定する (それ以上遅れて価格履歴も無ければ判定しない) */
  lateToleranceMs: number;
  /** 1 件の情報から判定する資産の上限 */
  maxAssetsPerItem: number;
  /** 重複排除に覚えておく id の上限 */
  seenLimit: number;
}

export const DEFAULT_NEWS_CHECK_OPTIONS: NewsCheckOptions = {
  horizonsMs: [15 * 60_000, 60 * 60_000, 4 * 3_600_000],
  minAbsSentiment: 0.15,
  maxAgeMs: 2 * 3_600_000,
  maxPending: 500,
  noiseAtrMult: 0.5,
  lateToleranceMs: 5 * 60_000,
  maxAssetsPerItem: 3,
  seenLimit: 5_000,
};

/** 判定待ちの 1 件 */
export interface NewsPending {
  itemId: string;
  source: string;
  asset: string;
  symbol: string;
  /** +1 強気 / −1 弱気 */
  direction: 1 | -1;
  /** |sentiment| */
  strength: number;
  ingestedAt: number;
  publishedAt: number;
  mid0: number;
  /** 取り込み時点の 1 分あたりの ATR 比 (無ければ 0) */
  atrPctPerMin: number;
  /** 往復コスト比 (手数料 × 2 + スプレッド / 仲値) */
  costPct: number;
  /** 判定済み (またはノイズ・期限切れで終えた) horizon (ms) */
  done: number[];
  /**
   * 1 判定の重みの割合 = 1 ÷ (時間の数 × その記事で判定する資産の数)。
   * 保存済みの判定待ち (この項目が無いもの) は読み込み時に同じ記事 id の件数から補う
   */
  share?: number;
}

export interface NewsCounts {
  n: number;
  hits: number;
  /** ノイズの範囲内で判定しなかった件数 */
  noise: number;
  /** 価格が取れず判定しなかった件数 */
  expired: number;
}

export interface NewsCheckStats {
  /** 情報源 → 合計と時間ごとの内訳 */
  sources: Record<string, NewsCounts & { byHorizon: Record<string, NewsCounts> }>;
  recorded: number;
  /** 上限超過で捨てた判定待ち */
  droppedCap: number;
  /** 監視をやめたため捨てた判定待ち */
  droppedUnwatched: number;
}

export interface NewsMarketInfo {
  instrument: Pick<Instrument, "symbol" | "baseCurrency">;
  mid?: number;
  atrPctPerMin?: number;
  costPct?: number;
}

export interface NewsCheckSummary {
  pending: number;
  recorded: number;
  droppedCap: number;
  droppedUnwatched: number;
  horizons: string[];
  sources: { source: string; n: number; hits: number; hitRate: number; noise: number; expired: number; byHorizon: Record<string, NewsCounts> }[];
  byHorizon: { horizon: string; n: number; hits: number; hitRate: number; noise: number; expired: number }[];
}

/** mode で分ける前の旧キー (移行元。読み書きしない) */
export const NEWS_PENDING_KEY = "newsCheck:pending";
export const NEWS_STATS_KEY = "newsCheck:stats";
export const NEWS_SEEN_KEY = "newsCheck:seen";
export const newsPendingKey = (mode: TradingMode) => `newsCheck:${mode}:pending`;
export const newsStatsKey = (mode: TradingMode) => `newsCheck:${mode}:stats`;
export const newsSeenKey = (mode: TradingMode) => `newsCheck:${mode}:seen`;

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const emptyCounts = (): NewsCounts => ({ n: 0, hits: 0, noise: 0, expired: 0 });

/** 15m / 1h / 4h / 90s のような表示用ラベル */
export function horizonLabel(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** ノイズの範囲 (比率)。max(ATR 比 (1 分) × √分数 × mult, 往復コスト比) */
export function noiseThreshold(p: Pick<NewsPending, "atrPctPerMin" | "costPct">, horizonMs: number, mult: number): number {
  const minutes = Math.max(1, horizonMs / 60_000);
  const atr = finite(p.atrPctPerMin) && p.atrPctPerMin > 0 ? p.atrPctPerMin * Math.sqrt(minutes) * mult : 0;
  return Math.max(atr, finite(p.costPct) && p.costPct > 0 ? p.costPct : 0);
}

export class NewsOutcomeTracker {
  readonly opts: NewsCheckOptions;
  private pending: NewsPending[];
  private seen: string[];
  private readonly seenSet: Set<string>;
  private stats: NewsCheckStats;

  constructor(
    private readonly store: Store,
    private readonly reliability: Pick<SourceReliabilityTracker, "observeNews">,
    opts: Partial<NewsCheckOptions> = {},
    /** 状態を保存する mode (省略時は paper) */
    readonly mode: TradingMode = "paper",
  ) {
    this.opts = { ...DEFAULT_NEWS_CHECK_OPTIONS, ...opts };
    const p = store.kvGet<NewsPending[]>(newsPendingKey(mode));
    this.pending = Array.isArray(p) ? p : [];
    // 旧形式の判定待ち (share なし): 同じ記事 id の判定待ちの件数 (= 資産の数) から割合を補う
    const perItem = new Map<string, number>();
    for (const x of this.pending) if (x && !finite(x.share)) perItem.set(x.itemId, (perItem.get(x.itemId) ?? 0) + 1);
    const h = Math.max(1, this.opts.horizonsMs.length);
    for (const x of this.pending) if (x && !finite(x.share)) x.share = 1 / (h * Math.max(1, perItem.get(x.itemId) ?? 1));
    const s = store.kvGet<string[]>(newsSeenKey(mode));
    this.seen = Array.isArray(s) ? s : [];
    this.seenSet = new Set(this.seen);
    this.stats = { sources: {}, recorded: 0, droppedCap: 0, droppedUnwatched: 0, ...(store.kvGet<Partial<NewsCheckStats>>(newsStatsKey(mode)) ?? {}) };
  }

  listPending(): NewsPending[] {
    return this.pending.map((p) => ({ ...p, done: [...p.done] }));
  }

  /**
   * 情報を取り込み、条件に合うものを判定待ちに加える。加えた件数を返す。
   * markets: 監視中の銘柄と、その時点の仲値・ATR 比・往復コスト比
   */
  ingest(items: readonly IntelItem[], markets: readonly NewsMarketInfo[], now: number): number {
    const byAsset = new Map<string, NewsMarketInfo>();
    for (const m of markets) {
      const a = m.instrument.baseCurrency?.toUpperCase();
      if (a && !byAsset.has(a) && finite(m.mid) && m.mid > 0) byAsset.set(a, m);
    }
    let added = 0;
    for (const it of items) {
      if (!it || typeof it.id !== "string" || this.seenSet.has(it.id)) continue;
      const s = it.sentiment;
      if (!finite(s) || Math.abs(s) < this.opts.minAbsSentiment) continue;
      if (!finite(it.publishedAt) || now - it.publishedAt > this.opts.maxAgeMs || it.publishedAt > now + 60_000) continue;
      const assets = [...new Set((it.assets ?? []).map((a) => String(a).toUpperCase()))].filter((a) => byAsset.has(a)).slice(0, this.opts.maxAssetsPerItem);
      if (assets.length === 0) continue;
      this.markSeen(it.id);
      const share = 1 / (Math.max(1, this.opts.horizonsMs.length) * assets.length);
      for (const asset of assets) {
        const m = byAsset.get(asset)!;
        this.pending.push({
          itemId: it.id,
          source: it.source,
          asset,
          symbol: m.instrument.symbol,
          direction: s > 0 ? 1 : -1,
          strength: Math.min(1, Math.abs(s)),
          ingestedAt: now,
          publishedAt: it.publishedAt,
          mid0: m.mid!,
          atrPctPerMin: finite(m.atrPctPerMin) && m.atrPctPerMin > 0 ? m.atrPctPerMin : 0,
          costPct: finite(m.costPct) && m.costPct > 0 ? m.costPct : 0,
          done: [],
          share,
        });
        added++;
        this.stats.recorded++;
      }
    }
    if (this.pending.length > this.opts.maxPending) {
      // 古い順に捨てる (sort は安定なので同時刻は取り込み順)
      this.pending.sort((a, b) => a.ingestedAt - b.ingestedAt);
      const drop = this.pending.length - this.opts.maxPending;
      this.pending.splice(0, drop);
      this.stats.droppedCap += drop;
    }
    if (added > 0) this.save(true);
    return added;
  }

  private markSeen(id: string) {
    this.seen.push(id);
    this.seenSet.add(id);
    if (this.seen.length > this.opts.seenLimit) {
      const removed = this.seen.splice(0, this.seen.length - this.opts.seenLimit);
      for (const r of removed) this.seenSet.delete(r);
    }
  }

  private counts(source: string, label: string) {
    const src = (this.stats.sources[source] ??= { ...emptyCounts(), byHorizon: {} });
    const h = (src.byHorizon[label] ??= emptyCounts());
    return { src, h };
  }

  /**
   * 判定時刻を過ぎたものを判定する。判定した件数 (ノイズ・期限切れを除く) を返す。
   * - priceAt(symbol, ts): ts 時点の価格 (1 分足の終値)。無ければ判定時刻から lateToleranceMs 以内に限り midNow を使う
   */
  evaluate(
    now: number,
    deps: { isWatched: (symbol: string) => boolean; midNow: (symbol: string) => number | undefined; priceAt?: PriceAt },
  ): number {
    if (this.pending.length === 0) return 0;
    let judged = 0;
    let changed = false;
    const keep: NewsPending[] = [];
    for (const p of this.pending) {
      if (!deps.isWatched(p.symbol)) {
        this.stats.droppedUnwatched++;
        changed = true;
        continue;
      }
      for (const h of this.opts.horizonsMs) {
        if (p.done.includes(h)) continue;
        const due = p.ingestedAt + h;
        if (now < due) continue;
        let px = deps.priceAt?.(p.symbol, due);
        if (!(finite(px) && px > 0)) px = now - due <= this.opts.lateToleranceMs ? deps.midNow(p.symbol) : undefined;
        const label = horizonLabel(h);
        const { src, h: hc } = this.counts(p.source, label);
        p.done.push(h);
        changed = true;
        if (!(finite(px) && px > 0) || !(p.mid0 > 0)) {
          src.expired++;
          hc.expired++;
          continue;
        }
        const change = (px - p.mid0) / p.mid0;
        if (Math.abs(change) < noiseThreshold(p, h, this.opts.noiseAtrMult)) {
          src.noise++;
          hc.noise++;
          continue;
        }
        const hit = Math.sign(change) === p.direction;
        src.n++;
        hc.n++;
        if (hit) {
          src.hits++;
          hc.hits++;
        }
        this.reliability.observeNews(p.source, hit, now, undefined, finite(p.share) && p.share > 0 ? p.share : 1);
        judged++;
      }
      if (this.opts.horizonsMs.some((h) => !p.done.includes(h))) keep.push(p);
    }
    this.pending = keep;
    if (changed) this.save(false);
    return judged;
  }

  private save(seen: boolean) {
    this.store.kvSet(newsPendingKey(this.mode), this.pending);
    this.store.kvSet(newsStatsKey(this.mode), this.stats);
    if (seen) this.store.kvSet(newsSeenKey(this.mode), this.seen);
  }

  getStats(): NewsCheckStats {
    return JSON.parse(JSON.stringify(this.stats)) as NewsCheckStats;
  }

  summary(): NewsCheckSummary {
    return summarizeNewsStats(this.getStats(), this.pending.length, this.opts.horizonsMs.map(horizonLabel));
  }
}

/** 集計 (純粋関数) */
export function summarizeNewsStats(stats: NewsCheckStats, pending: number, horizons: string[]): NewsCheckSummary {
  const rate = (c: NewsCounts) => (c.n > 0 ? c.hits / c.n : 0);
  const byH = new Map<string, NewsCounts>(horizons.map((h) => [h, emptyCounts()]));
  const sources = Object.entries(stats.sources ?? {}).map(([source, c]) => {
    for (const [h, x] of Object.entries(c.byHorizon ?? {})) {
      const t = byH.get(h) ?? emptyCounts();
      t.n += x.n;
      t.hits += x.hits;
      t.noise += x.noise;
      t.expired += x.expired;
      byH.set(h, t);
    }
    return { source, n: c.n, hits: c.hits, hitRate: rate(c), noise: c.noise, expired: c.expired, byHorizon: c.byHorizon ?? {} };
  });
  sources.sort((a, b) => b.n - a.n || a.source.localeCompare(b.source));
  return {
    pending,
    recorded: stats.recorded ?? 0,
    droppedCap: stats.droppedCap ?? 0,
    droppedUnwatched: stats.droppedUnwatched ?? 0,
    horizons,
    sources,
    byHorizon: [...byH].map(([horizon, c]) => ({ horizon, n: c.n, hits: c.hits, hitRate: rate(c), noise: c.noise, expired: c.expired })),
  };
}
