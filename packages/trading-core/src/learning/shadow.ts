/**
 * 見送ったシグナルの答え合わせ (シャドー学習)。
 *
 * 戦略が flat 以外のシグナルを出したのに発注しなかったもの (コスト比・リスク判定の拒否・direction_bias・
 * arm_disabled・lower_score・新規停止中など) を「仮想トレード」として記録し、毎ティックの気配で
 * 損切り・利確・時間切れを判定する。決済したら onClosed で学習側へ渡す (アロケーターの重み付き更新・集計)。
 *
 * - 実際の発注・リスク判定・建玉管理には一切関与しない (呼び出し側は例外を握りつぶす)。
 * - 未決済は kv `shadow:open:<mode>` に保存し、再起動後も続ける。
 * - R は統計値なので number で計算する (会計値ではない)。
 * - 約定の見積もりはバックテスト (src/backtest/engine.ts) と同じ考え方で、楽観しない:
 *   - 約定ずれ (片道) は資産クラス別のバックテストの既定値 (defaultCosts: crypto 1 / meme 20 bps。未知のクラスは crypto の値)。手数料は銘柄の taker 手数料 (往復)
 *   - エントリー: 買いは ask + 約定ずれ、売りは bid − 約定ずれ
 *   - 損切り: 決済側 (買い: bid / 売り: ask) で判定し、ストップ価格 (窓開けで越えていれば現在の決済側の気配) に約定ずれを不利側に加えて約定
 *   - 利確: 指値扱い (約定ずれなし)。時間切れ: 決済側の気配 ∓ 約定ずれ
 *   - エントリーした 1m 足 (確定後) も判定に含める。その足にはエントリー前の値動きも入るので、不利側 (損切り・MAE) にだけ使い、
 *     有利側 (利確・MFE) はエントリー時刻以降に始まった足と毎ティックの気配だけで判定する (保守的。確定足だけを使うので先読みはしない)
 * - 読みの管理 (options.thesis が有効): シグナルに最大保有・読みの期限があった仮想トレード (thesisExpectedMs あり) は、
 *   実際の建玉と同じ src/engine/thesis.ts の規則で 途中で読み外れ / 期限で読み外れ / 延長 / 延長の上限 を判定する。
 *   純 R は「今時間切れで決済したら」の netR (約定ずれ・借入コスト込み)。延長後の建値・トレーリングは
 *   延長した時点からの有利な極値 (thesisPeak。延長した時点の決済側の気配から始め、延長した時刻以降に始まった 1m 足と気配だけで進める)
 *   から計算する。前回の判定までの極値を使い (同じ判定の足の高値でストップを上げない = 保守的)、延長した判定ではストップを判定しない。
 *   延長後の保護ストップに触れたかは、延長した時刻以降に始まった 1m 足と気配だけで判定する (当初の損切りは従来どおり)。決済理由は trailing。
 *   途中で読み外れは値動きだけの R (方向 × (仲値 − エントリー価格) / 1R) で判定する (コストだけでは切らない)。
 *   thesisExpectedMs は読みの管理が有効なときだけ記録する。
 *   thesisExpectedMs の無い古い記録は従来どおり。
 * - 転換で決済 (options.reversal が有効で、戦略が対象): 実際の建玉と同じ src/engine/reversalExit.ts の規則で、実際の建玉と同じ時間足
 *   (REVERSAL_EXIT_TF。lower = 戦略の主時間足の 1 つ下、same = 主時間足。呼び出し側が exitTimeframe で渡し、記録時に reversalTf として保存)
 *   の新しい確定足ごとに 1 回、エントリー後にできた押し安値 (売りは戻り高値。REVERSAL_EXIT_FALLBACK なら無いときエントリーした足の安値・高値) を終値が越えたら
 *   決済する (理由 reversal、約定は時間切れと同じ 決済側の気配 ∓ 約定ずれ)。足は呼び出し側 (engine) が hub の確定足をそのまま渡す
 *   (hub は全戦略の時間足と転換で決済の時間足を持つので、1m 以外もリサンプルしない)。その時間足の足が無い・エントリーより新しい足しか無いときは判定しない。
 *   損切り・利確・読みの管理 (ティックごと) が先。reversalTf の無い古い記録・無効のときは従来どおり。
 * - 決済を自分で管理する戦略 (options.managesOwnExit が true を返す戦略 id。Strategy.managesOwnExit = trend_4h): 実際の建玉と同じく
 *   読みの管理・転換で決済・建値ストップを使わない (損切り・利確・maxHoldMs の時間切れだけ。戦略の決済シグナルは仮想トレードでは再現しない)。
 * - 建値ストップ (options.breakeven の triggerR > 0。src/engine/breakeven.ts): 実際の建玉と同じ規則。気配の仲値が entryMid から
 *   triggerR × 1R 有利に動いたら、保護ストップを往復コスト込みの建値 (エントリーの約定 (仲値 ± 半スプレッド ± 約定ずれ)・
 *   往復の手数料・発動時の半スプレッド) へ引き上げる (breakevenArmedAt / breakevenStop。一度上げたら戻さない)。
 *   発動した判定ではストップを判定せず、発動した時刻以降に始まった 1m 足と、次の判定以降の気配だけで判定する。決済理由は trailing。
 */
import { randomUUID } from "node:crypto";
import { defaultCosts } from "../backtest/engine";
import { costFeeRate } from "../core/fees";
import {
  advancePeak, decideThesis, resolveThesisMs, thesisGrossR, thesisOutcomeOf, thesisTrailStop, tighterStop, type ThesisSettings,
} from "../engine/thesis";
import { D } from "../core/decimal";
import type { HoldingCostModel } from "../core/holdingCost";
import { checkReversal, reversalAppliesTo, type ReversalSettings } from "../engine/reversalExit";
import { breakevenEnabled, breakevenStopPrice, breakevenTriggered, type BreakevenSettings } from "../engine/breakeven";
import {
  TIMEFRAME_MS, type AssetClass, type Candle, type Horizon, type Instrument, type Quote, type RegimeLabel, type ShadowExitReason, type ShadowTradeRecord,
  type Signal, type Store, type Timeframe, type TradingMode,
} from "../core/types";

