import { randomUUID } from "node:crypto";
import { createLogger } from "../core/logger";
import type {
  AssetClass, CauseCode, ParamAdjustment, Params, RegimeLabel, Store, TradeAttribution, TradeRecord, TradingMode,
} from "../core/types";
import { attributeTrade, pct, tradeOutcome } from "./attribution";
import { proportionGreaterPValue, sampleStats, signTestPValue, welchLessPValue, type SampleStats } from "./stats";

const log = createLogger("tuner");

/** 戦略のパラメータ情報 (Strategy から必要な部分だけ) */
export interface StrategyParamInfo {
  defaultParams: Params;
  paramBounds: Record<string, [number, number]>;
}

/** 検証の 1 区間の成績 */
export interface ValidationFold {
  /** 区間 [from, to) */
  from: number;
  to: number;
  trades: number;
  /** R 倍数の合計 */
  sumR: number;
}

/** パラメータ 1 組の検証結果 (区間ごとの成績と全トレード) */
export interface ValidationRun {
  /**
   * 使ったデータの識別子 (銘柄・時間足・期間)。現行と候補は同じデータで比べる必要があるので、
   * 2 回の検証の間にキャッシュが更新されて dataKey が変わったら比較しない
   */
  dataKey: string;
  folds: ValidationFold[];
  /** 全区間のトレード (要因の基準比率の計算に使う) */
  trades: TradeRecord[];
}

/**
 * パラメータ候補の検証 (エンジンが長い履歴を区間に分けてバックテスト)。
 * 評価できなければ undefined (履歴の取得失敗・データ不足・板が必須の戦略など)。
 */
export type ParamValidator = (strategyId: string, assetClass: AssetClass, params: Params) => Promise<ValidationRun | undefined>;

/** パラメータ調整の提案 (LLM の振り返り等の外部から) */
export interface ParamProposal {
  strategyId: string;
  assetClass: AssetClass;
  param: string;
  direction: "up" | "down";
  reason: string;
}

export interface TunerOptions {
  /** 判断に使う直近の件数の上限 */
  window: number;
  /** 調整の判断に必要な最小件数 (前回の調整以降・現行パラメータでの取引) */
  minSamples: number;
  /**
   * 事後評価の比較対象 (判断に使った期間より前の、現行パラメータでの取引) の最小件数。
   * 足りなければ調整しない (適用後に悪化を検定できない変更は入れない)
   */
  minPreSamples: number;
  /** 要因の比率が検証データの基準比率より高いことの検定の有意水準 (片側) */
  causeAlpha: number;
  /** 発火に必要な、根拠となる取引の最小件数 */
  minCauseCount: number;
  /** 基準比率の計算に必要な検証データの最小取引数 */
  minBaselineTrades: number;
  /** 通常パラメータの調整幅 (10%) */
  step: number;
  /** maxHoldBars の調整幅 (15%) */
  holdStep: number;
  /** 区間ごとの勝ち負けの符号検定の有意水準 (片側) */
  signAlpha: number;
  /**
   * 合計の改善の下限 (1 取引あたりの R)。(候補の R 合計 − 現行の R 合計) / 現行の取引数 がこれ以上。
   * 区間の勝ち負けが揃っていても、実務上意味の無い小さな改善では変えない
   */
  minImproveR: number;
  /** 検証で必要な最小取引数 (現行・候補とも全区間の合計) */
  minValidationTrades: number;
  /** 適用後の評価に必要な件数 */
  minReviewSamples: number;
  /** 差し戻しの Welch の t 検定の有意水準 (片側, H1: 適用後の平均 R < 適用前) */
  revertAlpha: number;
  /** 差し戻しに必要な平均 R の悪化幅の下限 (既定 0 = 有意なら戻す) */
  revertMarginR: number;
  /** 評価待ちの期限。過ぎても件数が足りなければ「判定不能」として評価を終える (調整を止め続けない) */
  reviewExpiryMs: number;
  /** 集計対象のトレードを遡る期間 */
  lookbackMs: number;
  /** 同じ (戦略, 資産クラス, パラメータ, 変更後の値) の proposed / rejected がこの期間内にあれば再度作らない */
  dedupeMs: number;
}

/**
 * 既定値の根拠:
 * - signAlpha 0.1 / 5 区間 (検証側): 区間が 5 つなら 5 勝 0 敗 (p = 1/32) だけが合格。実力差が無ければ約 3% しか通らない。
 * - minImproveR 0.03: 合成データのシミュレーションで、手数料の R 換算の差など実力と無関係な系統差を除ける大きさ。
 * - causeAlpha 0.01: 9 ルールを同時に見るので Bonferroni 相当 (0.1 / 9) に厳しくする。ライブと検証データは期間 (相場) が違い比率が
 *   もともとずれるため、0.05 では実力差の無い合成データでも 30〜50% の試行でどれかが発火した (0.01 で 3〜17%)。候補は検証でさらに絞る。
 * - minReviewSamples 30 / revertAlpha 0.1: 効果が無いときに誤って戻す確率を 10% に抑える。
 */
