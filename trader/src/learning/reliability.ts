import type { AssetClass, IntelItem, SourceReliability, Store, TradeRecord, TradingMode } from "../core/types";

/**
 * 収集情報のフィードバック。
 * - 情報源ごと: エントリー時の寄与 (sourceContrib) の符号と、実際の値動きの方向が一致したら的中。
 *   ewmaScore (-1〜1、事前 0。序盤は重み付き平均、以降は指数加重) を更新し weight = clamp(1 + ewmaScore × 縮小係数, 0.2, 2)。
 *   - 多重カウントの防止: トレードは (情報源, 記事 id) 単位で 1 記事 1 回 (kv sourceReliabilityCredits:<mode>)。
 *     同じ記事群を根拠にした取引が半減期 6 時間・遡り 24 時間の間に何度あっても、記事 1 本あたりの合計の重みは 1。
 *     ニュースの答え合わせは 1 記事あたりの合計の重みが newsWeight (0.3) (newsCheck.ts)。
 *   - エグジット後の値動き (postExitMovePct) は決済時には未設定なので、補完後に reviseWithPostExit で差分だけ反映する
 *     (決済時の更新内容は kv sourceReliabilityApplied:<mode>)。
 * - 資産クラスごと: 情報バイアス (sentiment × トレード方向) と R の指数加重相関から
 *   「情報の効き具合」intelInfluence (0〜1.5, 中立 1) を出す。エンジンが情報バイアスの影響度に掛ける。
 */
export interface ReliabilityOptions {
  /** 的中度の指数加重係数 */
  ewmaAlpha: number;
  /** 縮小推定の事前擬似件数 (n が少ないうちは weight を 1 に寄せる) */
  priorN: number;
  minWeight: number;
  maxWeight: number;
  /** |寄与| がこれ未満の情報源は判定しない */
  minContrib: number;
  /** postExitMovePct を値動き方向の判定に加味する重み */
  postExitWeight: number;
  /** 値動き (比率) の絶対値がこれ未満なら方向不明として判定しない */
  minMovePct: number;
  /** intelInfluence の指数加重係数 */
  influenceAlpha: number;
  /** intelInfluence の縮小推定の事前擬似件数 */
  influencePriorN: number;
  maxInfluence: number;
  /** 相関計算で R をクリップする幅 */
  rClip: number;
  /** ニュースと値動きの答え合わせ 1 記事あたりの合計の重み (トレード由来の更新は 1 記事群につき最大 1) */
  newsWeight: number;
  /**
   * トレードによる更新を (情報源, 記事 id) 単位で 1 記事 1 回にする (既定 true)。
   * 同じ記事群を根拠にした取引が続いても、その情報源の更新の重みは「まだ数えていない記事の質量 ÷ 全質量」になる
   */
  dedupeArticles: boolean;
  /** 記事の質量 (時間減衰 × importance) の半減期。情報収集側の集計 (aggregate) と同じ 6 時間 */
  articleHalfLifeMs: number;
  /** 数えた記事 id を覚えておく期間と、情報源ごとの上限 */
  creditRetentionMs: number;
  maxCreditsPerSource: number;
  /** 決済時の更新内容 (エグジット後の値動きの補完で差分を反映するため) を覚えておく期間と上限 */
  appliedRetentionMs: number;
  maxApplied: number;
}

export const DEFAULT_RELIABILITY_OPTIONS: ReliabilityOptions = {
  ewmaAlpha: 0.1,
  priorN: 5,
  minWeight: 0.2,
  maxWeight: 2,
  minContrib: 0.05,
  postExitWeight: 0.5,
  minMovePct: 0.0001,
  influenceAlpha: 0.05,
  influencePriorN: 20,
  maxInfluence: 1.5,
  rClip: 5,
  newsWeight: 0.3,
  dedupeArticles: true,
  articleHalfLifeMs: 6 * 3_600_000,
  creditRetentionMs: 7 * 86_400_000,
  maxCreditsPerSource: 2_000,
  // エグジット後の値動きの計測は long で 7 日後 (DEFAULT_POST_EXIT_HORIZON_MS) なので余裕を見て 10 日
  appliedRetentionMs: 10 * 86_400_000,
  maxApplied: 5_000,
};

/** 情報源ごとの「数えた記事 id → 数えた時刻」 */
export type SourceCredits = Record<string, Record<string, number>>;

