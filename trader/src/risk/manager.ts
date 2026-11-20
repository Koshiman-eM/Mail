import { D, floorToStep, Decimal } from "../core/decimal";
import { createLogger } from "../core/logger";
import { canShort } from "../core/short";
import { sweepOld } from "../core/sweep";
import { normalizeReason } from "../engine/context";
import type { AssetClass, Instrument, PositionView, Quote, RiskDecision, RiskLimits, RiskState, Signal, Store, TradingMode } from "../core/types";
import { effectiveRiskLimits } from "./settings";

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

/** 有限の数値か (number / Decimal) */
const finiteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 資産クラス別エクスポージャーの詳細 (口座通貨建て、decimal) */
export interface ClassExposure {
  /** 資産クラス別の建玉額。換算できない建玉があるクラスは、換算できた分だけの合計 */
  exposure: Record<AssetClass, Decimal>;
  /** 換算できない (価格・数量・為替が非有限) 建玉があり、合計が不明な資産クラスと銘柄 */
  unknown: Partial<Record<AssetClass, string[]>>;
}

/**
 * 資産クラス別エクスポージャー (口座通貨建ての建玉額) を decimal で計算する。
 * 価格・数量・契約サイズ・為替のどれかが非有限 / 不正なら、その建玉の資産クラスを「不明」にする
 * (NaN を合計に混ぜて上限判定を素通りさせない)。
 */
export function classExposure(
  positions: RiskPosition[],
  prices: Record<string, number> = {},
  instruments?: EntryParams["instruments"],
  toAccount: (ccy: string) => number = () => 1,
): ClassExposure {
  const exposure: Record<AssetClass, Decimal> = { crypto: D(0), meme: D(0), fx: D(0), stock: D(0) };
  const unknown: Partial<Record<AssetClass, string[]>> = {};
  const markUnknown = (cls: AssetClass, sym: string) => {
    (unknown[cls] ??= []).push(sym);
  };
  for (const p of positions) {
    if (p.qty === 0) continue;
    const inst = lookup(instruments, p.symbol);
    const cls = p.assetClass ?? inst?.assetClass;
    if (!cls) continue;
    const px = p.price ?? prices[p.symbol] ?? p.avgPrice;
    const cs = p.contractSize ?? inst?.contractSize ?? 1;
    const ccy = p.quoteCurrency ?? inst?.quoteCurrency;
    let rate = 1;
    try {
      rate = ccy ? toAccount(ccy) : 1;
    } catch {
      rate = NaN;
    }
    if (!finiteNum(p.qty) || !finiteNum(px) || !(px >= 0) || !finiteNum(cs) || !(cs > 0) || !finiteNum(rate) || !(rate > 0)) {
      markUnknown(cls, p.symbol);
      continue;
    }
    exposure[cls] = exposure[cls].plus(D(p.qty).abs().mul(px).mul(cs).mul(rate));
  }
  return { exposure, unknown };
}

/** 資産クラス別エクスポージャー (口座通貨建ての建玉額)。換算できない建玉があるクラスは NaN (不明) */
export function exposureByClass(
  positions: RiskPosition[],
  prices: Record<string, number> = {},
  instruments?: EntryParams["instruments"],
  toAccount: (ccy: string) => number = () => 1,
): Record<AssetClass, number> {
  const { exposure, unknown } = classExposure(positions, prices, instruments, toAccount);
  const out = {} as Record<AssetClass, number>;
  for (const cls of Object.keys(exposure) as AssetClass[]) out[cls] = unknown[cls] ? NaN : exposure[cls].toNumber();
  return out;
}

/**
 * サイズ倍率 (計画 × 腕の重み × 予想) の上限。呼び出し側でも同じ値で制限しているが、RiskManager でも二重に制限する
 */
export const MAX_SIZE_MULTIPLIER = 1.5;

/** GMOコインの建玉の合計の上限 (評価額の倍率) の既定値 (GMO_MAX_EFFECTIVE_LEVERAGE の既定と同じ) */
export const DEFAULT_GMO_MAX_EFFECTIVE_LEVERAGE = 1;
/** GMOコインの venue 名 (src/market/feeds/gmo.ts の GMO_VENUE と同じ) */
const GMO_VENUE = "gmo";

/**
 * ダッシュボードの上書き値 (kv `risk:limits:<mode>`) を読み直す間隔 (ms)。
 * 評価のたびに kv を読まないための短いキャッシュ。エンジンは毎ティックの onEquity で必ず読み直すので、
 * 変更は次のティックから効く (ティック間隔 SCALP_LOOP_MS の既定 5 秒より短くしておく)。
 */
export const RISK_OVERRIDE_CACHE_MS = 2_000;