export interface ShadowOptions {
  /**
   * 約定ずれ (片道, bps) を全資産クラスで固定する上書き。
   * 未指定ならバックテストと同じ資産クラス別の既定値 (shadowSlippageBps → backtest の defaultCosts)
   */
  slippageBps?: number;
  /** 未決済の上限 (全体)。超えた分は捨てる */
  maxOpen: number;
  /** 1 分あたりの新規作成の上限。超えた分は捨てる */
  maxPerMinute: number;
  /** シグナルに maxHoldMs が無い (0 以下) ときの保有上限 */
  defaultMaxHoldMs: number;
  /** 読みの管理 (省略・無効なら従来どおり maxHoldMs で時間切れ) */
  thesis?: ThesisSettings;
  /** 転換で決済 (省略・無効なら判定しない = 従来どおり) */
  reversal?: ReversalSettings;
  /** 建値ストップ (省略・0 なら発動しない = 従来どおり。発動済みの仮想トレードは保存したストップで守る) */
  breakeven?: BreakevenSettings;
  /**
   * 建玉の保有コストのモデル (src/core/holdingCost.ts。FX のスワップ・株式の信用の金利など)。
   * 省略時は従来どおり、記録した再現の空売りの借入コスト (simulatedShort・borrowRateDaily) だけ
   */
  holdingCost?: HoldingCostModel;
  /** 保有コストのモデルに渡す mode (既定 paper) */
  holdingCostMode?: TradingMode;
  /**
   * 戦略 id の持ち主が決済を自分で管理するか (Strategy.managesOwnExit。engine が渡す)。true の仮想トレードは
   * 読みの管理・転換で決済・建値ストップを使わない (損切り・利確・maxHoldMs の時間切れは従来どおり)。省略時は従来どおり
   */
  managesOwnExit?: (strategyId: string) => boolean;
}

export const DEFAULT_SHADOW_OPTIONS: ShadowOptions = {
  maxOpen: 200,
  maxPerMinute: 30,
  defaultMaxHoldMs: 24 * 3_600_000,
};

/** 未決済の仮想トレード */
export interface ShadowOpen extends Omit<ShadowTradeRecord, "exitTs" | "exitPrice" | "exitReason" | "grossR" | "costR" | "netR" | "mfeR" | "maeR"> {
  /** 1R (価格) */
  risk: number;
  mfeR: number;
  maeR: number;
  /** 判定に使った最後の 1m 確定足の開始時刻 (同じ足を二重に使わない) */
  lastCandleTs?: number;
  /**
   * 読みの管理で延長した後の有利な極値 (決済側の価格: 買いは bid 側の高値、売りは ask 側の安値)。
   * 延長した時点の決済側の気配から始め、延長した時刻以降に始まった 1m 足と気配だけで進める。決済の記録には残さない
   */
  thesisPeak?: number;
  /** 延長後の保護ストップ (きつくなる方へだけ更新する。決済の記録には残さない) */
  thesisStop?: number;
  /** 建値ストップを発動した時刻 (決済の記録には残さない) */
  breakevenArmedAt?: number;
  /** 建値ストップ (往復コスト込みの建値。発動時に決めて戻さない。決済の記録には残さない) */
  breakevenStop?: number;
  /** 転換で決済を判定する時間足 (戦略の主時間足。転換で決済が有効で戦略が対象のときだけ。決済の記録には残さない) */
  reversalTf?: Timeframe;
  /** 転換で決済を最後に判定した確定足の開始時刻 (確定足ごとに 1 回。決済の記録には残さない) */
  reversalBarTs?: number;
}

/** 件数の記録 (捨てた理由別) */
export interface ShadowCounters {
  created: number;
  closed: number;
  duplicate: number;
  droppedCap: number;
  droppedRate: number;
  invalid: number;
  unwatched: number;
}

export interface ShadowRecordInput {
  instrument: Pick<Instrument, "symbol" | "assetClass" | "takerFeeRate"> & Partial<Pick<Instrument, "fixedFeePerOrder" | "costModel">>;
  quote: Pick<Quote, "bid" | "ask">;
  signal: Pick<Signal, "strategyId" | "direction" | "confidence" | "expectedEdgeBps" | "stopLoss" | "takeProfit" | "maxHoldMs" | "expectedMs"> & { horizon?: Horizon };
  regime: RegimeLabel;
  /** 見送り理由 (正規化したキー) */
  reason: string;
  now: number;
  /**
   * paper で再現した空売り (取引所では空売りできない現物の売り)。腕は方向別のキー (…|short) で学習し、
   * 借入コスト (エントリーの仲値 × borrowRateDaily × 保有日数) を costR / netR に含める
   */
  simulatedShort?: boolean;
  borrowRateDaily?: number;
  /** 転換で決済の判定に使う時間足 (REVERSAL_EXIT_TF で決めた時間足。省略時は転換で決済を判定しない) */
  exitTimeframe?: Timeframe;
}

/** 前回の判定以降の値幅 (1m 確定足の高値・安値。仲値ベース) */
export interface PriceRange {
  high: number;
  low: number;
  /** 使った足の最後の開始時刻 */
  lastCandleTs: number;
}

/**
 * エンジンが新規停止中に記録した仮想トレードの見送り理由 (腕の更新に使わない)。
 * - "halted": リスク管理の停止中 (日次損失上限・kill switch)。engine.ts の ctx.halted の経路
 * - "order_unknown": 状態不明の注文による新規エントリーの一時停止 (entriesPaused)
 * - "risk: キルスイッチ作動中…" / "risk: 日次損失上限により…停止中": 同じティック内で停止に入り evaluateEntry が拒否したもの
 *   (normalizeReason で数字は # に置き換わるので前方一致で見る)
 */
export const HALT_SHADOW_REASONS: readonly string[] = ["halted", "order_unknown"];
export const HALT_SHADOW_REASON_PREFIXES: readonly string[] = ["risk: キルスイッチ作動中", "risk: 日次損失上限により"];

/** 停止中に記録された仮想トレードか (腕の更新から外す) */
export function isHaltShadowReason(reason: string | undefined): boolean {
  if (typeof reason !== "string") return false;
  return HALT_SHADOW_REASONS.includes(reason) || HALT_SHADOW_REASON_PREFIXES.some((p) => reason.startsWith(p));
}