/** 決済時の更新内容 (トレード id ごと)。m: 決済時の値動きの方向、o: 情報源 → [重み w, 指数加重の係数 a] */
export interface AppliedObservation {
  ts: number;
  m: number;
  o: Record<string, [number, number]>;
}

/** 資産クラス別の情報の効き具合 (指数加重の相関) */
export interface IntelInfluenceState {
  n: number;
  mx: number;
  my: number;
  vx: number;
  vy: number;
  cxy: number;
  corr: number;
  value: number;
  updatedAt: number;
}

/** mode で分ける前の情報源信頼度の旧キー (移行元。読み書きしない) */
export const SOURCE_RELIABILITY_KV_KEY = "intel:sourceReliability";
/** 情報源信頼度の集約キー (mode 別。情報収集側の aggregate がここから Record<source, SourceReliability> を読む) */
export const sourceReliabilityKey = (mode: TradingMode) => `${SOURCE_RELIABILITY_KV_KEY}:${mode}`;
/** 資産クラス別の情報の効き具合のキー (mode 別) */
export const intelInfluenceKey = (mode: TradingMode, ac: AssetClass) => `intelInfluence:${mode}:${ac}`;
/** 数えた記事 id (mode 別。移行対象の旧キーの名前空間とは重ならない名前にする) */
export const sourceCreditsKey = (mode: TradingMode) => `sourceReliabilityCredits:${mode}`;
/** 決済時の更新内容 (mode 別) */
export const sourceAppliedKey = (mode: TradingMode) => `sourceReliabilityApplied:${mode}`;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export class SourceReliabilityTracker {
  readonly opts: ReliabilityOptions;
  private sources: Record<string, SourceReliability>;
  private readonly key: string;

  /** 状態は mode 別のキーに保存する (省略時の mode は paper) */
  constructor(
    private readonly store: Store,
    opts: Partial<ReliabilityOptions> = {},
    readonly mode: TradingMode = "paper",
  ) {
    this.opts = { ...DEFAULT_RELIABILITY_OPTIONS, ...opts };
    this.key = sourceReliabilityKey(mode);
    this.sources = store.kvGet<Record<string, SourceReliability>>(this.key) ?? {};
  }

  /**
   * トレードの実際の値動き方向 (+1 上昇 / −1 下落 / 0 不明)。
   * グロス損益の方向 (価格変化) に postExitMovePct (方向付き) を重み付きで加味する。
   */
  marketDirection(t: TradeRecord): number {
    const dir = t.direction === "long" ? 1 : -1;
    if (!(t.entryPrice > 0)) return 0;
    let move = (t.exitPrice - t.entryPrice) / t.entryPrice;
    if (move === 0 && t.grossPnl !== 0) move = dir * Math.sign(t.grossPnl) * this.opts.minMovePct * 2;
    if (typeof t.postExitMovePct === "number" && Number.isFinite(t.postExitMovePct)) {
      move += this.opts.postExitWeight * dir * t.postExitMovePct;
    }
    return Math.abs(move) < this.opts.minMovePct ? 0 : Math.sign(move);
  }

  /**
   * 決済済みトレードで情報源の信頼度と情報の効き具合を更新。更新した情報源 ID を返す。
   * - 情報源ごとの重み w = その情報源のまだ数えていない記事の質量 ÷ 全質量 (1 記事 1 回。articleWeights)。
   *   同じ記事群を根拠にした取引が続いても、記事 1 本あたりの合計の重みは 1 を超えない。w = 0 の情報源は更新しない。
   * - postExitMovePct が未設定 (後で補完される) なら、更新内容を覚えておき reviseWithPostExit で差分だけ反映する
   */
  update(trade: TradeRecord, now: number = trade.exitTs): string[] {
    const intel = trade.entryContext?.intel;
    if (!intel) return [];
    const updated: string[] = [];
    const market = this.marketDirection(trade);
    const willRevise = !(typeof trade.postExitMovePct === "number" && Number.isFinite(trade.postExitMovePct));
    const contribs = Object.entries(intel.sourceContrib ?? {}).filter(
      ([, c]) => Number.isFinite(c) && Math.abs(c) >= this.opts.minContrib,
    );
    // 方向不明で後から補完もされないなら、記事を数えない (重みを消費しない)
    if (contribs.length > 0 && (market !== 0 || willRevise)) {
      const { weights, commit } = this.articleWeights(trade, contribs.map(([s]) => s), now);
      const applied: AppliedObservation = { ts: now, m: market, o: {} };
      const used: string[] = [];
      for (const [source, contrib] of contribs) {
        const w = weights[source] ?? 0;
        if (!(w > 1e-9)) continue;
        used.push(source);
        if (market !== 0) {
          const a = this.observe(source, Math.sign(contrib) === market, now, w);
          applied.o[source] = [w, a];
          updated.push(source);
        } else {
          applied.o[source] = [w, 0];
        }
      }
      commit(used);
      if (updated.length) this.store.kvSet(this.key, this.sources);
      if (willRevise && used.length > 0 && typeof trade.id === "string") this.saveApplied(trade.id, applied, now);
    }
    this.updateInfluence(trade, now);
    return updated;
  }

  /**
   * 情報源ごとの「まだ数えていない記事の割合」(記事の質量 = 時間減衰 × importance で重み付け)。
   * - 記事 id は IntelBias.sourceIds。store.getIntel で情報源を引き、その情報源の記事だけを見る。
   * - 引けない記事 (保存されていない・古いトレード) は、その情報源の記事として扱う (近似)。
   *   その情報源の記事が 1 本も引けなければ sourceIds 全体を代わりに使う。
   * - sourceIds が空 (古いトレード) または dedupeArticles=false なら従来どおり 1。
   * commit(used) で used の情報源について記事を「数えた」と記録する。
   */
  private articleWeights(trade: TradeRecord, sources: string[], now: number): { weights: Record<string, number>; commit: (used: string[]) => void } {
    const ids = [...new Set((trade.entryContext?.intel?.sourceIds ?? []).filter((x): x is string => typeof x === "string" && x.length > 0))];
    const weights: Record<string, number> = {};
    if (!this.opts.dedupeArticles || ids.length === 0) {
      for (const s of sources) weights[s] = 1;
      return { weights, commit: () => {} };
    }
    let items: IntelItem[] = [];
    try {
      items = this.store.getIntel(ids) ?? [];
    } catch {
      items = [];
    }
    const byId = new Map(items.filter((i) => i && typeof i.id === "string").map((i) => [i.id, i]));
    const unresolved = ids.filter((id) => !byId.has(id));
    const entryTs = Number.isFinite(trade.entryTs) ? trade.entryTs : now;
    const mass = (it: IntelItem | undefined): number => {
      if (!it) return 1;
      const age = Number.isFinite(it.publishedAt) ? Math.max(0, entryTs - it.publishedAt) : 0;
      const imp = clamp(Number.isFinite(it.importance) ? it.importance! : 0.5, 0.05, 1);
      return Math.max(1e-6, 0.5 ** (age / this.opts.articleHalfLifeMs) * imp);
    };
    const credits = this.store.kvGet<SourceCredits>(sourceCreditsKey(this.mode)) ?? {};
    const sets: Record<string, { id: string; m: number }[]> = {};
    for (const s of sources) {
      const own = ids.filter((id) => byId.get(id)?.source === s);
      const set = own.length > 0 || unresolved.length > 0 ? [...own, ...unresolved] : ids;
      sets[s] = set.map((id) => ({ id, m: mass(byId.get(id)) }));
      const seen = credits[s] ?? {};
      let total = 0;
      let fresh = 0;
      for (const a of sets[s]) {
        total += a.m;
        if (seen[a.id] === undefined) fresh += a.m;
      }
      weights[s] = total > 0 ? clamp(fresh / total, 0, 1) : 1;
    }
    const commit = (used: string[]) => {
      if (used.length === 0) return;
      const cutoff = now - this.opts.creditRetentionMs;
      for (const s of used) {
        const m = { ...(credits[s] ?? {}) };
        for (const a of sets[s] ?? []) m[a.id] = now;
        let entries = Object.entries(m).filter(([, ts]) => Number.isFinite(ts) && ts >= cutoff);
        if (entries.length > this.opts.maxCreditsPerSource) entries = entries.sort((x, y) => y[1] - x[1]).slice(0, this.opts.maxCreditsPerSource);
        credits[s] = Object.fromEntries(entries);
      }
      this.store.kvSet(sourceCreditsKey(this.mode), credits);
    };
    return { weights, commit };
  }

  private saveApplied(tradeId: string, rec: AppliedObservation, now: number): void {
    const all = this.store.kvGet<Record<string, AppliedObservation>>(sourceAppliedKey(this.mode)) ?? {};
    all[tradeId] = rec;
    const cutoff = now - this.opts.appliedRetentionMs;
    let entries = Object.entries(all).filter(([, r]) => r && Number.isFinite(r.ts) && r.ts >= cutoff);
    if (entries.length > this.opts.maxApplied) entries = entries.sort((x, y) => y[1].ts - x[1].ts).slice(0, this.opts.maxApplied);
    this.store.kvSet(sourceAppliedKey(this.mode), Object.fromEntries(entries));
  }

  /**
   * エグジット後の値動き (postExitMovePct) を補完したトレードで、決済時の更新を差分だけ直す (1 トレード 1 回)。
   * - 決済時に方向不明 (更新なし) → 補完後に方向が出れば、決済時に確保した重み w で新しく更新する
   * - 決済時と逆向きになった → 当たり/外れを入れ替える: ewmaScore += a × (新 − 旧)、hits を差し替え (n・effN は変えない)
   * - 同じ向き・補完後に方向不明 → 何もしない
   * 決済時の記録が無いトレード (この仕組みの前に決済、または決済時に postExitMovePct があった) は何もしない (二重に数えない)。
   * 直した情報源 ID を返す
   */
  reviseWithPostExit(trade: TradeRecord, now: number = Date.now()): string[] {
    const key = sourceAppliedKey(this.mode);
    const all = this.store.kvGet<Record<string, AppliedObservation>>(key);
    const rec = all?.[trade.id];
    if (!all || !rec) return [];
    delete all[trade.id];
    this.store.kvSet(key, all);
    const m1 = this.marketDirection(trade);
    if (m1 === 0 || m1 === rec.m) return [];
    const contrib = trade.entryContext?.intel?.sourceContrib ?? {};
    const revised: string[] = [];
    for (const [source, [w, a]] of Object.entries(rec.o ?? {})) {
      const c = contrib[source];
      if (!Number.isFinite(c) || !(w > 0)) continue;
      const hit1 = Math.sign(c) === m1;
      if (rec.m === 0) {
        this.observe(source, hit1, now, w);
        revised.push(source);
        continue;
      }
      const hit0 = Math.sign(c) === rec.m;
      if (hit0 === hit1) continue;
      const prev = this.sources[source];
      if (!prev) continue;
      const s0 = hit0 ? 1 : -1;
      const s1 = hit1 ? 1 : -1;
      const ewmaScore = clamp((Number.isFinite(prev.ewmaScore) ? prev.ewmaScore : 0) + (Number.isFinite(a) ? a : 0) * (s1 - s0), -1, 1);
      const effN = prev.effN ?? prev.n;
      this.sources[source] = {
        ...prev,
        hits: Math.max(0, (prev.hits ?? 0) + (hit1 ? 1 : 0) - (hit0 ? 1 : 0)),
        ewmaScore,
        weight: this.weightFrom(ewmaScore, effN),
        updatedAt: now,
      };
      revised.push(source);
    }
    if (revised.length) this.store.kvSet(this.key, this.sources);
    return revised;
  }

  /**
   * ニュースと値動きの答え合わせ 1 判定を反映する。重みは weight × share
   * (weight 既定 newsWeight = 0.3 は 1 記事あたりの合計。share は 1 記事の判定の数 (時間 × 資産) で割った割合)。
   * 件数 n / hits はトレード由来のまま、newsN / newsHits を別に数える
   */
  observeNews(source: string, hit: boolean, now: number, weight: number = this.opts.newsWeight, share = 1): SourceReliability {
    const w = weight * (Number.isFinite(share) && share > 0 ? Math.min(1, share) : 1);
    this.observe(source, hit, now, w, "news");
    this.store.kvSet(this.key, this.sources);
    return { ...this.sources[source] };
  }

  /**
   * 重み w の観測で更新する。ewmaScore の事前値は 0 (保存済みの値があればそこから続ける)。
   * 係数 a = max(w / effN, ewmaAlpha × w) (上限 1): 序盤 (effN < 1/ewmaAlpha) は重み付き平均 Σ w s / Σ w と同じになり、
   * 観測の順番や重みの大小で初回の 1 件が強く効きすぎない。以降は指数加重。
   * 縮小推定は重み付きの件数 effN で行う (少数・低重みのうちは weight を 1 に寄せる)。使った係数 a を返す
   */
  private observe(source: string, hit: boolean, now: number, w = 1, kind: "trade" | "news" = "trade"): number {
    const s = hit ? 1 : -1;
    const prev = this.sources[source];
    const isTrade = kind === "trade";
    const prevN = prev ? (Number.isFinite(prev.effN) ? prev.effN! : Number.isFinite(prev.n) ? prev.n : 0) : 0;
    const effN = prevN + w;
    const a = effN > 0 ? Math.min(1, Math.max(w / effN, this.opts.ewmaAlpha * w)) : 0;
    const prevScore = prev && Number.isFinite(prev.ewmaScore) ? clamp(prev.ewmaScore, -1, 1) : 0;
    const ewmaScore = prevScore + a * (s - prevScore);
    const next: SourceReliability = {
      source,
      n: (prev?.n ?? 0) + (isTrade ? 1 : 0),
      hits: (prev?.hits ?? 0) + (isTrade && hit ? 1 : 0),
      ewmaScore,
      weight: this.weightFrom(ewmaScore, effN),
      updatedAt: now,
      effN,
    };
    const newsN = (prev?.newsN ?? 0) + (isTrade ? 0 : 1);
    if (newsN > 0) {
      next.newsN = newsN;
      next.newsHits = (prev?.newsHits ?? 0) + (!isTrade && hit ? 1 : 0);
    }
    this.sources[source] = next;
    return a;
  }

  private weightFrom(ewmaScore: number, n: number) {
    const shrink = n / (n + this.opts.priorN);
    return clamp(1 + ewmaScore * shrink, this.opts.minWeight, this.opts.maxWeight);
  }

  private updateInfluence(t: TradeRecord, now: number) {
    const intel = t.entryContext.intel!;
    const dir = t.direction === "long" ? 1 : -1;
    const x = (intel.sentiment ?? 0) * dir;
    const y = clamp(Number.isFinite(t.rMultiple) ? t.rMultiple : 0, -this.opts.rClip, this.opts.rClip);
    if (!Number.isFinite(x)) return;
    const key = intelInfluenceKey(this.mode, t.assetClass);
    const st = this.store.kvGet<IntelInfluenceState>(key) ?? {
      n: 0,
      mx: 0,
      my: 0,
      vx: 0,
      vy: 0,
      cxy: 0,
      corr: 0,
      value: 1,
      updatedAt: now,
    };
    st.n += 1;
    // 序盤は単純平均、以降は指数加重
    const a = Math.max(1 / st.n, this.opts.influenceAlpha);
    const dx = x - st.mx;
    const dy = y - st.my;
    st.mx += a * dx;
    st.my += a * dy;
    st.vx = (1 - a) * (st.vx + a * dx * dx);
    st.vy = (1 - a) * (st.vy + a * dy * dy);
    st.cxy = (1 - a) * (st.cxy + a * dx * dy);
    st.corr = st.vx > 1e-12 && st.vy > 1e-12 ? clamp(st.cxy / Math.sqrt(st.vx * st.vy), -1, 1) : 0;
    const shrink = st.n / (st.n + this.opts.influencePriorN);
    st.value = clamp(1 + st.corr * shrink, 0, this.opts.maxInfluence);
    st.updatedAt = now;
    this.store.kvSet(key, st);
  }

  get(source: string): SourceReliability | undefined {
    const s = this.sources[source];
    return s ? { ...s } : undefined;
  }

  /** 情報源の重み (未知の情報源は 1) */
  weight(source: string): number {
    return this.sources[source]?.weight ?? 1;
  }

  /** 全情報源 (情報収集側の aggregate に渡す) */
  all(): Record<string, SourceReliability> {
    return Object.fromEntries(Object.entries(this.sources).map(([k, v]) => [k, { ...v }]));
  }

  /** 資産クラス別の情報の効き具合 0〜1.5 (中立 1)。エンジンが情報バイアスの影響度に掛ける */
  intelInfluence(assetClass: AssetClass): number {
    return this.store.kvGet<IntelInfluenceState>(intelInfluenceKey(this.mode, assetClass))?.value ?? 1;
  }

  influenceState(assetClass: AssetClass): IntelInfluenceState | undefined {
    return this.store.kvGet<IntelInfluenceState>(intelInfluenceKey(this.mode, assetClass));
  }
}