export const DEFAULT_TUNER_OPTIONS: TunerOptions = {
  window: 60,
  minSamples: 20,
  minPreSamples: 20,
  causeAlpha: 0.01,
  minCauseCount: 3,
  minBaselineTrades: 30,
  step: 0.1,
  holdStep: 0.15,
  signAlpha: 0.1,
  minImproveR: 0.03,
  minValidationTrades: 30,
  minReviewSamples: 30,
  revertAlpha: 0.1,
  revertMarginR: 0,
  reviewExpiryMs: 14 * 86_400_000,
  lookbackMs: 30 * 86_400_000,
  dedupeMs: 7 * 86_400_000,
};

export interface ParamTunerDeps {
  store: Store;
  getStrategy: (strategyId: string) => StrategyParamInfo | undefined;
  validate?: ParamValidator;
  strategyRegimes?: Record<string, RegimeLabel[]>;
  options?: Partial<TunerOptions>;
  /** 学習状態 (パラメータ・調整履歴・集計対象の取引) の mode。省略時は paper */
  mode?: TradingMode;
}

/** 適用した調整の評価用メタ情報 (kv "adjmeta:<mode>:<id>") */
export interface AdjustmentMeta {
  /** 比較対象 (判断に使った期間より前の、同じパラメータでの取引) の平均 R・件数・不偏分散 */
  preMeanR: number;
  preN: number;
  /** 旧形式のメタには無い (その場合は適用後の分散で代用する) */
  preVar?: number;
  /** 比較対象の取引のエントリー時刻の範囲 */
  preFrom?: number;
  preTo?: number;
  /** 判断に使った取引の最初のエントリー時刻 */
  decisionFrom?: number;
  /** 評価待ちの期限 */
  reviewDeadline?: number;
  reviewed: boolean;
  /** kept: 悪化なし / reverted: 有意に悪化して戻した / inconclusive: 期限までに件数が足りず判定不能 */
  outcome?: "kept" | "reverted" | "inconclusive";
  postMeanR?: number;
  postN?: number;
  /** 差し戻しの検定の片側 p 値 */
  pValue?: number;
  /** 評価を終えた時刻 (reverted ならパラメータを戻した時刻) */
  closedAt?: number;
}

/**
 * 要因 → 調整ルール。
 * evidence は「このルールの根拠となる取引か」(0/1)。ライブの取引での比率が、同じ戦略・現行パラメータで
 * 検証データをバックテストしたときの比率 (基準) より有意に高いときだけ発火する。
 * 期待値ゼロのランダムな取引でも late_exit などは常に一定の比率で出るので、絶対値ではなく基準との比較で判定する。
 * パラメータごとに上げる・下げるの両方向のルールを置き、どちらの根拠が強いか (p 値) で選ぶ (上下限への偏りを防ぐ)。
 */
interface Rule {
  id: string;
  /** 根拠の説明 (調整理由に書く) */
  label: string;
  evidence: (t: TradeRecord, att: TradeAttribution) => boolean;
  pick: (params: Params) => { param: string; direction: "up" | "down" } | undefined;
}

const has = (p: Params, k: string) => typeof p[k] === "number" && Number.isFinite(p[k]);
const hasCause = (a: TradeAttribution, ...codes: CauseCode[]) => a.causes.some((c) => codes.includes(c.code));
const stopWidthPct = (t: TradeRecord) => (t.entryPrice > 0 ? Math.abs(t.entryPrice - t.initialStop) / t.entryPrice : 0);
const costPctOf = (t: TradeRecord) => Math.max(0, t.entryContext?.costBps ?? 0) / 1e4;
const postMove = (t: TradeRecord) => (typeof t.postExitMovePct === "number" && Number.isFinite(t.postExitMovePct) ? t.postExitMovePct : undefined);