/**
 * 戦略自身が自分の条件 (コスト) で見送ったシグナルの仮想トレードの理由の接頭辞 (StrategyContext.onFiltered)。
 * 測定専用で、保存はするが腕・情報の効き具合には使わない
 */
export const OBSERVE_ONLY_SHADOW_REASON_PREFIX = "strategy_filter:";

export function isObserveOnlyShadowReason(reason: string | undefined): boolean {
  return typeof reason === "string" && reason.startsWith(OBSERVE_ONLY_SHADOW_REASON_PREFIX);
}

export const shadowOpenKey = (mode: TradingMode) => `shadow:open:${mode}`;
export const shadowCountersKey = (mode: TradingMode) => `shadow:counters:${mode}`;

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const dedupeKey = (symbol: string, strategyId: string, direction: string) => `${symbol}|${strategyId}|${direction}`;
const MINUTE = 60_000;

/**
 * 仮想トレードの約定ずれ (片道, bps)。上書きが無ければバックテストと同じ既定値
 * (銘柄のコストの前提 costModel があればその値 (Jupiter は価格影響を気配のスプレッドに含めるので 0)、無ければ資産クラス別)
 */
export function shadowSlippageBps(assetClass: AssetClass, override?: number, costModel?: Instrument["costModel"]): number {
  if (finite(override) && override >= 0) return override;
  if (costModel && finite(costModel.slippageBps) && costModel.slippageBps >= 0) return costModel.slippageBps;
  const c = defaultCosts(assetClass)?.slippageBps;
  return finite(c) && c >= 0 ? c : 2;
}

/** 決済の約定 (価格) */
export interface ShadowExitFill {
  /** 決済の約定価格 (決済側の価格。買いの決済は bid 側、売りは ask 側。約定ずれ込み) */
  fill: number;
  /** 決済時のスプレッドの半分 */
  halfSpread: number;
  /** 決済の約定ずれ (≥ 0) */
  slip: number;
}

/**
 * 仮想トレードを閉じたときの R (純粋関数)。
 * - 約定: エントリー = 仲値 ± (スプレッドの半分 + 約定ずれ)、決済 = exit.fill。手数料は約定価格 × taker 手数料 (往復)
 * - netR = (方向 × (決済の約定 − エントリーの約定) − 手数料) / 1R
 * - grossR = 方向 × (決済の仲値換算 − エントリーの仲値) / 1R (決済の仲値換算 = fill ± (半スプレッド + 約定ずれ))、costR = grossR − netR
 * exit に数値を渡したときは仲値ベースの決済価格とみなし、エントリー時のスプレッドの半分と約定ずれ (片道) を差し引いて約定させる
 */
export function shadowR(
  o: Pick<ShadowOpen, "direction" | "entryMid" | "entrySpread" | "risk" | "takerFeeRate" | "slippageBps">,
  exit: number | ShadowExitFill,
): { grossR: number; costR: number; netR: number } {
  const dir = o.direction === "long" ? 1 : -1;
  const rate = Math.max(0, finite(o.slippageBps) ? o.slippageBps : 0) / 10_000;
  const entryHalf = Math.max(0, o.entrySpread) / 2;
  const entrySlip = rate * o.entryMid;
  let x: ShadowExitFill;
  if (typeof exit === "number") {
    const half = entryHalf;
    const slip = rate * exit;
    x = { fill: exit - dir * (half + slip), halfSpread: half, slip };
  } else {
    x = { fill: exit.fill, halfSpread: Math.max(0, exit.halfSpread), slip: Math.max(0, exit.slip) };
  }
  const entryFill = o.entryMid + dir * (entryHalf + entrySlip);
  const exitRef = x.fill + dir * (x.halfSpread + x.slip);
  const fee = Math.max(0, o.takerFeeRate) * (Math.abs(entryFill) + Math.abs(x.fill));
  const grossR = (dir * (exitRef - o.entryMid)) / o.risk;
  const netR = (dir * (x.fill - entryFill) - fee) / o.risk;
  return { grossR, costR: grossR - netR, netR };
}

export interface ShadowTrackerDeps {
  store: Store;
  mode: TradingMode;
  /** 決済した仮想トレード (学習へ渡す)。例外は握りつぶして続ける */
  onClosed?: (t: ShadowTradeRecord) => void;
  options?: Partial<ShadowOptions>;
  onError?: (where: string, e: unknown) => void;
}

/** MFE/MAE だけが変わった場合の kv 保存の最短間隔 */
export const SHADOW_SAVE_INTERVAL_MS = 45_000;

export class ShadowTracker {
  readonly opts: ShadowOptions;
  readonly mode: TradingMode;
  private readonly store: Store;
  private readonly onClosed?: (t: ShadowTradeRecord) => void;
  private readonly onError?: (where: string, e: unknown) => void;
  private open: ShadowOpen[];
  private readonly keys = new Set<string>();
  /** 直近 1 分の作成時刻 (レート上限用。再起動で数え直す) */
  private recent: number[] = [];
  private counters: ShadowCounters;
  private dirty = false;
  private countersDirty = false;
  /** 決済・新規追加・監視解除など、間引かずに保存したい変化があった */
  private urgent = false;
  private lastSaveTs = -Infinity;

  constructor(deps: ShadowTrackerDeps) {
    this.store = deps.store;
    this.mode = deps.mode;
    this.onClosed = deps.onClosed;
    this.onError = deps.onError;
    this.opts = { ...DEFAULT_SHADOW_OPTIONS, ...(deps.options ?? {}) };
    const saved = deps.store.kvGet<ShadowOpen[]>(shadowOpenKey(deps.mode));
    this.open = Array.isArray(saved) ? saved.filter((o) => o && finite(o.risk) && o.risk > 0) : [];
    for (const o of this.open) this.keys.add(dedupeKey(o.symbol, o.strategyId, o.direction));
    this.counters = {
      created: 0, closed: 0, duplicate: 0, droppedCap: 0, droppedRate: 0, invalid: 0, unwatched: 0,
      ...(deps.store.kvGet<Partial<ShadowCounters>>(shadowCountersKey(deps.mode)) ?? {}),
    };
  }

  /** 持ち主の戦略が決済を自分で管理するか (options.managesOwnExit。無ければ false) */
  private ownExit(strategyId: string): boolean {
    try {
      return this.opts.managesOwnExit?.(strategyId) === true;
    } catch {
      return false;
    }
  }

