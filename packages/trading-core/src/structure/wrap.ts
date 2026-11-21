/**
 * 相場構造 (ダウ理論) のフィルターと損切りを、既存の戦略に後から掛けるラッパー。
 *
 * 戦略をラップするので、エンジン・バックテスト・パラメータ検証 (createParamValidator) のどれでも同じように効く
 * (エンジン側は変更しない)。新しい売買シグナルは作らない。元の戦略が出したシグナルを選別し、損切り位置を置き直すだけ。
 *
 * - 新規エントリー: 執行足 (主時間足) の目線と同じ方向だけ通す。useMTF なら上位足の目線とも一致が必要。
 *   目線が none・ちゃぶつき・conservative の weakening 中は通さない。
 *   通さなかったシグナルは ctx.onFiltered(signal, "structure_*") で知らせる (エンジンは仮想トレード
 *   `strategy_filter:structure_*` として観測専用で記録する。除外したシグナルが本当に悪かったかの検証用)。
 * - stopMode "structure": 損切り = 押し安値 − ATR × stopAtrBuffer (売りは 戻り高値 + ATR × stopAtrBuffer)。
 *   利確は元のシグナルの R 倍数 (利確幅 / 損切り幅) を保つように置き直す。数量は RiskManager が損切り幅から計算する
 *   (損切りが遠いほどロットは小さくなる。リスク判定は迂回しない)。
 * - exitOnReversal / exitOnWeakening: 保有中に目線が逆へ転換した (weakening に入った) ら決済のシグナル (flat) を返す。
 *
 * 先読みしない: 使うのは ctx.market の確定足だけ (上位足も確定足だけ。無ければ執行足から確定分だけ集約する)。
 * 構造は各時間足の直近 STRUCTURE_WINDOW_BARS 本で毎回計算し直す (純粋関数。同じ入力なら同じ出力)。
 */
import { D, floorToStep, toNum } from "../core/decimal";
import { TIMEFRAME_MS, type Candle, type MarketView, type Signal, type Strategy, type StrategyContext, type Timeframe } from "../core/types";
import { atrLast } from "../indicators/series";
import { exitSignal, positionSide, refPrice } from "../strategies/common";
import { resolveStructureOptions, structureAt } from "./machine";
import { higherCandles, higherTimeframeOf } from "./mtf";
import {
  DEFAULT_PERFECT_ORDER, type Bias, type BiasMethod, type BreakMode, type PerfectOrderOptions, type ReversalMode, type StructureState,
} from "./types";

export type StructureStopMode = "existing" | "structure";

/** ラッパーの設定 (環境変数 STRUCTURE_* から作る。src/structure/settings.ts) */
export interface StructureFilterConfig {
  pivotN: number;
  breakMode: BreakMode;
  biasMethod: BiasMethod;
  reversalMode: ReversalMode;
  useMTF: boolean;
  usePerfectOrder: boolean;
  perfectOrder: PerfectOrderOptions;
  stopMode: StructureStopMode;
  stopAtrBuffer: number;
  exitOnReversal: boolean;
  exitOnWeakening: boolean;
  chopM: number;
  chopR: number;
}

export const DEFAULT_STRUCTURE_FILTER_CONFIG: Readonly<StructureFilterConfig> = {
  pivotN: 6,
  breakMode: "close",
  biasMethod: "method1",
  reversalMode: "purist",
  useMTF: true,
  usePerfectOrder: false,
  perfectOrder: DEFAULT_PERFECT_ORDER,
  stopMode: "existing",
  stopAtrBuffer: 0.3,
  exitOnReversal: false,
  exitOnWeakening: false,
  chopM: 50,
  chopR: 3,
};

/** フィルターで通さなかった理由 (onFiltered に渡す) */
export type StructureFilterReason =
  | "structure_none"
  | "structure_weakening"
  | "structure_choppy"
  | "structure_bias"
  | "structure_mtf"
  | "structure_po"
  | "structure_stop";

/**
 * 構造を計算する足の本数 (各時間足の直近)。hub の履歴 (historyLimit 300) とバックテストの既定 (300 本以上) に合わせ、
 * 運用とバックテストで同じ長さの窓になるようにする
 */
export const STRUCTURE_WINDOW_BARS = 300;
/** 構造の損切り幅の許容範囲: 元の損切り幅の 0.5〜3 倍、ATR の 0.5 倍以上 (範囲外は structure_stop で通さない) */
export const STOP_DIST_MIN_RATIO = 0.5;
export const STOP_DIST_MAX_RATIO = 3;
export const STOP_DIST_MIN_ATR = 0.5;
/** 構造の ATR の期間 (損切りのバッファ用) */
export const STRUCTURE_ATR_PERIOD = 14;

