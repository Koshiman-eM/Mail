import { D, floorToStep, Decimal } from "../core/decimal";
import { createLogger } from "../core/logger";
import { sweepOld } from "../core/sweep";
import { normalizeReason } from "../engine/context";
import type { AssetClass, Instrument, PositionView, Quote, RiskDecision, RiskLimits, RiskState, Signal, Store, TradingMode } from "../core/types";

const log = createLogger("risk");
const DAY_MS = 86_400_000;
/** 旧キー (mode なし)。paper 用として扱い、live では読まない */
export const LEGACY_RISK_STATE_KEY = "risk:state";
export const riskStateKey = (mode: TradingMode) => `${LEGACY_RISK_STATE_KEY}:${mode}`;
/** 損切りと決済側の価格 (ロング: bid / ショート: ask) の距離の下限 (スプレッドの倍数) */
export const MIN_STOP_DISTANCE_SPREADS = 2;

/** 往復の想定コスト (bps) = 往復 taker 手数料 + スプレッド */
export function costBps(instrument: Pick<Instrument, "takerFeeRate">, quote: Pick<Quote, "bid" | "ask">): number {
  const mid = (quote.bid + quote.ask) / 2;
  const spreadBps = mid > 0 ? ((quote.ask - quote.bid) / mid) * 10_000 : 0;
  return instrument.takerFeeRate * 2 * 10_000 + Math.max(0, spreadBps);
}

/** リスク計算に使うポジション。assetClass 等が無ければ instruments から解決する */
export type RiskPosition = Pick<PositionView, "symbol" | "qty" | "avgPrice"> & {
  assetClass?: AssetClass;
  quoteCurrency?: string;
  contractSize?: number;
  /** 現在価格 (省略時は prices、さらに avgPrice) */
  price?: number;
};

export interface EntryParams {
  signal: Signal;
  instrument: Instrument;
  quote: Quote;
  equity: number;
  available: number;
  positions: RiskPosition[];
  riskMultiplier: number;
  now: number;
  liquidityUsd?: number;
  /** 既存ポジションの資産クラス解決・価格用 */
  instruments?: Map<string, Instrument> | Record<string, Instrument>;
  prices?: Record<string, number>;
  /** クオート通貨 -> 口座通貨 (既定 1) */
  toAccount?: (ccy: string) => number;
}

type InternalState = RiskState & { dayKey?: string };

const dayKeyOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const nextUtcMidnight = (ts: number) => Math.floor(ts / DAY_MS) * DAY_MS + DAY_MS;

const lookup = (m: EntryParams["instruments"], sym: string): Instrument | undefined =>
  !m ? undefined : m instanceof Map ? m.get(sym) : m[sym];

/** 資産クラス別エクスポージャー (口座通貨建ての建玉額) */
export function exposureByClass(
  positions: RiskPosition[],
  prices: Record<string, number> = {},
  instruments?: EntryParams["instruments"],
  toAccount: (ccy: string) => number = () => 1,
): Record<AssetClass, number> {
  const out: Record<AssetClass, number> = { crypto: 0, meme: 0, fx: 0, stock: 0 };
  for (const p of positions) {
    if (p.qty === 0) continue;
    const inst = lookup(instruments, p.symbol);
    const cls = p.assetClass ?? inst?.assetClass;
    if (!cls) continue;
    const px = p.price ?? prices[p.symbol] ?? p.avgPrice;
    const cs = p.contractSize ?? inst?.contractSize ?? 1;
    const ccy = p.quoteCurrency ?? inst?.quoteCurrency;
    out[cls] += Math.abs(p.qty) * px * cs * (ccy ? toAccount(ccy) : 1);
  }
  return out;
}

export class RiskManager {
  private st: InternalState;
  private lastAudit = new Map<string, number>();
  private lastAuditSweep = 0;
  private readonly key: string;