  /** 未決済の仮想トレード (複製) */
  list(): ShadowOpen[] {
    return this.open.map((o) => ({ ...o }));
  }

  get size(): number {
    return this.open.length;
  }

  stats(): ShadowCounters {
    return { ...this.counters };
  }

  /** 未決済がある銘柄 */
  symbols(): string[] {
    return [...new Set(this.open.map((o) => o.symbol))];
  }

  /**
   * 見送ったシグナルを仮想トレードとして記録する。作成したら true。
   * flat・不正な損切り・重複 (同じ銘柄・戦略・方向で未決済あり)・上限超過は記録しない
   */
  record(input: ShadowRecordInput): boolean {
    const { instrument: inst, quote: q, signal: sig, now } = input;
    if (sig.direction !== "long" && sig.direction !== "short") return false;
    const key = dedupeKey(inst.symbol, sig.strategyId, sig.direction);
    if (this.keys.has(key)) {
      this.counters.duplicate++;
      this.countersDirty = true;
      return false;
    }
    const long = sig.direction === "long";
    const entryPrice = long ? q.ask : q.bid;
    const risk = long ? entryPrice - sig.stopLoss : sig.stopLoss - entryPrice;
    if (!(q.bid > 0) || !(q.ask >= q.bid) || !finite(sig.stopLoss) || !(sig.stopLoss > 0) || !(risk > 0) || !finite(risk)) {
      this.counters.invalid++;
      this.countersDirty = true;
      return false;
    }
    if (this.open.length >= this.opts.maxOpen) {
      this.counters.droppedCap++;
      this.countersDirty = true;
      return false;
    }
    this.recent = this.recent.filter((t) => now - t < MINUTE && t <= now);
    if (this.recent.length >= this.opts.maxPerMinute) {
      this.counters.droppedRate++;
      this.countersDirty = true;
      return false;
    }
    const tpOk = finite(sig.takeProfit) && (long ? sig.takeProfit > entryPrice : sig.takeProfit < entryPrice);
    // 決済を自分で管理する戦略 (managesOwnExit) は読みの管理・転換で決済を使わない (実際の建玉と同じ)
    const ownExit = this.ownExit(sig.strategyId);
    // 読みの期限 (シグナルの expectedMs、無ければ最大保有。読みの管理が有効なときだけ)。既定の保有上限 (defaultMaxHoldMs) は読みの期限にしない
    const thesisMs = !ownExit && this.opts.thesis?.enabled === true ? resolveThesisMs(sig.expectedMs, sig.maxHoldMs) : undefined;
    // 転換で決済の時間足 (有効で戦略が対象のときだけ記録する)
    const reversalTf = !ownExit && input.exitTimeframe && TIMEFRAME_MS[input.exitTimeframe] && reversalAppliesTo(this.opts.reversal, sig.strategyId) ? input.exitTimeframe : undefined;
    const o: ShadowOpen = {
      id: `sh_${now.toString(36)}_${randomUUID().slice(0, 8)}`,
      mode: this.mode,
      symbol: inst.symbol,
      assetClass: inst.assetClass as AssetClass,
      strategyId: sig.strategyId,
      horizon: sig.horizon ?? "scalp",
      regime: input.regime,
      direction: sig.direction,
      reason: input.reason,
      confidence: finite(sig.confidence) ? sig.confidence : 0,
      expectedEdgeBps: finite(sig.expectedEdgeBps) ? sig.expectedEdgeBps : 0,
      entryTs: now,
      entryPrice,
      entryMid: (q.bid + q.ask) / 2,
      entrySpread: q.ask - q.bid,
      stopLoss: sig.stopLoss,
      ...(tpOk ? { takeProfit: sig.takeProfit } : {}),
      maxHoldMs: finite(sig.maxHoldMs) && sig.maxHoldMs > 0 ? sig.maxHoldMs : this.opts.defaultMaxHoldMs,
      ...(thesisMs !== undefined ? { thesisExpectedMs: thesisMs } : {}),
      // 手数料は taker 率 + 約定ごとの固定手数料の率換算 (Jupiter のネットワーク手数料。src/core/fees.ts)
      takerFeeRate: finite(inst.takerFeeRate) ? costFeeRate(inst) : 0,
      slippageBps: shadowSlippageBps(inst.assetClass as AssetClass, this.opts.slippageBps, inst.costModel),
      risk,
      mfeR: 0,
      maeR: 0,
      ...(input.simulatedShort && !long
        ? { simulatedShort: true, borrowRateDaily: finite(input.borrowRateDaily) ? Math.max(0, input.borrowRateDaily) : 0 }
        : {}),
      ...(reversalTf ? { reversalTf } : {}),
    };
    this.open.push(o);
    this.keys.add(key);
    this.recent.push(now);
    this.counters.created++;
    this.dirty = true;
    this.urgent = true;
    this.countersDirty = true;
    return true;
  }