/**
 * 構造の判定に必要な本数の目安 (その時間足で)。SH・SL が 2 つずつ確定するには最短で約 5N 本かかるので余裕を見て 8N + 1。
 * 足りないときは bias が none になり、新規エントリーは通さない。
 * 注: バックテストはこの本数を warmup としてゲートに使うが、運用 (live) には warmup のゲートが無い。hub の足が溜まるまでは
 * structure_none / structure_mtf で見送られる (害はない。通さないだけ)
 */
export const structureWarmupBars = (pivotN: number): number => 8 * Math.max(1, Math.round(pivotN)) + 1;

/** ラップ済みの戦略 (元の戦略と設定を参照できる) */
export interface StructureWrappedStrategy extends Strategy {
  readonly inner: Strategy;
  readonly structureConfig: Readonly<StructureFilterConfig>;
}

export function isStructureWrapped(s: Strategy): s is StructureWrappedStrategy {
  return typeof (s as Partial<StructureWrappedStrategy>).inner === "object" && typeof (s as Partial<StructureWrappedStrategy>).structureConfig === "object";
}

/** フィルターに使う目線 (method1: 押し安値・戻り高値、method2: HH/HL・LH/LL、both: 両方が一致したときだけ) */
export function effectiveBias(s: Pick<StructureState, "bias" | "trendConfirmed">, method: BiasMethod): Bias {
  if (method === "method2") return s.trendConfirmed;
  if (method === "both") return s.bias === s.trendConfirmed ? s.bias : "none";
  return s.bias;
}

export const biasNum = (b: Bias): number => (b === "up" ? 1 : b === "down" ? -1 : 0);

const tailOf = (c: readonly Candle[] | undefined, n: number): Candle[] => (!c ? [] : c.length > n ? c.slice(c.length - n) : c.slice());

const ceilToStep = (value: number, step: number): number => (step > 0 ? toNum(D(value).div(step).ceil().mul(step)) : value);
const floorTick = (value: number, step: number): number => (step > 0 ? toNum(floorToStep(value, step)) : value);

export function resolveStructureFilterConfig(cfg: Partial<StructureFilterConfig> = {}): StructureFilterConfig {
  const d = DEFAULT_STRUCTURE_FILTER_CONFIG;
  const m: StructureFilterConfig = { ...d, ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined)) };
  const o = resolveStructureOptions({ pivotN: m.pivotN, breakMode: m.breakMode, reversalMode: m.reversalMode, chopM: m.chopM, chopR: m.chopR });
  const buf = Number.isFinite(m.stopAtrBuffer) ? Math.min(2, Math.max(0, m.stopAtrBuffer)) : d.stopAtrBuffer;
  return {
    ...m,
    pivotN: o.pivotN,
    breakMode: o.breakMode,
    reversalMode: o.reversalMode,
    // ちゃぶつきの窓は構造の窓 (STRUCTURE_WINDOW_BARS) を超えられない
    chopM: Math.min(o.chopM, STRUCTURE_WINDOW_BARS),
    chopR: o.chopR,
    biasMethod: m.biasMethod === "method2" || m.biasMethod === "both" ? m.biasMethod : "method1",
    stopMode: m.stopMode === "structure" ? "structure" : "existing",
    stopAtrBuffer: buf,
  };
}

/**
 * 戦略を相場構造のフィルター・損切りでラップする。
 * id・horizon・assetClasses・regimes・paramBounds・defaultParams は元のまま。timeframes に上位足を加え (hub がその足を取るように。
 * 1w は hub に無ければ 1d から集約するので加えない)、warmup は構造の判定に必要な本数 (上位足の分を主時間足に換算) まで延ばす。
 */