  /**
   * 状態は kv `risk:state:<mode>` に保存する (既定 paper)。paper は旧キー `risk:state` からも引き継ぐ。
   * live は live のキーだけを読む (初回は最初の onEquity で現在の評価額を基準にする)。
   * 第 3 引数に文字列を渡すとそのキーをそのまま使う。
   */
  constructor(
    readonly limits: RiskLimits,
    private readonly store?: Store,
    keyOrOpts: string | { mode?: TradingMode } = {},
  ) {
    let saved: InternalState | undefined;
    if (typeof keyOrOpts === "string") {
      this.key = keyOrOpts;
      saved = store?.kvGet<InternalState>(this.key);
    } else {
      const mode = keyOrOpts.mode ?? "paper";
      this.key = riskStateKey(mode);
      saved = store?.kvGet<InternalState>(this.key);
      if (saved === undefined && mode === "paper") saved = store?.kvGet<InternalState>(LEGACY_RISK_STATE_KEY);
    }
    this.st = saved && typeof saved === "object"
      ? { ...saved, recentOrderTs: Array.isArray(saved.recentOrderTs) ? saved.recentOrderTs : [] }
      : { dayStartEquity: 0, peakEquity: 0, recentOrderTs: [] };
  }

  state(): RiskState {
    return { ...this.st, recentOrderTs: [...this.st.recentOrderTs] };
  }

  /** 新規エントリーを止める状態か */
  isHalted(now: number): { halted: boolean; reason?: string } {
    if (this.st.killSwitch) return { halted: true, reason: `キルスイッチ作動中 (${this.st.killSwitch.reason})` };
    if (this.st.haltedUntil !== undefined && now < this.st.haltedUntil) {
      return { halted: true, reason: `日次損失上限により ${new Date(this.st.haltedUntil).toISOString()} まで停止中` };
    }
    return { halted: false };
  }

  private persist(): void {
    this.store?.kvSet(this.key, this.st);
  }

  private audit(type: string, now: number, data: Record<string, unknown>): void {
    this.store?.audit({ ts: now, type, data });
  }

  /** 口座評価額の更新。日次損失・ドローダウンの停止判定もここで行う */
  onEquity(equity: number, now: number): { halted: boolean; killSwitch: boolean; dailyLossPct: number; drawdownPct: number } {
    const st = this.st;
    // 取得失敗などで NaN / 非有限になった評価額では状態を更新しない (基準の破壊・誤った停止を防ぐ)
    if (typeof equity !== "number" || !Number.isFinite(equity)) {
      log.warn("評価額が不正なため無視します", { equity: String(equity) });
      return { halted: this.isHalted(now).halted, killSwitch: !!st.killSwitch, dailyLossPct: 0, drawdownPct: 0 };
    }
    const key = dayKeyOf(now);
    let changed = false;
    if (st.dayKey !== key || st.dayStartEquity <= 0) {
      st.dayKey = key;
      st.dayStartEquity = equity;
      if (st.haltedUntil !== undefined && now >= st.haltedUntil) st.haltedUntil = undefined;
      changed = true;
    }
    if (equity > st.peakEquity) {
      st.peakEquity = equity;
      changed = true;
    }
    const dailyLossPct = st.dayStartEquity > 0 ? (st.dayStartEquity - equity) / st.dayStartEquity : 0;
    const drawdownPct = st.peakEquity > 0 ? (st.peakEquity - equity) / st.peakEquity : 0;

    if (dailyLossPct > this.limits.maxDailyLoss && (st.haltedUntil === undefined || now >= st.haltedUntil)) {
      st.haltedUntil = nextUtcMidnight(now);
      changed = true;
      log.warn("日次損失上限に到達: 当日の新規エントリーを停止", { dailyLossPct });
      this.audit("risk.halt_daily", now, { equity, dayStartEquity: st.dayStartEquity, dailyLossPct, haltedUntil: st.haltedUntil });
    }
    if (drawdownPct > this.limits.maxDrawdown && !st.killSwitch) {
      st.killSwitch = { at: now, reason: `最大ドローダウン超過 ${(drawdownPct * 100).toFixed(2)}%` };
      changed = true;
      log.error("最大ドローダウン超過: キルスイッチ作動", { drawdownPct });
      this.audit("risk.kill_switch", now, { equity, peakEquity: st.peakEquity, drawdownPct });
    }
    if (changed) this.persist();
    return { halted: this.isHalted(now).halted, killSwitch: !!st.killSwitch, dailyLossPct, drawdownPct };
  }

