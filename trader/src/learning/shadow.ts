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
 */
import { randomUUID } from "node:crypto";
import type {
  AssetClass, Horizon, Instrument, Quote, RegimeLabel, ShadowExitReason, ShadowTradeRecord, Signal, Store, TradingMode,
} from "../core/types";

export interface ShadowOptions {
  /** 楽観を避けるための約定ずれ (片道, bps)。往復で 2 倍を差し引く */
  slippageBps: number;
  /** 未決済の上限 (全体)。超えた分は捨てる */
  maxOpen: number;
  /** 1 分あたりの新規作成の上限。超えた分は捨てる */
  maxPerMinute: number;
  /** シグナルに maxHoldMs が無い (0 以下) ときの保有上限 */
  defaultMaxHoldMs: number;
}

export const DEFAULT_SHADOW_OPTIONS: ShadowOptions = {
  slippageBps: 2,
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

export const shadowOpenKey = (mode: TradingMode) => `shadow:open:${mode}`;
export const shadowCountersKey = (mode: TradingMode) => `shadow:counters:${mode}`;

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const dedupeKey = (symbol: string, strategyId: string, direction: string) => `${symbol}|${strategyId}|${direction}`;
const MINUTE = 60_000;

/** 仮想トレードを閉じたときの R (純粋関数) */
export function shadowR(
  o: Pick<ShadowOpen, "direction" | "entryMid" | "entrySpread" | "risk" | "takerFeeRate" | "slippageBps">,
  exitPrice: number,
): { grossR: number; costR: number; netR: number } {
  const dir = o.direction === "long" ? 1 : -1;
  const grossR = (dir * (exitPrice - o.entryMid)) / o.risk;
  // 往復の taker 手数料 + エントリー時のスプレッド (半分 × 2) + 約定ずれ (片道 × 2)
  const notional = o.entryMid + exitPrice;
  const fee = Math.max(0, o.takerFeeRate) * notional;
  const spread = Math.max(0, o.entrySpread);
  const slip = (Math.max(0, o.slippageBps) / 10_000) * notional;
  const costR = (fee + spread + slip) / o.risk;
  return { grossR, costR, netR: grossR - costR };
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
      slippageBps: this.opts.slippageBps,
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
   * - 時間切れは仲値で閉じる
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
      let range: PriceRange | undefined;
      try {
        range = opts.rangeOf?.(o.symbol, Math.max(o.entryTs, (o.lastCandleTs ?? o.entryTs - 1) + 1));
      } catch (e) {
        this.onError?.("shadow.range", e);
      }
      const before = `${o.mfeR}|${o.maeR}|${o.lastCandleTs ?? ""}`;
      const res = this.step(o, q, now, range);
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

  /** 1 件の判定 (決済したら記録を返す)。o の MFE / MAE は更新する */
  private step(o: ShadowOpen, q: Pick<Quote, "bid" | "ask">, now: number, range?: PriceRange): ShadowTradeRecord | undefined {
    const long = o.direction === "long";
    const half = (q.ask - q.bid) / 2;
    const mid = (q.bid + q.ask) / 2;
    const useRange = range && finite(range.high) && finite(range.low) && range.high >= range.low && range.high > 0;
    // 決済側の価格の範囲 (足は仲値ベースなので現在のスプレッドの半分をずらす)
    const exitSideLow = Math.min(long ? q.bid : q.ask, useRange ? (long ? range!.low - half : range!.low + half) : Infinity);
    const exitSideHigh = Math.max(long ? q.bid : q.ask, useRange ? (long ? range!.high - half : range!.high + half) : -Infinity);
    const midLow = Math.min(mid, useRange ? range!.low : Infinity);
    const midHigh = Math.max(mid, useRange ? range!.high : -Infinity);
    if (useRange) o.lastCandleTs = range!.lastCandleTs;

    // MFE / MAE (仲値ベース, R)
    const fav = long ? (midHigh - o.entryMid) / o.risk : (o.entryMid - midLow) / o.risk;
    const adv = long ? (o.entryMid - midLow) / o.risk : (midHigh - o.entryMid) / o.risk;
    o.mfeR = Math.max(o.mfeR, fav, 0);
    o.maeR = Math.max(o.maeR, adv, 0);

    const stopHit = long ? exitSideLow <= o.stopLoss : exitSideHigh >= o.stopLoss;
    const tp = o.takeProfit;
    const tpHit = tp !== undefined && (long ? exitSideHigh >= tp : exitSideLow <= tp);
    let reason: ShadowExitReason | undefined;
    let exitPrice = mid;
    if (stopHit) {
      // 保守的に損切りを先にする。窓開けで損切りを越えていれば現在の仲値
      reason = "stop";
      exitPrice = long ? Math.min(o.stopLoss, mid) : Math.max(o.stopLoss, mid);
    } else if (tpHit) {
      reason = "take_profit";
      exitPrice = tp!;
    } else if (now - o.entryTs >= o.maxHoldMs) {
      reason = "time";
      exitPrice = mid;
    }
    if (!reason) return undefined;
    const r = shadowR(o, exitPrice);
    const { risk: _risk, lastCandleTs: _l, mfeR, maeR, ...base } = o;
    return { ...base, exitTs: now, exitPrice, exitReason: reason, ...r, mfeR, maeR };
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