  /**
   * 新しい気配で全件を判定する (毎ティック)。
   * - 監視をやめた銘柄 (isWatched が false) の仮想トレードは捨てる (学習に使わない)
   * - 損切りは決済側 (買い: bid / 売り: ask) で判定。同じ判定で損切りと利確の両方に届きうる場合は損切りを先にする
   * - 損切りはストップ価格 (窓開けなら決済側の気配) に約定ずれを不利側に加えて約定。利確は指値。時間切れは決済側の気配 ∓ 約定ずれ
   * - rangeOf の 1m 確定足: エントリーした足も含める (不利側だけ。ファイル冒頭)
   * - candlesOf: 転換で決済の判定に使う、その時間足の確定足 (昇順。最後が直近の確定足)。省略時は転換で決済を判定しない
   * 決済したものを返す。kv への保存は変化があったときだけ (1 回)
   */
  update(
    now: number,
    quoteOf: (symbol: string) => Pick<Quote, "bid" | "ask"> | undefined,
    opts: {
      isWatched?: (symbol: string) => boolean;
      rangeOf?: (symbol: string, sinceTs: number) => PriceRange | undefined;
      candlesOf?: (symbol: string, tf: Timeframe) => readonly Candle[] | undefined;
    } = {},
  ): ShadowTradeRecord[] {
    const closed: ShadowTradeRecord[] = [];
    const keep: ShadowOpen[] = [];
    for (const o of this.open) {
      if (opts.isWatched && !opts.isWatched(o.symbol)) {
        this.counters.unwatched++;
        this.keys.delete(dedupeKey(o.symbol, o.strategyId, o.direction));
        this.dirty = true;
        this.urgent = true;
        this.countersDirty = true;
        continue;
      }
      const q = quoteOf(o.symbol);
      if (!q || !(q.bid > 0) || !(q.ask >= q.bid)) {
        keep.push(o);
        continue;
      }
      let adverse: PriceRange | undefined;
      let favorable: PriceRange | undefined;
      let thesisFav: PriceRange | undefined;
      let breakevenRange: PriceRange | undefined;
      try {
        if (opts.rangeOf) {
          if (o.lastCandleTs === undefined) {
            // まだ足を使っていない: 不利側はエントリーした足から、有利側はエントリー時刻以降に始まった足から
            const entryBar = Math.floor(o.entryTs / MINUTE) * MINUTE;
            adverse = opts.rangeOf(o.symbol, entryBar);
            favorable = entryBar === o.entryTs ? adverse : opts.rangeOf(o.symbol, o.entryTs);
          } else {
            adverse = favorable = opts.rangeOf(o.symbol, o.lastCandleTs + 1);
          }
          // 延長後の極値は、延長した時刻以降に始まった足だけで進める (延長より前の高値・安値を使わない)
          if (o.thesisExtendedAt !== undefined) {
            thesisFav = opts.rangeOf(o.symbol, o.lastCandleTs !== undefined ? Math.max(o.lastCandleTs + 1, o.thesisExtendedAt) : o.thesisExtendedAt);
          }
          // 建値ストップは、発動した時刻以降に始まった足だけで判定する (発動より前の安値・高値で決済しない)
          if (o.breakevenArmedAt !== undefined) {
            breakevenRange = opts.rangeOf(o.symbol, o.lastCandleTs !== undefined ? Math.max(o.lastCandleTs + 1, o.breakevenArmedAt) : o.breakevenArmedAt);
          }
        }
      } catch (e) {
        this.onError?.("shadow.range", e);
      }
      // 転換で決済: 戦略の主時間足の確定足 (有効で、記録時に時間足を保存した仮想トレードだけ)
      let revCandles: readonly Candle[] | undefined;
      try {
        if (o.reversalTf && opts.candlesOf && reversalAppliesTo(this.opts.reversal, o.strategyId) && !this.ownExit(o.strategyId)) revCandles = opts.candlesOf(o.symbol, o.reversalTf);
      } catch (e) {
        this.onError?.("shadow.candles", e);
      }
      const key = () => `${o.mfeR}|${o.maeR}|${o.lastCandleTs ?? ""}|${o.thesisExtendedAt ?? ""}|${o.thesisPeak ?? ""}|${o.thesisStop ?? ""}|${o.breakevenStop ?? ""}`;
      const before = key();
      const res = this.step(o, q, now, adverse, favorable, thesisFav, revCandles, breakevenRange);
      if (!res) {
        if (before !== key()) this.dirty = true;
        keep.push(o);
        continue;
      }
      this.dirty = true;
      this.urgent = true;
      this.keys.delete(dedupeKey(o.symbol, o.strategyId, o.direction));
      this.counters.closed++;
      this.countersDirty = true;
      closed.push(res);
    }
    this.open = keep;
    this.flush(now, false);
    for (const t of closed) {
      try {
        this.onClosed?.(t);
      } catch (e) {
        this.onError?.("shadow.onClosed", e);
      }
    }
    return closed;
  }

