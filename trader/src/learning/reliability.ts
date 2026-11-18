import type { AssetClass, SourceReliability, Store, TradeRecord } from "../core/types";

/**
 * 収集情報のフィードバック。
 * - 情報源ごと: エントリー時の寄与 (sourceContrib) の符号と、実際の値動きの方向が一致したら的中。
 *   ewmaScore (-1〜1) を更新し weight = clamp(1 + ewmaScore × 縮小係数, 0.2, 2)。
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
};

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

/** 情報源信頼度の集約キー (情報収集側の aggregate がここから Record<source, SourceReliability> を読む) */
export const SOURCE_RELIABILITY_KV_KEY = "intel:sourceReliability";
const influenceKey = (ac: AssetClass) => `intelInfluence:${ac}`;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export class SourceReliabilityTracker {
  readonly opts: ReliabilityOptions;
  private sources: Record<string, SourceReliability>;

  constructor(
    private readonly store: Store,
    opts: Partial<ReliabilityOptions> = {},
  ) {
    this.opts = { ...DEFAULT_RELIABILITY_OPTIONS, ...opts };
    this.sources = store.kvGet<Record<string, SourceReliability>>(SOURCE_RELIABILITY_KV_KEY) ?? {};
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

  /** 決済済みトレードで情報源の信頼度と情報の効き具合を更新。更新した情報源 ID を返す */
  update(trade: TradeRecord, now: number = trade.exitTs): string[] {
    const intel = trade.entryContext?.intel;
    if (!intel) return [];
    const updated: string[] = [];
    const market = this.marketDirection(trade);
    if (market !== 0) {
      for (const [source, contrib] of Object.entries(intel.sourceContrib ?? {})) {
        if (!Number.isFinite(contrib) || Math.abs(contrib) < this.opts.minContrib) continue;
        const hit = Math.sign(contrib) === market;
        this.observe(source, hit, now);
        updated.push(source);
      }
      if (updated.length) this.store.kvSet(SOURCE_RELIABILITY_KV_KEY, this.sources);
    }
    this.updateInfluence(trade, now);
    return updated;
  }

  private observe(source: string, hit: boolean, now: number) {
    const s = hit ? 1 : -1;
    const prev = this.sources[source];
    const n = (prev?.n ?? 0) + 1;
    // 初回は観測値で初期化し、少数サンプルは縮小推定で 1 に寄せる
    const ewmaScore = prev ? (1 - this.opts.ewmaAlpha) * prev.ewmaScore + this.opts.ewmaAlpha * s : s;
    this.sources[source] = {
      source,
      n,
      hits: (prev?.hits ?? 0) + (hit ? 1 : 0),
      ewmaScore,
      weight: this.weightFrom(ewmaScore, n),
      updatedAt: now,
    };
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
    const key = influenceKey(t.assetClass);
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
    return this.store.kvGet<IntelInfluenceState>(influenceKey(assetClass))?.value ?? 1;
  }

  influenceState(assetClass: AssetClass): IntelInfluenceState | undefined {
    return this.store.kvGet<IntelInfluenceState>(influenceKey(assetClass));
  }
}