export const TUNER_RULES: readonly Rule[] = [
  // 損切りで刈られた後、損切り幅以上に有利方向へ戻った (ノイズで刈られている) → 損切り幅を広げる
  {
    id: "stop_widen",
    label: "stop_too_tight (損切り後に損切り幅以上戻った)",
    evidence: (_t, a) => hasCause(a, "stop_too_tight"),
    pick: (p) => (has(p, "stopAtr") ? { param: "stopAtr", direction: "up" } : undefined),
  },
  // 勝ち取引が損切りの近くまで一度も逆行していない (損切りが必要以上に遠い)。
  // 損切り幅でサイズを決めるので、遠すぎる損切りは 1 取引あたりの R (利確幅 / 損切り幅) を小さくする → 損切り幅を狭める
  {
    id: "stop_tighten",
    label: "勝ち取引の最大含み損が損切り幅の 30% 未満 (損切りが遠すぎる)",
    evidence: (t) => {
      const sw = stopWidthPct(t);
      return tradeOutcome(t) === "win" && sw > 0 && typeof t.maePct === "number" && t.maePct < 0.3 * sw;
    },
    pick: (p) => (has(p, "stopAtr") ? { param: "stopAtr", direction: "down" } : undefined),
  },
  // 利確・シグナル決済の後にさらに伸びた → 利確幅を広げる
  {
    id: "tp_raise",
    label: "early_exit (利確後にさらに伸びた)",
    evidence: (_t, a) => hasCause(a, "early_exit"),
    pick: (p) => (has(p, "tpAtr") ? { param: "tpAtr", direction: "up" } : undefined),
  },
  // 十分な含み益を吐き出した → トレーリングを詰める (無効なら利確幅を縮める)
  {
    id: "exit_sooner",
    label: "late_exit (含み益の吐き出し)",
    evidence: (_t, a) => hasCause(a, "late_exit"),
    pick: (p) =>
      has(p, "trailAtr") && p.trailAtr > 0
        ? { param: "trailAtr", direction: "down" }
        : has(p, "tpAtr")
          ? { param: "tpAtr", direction: "down" }
          : undefined,
  },
  // トレーリングで決済した後、実現リターン以上に有利方向へ伸びた (トレーリングが近すぎる) → トレーリングを緩める
  {
    id: "trail_loosen",
    label: "トレーリング決済後にさらに伸びた",
    evidence: (t) => {
      const post = postMove(t);
      if (t.exitReason !== "trailing" || post === undefined) return false;
      return post > 0 && post >= Math.max(Math.abs(t.returnPct), costPctOf(t), 0.25 * stopWidthPct(t));
    },
    pick: (p) => (has(p, "trailAtr") && p.trailAtr > 0 ? { param: "trailAtr", direction: "up" } : undefined),
  },
  // 一度も有利に動かない損失・手数料負けが多い → エントリーを厳選
  {
    id: "entry_stricter",
    label: "wrong_direction / fee_drag (方向感の誤り・手数料負け)",
    evidence: (_t, a) => hasCause(a, "wrong_direction", "fee_drag"),
    pick: (p) => (has(p, "entryThreshold") ? { param: "entryThreshold", direction: "up" } : undefined),
  },
  // 計画通りの勝ち (他の要因なし) が基準より多い = 今の条件で入った取引の質が戦略の平時より高い。
  // 条件を少し緩めても質を保ったまま機会を増やせる可能性がある (仮説。採否は検証で決める) → エントリー条件を緩める
  {
    id: "entry_looser",
    label: "計画通りの勝ち (good_process) が基準より多い",
    evidence: (t, a) => tradeOutcome(t) === "win" && a.causes.length > 0 && a.causes.every((c) => c.code === "good_process"),
    pick: (p) => (has(p, "entryThreshold") ? { param: "entryThreshold", direction: "down" } : undefined),
  },
  // 時間切れ決済で値幅が小さい → 保有時間を短く
  {
    id: "hold_shorten",
    label: "time_decay (時間切れで値幅が小さい)",
    evidence: (_t, a) => hasCause(a, "time_decay"),
    pick: (p) => (has(p, "maxHoldBars") ? { param: "maxHoldBars", direction: "down" } : undefined),
  },
  // 時間切れで決済した後、有利方向へ大きく動いた (保有時間が短すぎる) → 保有時間を長く
  {
    id: "hold_extend",
    label: "時間切れ決済後に有利方向へ伸びた",
    evidence: (t) => {
      const post = postMove(t);
      return t.exitReason === "time" && post !== undefined && post > 0 && post >= Math.max(0.5 * stopWidthPct(t), 2 * costPctOf(t));
    },
    pick: (p) => (has(p, "maxHoldBars") ? { param: "maxHoldBars", direction: "up" } : undefined),
  },
];

/** 学習済みパラメータの kv キー (mode 別) */
export const paramsKey = (mode: TradingMode, strategyId: string, assetClass: AssetClass) => `params:${mode}:${strategyId}:${assetClass}`;
/** 適用した調整の評価用メタ情報の kv キー (mode 別) */
export const adjustmentMetaKey = (mode: TradingMode, id: string) => `adjmeta:${mode}:${id}`;
/**
 * パラメータ調整に使える取引 (推定約定 estimated と、paper で再現した空売り simulatedShort を除く)。
 * パラメータは買い・売り共通 (戦略×資産クラス) で、live に持ち込む調整の判断材料にするため、live で実行できない
 * 再現の空売りは集計・事後評価 (Welch の差し戻し) から外す (空売りは方向別の腕 …|short でだけ学習する)。
 * 区間検証のバックテストも mode を渡さないので現物の空売りは含まない (同じ基準)
 */