  /**
   * 1 件の判定 (決済したら記録を返す)。o の MFE / MAE は更新する。
   * adverse: 不利側 (損切り・MAE) に使う足の値幅、favorable: 有利側 (利確・MFE) に使う足の値幅 (どちらも仲値ベース)。
   * thesisFav: 延長した時刻以降に始まった足の値幅 (延長後の極値と、延長後の保護ストップの判定に使う)。
   * revCandles: 転換で決済の判定に使う時間足 (o.reversalTf) の確定足 (無ければ判定しない)。
   * breakevenRange: 建値ストップを発動した時刻以降に始まった足の値幅 (建値ストップの判定に使う)
   */
  private step(
    o: ShadowOpen, q: Pick<Quote, "bid" | "ask">, now: number, adverse?: PriceRange, favorable?: PriceRange, thesisFav?: PriceRange,
    revCandles?: readonly Candle[], breakevenRange?: PriceRange,
  ): ShadowTradeRecord | undefined {
    const long = o.direction === "long";
    const dir = long ? 1 : -1;
    const half = (q.ask - q.bid) / 2;
    const mid = (q.bid + q.ask) / 2;
    const exitSide = long ? q.bid : q.ask;
    const ok = (r?: PriceRange): r is PriceRange => !!r && finite(r.high) && finite(r.low) && r.high >= r.low && r.high > 0;
    const adv = ok(adverse) ? adverse : undefined;
    const fav = ok(favorable) ? favorable : undefined;
    // 決済側の価格の範囲 (足は仲値ベースなので現在のスプレッドの半分をずらす)
    const advExit = long ? Math.min(q.bid, adv ? adv.low - half : Infinity) : Math.max(q.ask, adv ? adv.high + half : -Infinity);
    const favExit = long ? Math.max(q.bid, fav ? fav.high - half : -Infinity) : Math.min(q.ask, fav ? fav.low + half : Infinity);
    const advMid = long ? Math.min(mid, adv ? adv.low : Infinity) : Math.max(mid, adv ? adv.high : -Infinity);
    const favMid = long ? Math.max(mid, fav ? fav.high : -Infinity) : Math.min(mid, fav ? fav.low : Infinity);
    const lastTs = Math.max(adv?.lastCandleTs ?? -Infinity, fav?.lastCandleTs ?? -Infinity);
    if (Number.isFinite(lastTs)) o.lastCandleTs = Math.max(o.lastCandleTs ?? -Infinity, lastTs);

    // 読みの管理 (延長後の保護ストップは、この判定で更新する前の延長後の極値 = 前回までの有利な極値から計算する)
    const thesis = this.opts.thesis?.enabled === true && finite(o.thesisExpectedMs) && o.thesisExpectedMs > 0 ? this.opts.thesis : undefined;
    const rate = Math.max(0, finite(o.slippageBps) ? o.slippageBps : 0) / 10_000;
    const entryFill = o.entryMid + dir * (Math.max(0, o.entrySpread) / 2 + rate * o.entryMid);
    const pricing = { direction: o.direction, entryPrice: entryFill, risk: o.risk, entryFeePerUnit: Math.max(0, o.takerFeeRate) * entryFill, takerFeeRate: Math.max(0, o.takerFeeRate) };
    const wasExtended = o.thesisExtendedAt !== undefined;
    // 延長後の保護ストップ: 保存済みのストップと今の計算のきつい方 (設定が変わっても緩めない。読みの管理が無効になっても保存済みで守る)。
    // 当初の損切りより有利なときだけ使う
    let thesisStop: number | undefined;
    if (wasExtended) {
      const cur = thesis ? thesisTrailStop(pricing, o.thesisPeak ?? Number.NaN, thesis.trailR) : undefined;
      const t = tighterStop(o.direction, o.thesisStop, cur);
      if (t !== undefined && (long ? t > o.stopLoss : t < o.stopLoss)) thesisStop = t;
    }
    // 延長後の保護ストップは、延長した時刻以降に始まった足と気配だけで判定する (延長より前の安値・高値で決済しない)。
    // 当初の損切りは従来どおりの範囲で判定する
    const tr = ok(thesisFav) ? thesisFav : undefined;
    const thesisAdvExit = long ? Math.min(q.bid, tr ? tr.low - half : Infinity) : Math.max(q.ask, tr ? tr.high + half : -Infinity);

    // MFE / MAE (仲値ベース, R)
    o.mfeR = Math.max(o.mfeR, (dir * (favMid - o.entryMid)) / o.risk, 0);
    o.maeR = Math.max(o.maeR, (dir * (o.entryMid - advMid)) / o.risk, 0);

    const thesisHit = thesisStop !== undefined && (long ? thesisAdvExit <= thesisStop : thesisAdvExit >= thesisStop);
    // 建値ストップ (発動済みで当初の損切りより有利なときだけ。発動した時刻以降に始まった足と今の気配で判定する)
    const beStop = finite(o.breakevenStop) && (long ? o.breakevenStop > o.stopLoss : o.breakevenStop < o.stopLoss) ? o.breakevenStop : undefined;
    const br = ok(breakevenRange) ? breakevenRange : undefined;
    const beAdvExit = long ? Math.min(q.bid, br ? br.low - half : Infinity) : Math.max(q.ask, br ? br.high + half : -Infinity);
    const beHit = beStop !== undefined && (long ? beAdvExit <= beStop : beAdvExit >= beStop);
    const stopHit = long ? advExit <= o.stopLoss : advExit >= o.stopLoss;
    const tp = o.takeProfit;
    const tpHit = tp !== undefined && (long ? favExit >= tp : favExit <= tp);
    const timeSlip = rate * exitSide;
    const timeExit: ShadowExitFill = { fill: exitSide - dir * timeSlip, halfSpread: half, slip: timeSlip };
    const stopFill = (stop: number): ShadowExitFill => {
      // 窓開けで越えていれば現在の決済側の気配。約定ずれを不利側に加える
      const level = long ? Math.min(stop, q.bid) : Math.max(stop, q.ask);
      const slip = rate * level;
      return { fill: level - dir * slip, halfSpread: half, slip };
    };
    let reason: ShadowExitReason | undefined;
    let exit: ShadowExitFill | undefined;
    if (thesisHit || beHit) {
      // 延長後の保護ストップ・建値ストップ (当初の損切りより建玉に近いので先に触れる。両方に触れたらきつい方 = 先に触れた方)
      reason = "trailing";
      exit = stopFill(thesisHit && beHit ? tighterStop(o.direction, thesisStop, beStop)! : thesisHit ? thesisStop! : beStop!);
    } else if (stopHit) {
      // 保守的に損切りを先にする
      reason = "stop";
      exit = stopFill(o.stopLoss);
    } else if (tpHit) {
      reason = "take_profit";
      exit = { fill: tp!, halfSpread: half, slip: 0 };
    } else if (thesis) {
      const netR = this.closeR(o, timeExit, now).netR;
      // 途中で読み外れは値動きだけ (仲値 − エントリー価格) で判定する (コストだけでは切らない)
      const grossR = thesisGrossR({ direction: o.direction, entryPrice: o.entryPrice, risk: o.risk }, mid);
      const d = decideThesis(
        { elapsedMs: now - o.entryTs, expectedMs: o.thesisExpectedMs, maxHoldMs: o.maxHoldMs, extended: wasExtended, netR, grossR },
        thesis,
      );
      if (d.extend) {
        // 延長: 極値は今の決済側の気配から始める (ストップは max(建値, 気配 − trailR × R) より厳しくならず、この判定では決済しない)
        o.thesisExtendedAt = now;
        o.thesisNetRAtDeadline = d.extend.netR;
        o.thesisPeak = exitSide;
        const st = thesisTrailStop(pricing, exitSide, thesis.trailR);
        if (st !== undefined) o.thesisStop = st;
        this.urgent = true;
      }
      if (d.exit) {
        if (d.exit.reason === "thesis_timeout" && d.exit.netR !== undefined) o.thesisNetRAtDeadline = d.exit.netR;
        reason = d.exit.reason;
        exit = timeExit;
      }
    } else if (now - o.entryTs >= o.maxHoldMs) {
      reason = "time";
      exit = timeExit;
    }
    // 転換で決済 (損切り・利確・読みの管理・時間切れの後。延長した判定と同じ回でも判定する = 実際の建玉と同じ)。
    // 戦略の主時間足の新しい確定足ごとに 1 回、エントリー後の押し安値 (売りは戻り高値) を終値が越えたら決済側の気配 ∓ 約定ずれで決済
    if (!reason && o.reversalTf && revCandles && revCandles.length > 0 && this.opts.reversal) {
      const tfMs = TIMEFRAME_MS[o.reversalTf];
      const last = revCandles[revCandles.length - 1];
      if (last.ts + tfMs > o.entryTs && o.reversalBarTs !== last.ts) {
        o.reversalBarTs = last.ts;
        const r = checkReversal(revCandles, o.entryTs, o.direction, {
          pivotN: this.opts.reversal.pivotN, bufferAtr: this.opts.reversal.bufferAtr, tfMs, fallback: this.opts.reversal.fallback === true,
        });
        if (r.exit) {
          reason = "reversal";
          exit = timeExit;
        }
      }
    }
    if (!reason || !exit) {
      // 延長後の極値と保護ストップを進める (延長した時刻以降に始まった足と今の気配。次の判定のストップから効く)
      if (thesis && wasExtended) {
        const px = long ? Math.max(q.bid, tr ? tr.high - half : -Infinity) : Math.min(q.ask, tr ? tr.low + half : Infinity);
        o.thesisPeak = advancePeak(o.direction, o.thesisPeak, px);
        o.thesisStop = tighterStop(o.direction, o.thesisStop, thesisTrailStop(pricing, o.thesisPeak ?? Number.NaN, thesis.trailR));
      }
      // 建値ストップの発動 (今の気配の仲値で判定。この判定ではストップを判定しない = 次の判定から効く)
      if (o.breakevenStop === undefined && breakevenEnabled(this.opts.breakeven) && !this.ownExit(o.strategyId) && breakevenTriggered(this.opts.breakeven, o.direction, o.entryMid, o.risk, mid)) {
        const st = breakevenStopPrice({
          direction: o.direction, entryPrice: entryFill, entryFeePerUnit: Math.max(0, o.takerFeeRate) * entryFill,
          exitFeeRate: Math.max(0, o.takerFeeRate), halfSpreadRate: mid > 0 ? half / mid : 0,
        });
        if (st !== undefined) {
          o.breakevenArmedAt = now;
          o.breakevenStop = st;
          this.urgent = true;
        }
      }
      return undefined;
    }
    const r = this.closeR(o, exit, now);
    const { risk: _risk, lastCandleTs: _l, mfeR, maeR, thesisPeak: _tp, thesisStop: _ts, reversalTf: _rt, reversalBarTs: _rb,
      breakevenArmedAt: _ba, breakevenStop: _bs, ...base } = o;
    return {
      ...base, exitTs: now, exitPrice: exit.fill, exitReason: reason, ...r, mfeR, maeR,
      ...(thesis ? { thesisOutcome: thesisOutcomeOf(reason, o.thesisExtendedAt !== undefined) } : {}),
    };
  }

