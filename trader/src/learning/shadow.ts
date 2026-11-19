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
 *   - 約定ずれ (片道) は資産クラス別のバックテストの既定値 (defaultCosts: crypto 1 / meme 20 / fx 0.5 / stock 1 bps)。手数料は銘柄の taker 手数料 (往復)
 *   - エントリー: 買いは ask + 約定ずれ、売りは bid − 約定ずれ
 *   - 損切り: 決済側 (買い: bid / 売り: ask) で判定し、ストップ価格 (窓開けで越えていれば現在の決済側の気配) に約定ずれを不利側に加えて約定
 *   - 利確: 指値扱い (約定ずれなし)。時間切れ: 決済側の気配 ∓ 約定ずれ
 *   - エントリーした 1m 足 (確定後) も判定に含める。その足にはエントリー前の値動きも入るので、不利側 (損切り・MAE) にだけ使い、
 *     有利側 (利確・MFE) はエントリー時刻以降に始まった足と毎ティックの気配だけで判定する (保守的。確定足だけを使うので先読みはしない)
 */
import { randomUUID } from "node:crypto";
import { defaultCosts } from "../backtest/engine";
import type {
  AssetClass, Horizon, Instrument, Quote, RegimeLabel, ShadowExitReason, ShadowTradeRecord, Signal, Store, TradingMode,
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
  instrument: Pick<Instrument, "symbol" | "assetClass" | "takerFeeRate">;
  quote: Pick<Quote, "bid" | "ask">;
  signal: Pick<Signal, "strategyId" | "direction" | "confidence" | "expectedEdgeBps" | "stopLoss" | "takeProfit" | "maxHoldMs"> & { horizon?: Horizon };
  regime: RegimeLabel;
  /** 見送り理由 (正規化したキー) */
  reason: string;
  now: number;
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

export const shadowOpenKey = (mode: TradingMode) => `shadow:open:${mode}`;
export const shadowCountersKey = (mode: TradingMode) => `shadow:counters:${mode}`;

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const dedupeKey = (symbol: string, strategyId: string, direction: string) => `${symbol}|${strategyId}|${direction}`;
const MINUTE = 60_000;

/** 仮想トレードの約定ずれ (片道, bps)。上書きが無ければバックテストと同じ資産クラス別の既定値 */
export function shadowSlippageBps(assetClass: AssetClass, override?: number): number {
  if (finite(override) && override >= 0) return override;
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
      takerFeeRate: finite(inst.takerFeeRate) ? Math.max(0, inst.takerFeeRate) : 0,
      slippageBps: shadowSlippageBps(inst.assetClass as AssetClass, this.opts.slippageBps),
      risk,
      mfeR: 0,
      maeR: 0,
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
   * 決済したものを返す。kv への保存は変化があったときだけ (1 回)
   */
  update(
    now: number,
    quoteOf: (symbol: string) => Pick<Quote, "bid" | "ask"> | undefined,
    opts: { isWatched?: (symbol: string) => boolean; rangeOf?: (symbol: string, sinceTs: number) => PriceRange | undefined } = {},
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
        }
      } catch (e) {
        this.onError?.("shadow.range", e);
      }
      const before = `${o.mfeR}|${o.maeR}|${o.lastCandleTs ?? ""}`;
      const res = this.step(o, q, now, adverse, favorable);
      if (!res) {
        if (before !== `${o.mfeR}|${o.maeR}|${o.lastCandleTs ?? ""}`) this.dirty = true;
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
   * adverse: 不利側 (損切り・MAE) に使う足の値幅、favorable: 有利側 (利確・MFE) に使う足の値幅 (どちらも仲値ベース)
   */
  private step(o: ShadowOpen, q: Pick<Quote, "bid" | "ask">, now: number, adverse?: PriceRange, favorable?: PriceRange): ShadowTradeRecord | undefined {
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

    // MFE / MAE (仲値ベース, R)
    o.mfeR = Math.max(o.mfeR, (dir * (favMid - o.entryMid)) / o.risk, 0);
    o.maeR = Math.max(o.maeR, (dir * (o.entryMid - advMid)) / o.risk, 0);

    const stopHit = long ? advExit <= o.stopLoss : advExit >= o.stopLoss;
    const tp = o.takeProfit;
    const tpHit = tp !== undefined && (long ? favExit >= tp : favExit <= tp);
    const rate = Math.max(0, finite(o.slippageBps) ? o.slippageBps : 0) / 10_000;
    let reason: ShadowExitReason | undefined;
    let exit: ShadowExitFill | undefined;
    if (stopHit) {
      // 保守的に損切りを先にする。窓開けで損切りを越えていれば現在の決済側の気配。どちらも約定ずれを不利側に加える
      reason = "stop";
      const level = long ? Math.min(o.stopLoss, q.bid) : Math.max(o.stopLoss, q.ask);
      const slip = rate * level;
      exit = { fill: level - dir * slip, halfSpread: half, slip };
    } else if (tpHit) {
      reason = "take_profit";
      exit = { fill: tp!, halfSpread: half, slip: 0 };
    } else if (now - o.entryTs >= o.maxHoldMs) {
      reason = "time";
      const slip = rate * exitSide;
      exit = { fill: exitSide - dir * slip, halfSpread: half, slip };
    }
    if (!reason || !exit) return undefined;
    const r = shadowR(o, exit);
    const { risk: _risk, lastCandleTs: _l, mfeR, maeR, ...base } = o;
    return { ...base, exitTs: now, exitPrice: exit.fill, exitReason: reason, ...r, mfeR, maeR };
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
  exitReasons: Partial<Record<ShadowExitReason, number>>;
  counters: ShadowCounters;
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
    exitReasons,
    counters: extra.counters ?? emptyCounters(),
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