export class RiskManager {
  private st: InternalState;
  private lastAudit = new Map<string, number>();
  private lastAuditSweep = 0;
  private readonly key: string;
  /** 上書き値を読む mode (文字列キー指定・store なしのときは読まない = 渡された limits をそのまま使う) */
  private readonly overrideMode?: TradingMode;
  private readonly overrideCacheMs: number;
  /**
   * 取引 mode (空売りの可否の判定に使う。paper の空売りの再現は mode が paper のときだけ)。
   * 文字列キー指定のときは不明 (= 取引所の allowShort だけで判定する)
   */
  readonly tradeMode?: TradingMode;
  private limitsCache?: { at: number; limits: RiskLimits; updatedAt: number };
  /** GMO の建玉の合計 (絶対値の口座通貨換算) の上限 (評価額の倍率) */
  private readonly gmoMaxLeverage: number = DEFAULT_GMO_MAX_EFFECTIVE_LEVERAGE;
  /**
   * GMO 以外の発注先 (live で併用しているもの)。エンジンが渡す評価額は全発注先の合計で、GMO 口座の評価額 (actualProfitLoss) を
   * 基準にできないので、空でなければ live の GMO の新規エントリーを拒否する
   */
  private readonly gmoOtherOrderVenues: readonly string[] = [];

  /**
   * 状態は kv `risk:state:<mode>` に保存する (既定 paper)。paper は旧キー `risk:state` からも引き継ぐ。
   * live は live のキーだけを読む (初回は最初の onEquity で現在の評価額を基準にする)。
   * 第 3 引数に文字列を渡すとそのキーをそのまま使う。
   *
   * envLimits は .env の値。mode 指定 (オブジェクト形式) で store があれば、ダッシュボードの上書き値
   * (kv `risk:limits:<mode>`) を重ねた実効値を `limits` として使う (再起動後も kv から読むので残る)。
   */
  constructor(
    private readonly envLimits: RiskLimits,
    private readonly store?: Store,
    keyOrOpts: string | { mode?: TradingMode; overrideCacheMs?: number; gmoMaxEffectiveLeverage?: number; gmoOtherOrderVenues?: readonly string[] } = {},
  ) {
    let saved: InternalState | undefined;
    this.overrideCacheMs = RISK_OVERRIDE_CACHE_MS;
    if (typeof keyOrOpts === "object") {
      const lev = keyOrOpts.gmoMaxEffectiveLeverage;
      // 不正な値 (非有限・0 以下) は既定値 (1 倍) を使う。上限 2 倍は config の検証と同じ
      if (lev !== undefined && Number.isFinite(lev) && lev > 0) this.gmoMaxLeverage = Math.min(lev, 2);
      if (keyOrOpts.gmoOtherOrderVenues?.length) this.gmoOtherOrderVenues = [...keyOrOpts.gmoOtherOrderVenues];
    }
    if (typeof keyOrOpts === "string") {
      this.key = keyOrOpts;
      saved = store?.kvGet<InternalState>(this.key);
    } else {
      const mode = keyOrOpts.mode ?? "paper";
      this.tradeMode = mode;
      if (store) this.overrideMode = mode;
      if (keyOrOpts.overrideCacheMs !== undefined) this.overrideCacheMs = keyOrOpts.overrideCacheMs;
      this.key = riskStateKey(mode);
      saved = store?.kvGet<InternalState>(this.key);
      if (saved === undefined && mode === "paper") saved = store?.kvGet<InternalState>(LEGACY_RISK_STATE_KEY);
    }
    this.st = saved && typeof saved === "object"
      ? { ...saved, recentOrderTs: Array.isArray(saved.recentOrderTs) ? saved.recentOrderTs : [] }
      : { dayStartEquity: 0, peakEquity: 0, recentOrderTs: [] };
  }

  /** 実効のリスク上限 (.env の値 + ダッシュボードの上書き値)。短時間キャッシュする */
  get limits(): RiskLimits {
    if (this.overrideMode === undefined) return this.envLimits;
    const c = this.limitsCache;
    if (c && Date.now() - c.at < this.overrideCacheMs) return c.limits;
    return this.refreshLimits();
  }

  /** .env の値 (上書き前) */
  get baseLimits(): RiskLimits {
    return this.envLimits;
  }