  /**
   * 決済したときの R (shadowR + 再現した空売りの借入コスト)。
   * 廃止した GMOコインの持ち越し手数料 (古い記録の holdingFeeDaily) は計上しない (記録は書き換えない)
   */
  /** アプリの保有コストのモデルでの 1 単位あたりの保有コスト (R)。計算できなければ 0 */
  private holdingCostR(o: ShadowOpen, now: number): number {
    const model = this.opts.holdingCost;
    if (!model || !finite(o.entryMid) || !(o.risk > 0)) return 0;
    const qty = D(o.direction === "short" ? -1 : 1);
    const inst = { symbol: o.symbol, assetClass: o.assetClass, allowShort: o.simulatedShort !== true };
    const cost = model.accrue({ inst, qty, avgPrice: D(o.entryMid), from: o.entryTs, to: now, mode: this.opts.holdingCostMode ?? "paper" }).toNumber();
    return finite(cost) ? cost / o.risk : 0;
  }

  private closeR(o: ShadowOpen, exit: ShadowExitFill, now: number): { grossR: number; costR: number; netR: number } {
    const r = shadowR(o, exit);
    // 保有コスト (1 単位あたりを R に換算)。既定は再現した空売りの借入コスト (PaperBroker と同じ: 建玉代金 × 日率 × 保有日数)
    const borrow = this.opts.holdingCost
      ? this.holdingCostR(o, now)
      : o.simulatedShort && finite(o.borrowRateDaily) && o.borrowRateDaily > 0
        ? (o.entryMid * o.borrowRateDaily * Math.max(0, now - o.entryTs)) / 86_400_000 / o.risk
        : 0;
    if (borrow !== 0 && Number.isFinite(borrow)) {
      r.netR -= borrow;
      r.costR += borrow;
    }
    return r;
  }

  /**
   * 変化があれば kv に保存する。引数なし (終了処理など) は間引かず即保存。
   * update 内 (force=false) では、決済・新規追加・監視解除以外 (MFE/MAE 更新のみ) は SHADOW_SAVE_INTERVAL_MS 間隔に間引く
   */
  flush(now?: number, force = true): void {
    const ts = now ?? Date.now();
    const due = force || this.urgent || ts - this.lastSaveTs >= SHADOW_SAVE_INTERVAL_MS;
    if (this.dirty && due) {
      this.dirty = false;
      this.urgent = false;
      this.lastSaveTs = ts;
      this.store.kvSet(shadowOpenKey(this.mode), this.open);
    }
    if (this.countersDirty && due) {
      this.countersDirty = false;
      this.store.kvSet(shadowCountersKey(this.mode), this.counters);
    }
  }
}

// ───────── 集計 (見送り理由ごと・戦略ごと) ─────────

export interface ShadowGroup {
  key: string;
  n: number;
  wins: number;
  winRate: number;
  /** 平均の純 R */
  avgNetR: number;
  /** 純 R の合計 */
  sumNetR: number;
}

export interface ShadowSummary {
  /** 集計対象の期間の開始 (exitTs) */
  since?: number;
  closed: number;
  wins: number;
  winRate: number;
  avgNetR: number;
  /** 未決済の件数 (mode 別の kv の合計) */
  open: number;
  byReason: ShadowGroup[];
  byStrategy: ShadowGroup[];
  /** 見送り理由 × 戦略 ("理由 / 戦略") */
  byReasonStrategy: ShadowGroup[];
  /** 方向別 ("買い" / "売り" / "空売り (paper 再現)")。paper で再現した空売りを買いと分けて見る */
  bySide?: ShadowGroup[];
  exitReasons: Partial<Record<ShadowExitReason, number>>;
  counters: ShadowCounters;
  /** 超短期 (MICRO_STRATEGY_IDS) の決済済み仮想トレードの戦略・見送り理由別の答え合わせ (戦略ごとに最後の行が "合計")。無ければ省略 */
  micro?: MicroObservationGroup[];
}

