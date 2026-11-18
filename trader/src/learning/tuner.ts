import { randomUUID } from "node:crypto";
import { createLogger } from "../core/logger";
import type { AssetClass, CauseCode, ParamAdjustment, Params, RegimeLabel, Store, TradeRecord } from "../core/types";
import { attributeTrade, CAUSE_LABEL, pct } from "./attribution";

const log = createLogger("tuner");

/** 戦略のパラメータ情報 (Strategy から必要な部分だけ) */
export interface StrategyParamInfo {
  defaultParams: Params;
  paramBounds: Record<string, [number, number]>;
}

/** パラメータ候補の検証 (エンジンがバックテストで評価)。評価できなければ undefined */
export type ParamValidator = (
  strategyId: string,
  assetClass: AssetClass,
  params: Params,
) => Promise<{ score: number; trades: number } | undefined>;

/** パラメータ調整の提案 (LLM の振り返り等の外部から) */
export interface ParamProposal {
  strategyId: string;
  assetClass: AssetClass;
  param: string;
  direction: "up" | "down";
  reason: string;
}

export interface TunerOptions {
  /** (strategyId, assetClass) ごとに集計する直近件数 */
  window: number;
  /** 調整に必要な最小サンプル数 (前回の調整以降の件数) */
  minSamples: number;
  /** 要因の重み合計 / 件数 がこれ以上で「多い」とみなす */
  causeShare: number;
  /** 通常パラメータの調整幅 (10%) */
  step: number;
  /** maxHoldBars の調整幅 (15%) */
  holdStep: number;
  /** 候補スコアが現行スコアよりこの割合以上良ければ適用 (+5%) */
  improveRatio: number;
  /** 改善幅の絶対下限 (現行スコアが 0 付近の時用) */
  minAbsImprove: number;
  /** 検証で必要な最小取引数 */
  minValidationTrades: number;
  /** 適用後の評価に必要な件数 */
  minReviewSamples: number;
  /** 適用後の平均 R が適用前よりこれ以上悪化したら元に戻す */
  revertMarginR: number;
  /** 集計対象のトレードを遡る期間 */
  lookbackMs: number;
}

export const DEFAULT_TUNER_OPTIONS: TunerOptions = {
  window: 60,
  minSamples: 20,
  causeShare: 0.25,
  step: 0.1,
  holdStep: 0.15,
  improveRatio: 0.05,
  minAbsImprove: 1e-6,
  minValidationTrades: 20,
  minReviewSamples: 20,
  revertMarginR: 0.05,
  lookbackMs: 30 * 86_400_000,
};

export interface ParamTunerDeps {
  store: Store;
  getStrategy: (strategyId: string) => StrategyParamInfo | undefined;
  validate?: ParamValidator;
  strategyRegimes?: Record<string, RegimeLabel[]>;
  options?: Partial<TunerOptions>;
}

/** 適用した調整の評価用メタ情報 (kv "adjmeta:<id>") */
interface AdjustmentMeta {
  preMeanR: number;
  preN: number;
  reviewed: boolean;
  postMeanR?: number;
  postN?: number;
}

/** 要因 → 調整ルール */
interface Rule {
  codes: CauseCode[];
  pick: (params: Params) => { param: string; direction: "up" | "down" } | undefined;
}

const has = (p: Params, k: string) => typeof p[k] === "number" && Number.isFinite(p[k]);

const RULES: Rule[] = [
  // 損切りが近すぎ → 損切り幅を広げる
  { codes: ["stop_too_tight"], pick: (p) => (has(p, "stopAtr") ? { param: "stopAtr", direction: "up" } : undefined) },
  // 利益の取り逃し → トレーリングを詰める (無効なら利確幅を縮める)
  {
    codes: ["late_exit"],
    pick: (p) =>
      has(p, "trailAtr") && p.trailAtr > 0
        ? { param: "trailAtr", direction: "down" }
        : has(p, "tpAtr")
          ? { param: "tpAtr", direction: "down" }
          : undefined,
  },
  // 早すぎる利確 → 利確幅を広げる
  { codes: ["early_exit"], pick: (p) => (has(p, "tpAtr") ? { param: "tpAtr", direction: "up" } : undefined) },
  // 手数料負け・方向感の誤り → エントリーを厳選
  {
    codes: ["fee_drag", "wrong_direction"],
    pick: (p) => (has(p, "entryThreshold") ? { param: "entryThreshold", direction: "up" } : undefined),
  },
  // 時間切れ → 保有時間を短く
  { codes: ["time_decay"], pick: (p) => (has(p, "maxHoldBars") ? { param: "maxHoldBars", direction: "down" } : undefined) },
];