  /** 外部要因 (異常検知など) でキルスイッチを作動させる */
  trip(reason: string, now: number): void {
    if (this.st.killSwitch) return;
    this.st.killSwitch = { at: now, reason };
    this.persist();
    this.audit("risk.kill_switch", now, { reason });
  }

  recordOrder(now: number): void {
    this.st.recentOrderTs = this.st.recentOrderTs.filter((t) => now - t < 60_000);
    this.st.recentOrderTs.push(now);
    this.persist();
  }

  /**
   * 手動再開。停止解除に加え、再発動を避けるため基準 (ピーク/日次開始) を次の onEquity で現在値へ再設定する。
   * equity を渡せば即座に再設定。
   */
  resume(opts: { equity?: number; now?: number; by?: string } = {}): void {
    const was = { killSwitch: this.st.killSwitch, haltedUntil: this.st.haltedUntil };
    this.st.killSwitch = undefined;
    this.st.haltedUntil = undefined;
    this.st.peakEquity = opts.equity ?? 0;
    this.st.dayStartEquity = opts.equity ?? 0;
    this.persist();
    this.audit("risk.resume", opts.now ?? Date.now(), { by: opts.by ?? "manual", was });
  }

  private auditReject(p: EntryParams, reason: string): void {
    const k = `${p.instrument.symbol}|${normalizeReason(reason)}`;
    const last = this.lastAudit.get(k);
    if (last !== undefined && p.now - last < 60_000) return;
    this.lastAudit.set(k, p.now);
    if (this.lastAudit.size > 200 || p.now - this.lastAuditSweep > 60_000) {
      this.lastAuditSweep = p.now;
      sweepOld(this.lastAudit, p.now, 10 * 60_000);
    }
    this.audit("risk.reject", p.now, { symbol: p.instrument.symbol, strategyId: p.signal.strategyId, reason });
  }

  evaluateEntry(p: EntryParams): RiskDecision {
    const d = this.decide(p);
    if (!d.ok) this.auditReject(p, d.reason);
    return d;
  }