export interface MicroObservationGroup {
  /** 見送り理由 (合計は "合計") */
  key: string;
  /** 戦略 (scalp_micro / scalp_rebound) */
  strategyId?: string;
  n: number;
  /** 利確到達率 (exitReason === "take_profit" の割合) */
  tpRate: number;
  /** ランダムウォーク勝率 p0 の平均 (算出できないものは除外。1 件も無ければ NaN) */
  p0: number;
  avgGrossR: number;
  avgNetR: number;
}

export const MICRO_STRATEGY_ID = "scalp_micro";
/** 答え合わせの表に載せる超短期の戦略 */
export const MICRO_STRATEGY_IDS: readonly string[] = [MICRO_STRATEGY_ID, "scalp_rebound"];
export const MICRO_TOTAL_KEY = "合計";
const MICRO_REASON_LABEL: Record<string, string> = {
  "strategy_filter:cost": "コストで見送り",
  "strategy_filter:spread": "スプレッドで見送り",
  "strategy_filter:edge": "期待値で見送り",
  observe_only: "観測専用",
  // MAX_HOLD_MINUTES で発注しなかった中期・長期の戦略 (observe_only と同じく通常の見送りとして腕に重み 0.25 で入る)
  hold_limit: "最大保有の対象外",
  // テンポの上限 (直近 1 時間のエントリー数) で見送ったもの (通常の見送りと同じ扱い)
  tempo_cap: "テンポの上限",
};
export const microReasonLabel = (reason: string): string => MICRO_REASON_LABEL[reason] ?? reason;

function summarizeMicro(records: readonly ShadowTradeRecord[]): MicroObservationGroup[] {
  const out: MicroObservationGroup[] = [];
  for (const id of MICRO_STRATEGY_IDS) out.push(...summarizeMicroOf(records, id));
  return out;
}

function summarizeMicroOf(records: readonly ShadowTradeRecord[], strategyId: string): MicroObservationGroup[] {
  const rs = records.filter((t) => t.strategyId === strategyId);
  if (rs.length === 0) return [];
  const mk = (key: string, list: ShadowTradeRecord[]): MicroObservationGroup => {
    let tp = 0, g = 0, nn = 0, p0s = 0, p0n = 0;
    for (const t of list) {
      if (t.exitReason === "take_profit") tp++;
      g += finite(t.grossR) ? t.grossR : 0;
      nn += finite(t.netR) ? t.netR : 0;
      if (finite(t.takeProfit) && finite(t.entryMid) && finite(t.stopLoss)) {
        const tpD = Math.abs(t.takeProfit - t.entryMid);
        const slD = Math.abs(t.entryMid - t.stopLoss);
        const den = tpD + slD;
        if (den > 0) {
          p0s += slD / den;
          p0n++;
        }
      }
    }
    const n = list.length;
    return { key, strategyId, n, tpRate: n ? tp / n : 0, p0: p0n ? p0s / p0n : NaN, avgGrossR: n ? g / n : 0, avgNetR: n ? nn / n : 0 };
  };
  const by = new Map<string, ShadowTradeRecord[]>();
  for (const t of rs) by.set(t.reason, [...(by.get(t.reason) ?? []), t]);
  const rows = [...by.entries()].map(([k, l]) => mk(k, l)).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  return [...rows, mk(MICRO_TOTAL_KEY, rs)];
}

/** 方向の表示名。paper で再現した空売りは「空売り (paper 再現)」として買い・取引所で可能な売りと分ける */
export const SIMULATED_SHORT_LABEL = "空売り (paper 再現)";
export function sideLabel(direction: "long" | "short", simulatedShort?: boolean): string {
  if (direction === "long") return "買い";
  return simulatedShort ? SIMULATED_SHORT_LABEL : "売り";
}

const emptyCounters = (): ShadowCounters => ({ created: 0, closed: 0, duplicate: 0, droppedCap: 0, droppedRate: 0, invalid: 0, unwatched: 0 });

/** 決済済みの仮想トレードの集計 (純粋関数)。勝ち = 純 R > 0 */
export function summarizeShadowTrades(
  records: readonly ShadowTradeRecord[],
  extra: { open?: number; counters?: ShadowCounters; since?: number; limitGroups?: number } = {},
): ShadowSummary {
  const group = (keyOf: (t: ShadowTradeRecord) => string): ShadowGroup[] => {
    const m = new Map<string, ShadowGroup>();
    for (const t of records) {
      const k = keyOf(t);
      const g = m.get(k) ?? { key: k, n: 0, wins: 0, winRate: 0, avgNetR: 0, sumNetR: 0 };
      g.n++;
      if (t.netR > 0) g.wins++;
      g.sumNetR += finite(t.netR) ? t.netR : 0;
      m.set(k, g);
    }
    return [...m.values()]
      .map((g) => ({ ...g, winRate: g.n ? g.wins / g.n : 0, avgNetR: g.n ? g.sumNetR / g.n : 0 }))
      .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key))
      .slice(0, extra.limitGroups ?? 50);
  };
  const wins = records.filter((t) => t.netR > 0).length;
  const sum = records.reduce((s, t) => s + (finite(t.netR) ? t.netR : 0), 0);
  const exitReasons: Partial<Record<ShadowExitReason, number>> = {};
  for (const t of records) exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
  return {
    ...(extra.since !== undefined ? { since: extra.since } : {}),
    closed: records.length,
    wins,
    winRate: records.length ? wins / records.length : 0,
    avgNetR: records.length ? sum / records.length : 0,
    open: extra.open ?? 0,
    byReason: group((t) => t.reason),
    byStrategy: group((t) => t.strategyId),
    byReasonStrategy: group((t) => `${t.reason} / ${t.strategyId}`),
    bySide: group((t) => sideLabel(t.direction, t.simulatedShort)),
    exitReasons,
    counters: extra.counters ?? emptyCounters(),
    ...(records.some((t) => MICRO_STRATEGY_IDS.includes(t.strategyId)) ? { micro: summarizeMicro(records) } : {}),
  };
}

/** 保存済みの件数の記録を mode をまたいで合算する */
export function sumShadowCounters(list: (Partial<ShadowCounters> | undefined)[]): ShadowCounters {
  const out = emptyCounters();
  for (const c of list) {
    if (!c) continue;
    for (const k of Object.keys(out) as (keyof ShadowCounters)[]) out[k] += finite(c[k]) ? c[k]! : 0;
  }
  return out;
}