export function withStructure(strategy: Strategy, cfgIn: Partial<StructureFilterConfig> = {}): StructureWrappedStrategy {
  const inner = isStructureWrapped(strategy) ? strategy.inner : strategy;
  const cfg = Object.freeze(resolveStructureFilterConfig(cfgIn));
  const exec = inner.primaryTimeframe;
  const upper = cfg.useMTF ? higherTimeframeOf(exec) : undefined;
  const opts = resolveStructureOptions({
    pivotN: cfg.pivotN, breakMode: cfg.breakMode, reversalMode: cfg.reversalMode, chopM: cfg.chopM, chopR: cfg.chopR,
    ...(cfg.usePerfectOrder ? { perfectOrder: cfg.perfectOrder } : {}),
  });
  const upperOpts = resolveStructureOptions({ pivotN: cfg.pivotN, breakMode: cfg.breakMode, reversalMode: cfg.reversalMode, chopM: cfg.chopM, chopR: cfg.chopR });
  const need = structureWarmupBars(cfg.pivotN);
  const execMs = TIMEFRAME_MS[exec];
  const upperNeed = upper ? Math.ceil((need * TIMEFRAME_MS[upper]) / execMs) : 0;
  const warmup = Math.max(inner.warmup, need, upperNeed);
  const timeframes: Timeframe[] = [...inner.timeframes];
  if (upper && upper !== "1w" && !timeframes.includes(upper)) timeframes.push(upper);
  // 元の戦略に渡す足の本数 (バックテストの既定 max(300, warmup + 100) と同じ)。ラップで warmup が延びても、
  // 元の戦略が見る足の長さ (指標の初期値) は変えない (A: ラップなし との比較をそろえるため)
  const innerHistory = Math.max(300, inner.warmup + 100);
  const meta = { id: inner.id, horizon: inner.horizon, primaryTimeframe: inner.primaryTimeframe };

  const innerView = (view: MarketView): MarketView => {
    let candles: MarketView["candles"] | undefined;
    for (const [tf, c] of Object.entries(view.candles) as [Timeframe, Candle[] | undefined][]) {
      if (c && c.length > innerHistory) {
        candles ??= { ...view.candles };
        candles[tf] = c.slice(c.length - innerHistory);
      }
    }
    return candles ? { ...view, candles } : view;
  };

  const evaluate = (ctx: StrategyContext): Signal | null => {
    const view = ctx.market;
    const iv = innerView(view);
    const sig = inner.evaluate(iv === view ? ctx : { ...ctx, market: iv });
    const side = positionSide(ctx);

    let execState: StructureState | undefined;
    const execCandles = () => tailOf(view.candles[exec], STRUCTURE_WINDOW_BARS);
    const st = (): StructureState => (execState ??= structureAt(execCandles(), undefined, opts));

    if (side) {
      // 保有中: 元の戦略の決済 (flat / 逆方向) を優先。その後に構造による決済
      if (sig && (sig.direction === "flat" || sig.direction !== side)) return sig;
      if (cfg.exitOnReversal || cfg.exitOnWeakening) {
        const s = st();
        const eb = effectiveBias(s, cfg.biasMethod);
        const against = side === "long" ? "down" : "up";
        const feats = { structBias: biasNum(eb), structOshiYasune: s.oshiYasune ?? 0, structModoriTakane: s.modoriTakane ?? 0 };
        if (cfg.exitOnReversal && eb === against) {
          return exitSignal(ctx, meta, 1, `構造: 保有方向と逆の目線へ転換 (${eb})`, feats);
        }
        const weak = side === "long" ? "weakeningUp" : "weakeningDown";
        if (cfg.exitOnWeakening && s.regime === weak) {
          return exitSignal(ctx, meta, 1, `構造: 転換の途中 (${weak})`, feats);
        }
      }
      return sig;
    }
    if (!sig || sig.direction === "flat") return sig;

    const dir = sig.direction;
    const want: Bias = dir === "long" ? "up" : "down";
    const s = st();
    const eb = effectiveBias(s, cfg.biasMethod);
    let upperBias: Bias | undefined;
    if (upper) {
      const uc = tailOf(higherCandles(view, exec, upper), STRUCTURE_WINDOW_BARS);
      upperBias = effectiveBias(structureAt(uc, undefined, upperOpts), cfg.biasMethod);
    }
    const features: Record<string, number> = {
      structBias: biasNum(eb),
      structMtfBias: upperBias ? biasNum(upperBias) : 0,
      structOshiYasune: s.oshiYasune ?? 0,
      structModoriTakane: s.modoriTakane ?? 0,
      structChoppy: s.choppy ? 1 : 0,
    };
    const withFeatures: Signal = { ...sig, features: { ...sig.features, ...features } };
    const reject = (reason: StructureFilterReason): null => {
      ctx.onFiltered?.(withFeatures, reason);
      return null;
    };

    if (s.regime === "weakeningUp" || s.regime === "weakeningDown") return reject("structure_weakening");
    if (eb === "none") return reject("structure_none");
    if (s.choppy) return reject("structure_choppy");
    if (eb !== want) return reject("structure_bias");
    if (upper && upperBias !== want) return reject("structure_mtf");
    if (cfg.usePerfectOrder && s.perfectOrder !== want) return reject("structure_po");
    if (cfg.stopMode !== "structure") return withFeatures;

    // 構造の損切り: 押し安値 − ATR × buffer (売りは 戻り高値 + ATR × buffer)。利確は元の R 倍数を保つ
    const lvl = dir === "long" ? s.oshiYasune : s.modoriTakane;
    const ec = execCandles();
    const atr = atrLast(ec, STRUCTURE_ATR_PERIOD);
    const last = ec.length ? ec[ec.length - 1].close : NaN;
    // 想定エントリー価格: 指値の価格があればそれ (エンジン・バックテストの intended と同じ)、無ければ成行の気配。
    // 成行の基準は refPrice (買いは ask、売りは bid)。maker の指値で約定する場合は約定価格と
    // スプレッド 1 本分ほどずれることがある (許容する)
    const price = sig.entry.type === "limit" && sig.entry.price && sig.entry.price > 0 ? sig.entry.price : refPrice(ctx, dir, last);
    if (lvl === null || !Number.isFinite(atr) || !(atr >= 0) || !(price > 0)) return reject("structure_stop");
    const tick = view.instrument.tickSize;
    const stopRaw = dir === "long" ? lvl - atr * cfg.stopAtrBuffer : lvl + atr * cfg.stopAtrBuffer;
    const stop = dir === "long" ? floorTick(stopRaw, tick) : ceilToStep(stopRaw, tick);
    // 押し安値 (戻り高値) がエントリー価格の反対側にある・損切りが無効なら通さない
    if (dir === "long" ? !(lvl < price && stop < price && stop > 0) : !(lvl > price && stop > price)) return reject("structure_stop");
    const oldDist = Math.abs(price - sig.stopLoss);
    const newDist = Math.abs(price - stop);
    // 損切り幅の妥当性: 元の損切り幅の 0.5〜3 倍、かつ ATR の 0.5 倍以上 (ATR は戦略の features.atr を優先し、無ければ執行足の ATR14)
    const stratAtr = sig.features?.atr;
    const refAtr = typeof stratAtr === "number" && Number.isFinite(stratAtr) && stratAtr > 0 ? stratAtr : atr;
    if (!(oldDist > 0) || newDist < STOP_DIST_MIN_RATIO * oldDist || newDist > STOP_DIST_MAX_RATIO * oldDist || newDist < STOP_DIST_MIN_ATR * refAtr) {
      return reject("structure_stop");
    }
    let takeProfit: number | undefined;
    if (sig.takeProfit !== undefined) {
      const r = Math.abs(sig.takeProfit - price) / oldDist;
      const tpRaw = dir === "long" ? price + r * newDist : price - r * newDist;
      const tp = dir === "long" ? ceilToStep(tpRaw, tick) : floorTick(tpRaw, tick);
      // 置き直した利確が利益側 (買いは価格より上、売りは下) に無い・0 以下なら、黙って外さず通さない
      if (!Number.isFinite(tp) || !(tp > 0) || (dir === "long" ? !(tp > price) : !(tp < price))) return reject("structure_stop");
      takeProfit = tp;
    }
    // 期待値幅は目標までの距離に比例させる (利確が無ければ max(トレーリング幅, 損切り幅))。
    // 損切りが広がっても期待値は増やさない (縮むときだけ比例して縮める): min(1, 新目標 / 元目標)
    const trailDist = sig.trailingStopPct !== undefined ? sig.trailingStopPct * price : 0;
    const oldTarget = sig.takeProfit !== undefined ? Math.abs(sig.takeProfit - price) : Math.max(trailDist, oldDist);
    const newTarget = takeProfit !== undefined ? Math.abs(takeProfit - price) : Math.max(trailDist, newDist);
    const edgeRatio = oldTarget > 0 && Number.isFinite(newTarget / oldTarget) ? Math.min(1, newTarget / oldTarget) : 1;
    const out: Signal = {
      ...withFeatures,
      stopLoss: stop,
      expectedEdgeBps: sig.expectedEdgeBps * edgeRatio,
      features: { ...withFeatures.features, structStopAtr: atr, structStopDist: newDist, structOrigStopDist: oldDist },
    };
    if (takeProfit !== undefined) out.takeProfit = takeProfit;
    else delete out.takeProfit;
    return out;
  };

  return { ...inner, timeframes, warmup, evaluate, inner, structureConfig: cfg };
}

/**
 * 構造のフィルターで通さなかった件数を理由別に数えるための包み (比較コマンド・simulate の集計用)。
 * 判定は変えない (onFiltered をそのまま元の呼び出し側へも渡す)。数えるのは structure_* の理由だけ
 */
export function withFilterCounter<S extends Strategy>(s: S, counts: Record<string, number>): S {
  return {
    ...s,
    evaluate(ctx: StrategyContext): Signal | null {
      const prev = ctx.onFiltered;
      return s.evaluate({
        ...ctx,
        onFiltered: (sig, reason) => {
          if (reason.startsWith("structure_")) counts[reason] = (counts[reason] ?? 0) + 1;
          prev?.(sig, reason);
        },
      });
    },
  };
}