const paramsKey = (strategyId: string, assetClass: AssetClass) => `params:${strategyId}:${assetClass}`;
const metaKey = (id: string) => `adjmeta:${id}`;
const meanR = (ts: TradeRecord[]) => (ts.length ? ts.reduce((s, t) => s + (Number.isFinite(t.rMultiple) ? t.rMultiple : 0), 0) / ts.length : 0);
const round6 = (x: number) => Number(x.toPrecision(6));

/**
 * 要因分析の集計から標準名パラメータを小さく調整する。
 * 候補は validate (バックテスト) で現行と比較し、十分良い時だけ適用。悪化したら reviewApplied で元に戻す。
 */
export class ParamTuner {
  readonly opts: TunerOptions;

  constructor(private readonly deps: ParamTunerDeps) {
    this.opts = { ...DEFAULT_TUNER_OPTIONS, ...deps.options };
  }

  /** 現行パラメータ (既定値に学習済みの値を上書き。既定値に無いキーは無視) */
  currentParams(strategyId: string, assetClass: AssetClass, defaults: Params): Params {
    const saved = this.deps.store.kvGet<Params>(paramsKey(strategyId, assetClass)) ?? {};
    const out: Params = { ...defaults };
    for (const [k, v] of Object.entries(saved)) {
      if (k in defaults && Number.isFinite(v)) out[k] = v;
    }
    return out;
  }

  private setParam(strategyId: string, assetClass: AssetClass, param: string, value: number) {
    const key = paramsKey(strategyId, assetClass);
    const saved = this.deps.store.kvGet<Params>(key) ?? {};
    this.deps.store.kvSet(key, { ...saved, [param]: value });
  }

  /** 調整後の値 (bounds でクランプ)。変化しなければ undefined */
  nextValue(param: string, from: number, direction: "up" | "down", bounds: [number, number]): number | undefined {
    const [lo, hi] = bounds[0] <= bounds[1] ? bounds : [bounds[1], bounds[0]];
    const sign = direction === "up" ? 1 : -1;
    const step = param === "maxHoldBars" ? this.opts.holdStep : this.opts.step;
    let to: number;
    if (from === 0) {
      // 0 は倍率で動かないので範囲幅の一定割合で動かす
      to = from + sign * step * (hi - lo);
    } else {
      to = from * (1 + sign * step * Math.sign(from));
    }
    if (param === "maxHoldBars") {
      let r = Math.round(to);
      if (r === from) r = from + sign;
      to = r;
    }
    to = round6(Math.min(hi, Math.max(lo, to)));
    return Math.abs(to - from) < 1e-12 ? undefined : to;
  }