  private decide(p: EntryParams): RiskDecision {
    const { signal, instrument: inst, quote, equity, available, now } = p;
    const L = this.limits;
    const notes: string[] = [];

    const h = this.isHalted(now);
    if (h.halted) return { ok: false, reason: h.reason! };
    if (signal.direction === "flat") return { ok: false, reason: "flat シグナルは新規エントリーではありません" };
    if (!(p.riskMultiplier > 0)) return { ok: false, reason: "リスク倍率が 0 以下" };
    if (!(equity > 0)) return { ok: false, reason: "評価額が 0 以下" };
    const isLong = signal.direction === "long";
    if (!isLong && !inst.allowShort) return { ok: false, reason: `${inst.symbol} は空売り不可` };

    const open = p.positions.filter((x) => x.qty !== 0);
    const existing = open.find((x) => x.symbol === inst.symbol);
    if (!existing && open.length >= L.maxOpenPositions) return { ok: false, reason: `最大保有数 ${L.maxOpenPositions} に到達` };

    // コスト比
    const cost = costBps(inst, quote);
    if (signal.expectedEdgeBps < L.minEdgeToCostRatio * cost) {
      return { ok: false, reason: `期待値幅 ${signal.expectedEdgeBps.toFixed(1)}bps < コスト ${cost.toFixed(1)}bps × ${L.minEdgeToCostRatio}` };
    }
    notes.push(`edge ${signal.expectedEdgeBps.toFixed(1)}bps / cost ${cost.toFixed(1)}bps`);

    // サイジング
    const entry = signal.entry.type === "limit" && signal.entry.price ? signal.entry.price : isLong ? quote.ask : quote.bid;
    const dist = Math.abs(entry - signal.stopLoss);
    if (!(signal.stopLoss > 0) || !(dist > 0) || (isLong ? signal.stopLoss >= entry : signal.stopLoss <= entry)) {
      return { ok: false, reason: `損切り価格が不正 (entry=${entry}, stop=${signal.stopLoss})` };
    }
    // 損切りは決済側の価格 (ロング: bid / ショート: ask) より外側で、スプレッドの MIN_STOP_DISTANCE_SPREADS 倍以上離す
    // (スプレッドの内側の損切りは約定直後に発動してしまう)
    const exitPx = isLong ? quote.bid : quote.ask;
    const spread = Math.max(0, quote.ask - quote.bid);
    const room = isLong ? exitPx - signal.stopLoss : signal.stopLoss - exitPx;
    if (!(exitPx > 0) || !(room > 0)) {
      return { ok: false, reason: `損切りがスプレッドの内側 (stop=${signal.stopLoss}, ${isLong ? "bid" : "ask"}=${exitPx})` };
    }
    if (room < MIN_STOP_DISTANCE_SPREADS * spread) {
      return { ok: false, reason: `損切りが決済側の価格に近すぎます (距離 ${room} < スプレッド ${spread} × ${MIN_STOP_DISTANCE_SPREADS})` };
    }
    const toAcct = p.toAccount ?? (() => 1);
    const fx = D(inst.quoteCurrency ? toAcct(inst.quoteCurrency) : 1);
    const cs = D(inst.contractSize ?? 1);
    const confidence = Math.min(1, Math.max(0, signal.confidence));
    const riskAmount = D(equity).mul(L.riskPerTrade).mul(p.riskMultiplier).mul(0.5 + 0.5 * confidence);
    const perUnitRisk = D(dist).mul(cs).mul(fx);
    const perUnitNotional = D(entry).mul(cs).mul(fx);
    let qty = riskAmount.div(perUnitRisk);
    notes.push(`risk-based qty ${qty.toSignificantDigits(6)}`);

    const cap = (name: string, limitQty: Decimal) => {
      if (limitQty.lt(qty)) {
        qty = limitQty;
        notes.push(`${name} で ${limitQty.toSignificantDigits(6)} に制限`);
      }
    };

    const exNotional = existing ? D(Math.abs(existing.qty)).mul(existing.price ?? p.prices?.[existing.symbol] ?? existing.avgPrice).mul(cs).mul(fx) : D(0);
    const posRoom = D(equity).mul(L.maxPositionPct).minus(exNotional);
    if (posRoom.lte(0)) return { ok: false, reason: `1銘柄上限 ${(L.maxPositionPct * 100).toFixed(0)}% に到達` };
    cap("1銘柄上限", posRoom.div(perUnitNotional));

    const exp = exposureByClass(open, p.prices, p.instruments, toAcct);
    const classRoom = D(equity).mul(L.maxExposureByClass[inst.assetClass]).minus(exp[inst.assetClass]);
    if (classRoom.lte(0)) return { ok: false, reason: `${inst.assetClass} のエクスポージャー上限に到達` };
    cap(`${inst.assetClass} エクスポージャー上限`, classRoom.div(perUnitNotional));

    if (!(available > 0)) return { ok: false, reason: "余力がありません" };
    cap("余力", D(available).div(perUnitNotional));

    qty = floorToStep(qty, inst.lotSize);
    if (qty.lte(0) || qty.lt(inst.minQty)) return { ok: false, reason: `数量 ${qty} が最小数量 ${inst.minQty} 未満` };
    if (inst.minNotional !== undefined && D(entry).mul(qty).mul(cs).lt(inst.minNotional)) {
      return { ok: false, reason: `約定代金 ${D(entry).mul(qty).mul(cs)} が最小 ${inst.minNotional} 未満` };
    }

    if (inst.assetClass === "meme") {
      const liq = p.liquidityUsd;
      if (liq === undefined || !Number.isFinite(liq)) return { ok: false, reason: "ミームコインの流動性が不明のため拒否" };
      if (liq < L.memeMinLiquidityUsd) return { ok: false, reason: `流動性 $${Math.round(liq)} < 最低 $${L.memeMinLiquidityUsd}` };
      notes.push(`liquidity $${Math.round(liq)}`);
    }

    const recent = this.st.recentOrderTs.filter((t) => now - t < 60_000).length;
    if (recent >= L.maxOrdersPerMinute) return { ok: false, reason: `1分あたり発注数上限 ${L.maxOrdersPerMinute} に到達` };

    notes.push(`qty ${qty.toString()}`);
    return { ok: true, qty: qty.toString(), notes };
  }
}