export const learnableTrades = (ts: TradeRecord[]) => ts.filter((t) => !t.estimated && !t.simulatedShort);
const rOf = (t: TradeRecord) => (Number.isFinite(t.rMultiple) ? t.rMultiple : 0);
const round6 = (x: number) => Number(x.toPrecision(6));
const fmtP = (p: number) => (p < 0.001 ? "<0.001" : p.toFixed(3));
const fmtR = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;

export interface CompareOptions {
  signAlpha: number;
  minImproveR: number;
  minValidationTrades: number;
}

export interface ValidationComparison {
  /** 同じデータ・同じ区間で比較できたか (false なら検証不能) */
  comparable: boolean;
  /** 候補の R 合計が現行より大きい / 小さい / 同じ区間の数 */
  wins: number;
  losses: number;
  ties: number;
  /** 符号検定の片側 p 値 */
  pValue: number;
  baseTrades: number;
  candTrades: number;
  baseSumR: number;
  candSumR: number;
  /** (候補の R 合計 − 現行の R 合計) / 現行の取引数 */
  improvementR: number;
  accepted: boolean;
  summary: string;
}

/**
 * 現行と候補の検証結果を区間ごとに比べる (純粋関数)。
 * 区間のスコアは R 合計 (= 取引数 × 期待 R。固定リスクのサイズ計算での損益に比例する)。
 * 合格: 区間ごとの差の符号検定が有意 (片側 p < signAlpha) かつ 合計の改善 ≥ minImproveR かつ 両方の総取引数 ≥ minValidationTrades。
 */
export function compareValidation(base: ValidationRun, cand: ValidationRun, o: CompareOptions): ValidationComparison {
  const sum = (r: ValidationRun, k: "trades" | "sumR") => r.folds.reduce((s, f) => s + (Number.isFinite(f[k]) ? f[k] : 0), 0);
  const baseTrades = sum(base, "trades");
  const candTrades = sum(cand, "trades");
  const baseSumR = sum(base, "sumR");
  const candSumR = sum(cand, "sumR");
  const comparable =
    base.dataKey === cand.dataKey &&
    base.folds.length > 0 &&
    base.folds.length === cand.folds.length &&
    base.folds.every((f, i) => f.from === cand.folds[i].from && f.to === cand.folds[i].to);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  if (comparable) {
    base.folds.forEach((f, i) => {
      const d = cand.folds[i].sumR - f.sumR;
      if (!Number.isFinite(d) || Math.abs(d) < 1e-9) ties++;
      else if (d > 0) wins++;
      else losses++;
    });
  }
  const pValue = comparable ? signTestPValue(wins, losses) : 1;
  const improvementR = (candSumR - baseSumR) / Math.max(1, baseTrades);
  const enough = baseTrades >= o.minValidationTrades && candTrades >= o.minValidationTrades;
  const accepted = comparable && enough && pValue < o.signAlpha && improvementR >= o.minImproveR;
  const summary = comparable
    ? `検証 ${base.folds.length} 区間で候補の勝ち ${wins} / 負け ${losses} / 同じ ${ties} (符号検定 p=${fmtP(pValue)})、` +
      `R 合計 ${baseSumR.toFixed(1)} → ${candSumR.toFixed(1)} (1 取引あたり ${fmtR(improvementR)})、取引数 ${baseTrades} → ${candTrades}`
    : "検証データが一致しないため比較できない";
  return { comparable, wins, losses, ties, pValue, baseTrades, candTrades, baseSumR, candSumR, improvementR, accepted, summary };
}

export interface RuleFiring {
  rule: Rule;
  /** ライブの取引のうち根拠となる取引の件数・比率 */
  liveCount: number;
  liveShare: number;
  /** 検証データ (現行パラメータのバックテスト) での件数・比率 */
  baseCount: number;
  baseShare: number;
  baseN: number;
  pValue: number;
}

/** ルールごとに「ライブの比率 > 基準比率」を検定し、発火したものを p 値の小さい順に返す (純粋関数) */
export function fireRules(
  live: { trade: TradeRecord; att: TradeAttribution }[],
  baseline: { trade: TradeRecord; att: TradeAttribution }[],
  o: { causeAlpha: number; minCauseCount: number },
  rules: readonly Rule[] = TUNER_RULES,
): RuleFiring[] {
  const out: RuleFiring[] = [];
  for (const rule of rules) {
    const liveCount = live.filter((x) => rule.evidence(x.trade, x.att)).length;
    const baseCount = baseline.filter((x) => rule.evidence(x.trade, x.att)).length;
    const pValue = proportionGreaterPValue(liveCount, live.length, baseCount, baseline.length);
    if (liveCount < o.minCauseCount || !(pValue < o.causeAlpha)) continue;
    out.push({
      rule,
      liveCount,
      liveShare: live.length ? liveCount / live.length : 0,
      baseCount,
      baseShare: baseline.length ? baseCount / baseline.length : 0,
      baseN: baseline.length,
      pValue,
    });
  }
  return out.sort((a, b) => a.pValue - b.pValue);
}