  /**
   * 上書き値を kv から読み直す (エンジンは毎ティックの onEquity で呼ぶ。ダッシュボードの保存直後にも呼ぶ)。
   * 読めない場合 (DB の一時的な失敗など) は直前の値を使い続ける (失敗で上限を緩めも締めもしない)
   */
  refreshLimits(): RiskLimits {
    if (this.overrideMode === undefined) return this.envLimits;
    const prev = this.limitsCache;
    try {
      const { limits, override } = effectiveRiskLimits(this.envLimits, this.store, this.overrideMode);
      const updatedAt = override?.updatedAt ?? 0;
      if (prev && prev.updatedAt !== updatedAt) log.warn("リスク上限の変更を反映しました", { mode: this.overrideMode, overridden: Boolean(override) });
      this.limitsCache = { at: Date.now(), limits, updatedAt };
      return limits;
    } catch (e) {
      log.warn("リスク上限の上書き値を読めません。直前の値を使います", { error: e instanceof Error ? e.message : String(e) });
      if (prev) {
        this.limitsCache = { ...prev, at: Date.now() };
        return prev.limits;
      }
      return this.envLimits;
    }
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
    // 毎ティックここで上書き値を読み直す (ダッシュボードの変更を次のティックから反映。再起動は不要)
    const L = this.refreshLimits();
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

    if (dailyLossPct > L.maxDailyLoss && (st.haltedUntil === undefined || now >= st.haltedUntil)) {
      st.haltedUntil = nextUtcMidnight(now);
      changed = true;
      log.warn("日次損失上限に到達: 当日の新規エントリーを停止", { dailyLossPct });
      this.audit("risk.halt_daily", now, { equity, dayStartEquity: st.dayStartEquity, dailyLossPct, haltedUntil: st.haltedUntil });
    }
    if (drawdownPct > L.maxDrawdown && !st.killSwitch) {
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
    if (!Number.isFinite(p.riskMultiplier)) return { ok: false, reason: `リスク倍率が数値ではありません (${p.riskMultiplier})` };
    if (!finiteNum(equity)) return { ok: false, reason: `評価額が数値ではありません (${equity}) のため拒否` };
    if (!(equity > 0)) return { ok: false, reason: "評価額が 0 以下" };
    if (!finiteNum(available)) return { ok: false, reason: `余力が数値ではありません (${available}) のため拒否` };
    const isLong = signal.direction === "long";
    // 実効の空売り可否 (live では取引所の allowShort だけ。paper では再現する銘柄 simulatedShort も可)。
    // 再現した空売りも以降の判定 (最大保有数・コスト比・損切り (上側)・1 銘柄上限・資産クラス別上限・余力) をすべて通す
    if (!isLong && !canShort(inst, this.tradeMode)) return { ok: false, reason: `${inst.symbol} は空売り不可` };

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
    let fxRate: number;
    try {
      fxRate = inst.quoteCurrency ? toAcct(inst.quoteCurrency) : 1;
    } catch {
      fxRate = NaN;
    }
    if (!finiteNum(fxRate) || !(fxRate > 0)) {
      return { ok: false, reason: `${inst.quoteCurrency} を口座通貨へ換算できないため拒否 (為替 ${fxRate})` };
    }
    const fx = D(fxRate);
    const csNum = inst.contractSize ?? 1;
    if (!finiteNum(csNum) || !(csNum > 0)) return { ok: false, reason: `契約サイズが不正 (${csNum})` };
    const cs = D(csNum);
    const confidence = Number.isFinite(signal.confidence) ? Math.min(1, Math.max(0, signal.confidence)) : 0;
    // サイズ倍率 (計画 × 腕の重み × 予想) は呼び出し側でも MAX_SIZE_MULTIPLIER で制限しているが、ここでも二重に制限する
    let sizeMult = p.riskMultiplier;
    if (sizeMult > MAX_SIZE_MULTIPLIER) {
      notes.push(`サイズ倍率 ${sizeMult.toFixed(3)} を上限 ${MAX_SIZE_MULTIPLIER} に制限`);
      sizeMult = MAX_SIZE_MULTIPLIER;
    }
    const riskAmount = D(equity).mul(L.riskPerTrade).mul(sizeMult).mul(0.5 + 0.5 * confidence);
    const perUnitRisk = D(dist).mul(cs).mul(fx);
    const perUnitNotional = D(entry).mul(cs).mul(fx);
    if (!perUnitNotional.isFinite() || !perUnitNotional.gt(0) || !perUnitRisk.isFinite() || !perUnitRisk.gt(0)) {
      return { ok: false, reason: `1 単位あたりの代金・リスクが計算できないため拒否 (代金 ${perUnitNotional}, リスク ${perUnitRisk})` };
    }
    let qty = riskAmount.div(perUnitRisk);
    if (!qty.isFinite()) return { ok: false, reason: `数量が計算できないため拒否 (${qty})` };
    notes.push(`risk-based qty ${qty.toSignificantDigits(6)}`);

    const cap = (name: string, limitQty: Decimal) => {
      if (limitQty.lt(qty)) {
        qty = limitQty;
        notes.push(`${name} で ${limitQty.toSignificantDigits(6)} に制限`);
      }
    };

    let exNotional = D(0);
    if (existing) {
      const exPx = existing.price ?? p.prices?.[existing.symbol] ?? existing.avgPrice;
      exNotional = finiteNum(existing.qty) && finiteNum(exPx) ? D(Math.abs(existing.qty)).mul(exPx).mul(cs).mul(fx) : D(NaN);
    }
    const posRoom = D(equity).mul(L.maxPositionPct).minus(exNotional);
    if (!posRoom.isFinite()) return { ok: false, reason: `${inst.symbol} の既存の建玉額が計算できないため拒否 (1銘柄上限を確認できません)` };
    if (posRoom.lte(0)) return { ok: false, reason: `1銘柄上限 ${(L.maxPositionPct * 100).toFixed(0)}% に到達` };
    cap("1銘柄上限", posRoom.div(perUnitNotional));

    const { exposure, unknown } = classExposure(open, p.prices, p.instruments, toAcct);
    const unknownSyms = unknown[inst.assetClass];
    if (unknownSyms?.length) {
      return {
        ok: false,
        reason: `${inst.assetClass} のエクスポージャーが不明のため拒否 (口座通貨へ換算できない建玉: ${unknownSyms.join(", ")})`,
      };
    }
    const classRoom = D(equity).mul(L.maxExposureByClass[inst.assetClass]).minus(exposure[inst.assetClass]);
    if (!classRoom.isFinite()) return { ok: false, reason: `${inst.assetClass} のエクスポージャー上限の余地が計算できないため拒否` };
    if (classRoom.lte(0)) return { ok: false, reason: `${inst.assetClass} のエクスポージャー上限に到達` };
    cap(`${inst.assetClass} エクスポージャー上限`, classRoom.div(perUnitNotional));

    // GMOコイン: 建玉の合計 (絶対値の口座通貨換算) が評価額 × GMO_MAX_EFFECTIVE_LEVERAGE を超えないようにする。
    // 評価額は GMO 口座の評価額 (actualProfitLoss) を前提とする: live は GMO 単独のときだけ通す (上の gmoOtherOrderVenues)。
    // paper は単一の PaperBroker の評価額 (全銘柄の合計) を使う
    // (GMO は証拠金の 2 倍まで建てられるが、このツールでは既定 1 倍まで。上の判定に追加で効く = 緩めない)
    if (inst.venue === GMO_VENUE) {
      if (this.tradeMode === "live" && this.gmoOtherOrderVenues.length) {
        return {
          ok: false,
          reason: `VENUES に GMO 以外の発注先 (${this.gmoOtherOrderVenues.join(", ")}) があり、GMO 口座の評価額で実効レバレッジを確認できないため拒否 (live の GMO は単独で使ってください)`,
        };
      }
      let gmoExposure = D(0);
      for (const x of open) {
        const xi = x.symbol === inst.symbol ? inst : lookup(p.instruments, x.symbol);
        if (!xi) return { ok: false, reason: `取引先の分からない建玉 (${x.symbol}) があるため GMO の実効レバレッジを確認できず拒否` };
        if (xi.venue !== GMO_VENUE) continue;
        const px = x.price ?? p.prices?.[x.symbol] ?? x.avgPrice;
        let rate = NaN;
        try {
          rate = xi.quoteCurrency ? toAcct(xi.quoteCurrency) : 1;
        } catch {
          rate = NaN;
        }
        const xcs = x.contractSize ?? xi.contractSize ?? 1;
        if (!finiteNum(x.qty) || !finiteNum(px) || !(px >= 0) || !finiteNum(rate) || !(rate > 0) || !finiteNum(xcs) || !(xcs > 0)) {
          return { ok: false, reason: `GMO の建玉額が計算できないため拒否 (${x.symbol})` };
        }
        gmoExposure = gmoExposure.plus(D(Math.abs(x.qty)).mul(px).mul(xcs).mul(rate));
      }
      const levRoom = D(equity).mul(this.gmoMaxLeverage).minus(gmoExposure);
      if (!levRoom.isFinite()) return { ok: false, reason: "GMO の実効レバレッジの余地が計算できないため拒否" };
      if (levRoom.lte(0)) {
        return { ok: false, reason: `GMO の建玉の合計が評価額の ${this.gmoMaxLeverage} 倍 (実効レバレッジの上限) に達しているため拒否` };
      }
      cap(`GMO の実効レバレッジ上限 (評価額の ${this.gmoMaxLeverage} 倍)`, levRoom.div(perUnitNotional));
    }

    if (!(available > 0)) return { ok: false, reason: "余力がありません" };
    cap("余力", D(available).div(perUnitNotional));

    if (!qty.isFinite()) return { ok: false, reason: `数量が計算できないため拒否 (${qty})` };
    qty = floorToStep(qty, inst.lotSize);
    if (!qty.isFinite()) return { ok: false, reason: `数量が計算できないため拒否 (${qty})` };
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