  private groupTrades(now: number): Map<string, TradeRecord[]> {
    const groups = new Map<string, TradeRecord[]>();
    for (const t of this.deps.store.listTrades({ since: now - this.opts.lookbackMs, until: now })) {
      const k = `${t.strategyId}\u0000${t.assetClass}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(t);
    }
    return groups;
  }

  private groupAdjustments(strategyId: string, assetClass: AssetClass): ParamAdjustment[] {
    return this.deps.store.listAdjustments({ strategyId }).filter((a) => a.assetClass === assetClass);
  }

  /** 評価待ちの適用済み調整があるか */
  private hasPendingReview(adjs: ParamAdjustment[]): boolean {
    return adjs.some((a) => a.status === "applied" && !this.deps.store.kvGet<AdjustmentMeta>(metaKey(a.id))?.reviewed);
  }

  /** 要因の重みの合計 / 件数 */
  causeShares(trades: TradeRecord[]): Partial<Record<CauseCode, number>> {
    const sums: Partial<Record<CauseCode, number>> = {};
    for (const t of trades) {
      const att =
        this.deps.store.getAttribution(t.id) ?? attributeTrade(t, { strategyRegimes: this.deps.strategyRegimes });
      for (const c of att.causes) sums[c.code] = (sums[c.code] ?? 0) + c.weight;
    }
    const out: Partial<Record<CauseCode, number>> = {};
    for (const [k, v] of Object.entries(sums)) out[k as CauseCode] = v / Math.max(1, trades.length);
    return out;
  }

  /** 全 (strategyId, assetClass) について 1 パラメータずつ調整を試みる */
  async run(now: number): Promise<ParamAdjustment[]> {
    const out: ParamAdjustment[] = [];
    for (const trades of this.groupTrades(now).values()) {
      const { strategyId, assetClass } = trades[0];
      const info = this.deps.getStrategy(strategyId);
      if (!info) continue;
      const adjs = this.groupAdjustments(strategyId, assetClass);
      if (this.hasPendingReview(adjs)) continue;
      // 前回の調整以降のトレードだけを使う (調整の効果を混ぜない・頻繁な再調整を防ぐ)
      const lastAdjAt = adjs.reduce((m, a) => Math.max(m, a.createdAt), Number.NEGATIVE_INFINITY);
      const recent = trades.filter((t) => t.entryTs >= lastAdjAt).slice(-this.opts.window);
      if (recent.length < this.opts.minSamples) continue;

      const shares = this.causeShares(recent);
      const current = this.currentParams(strategyId, assetClass, info.defaultParams);
      const ranked = RULES.map((r) => ({ rule: r, share: r.codes.reduce((s, c) => s + (shares[c] ?? 0), 0) }))
        .filter((x) => x.share >= this.opts.causeShare)
        .sort((a, b) => b.share - a.share);

      for (const { rule, share } of ranked) {
        const pick = rule.pick(current);
        if (!pick) continue;
        const bounds = info.paramBounds[pick.param];
        if (!bounds) continue; // 上下限が無いパラメータは自動調整しない
        const from = current[pick.param];
        const to = this.nextValue(pick.param, from, pick.direction, bounds);
        if (to === undefined) continue;
        const causeText = rule.codes.map((c) => `${c}(${CAUSE_LABEL[c]})`).join("+");
        const reason = `[rule] 直近 ${recent.length} 件で ${causeText} の比率 ${pct(share)} → ${pick.param} を ${from} → ${to}`;
        out.push(
          await this.evaluate({ strategyId, assetClass, param: pick.param, from, to, reason, current, preTrades: recent, now }),
        );
        break; // 1 回の調整は 1 パラメータずつ
      }
    }
    return out;
  }

  /** 外部 (LLM の振り返り等) からの提案。同じ検証経路を通す (検証なしで適用しない) */
  async propose(p: ParamProposal, now: number): Promise<ParamAdjustment | undefined> {
    const info = this.deps.getStrategy(p.strategyId);
    if (!info) {
      log.warn("未知の戦略への提案を無視", { strategyId: p.strategyId });
      return undefined;
    }
    const bounds = info.paramBounds[p.param];
    if (!bounds || !(p.param in info.defaultParams)) {
      log.warn("上下限の無いパラメータへの提案を無視", { strategyId: p.strategyId, param: p.param });
      return undefined;
    }
    const adjs = this.groupAdjustments(p.strategyId, p.assetClass);
    if (this.hasPendingReview(adjs)) {
      log.info("評価待ちの調整があるため提案を保留", { strategyId: p.strategyId, assetClass: p.assetClass });
      return undefined;
    }
    const current = this.currentParams(p.strategyId, p.assetClass, info.defaultParams);
    const from = current[p.param];
    const to = this.nextValue(p.param, from, p.direction, bounds);
    if (to === undefined) return undefined;
    const preTrades = this.deps.store
      .listTrades({ strategyId: p.strategyId, assetClass: p.assetClass, until: now, limit: this.opts.window });
    const reason = `[proposal] ${p.reason} → ${p.param} を ${from} → ${to}`;
    return this.evaluate({ strategyId: p.strategyId, assetClass: p.assetClass, param: p.param, from, to, reason, current, preTrades, now });
  }

  private async safeValidate(strategyId: string, assetClass: AssetClass, params: Params) {
    if (!this.deps.validate) return undefined;
    try {
      const r = await this.deps.validate(strategyId, assetClass, params);
      return r && Number.isFinite(r.score) && Number.isFinite(r.trades) ? r : undefined;
    } catch (e) {
      log.warn("パラメータ検証に失敗", { strategyId, assetClass, error: String(e) });
      return undefined;
    }
  }

  private async evaluate(a: {
    strategyId: string;
    assetClass: AssetClass;
    param: string;
    from: number;
    to: number;
    reason: string;
    current: Params;
    preTrades: TradeRecord[];
    now: number;
  }): Promise<ParamAdjustment> {
    const candidate: Params = { ...a.current, [a.param]: a.to };
    const base = await this.safeValidate(a.strategyId, a.assetClass, a.current);
    const cand = base ? await this.safeValidate(a.strategyId, a.assetClass, candidate) : undefined;

    let status: ParamAdjustment["status"] = "proposed";
    if (base && cand) {
      const need = Math.max(Math.abs(base.score) * this.opts.improveRatio, this.opts.minAbsImprove);
      status = cand.trades >= this.opts.minValidationTrades && cand.score >= base.score + need ? "applied" : "rejected";
    }
    const adj: ParamAdjustment = {
      id: randomUUID(),
      strategyId: a.strategyId,
      assetClass: a.assetClass,
      param: a.param,
      from: a.from,
      to: a.to,
      reason: a.reason,
      ...(base && cand ? { validation: { baselineScore: base.score, candidateScore: cand.score, trades: cand.trades } } : {}),
      status,
      createdAt: a.now,
    };
    const store = this.deps.store;
    if (status === "applied") {
      this.setParam(a.strategyId, a.assetClass, a.param, a.to);
      const meta: AdjustmentMeta = { preMeanR: meanR(a.preTrades), preN: a.preTrades.length, reviewed: false };
      store.kvSet(metaKey(adj.id), meta);
    }
    store.saveAdjustment(adj);
    store.audit({
      ts: a.now,
      type: "learning.param_adjust",
      data: { ...adj } as unknown as Record<string, unknown>,
    });
    log.info("パラメータ調整", { strategyId: adj.strategyId, assetClass: adj.assetClass, param: adj.param, from: adj.from, to: adj.to, status });
    return adj;
  }

  /**
   * 適用済み調整の事後評価。適用後に建てたトレードが minReviewSamples 件たまったら、
   * 平均 R が適用前より revertMarginR 以上悪化していれば元の値に戻して "reverted" にする。
   * 元に戻した調整を返す。
   */
  reviewApplied(now: number): ParamAdjustment[] {
    const store = this.deps.store;
    const reverted: ParamAdjustment[] = [];
    for (const adj of store.listAdjustments({ status: "applied" })) {
      const meta = store.kvGet<AdjustmentMeta>(metaKey(adj.id));
      if (!meta || meta.reviewed) continue;
      const post = store
        .listTrades({ strategyId: adj.strategyId, assetClass: adj.assetClass, since: adj.createdAt, until: now })
        .filter((t) => t.entryTs >= adj.createdAt)
        .slice(0, this.opts.window);
      if (post.length < this.opts.minReviewSamples) continue;
      const postMeanR = meanR(post);
      const worse = postMeanR < meta.preMeanR - this.opts.revertMarginR;
      if (worse) {
        this.setParam(adj.strategyId, adj.assetClass, adj.param, adj.from);
        const r: ParamAdjustment = {
          ...adj,
          status: "reverted",
          reason: `${adj.reason} / 適用後 ${post.length} 件の平均 ${postMeanR.toFixed(2)}R が適用前 ${meta.preMeanR.toFixed(2)}R より悪化したため元に戻した`,
        };
        store.saveAdjustment(r);
        store.audit({
          ts: now,
          type: "learning.param_revert",
          data: { id: adj.id, strategyId: adj.strategyId, assetClass: adj.assetClass, param: adj.param, from: adj.to, to: adj.from, preMeanR: meta.preMeanR, postMeanR, postN: post.length },
        });
        log.info("パラメータ調整を元に戻した", { id: adj.id, param: adj.param, preMeanR: meta.preMeanR, postMeanR });
        reverted.push(r);
      }
      store.kvSet(metaKey(adj.id), { ...meta, reviewed: true, postMeanR, postN: post.length });
    }
    return reverted;
  }
}