/**
 * 要因分析とライブの取引から標準名パラメータを小さく調整する。
 * 1. 要因の比率を、同じ戦略を検証データでバックテストしたときの比率 (基準) と比べ、有意に高いルールだけ発火させる。
 * 2. 候補は長い履歴を k 区間に分けたバックテストで現行と比べ、区間ごとの符号検定で有意に良く、改善幅・取引数も十分な時だけ適用。
 * 3. 適用後の実取引を、判断に使った期間より前の取引と Welch の t 検定で比べ、有意に悪化したら元に戻す (期限付き)。
 * パラメータ・調整履歴・集計対象の取引は mode 別 (集計は現在の mode かつ推定約定でない取引だけ)。
 */
export class ParamTuner {
  readonly opts: TunerOptions;
  readonly mode: TradingMode;

  constructor(private readonly deps: ParamTunerDeps) {
    this.opts = { ...DEFAULT_TUNER_OPTIONS, ...deps.options };
    this.mode = deps.mode ?? "paper";
  }

  private metaKey(id: string) {
    return adjustmentMetaKey(this.mode, id);
  }

  private getMeta(id: string): AdjustmentMeta | undefined {
    return this.deps.store.kvGet<AdjustmentMeta>(this.metaKey(id));
  }

  /**
   * 現行パラメータ (既定値に学習済みの値を上書き。既定値に無いキーは無視)。
   * 保存値は paramBounds でクランプする (bounds 変更後の古い値や壊れた kv を範囲外のまま使わない)。
   * bounds 省略時は getStrategy の paramBounds を使う。
   */
  currentParams(strategyId: string, assetClass: AssetClass, defaults: Params, bounds?: Record<string, [number, number]>): Params {
    const saved = this.deps.store.kvGet<Params>(paramsKey(this.mode, strategyId, assetClass)) ?? {};
    const b = bounds ?? this.deps.getStrategy(strategyId)?.paramBounds ?? {};
    const out: Params = { ...defaults };
    for (const [k, v] of Object.entries(saved)) {
      if (!(k in defaults) || typeof v !== "number" || !Number.isFinite(v)) continue;
      const range = b[k];
      if (range && Number.isFinite(range[0]) && Number.isFinite(range[1])) {
        const lo = Math.min(range[0], range[1]);
        const hi = Math.max(range[0], range[1]);
        out[k] = Math.min(hi, Math.max(lo, v));
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  private setParam(strategyId: string, assetClass: AssetClass, param: string, value: number) {
    const key = paramsKey(this.mode, strategyId, assetClass);
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
    for (const t of learnableTrades(this.deps.store.listTrades({ since: now - this.opts.lookbackMs, until: now, mode: this.mode }))) {
      const k = `${t.strategyId}\u0000${t.assetClass}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(t);
    }
    for (const g of groups.values()) g.sort((a, b) => a.entryTs - b.entryTs);
    return groups;
  }

  private groupAdjustments(strategyId: string, assetClass: AssetClass): ParamAdjustment[] {
    return this.deps.store.listAdjustments({ strategyId, mode: this.mode }).filter((a) => a.assetClass === assetClass);
  }

  private deadlineOf(adj: ParamAdjustment, meta: AdjustmentMeta): number {
    return meta.reviewDeadline ?? adj.createdAt + this.opts.reviewExpiryMs;
  }

  /**
   * 評価待ちの適用済み調整があるか。
   * 評価用メタ (adjmeta) が無い applied、期限切れのものは評価待ちとみなさない
   * (欠けたメタや、適用後に腕が無効化されて取引がたまらない調整で、その (戦略, 資産クラス) の調整が永久に止まるのを防ぐ)。
   */
  private hasPendingReview(adjs: ParamAdjustment[], now: number): boolean {
    return adjs.some((a) => {
      if (a.status !== "applied") return false;
      const meta = this.getMeta(a.id);
      return meta !== undefined && !meta.reviewed && now < this.deadlineOf(a, meta);
    });
  }

  /** 現行パラメータになった時刻 (直近の適用、または差し戻しの時刻) */
  private lastParamChangeAt(adjs: ParamAdjustment[]): number {
    let t = Number.NEGATIVE_INFINITY;
    for (const a of adjs) {
      if (a.status === "applied") t = Math.max(t, a.createdAt);
      else if (a.status === "reverted") t = Math.max(t, this.getMeta(a.id)?.closedAt ?? a.createdAt);
    }
    return t;
  }

  /** 直近 dedupeMs 以内に同じ内容の proposed / rejected があるか (同じ案の繰り返し記録を防ぐ) */
  private isDuplicate(adjs: ParamAdjustment[], param: string, to: number, now: number): boolean {
    return adjs.some(
      (a) =>
        (a.status === "proposed" || a.status === "rejected") &&
        a.param === param &&
        Math.abs(a.to - to) < 1e-12 &&
        now - a.createdAt <= this.opts.dedupeMs,
    );
  }

  private attributed(trades: TradeRecord[], useStored: boolean): { trade: TradeRecord; att: TradeAttribution }[] {
    return trades.map((t) => ({
      trade: t,
      att: (useStored ? this.deps.store.getAttribution(t.id) : undefined) ?? attributeTrade(t, { strategyRegimes: this.deps.strategyRegimes }),
    }));
  }

  /**
   * 判断に使う取引と、事後評価の比較対象の取引に分ける。
   * - sameParams: 現行パラメータになってからの取引 (lastChangeAt 以降)
   * - decision: sameParams のうち decisionStart 以降の直近の取引 (最大 window 件)。
   *   比較対象を確保するため、sameParams に余裕があれば古い minPreSamples 件は判断に使わない (判断は最低 minSamples 件)
   * - pre: sameParams のうち decision より前の直近 window 件 (判断と重ならない期間)
   */
  private split(trades: TradeRecord[], lastChangeAt: number, decisionStart: number) {
    const sameParams = trades.filter((t) => t.entryTs >= lastChangeAt);
    const candidates = sameParams.filter((t) => t.entryTs >= decisionStart);
    const room = Math.max(this.opts.minSamples, Math.min(this.opts.window, sameParams.length - this.opts.minPreSamples));
    const decision = candidates.slice(-room);
    const decisionFrom = decision.length ? decision[0].entryTs : Number.POSITIVE_INFINITY;
    const pre = sameParams.filter((t) => t.entryTs < decisionFrom).slice(-this.opts.window);
    return { decision, decisionFrom, pre };
  }

  /** 全 (strategyId, assetClass) について 1 パラメータずつ調整を試みる */
  async run(now: number): Promise<ParamAdjustment[]> {
    const out: ParamAdjustment[] = [];
    if (!this.deps.validate) return out; // 基準比率も検証もできないので何もしない (検証なしで変えない)
    for (const trades of this.groupTrades(now).values()) {
      const { strategyId, assetClass } = trades[0];
      const info = this.deps.getStrategy(strategyId);
      if (!info) continue;
      const adjs = this.groupAdjustments(strategyId, assetClass);
      if (this.hasPendingReview(adjs, now)) continue;
      // 判断には前回の調整 (却下も含む) 以降の取引だけを使う (同じ取引で繰り返し判断しない)
      const lastAttemptAt = adjs.reduce((m, a) => Math.max(m, a.createdAt), Number.NEGATIVE_INFINITY);
      const { decision, decisionFrom, pre } = this.split(trades, this.lastParamChangeAt(adjs), lastAttemptAt);
      if (decision.length < this.opts.minSamples) continue;
      if (pre.length < this.opts.minPreSamples) {
        log.debug("事後評価の比較対象 (判断より前の取引) が足りないため調整を見送り", { strategyId, assetClass, pre: pre.length });
        continue;
      }

      const current = this.currentParams(strategyId, assetClass, info.defaultParams, info.paramBounds);
      const base = await this.safeValidate(strategyId, assetClass, current);
      if (!base) continue; // 履歴を取得できない等: 基準比率が無いので判断しない (短い足で代用しない)
      if (base.trades.length < this.opts.minBaselineTrades) {
        log.debug("検証データの取引が少なく基準比率を決められないため調整を見送り", { strategyId, assetClass, trades: base.trades.length });
        continue;
      }
      const fired = fireRules(this.attributed(decision, true), this.attributed(base.trades, false), this.opts);

      for (const f of fired) {
        const pick = f.rule.pick(current);
        if (!pick) continue;
        const bounds = info.paramBounds[pick.param];
        if (!bounds) continue; // 上下限が無いパラメータは自動調整しない
        const from = current[pick.param];
        const to = this.nextValue(pick.param, from, pick.direction, bounds);
        if (to === undefined) continue;
        if (this.isDuplicate(adjs, pick.param, to, now)) continue; // 直近に同じ案がある
        const reason =
          `[rule:${f.rule.id}] 直近 ${decision.length} 件で ${f.rule.label} が ${pct(f.liveShare)} ` +
          `(検証データの基準 ${pct(f.baseShare)} / ${f.baseN} 件, 片側 p=${fmtP(f.pValue)}) → ${pick.param} を ${from} → ${to}`;
        out.push(await this.evaluate({ strategyId, assetClass, param: pick.param, from, to, reason, current, base, pre, decisionFrom, now }));
        break; // 1 回の調整は 1 パラメータずつ
      }
    }
    return out;
  }

  /**
   * 外部 (LLM の振り返り等) からの提案。同じ検証経路を通す (検証なしで適用しない)。
   * decisionFrom: 提案の判断に使った期間の開始 (振り返りの対象期間)。事後評価の比較対象はこれより前の取引にする。
   * 現行パラメータになってから判断期間内の取引が minSamples 件未満、または比較対象が minPreSamples 件未満なら提案を捨てる。
   */
  async propose(p: ParamProposal, now: number, opts: { decisionFrom?: number } = {}): Promise<ParamAdjustment | undefined> {
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
    if (this.hasPendingReview(adjs, now)) {
      log.info("評価待ちの調整があるため提案を保留", { strategyId: p.strategyId, assetClass: p.assetClass });
      return undefined;
    }
    const trades = learnableTrades(
      this.deps.store.listTrades({ strategyId: p.strategyId, assetClass: p.assetClass, since: now - this.opts.lookbackMs, until: now, mode: this.mode }),
    ).sort((a, b) => a.entryTs - b.entryTs);
    const lastChangeAt = this.lastParamChangeAt(adjs);
    // 判断期間が分からなければ直近 window 件を判断に使ったとみなす
    const decisionStart =
      opts.decisionFrom ?? (trades.filter((t) => t.entryTs >= lastChangeAt).slice(-this.opts.window)[0]?.entryTs ?? Number.POSITIVE_INFINITY);
    const { decision, decisionFrom, pre } = this.split(trades, lastChangeAt, decisionStart);
    if (decision.length < this.opts.minSamples || pre.length < this.opts.minPreSamples) {
      log.info("取引が少ないため提案を見送り", { strategyId: p.strategyId, assetClass: p.assetClass, decision: decision.length, pre: pre.length });
      return undefined;
    }
    const current = this.currentParams(p.strategyId, p.assetClass, info.defaultParams, info.paramBounds);
    const from = current[p.param];
    const to = this.nextValue(p.param, from, p.direction, bounds);
    if (to === undefined) return undefined;
    if (this.isDuplicate(adjs, p.param, to, now)) {
      log.info("直近に同じ調整案があるため提案を見送り", { strategyId: p.strategyId, assetClass: p.assetClass, param: p.param, to });
      return undefined;
    }
    const reason = `[proposal] ${p.reason} → ${p.param} を ${from} → ${to}`;
    const base = await this.safeValidate(p.strategyId, p.assetClass, current);
    return this.evaluate({ strategyId: p.strategyId, assetClass: p.assetClass, param: p.param, from, to, reason, current, base, pre, decisionFrom, now });
  }

  private async safeValidate(strategyId: string, assetClass: AssetClass, params: Params): Promise<ValidationRun | undefined> {
    if (!this.deps.validate) return undefined;
    try {
      const r = await this.deps.validate(strategyId, assetClass, params);
      if (!r || !Array.isArray(r.folds) || !Array.isArray(r.trades)) return undefined;
      return r.folds.every((f) => Number.isFinite(f.sumR) && Number.isFinite(f.trades)) ? r : undefined;
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
    base: ValidationRun | undefined;
    pre: TradeRecord[];
    decisionFrom: number;
    now: number;
  }): Promise<ParamAdjustment> {
    const candidate: Params = { ...a.current, [a.param]: a.to };
    const cand = a.base ? await this.safeValidate(a.strategyId, a.assetClass, candidate) : undefined;
    const cmp = a.base && cand ? compareValidation(a.base, cand, this.opts) : undefined;

    let status: ParamAdjustment["status"] = "proposed";
    if (cmp?.comparable) status = cmp.accepted ? "applied" : "rejected";
    const adj: ParamAdjustment = {
      id: randomUUID(),
      strategyId: a.strategyId,
      assetClass: a.assetClass,
      param: a.param,
      from: a.from,
      to: a.to,
      reason: cmp ? `${a.reason} / ${cmp.summary}` : `${a.reason} / 検証できず (履歴の取得失敗・データ不足など)`,
      ...(cmp?.comparable ? { validation: { baselineScore: cmp.baseSumR, candidateScore: cmp.candSumR, trades: cmp.candTrades } } : {}),
      status,
      createdAt: a.now,
      mode: this.mode,
    };
    const store = this.deps.store;
    const write = () => {
      if (status === "applied") {
        this.setParam(a.strategyId, a.assetClass, a.param, a.to);
        const pre = sampleStats(a.pre.map(rOf));
        const meta: AdjustmentMeta = {
          preMeanR: pre.mean,
          preN: pre.n,
          preVar: pre.variance,
          ...(a.pre.length ? { preFrom: a.pre[0].entryTs, preTo: a.pre[a.pre.length - 1].entryTs } : {}),
          ...(Number.isFinite(a.decisionFrom) ? { decisionFrom: a.decisionFrom } : {}),
          reviewDeadline: a.now + this.opts.reviewExpiryMs,
          reviewed: false,
        };
        store.kvSet(this.metaKey(adj.id), meta);
      }
      store.saveAdjustment(adj);
      store.audit({
        ts: a.now,
        type: "learning.param_adjust",
        data: {
          ...adj,
          ...(cmp ? { wins: cmp.wins, losses: cmp.losses, ties: cmp.ties, pValue: cmp.pValue, improvementR: cmp.improvementR, baseTrades: cmp.baseTrades } : {}),
        } as unknown as Record<string, unknown>,
      });
    };
    if (store.transaction) store.transaction(write);
    else write();
    log.info("パラメータ調整", { strategyId: adj.strategyId, assetClass: adj.assetClass, param: adj.param, from: adj.from, to: adj.to, status });
    return adj;
  }

  /**
   * 適用済み調整の事後評価。
   * 適用後に建てた取引 (現在の mode・推定約定を除く) が minReviewSamples 件たまったら、
   * 判断より前の取引 (メタに保存した平均・分散・件数) と Welch の t 検定で比べ、有意に悪化 (片側 p < revertAlpha) なら元の値に戻して "reverted" にする。
   * 期限 (reviewExpiryMs) までに件数が足りなければ「判定不能」として評価を終える (パラメータはそのまま)。
   * 元に戻した調整を返す。
   */
  reviewApplied(now: number): ParamAdjustment[] {
    const store = this.deps.store;
    const reverted: ParamAdjustment[] = [];
    for (const adj of store.listAdjustments({ status: "applied", mode: this.mode })) {
      const meta = this.getMeta(adj.id);
      if (!meta || meta.reviewed) continue;
      const deadline = this.deadlineOf(adj, meta);
      // 期限内にエントリーした取引だけで評価する (期限後の取引で遅れて差し戻さない。期限切れは判定不能として閉じる)
      const post = learnableTrades(
        store.listTrades({ strategyId: adj.strategyId, assetClass: adj.assetClass, since: adj.createdAt, until: now, mode: this.mode }),
      )
        .filter((t) => t.entryTs >= adj.createdAt && t.entryTs < deadline)
        .sort((a, b) => a.entryTs - b.entryTs)
        .slice(0, this.opts.window);
      if (post.length < this.opts.minReviewSamples) {
        if (now >= deadline) {
          store.kvSet(this.metaKey(adj.id), { ...meta, reviewed: true, outcome: "inconclusive", postN: post.length, closedAt: now } satisfies AdjustmentMeta);
          store.audit({
            ts: now,
            type: "learning.param_review_expired",
            data: { id: adj.id, mode: this.mode, strategyId: adj.strategyId, assetClass: adj.assetClass, param: adj.param, postN: post.length },
          });
          log.info("調整の事後評価が期限切れ (判定不能。パラメータはそのまま)", { id: adj.id, param: adj.param, postN: post.length });
        }
        continue;
      }
      const postStats = sampleStats(post.map(rOf));
      // 旧形式のメタ (分散なし) は適用後の分散で代用する
      const preStats: SampleStats = { n: meta.preN, mean: meta.preMeanR, variance: meta.preVar ?? postStats.variance };
      const w = welchLessPValue(postStats, preStats);
      const testable = preStats.n >= 2;
      const worse = testable && w.p < this.opts.revertAlpha && postStats.mean < meta.preMeanR - this.opts.revertMarginR;
      const outcome: AdjustmentMeta["outcome"] = !testable ? "inconclusive" : worse ? "reverted" : "kept";
      const write = () => {
        if (worse) {
          this.setParam(adj.strategyId, adj.assetClass, adj.param, adj.from);
          const r: ParamAdjustment = {
            ...adj,
            status: "reverted",
            reason:
              `${adj.reason} / 適用後 ${post.length} 件の平均 ${postStats.mean.toFixed(2)}R が適用前 ${meta.preN} 件の ${meta.preMeanR.toFixed(2)}R より` +
              `有意に悪化 (Welch t=${w.t.toFixed(2)}, 片側 p=${fmtP(w.p)}) したため元に戻した`,
          };
          store.saveAdjustment(r);
          store.audit({
            ts: now,
            type: "learning.param_revert",
            data: {
              id: adj.id, mode: this.mode, strategyId: adj.strategyId, assetClass: adj.assetClass, param: adj.param, from: adj.to, to: adj.from,
              preMeanR: meta.preMeanR, preN: meta.preN, postMeanR: postStats.mean, postN: post.length, pValue: w.p,
            },
          });
          reverted.push(r);
        }
        store.kvSet(this.metaKey(adj.id), {
          ...meta, reviewed: true, outcome, postMeanR: postStats.mean, postN: post.length, pValue: w.p, closedAt: now,
        } satisfies AdjustmentMeta);
      };
      if (store.transaction) store.transaction(write);
      else write();
      log.info(worse ? "パラメータ調整を元に戻した" : "パラメータ調整の事後評価", { id: adj.id, param: adj.param, preMeanR: meta.preMeanR, postMeanR: postStats.mean, p: w.p, outcome });
    }
    return reverted;
  }
}
