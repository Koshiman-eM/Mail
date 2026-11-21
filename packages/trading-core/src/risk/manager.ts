import { enabledAssetClasses, enabledProfile } from "../core/assetClasses";
import { quoteCostBps } from "../core/costs";
import type { MarketCalendar } from "../core/calendar";
import { D, floorToStep, Decimal } from "../core/decimal";
import { costFeeRate } from "../core/fees";
import { createLogger } from "../core/logger";
import { canShort } from "../core/short";
import { sweepOld } from "../core/sweep";
import { normalizeReason } from "../engine/context";
import { clampTempo, relaxToward } from "../engine/tempo";
import type { AssetClass, Instrument, PositionView, Quote, RiskDecision, RiskLimits, RiskState, Signal, Store, TradingMode } from "../core/types";
import { effectiveRiskLimits } from "./settings";
import { isoDayKey } from "../core/util";

const log = createLogger("risk");
const DAY_MS = 86_400_000;
/** 旧キー (mode なし)。paper 用として扱い、live では読まない */
export const LEGACY_RISK_STATE_KEY = "risk:state";
export const riskStateKey = (mode: TradingMode) => `${LEGACY_RISK_STATE_KEY}:${mode}`;
/** 損切りと決済側の価格 (ロング: bid / ショート: ask) の距離の下限 (スプレッドの倍数) */
export const MIN_STOP_DISTANCE_SPREADS = 2;

/**
 * 往復の想定コスト (bps) = 往復の手数料 (taker + 約定ごとの固定手数料の率換算。src/core/fees.ts) + スプレッド。
 * 固定手数料の無い銘柄は従来どおり 往復 taker 手数料 + スプレッド (定義は src/core/costs.ts)
 */
export const costBps = quoteCostBps;

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
  /**
   * テンポ (0〜1。`src/engine/tempo.ts`)。省略時は従来のコスト比の判定そのまま
   * (控除前の期待値: 期待値 ≥ 比率 × コスト。コスト控除後 (edgeIsNet): 期待値 ≥ max(0, 比率 − 1) × コスト かつ > 0)。
   * 渡すとテンポのモードになり、コスト比の判定だけを変える (tempoEdgeRequirement)。ほかの判定は変えない
   */
  tempo?: number;
  /**
   * 探索を許すか (テンポのモードのときだけ意味を持つ。paper、または live で TEMPO_ALLOW_LIVE_EXPLORE=true のときエンジンが true にする)。
   * true なら edgeIsNet のシグナルの「期待値 > 0」を外し、下限を tempo × cost だけ下げる (tempoEdgeRequirement)。
   * 控除前の期待値のシグナル (edgeIsNet なし) には影響しない。tempo が無ければ無視する
   */
  tempoExplore?: boolean;
  /**
   * 予定の約定代金 (クオート通貨建て) での往復コスト (bps)。Jupiter の銘柄だけエンジンが渡す (固定手数料の率と価格影響が代金で変わるため)。
   * 渡すと、サイズを決めた後にその代金のコストで期待値の判定 (上と同じ規則) をもう一度行い、満たさなければ拒否する。
   * 省略時は従来どおり (気配のスプレッドと代表的な代金のコストだけ)
   */
  costBpsAt?: (notionalQuote: number) => number | undefined;
}

/**
 * コスト控除後の期待値 (edgeIsNet) のシグナルに求める期待値の下限: max(0, 比率 − 1) × コスト (bps)。
 * これに加えて「純 > 0」も求める。テンポの有無によらず同じ規則 (RiskManager とバックテストのエントリーの判定で共通)
 */
export function netEdgeMinBps(ratio: number, cost: number): number {
  return Math.max(0, ratio - 1) * cost;
}

/** テンポのモードで minEdgeToCostRatio を緩める下限の既定値 (RiskLimits.tempoMinEdgeToCost) */
export const DEFAULT_TEMPO_MIN_EDGE_TO_COST = 1;

/**
 * テンポのモードのコスト比の要件。
 * - 比率 ratioEff = relaxToward(minEdgeToCostRatio, 下限, tempo)。下限 = max(1, tempoMinEdgeToCost (既定 1))。
 *   設定が下限より低ければ設定のまま。
 * - edgeIsNet (期待値がコスト控除後) のシグナル: expectedEdgeBps ≥ max(0, ratioEff - 1) × cost かつ > 0
 *   (控除前に直すと「控除前 ≥ ratioEff × cost」で、コストを二重に数えない)。
 *   explore (探索を許す) なら expectedEdgeBps ≥ max(0, ratioEff - 1) × cost - clamp(tempo) × cost で、「> 0」は外す
 *   (戦略の tempoNetEdgeFloor と同じ幅だけ下げる。期待値 0 以下の探索のシグナルを通す。サイズはエンジンが絞る)。
 * - それ以外: expectedEdgeBps ≥ ratioEff × cost (explore でも同じ。比率の下限 ≥ 1 なので期待値は 0 以上が必要なまま)。
 */
export function tempoEdgeRequirement(
  limits: Pick<RiskLimits, "minEdgeToCostRatio" | "tempoMinEdgeToCost">,
  tempo: number,
  cost: number,
  edgeIsNet: boolean,
  explore = false,
): { ratio: number; minEdgeBps: number; requirePositive: boolean } {
  const t = limits.tempoMinEdgeToCost;
  const floor = t !== undefined && Number.isFinite(t) ? Math.max(DEFAULT_TEMPO_MIN_EDGE_TO_COST, t) : DEFAULT_TEMPO_MIN_EDGE_TO_COST;
  const ratio = relaxToward(limits.minEdgeToCostRatio, floor, tempo);
  if (edgeIsNet) {
    const base = netEdgeMinBps(ratio, cost);
    if (explore) return { ratio, minEdgeBps: base - clampTempo(tempo) * cost, requirePositive: false };
    return { ratio, minEdgeBps: base, requirePositive: true };
  }
  return { ratio, minEdgeBps: ratio * cost, requirePositive: false };
}

type InternalState = RiskState & { dayKey?: string };

const nextUtcMidnight = (ts: number) => Math.floor(ts / DAY_MS) * DAY_MS + DAY_MS;

const lookup = (m: EntryParams["instruments"], sym: string): Instrument | undefined =>
  !m ? undefined : m instanceof Map ? m.get(sym) : m[sym];

/** 有限の数値か (number / Decimal) */
const finiteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 資産クラス別エクスポージャーの詳細 (口座通貨建て、decimal) */
export interface ClassExposure {
  /**
   * 資産クラス別の建玉額。換算できない建玉があるクラスは、換算できた分だけの合計。
   * 使うクラス (アプリが選んだクラス) は 0 から始める。使わないクラス (trader の古い fx / stock の建玉など) があれば
   * そのクラスのキーにも積む (例外にしない)
   */
  exposure: Partial<Record<string, Decimal>>;
  /** 換算できない (価格・数量・為替が非有限) 建玉があり、合計が不明な資産クラスと銘柄 */
  unknown: Partial<Record<string, string[]>>;
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
  const exposure: ClassExposure["exposure"] = Object.fromEntries(enabledAssetClasses().map((c) => [c, D(0)]));
  const unknown: ClassExposure["unknown"] = {};
  const markUnknown = (cls: string, sym: string) => {
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
    exposure[cls] = (exposure[cls] ?? D(0)).plus(D(p.qty).abs().mul(px).mul(cs).mul(rate));
  }
  return { exposure, unknown };
}

/**
 * サイズ倍率 (計画 × 腕の重み × 予想) の上限。呼び出し側でも同じ値で制限しているが、RiskManager でも二重に制限する
 */
export const MAX_SIZE_MULTIPLIER = 1.5;

/**
 * ダッシュボードの上書き値 (kv `risk:limits:<mode>`) を読み直す間隔 (ms)。
 * 評価のたびに kv を読まないための短いキャッシュ。エンジンは毎ティックの onEquity で必ず読み直すので、
 * 変更は次のティックから効く (ティック間隔 SCALP_LOOP_MS の既定 5 秒より短くしておく)。
 */
export const RISK_OVERRIDE_CACHE_MS = 2_000;

export interface RiskManagerOptions {
  mode?: TradingMode;
  overrideCacheMs?: number;
  /**
   * 取引先 (Instrument.venue と完全一致) ごとの実効レバレッジの上限 (評価額の倍率。正の数)。
   * その取引先の建玉の合計 (絶対値の口座通貨換算) が 評価額 × 上限 を超える新規エントリーを縮める・拒否する (ほかの上限に追加で効く)。
   * 既定なし (trader は使わない)。FX・株式の証拠金口座で使う
   */
  venueLeverageCaps?: Record<string, number>;
  /** 取引時間のカレンダー (日次損失の日の区切り)。省略時は UTC の 0 時 (従来どおり) */
  calendar?: MarketCalendar;
}

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
  /** 取引先ごとの実効レバレッジの上限 (評価額の倍率)。無い取引先は判定しない */
  private readonly venueLeverageCaps?: Readonly<Record<string, number>>;
  /** 取引時間のカレンダー (日の区切り)。無ければ UTC */
  private readonly calendar?: MarketCalendar;

  /**
   * 取引先の建玉の合計 (絶対値の口座通貨換算) が 評価額 × 上限 を超えない余地 (建玉額)。
   * 評価額はその取引先の口座の評価額を前提とする: live でほかの取引先の建玉があれば (評価額が口座ごとでないので) 拒否する。
   * paper は単一の PaperBroker の評価額 (全銘柄の合計) を使い、ほかの取引先の建玉は数えない
   */
  private venueLeverageRoom(
    inst: Instrument, levCap: number, open: RiskPosition[], p: EntryParams, toAcct: (ccy: string) => number, equity: number,
  ): { ok: true; room: Decimal } | { ok: false; reason: string } {
    let venueExposure = D(0);
    for (const x of open) {
      const xi = x.symbol === inst.symbol ? inst : lookup(p.instruments, x.symbol);
      if (!xi) return { ok: false, reason: `取引先の分からない建玉 (${x.symbol}) があるため ${inst.venue} の実効レバレッジを確認できず拒否` };
      if (xi.venue !== inst.venue) {
        if (this.tradeMode === "live") {
          return { ok: false, reason: `live にほかの取引先の建玉 (${x.symbol}, ${xi.venue}) があり、${inst.venue} の口座の評価額で実効レバレッジを確認できないため拒否` };
        }
        continue;
      }
      const px = x.price ?? p.prices?.[x.symbol] ?? x.avgPrice;
      let rate = NaN;
      try {
        rate = xi.quoteCurrency ? toAcct(xi.quoteCurrency) : 1;
      } catch {
        rate = NaN;
      }
      const xcs = x.contractSize ?? xi.contractSize ?? 1;
      if (!finiteNum(x.qty) || !finiteNum(px) || !(px >= 0) || !finiteNum(rate) || !(rate > 0) || !finiteNum(xcs) || !(xcs > 0)) {
        return { ok: false, reason: `${inst.venue} の建玉額が計算できないため拒否 (${x.symbol})` };
      }
      venueExposure = venueExposure.plus(D(Math.abs(x.qty)).mul(px).mul(xcs).mul(rate));
    }
    const room = D(equity).mul(levCap).minus(venueExposure);
    if (!room.isFinite()) return { ok: false, reason: `${inst.venue} の実効レバレッジの余地が計算できないため拒否` };
    if (room.lte(0)) return { ok: false, reason: `${inst.venue} の建玉の合計が評価額の ${levCap} 倍 (実効レバレッジの上限) に達しているため拒否` };
    return { ok: true, room };
  }

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
    keyOrOpts: string | RiskManagerOptions = {},
  ) {
    let saved: InternalState | undefined;
    this.overrideCacheMs = RISK_OVERRIDE_CACHE_MS;
    if (typeof keyOrOpts === "string") {
      this.key = keyOrOpts;
      saved = store?.kvGet<InternalState>(this.key);
    } else {
      const mode = keyOrOpts.mode ?? "paper";
      this.tradeMode = mode;
      if (store) this.overrideMode = mode;
      if (keyOrOpts.overrideCacheMs !== undefined) this.overrideCacheMs = keyOrOpts.overrideCacheMs;
      if (keyOrOpts.calendar) this.calendar = keyOrOpts.calendar;
      if (keyOrOpts.venueLeverageCaps) {
        for (const [venue, k] of Object.entries(keyOrOpts.venueLeverageCaps)) {
          if (!(Number.isFinite(k) && k > 0)) throw new Error(`venueLeverageCaps の ${venue} は正の倍率で指定してください (${k})`);
        }
        this.venueLeverageCaps = { ...keyOrOpts.venueLeverageCaps };
      }
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
    // 日の区切り: 取引時間のカレンダーがあればその取引日 (FX は NY 17:00 など)、無ければ UTC の日付 (従来どおり)
    const key = this.calendar ? this.calendar.tradingDayKey(now) : isoDayKey(now);
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
      st.haltedUntil = this.calendar ? this.calendar.nextTradingDayStart(now) : nextUtcMidnight(now);
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

  /**
   * 期待値とコストの比の判定 (純期待値の規則・テンポ)。cost は往復コスト (bps)。
   * 気配のコストで 1 回、Jupiter (costBpsAt あり) はサイズを決めた後に実際の代金のコストでもう 1 回使う
   */
  private edgeCheck(signal: Signal, cost: number, L: RiskLimits, p: Pick<EntryParams, "tempo" | "tempoExplore">): { ok: true; note: string } | { ok: false; reason: string } {
    if (p.tempo === undefined) {
      if (signal.edgeIsNet === true) {
        // コスト控除後の期待値のシグナル: テンポの有無によらず「純 ≥ max(0, 比率 − 1) × コスト かつ 純 > 0」
        // (控除前に直すと「控除前 ≥ 比率 × コスト」。コストを二重に数えない。NaN は通さない)
        const edge = signal.expectedEdgeBps;
        const min = netEdgeMinBps(L.minEdgeToCostRatio, cost);
        if (!(edge > 0)) return { ok: false, reason: `期待値 (コスト控除後) ${edge.toFixed(1)}bps が 0 以下` };
        if (!(edge >= min)) {
          return { ok: false, reason: `期待値 (コスト控除後) ${edge.toFixed(1)}bps < コスト ${cost.toFixed(1)}bps × (${L.minEdgeToCostRatio} - 1)` };
        }
        return { ok: true, note: `edge ${edge.toFixed(1)}bps (net) / cost ${cost.toFixed(1)}bps` };
      } else {
        if (signal.expectedEdgeBps < L.minEdgeToCostRatio * cost) {
          return { ok: false, reason: `期待値幅 ${signal.expectedEdgeBps.toFixed(1)}bps < コスト ${cost.toFixed(1)}bps × ${L.minEdgeToCostRatio}` };
        }
        return { ok: true, note: `edge ${signal.expectedEdgeBps.toFixed(1)}bps / cost ${cost.toFixed(1)}bps` };
      }
    } else {
      // テンポのモード: 比率を下限まで緩める。コスト控除後の期待値のシグナルはコストを二重に数えない (比率 - 1)。
      // NaN の期待値は通さない (fail-closed)
      // 探索 (tempoExplore) はコスト控除後の期待値のシグナルにだけ効き、「> 0」を外して下限を tempo × cost 下げる
      const t = clampTempo(p.tempo);
      const net = signal.edgeIsNet === true;
      const explore = net && p.tempoExplore === true;
      const req = tempoEdgeRequirement(L, t, cost, net, explore);
      const edge = signal.expectedEdgeBps;
      const tag = `テンポ ${t.toFixed(2)}${explore ? " (探索)" : ""}`;
      if (net) {
        if (req.requirePositive && !(edge > 0)) {
          return { ok: false, reason: `${tag}: 期待値 (コスト控除後) ${edge.toFixed(1)}bps が 0 以下` };
        }
        if (!(edge >= req.minEdgeBps)) {
          return {
            ok: false,
            reason: explore
              ? `${tag}: 期待値 (コスト控除後) ${edge.toFixed(1)}bps < コスト ${cost.toFixed(1)}bps × (${req.ratio.toFixed(2)} - 1 - ${t.toFixed(2)})`
              : `${tag}: 期待値 (コスト控除後) ${edge.toFixed(1)}bps < コスト ${cost.toFixed(1)}bps × (${req.ratio.toFixed(2)} - 1)`,
          };
        }
      } else if (!(edge >= req.minEdgeBps)) {
        return { ok: false, reason: `${tag}: 期待値幅 ${edge.toFixed(1)}bps < コスト ${cost.toFixed(1)}bps × ${req.ratio.toFixed(2)}` };
      }
      return { ok: true, note: `edge ${edge.toFixed(1)}bps${net ? " (net)" : ""} / cost ${cost.toFixed(1)}bps / ${tag} (比率 ${req.ratio.toFixed(2)})` };
    }
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

    // コスト比 (気配のスプレッドと代表的な代金でのコスト。Jupiter は下でサイズを決めてから実際の代金のコストでも確かめる)
    const cost = costBps(inst, quote);
    const edgeCheck = this.edgeCheck(signal, cost, L, p);
    if (!edgeCheck.ok) return { ok: false, reason: edgeCheck.reason };
    notes.push(edgeCheck.note);

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
    // 上限の無い資産クラス (廃止した fx / stock の古い銘柄定義など) は新規エントリーしない (fail-closed)
    const classLimit = (L.maxExposureByClass as Partial<Record<string, number>>)[inst.assetClass];
    if (!finiteNum(classLimit)) return { ok: false, reason: `${inst.assetClass} は対象外の資産クラスのため拒否 (エクスポージャー上限がありません)` };
    const classRoom = D(equity).mul(classLimit).minus(exposure[inst.assetClass] ?? D(0));
    if (!classRoom.isFinite()) return { ok: false, reason: `${inst.assetClass} のエクスポージャー上限の余地が計算できないため拒否` };
    if (classRoom.lte(0)) return { ok: false, reason: `${inst.assetClass} のエクスポージャー上限に到達` };
    cap(`${inst.assetClass} エクスポージャー上限`, classRoom.div(perUnitNotional));

    // 取引先ごとの実効レバレッジの上限 (venueLeverageCaps。FX・株式の証拠金口座など。既定なし = 判定しない)
    const venueCap = this.venueLeverageCaps?.[inst.venue];
    if (venueCap !== undefined) {
      const r = this.venueLeverageRoom(inst, venueCap, open, p, toAcct, equity);
      if (!r.ok) return { ok: false, reason: r.reason };
      cap(`${inst.venue} の実効レバレッジ上限 (評価額の ${venueCap} 倍)`, r.room.div(perUnitNotional));
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
    // 実際の代金でのコスト (Jupiter: 固定手数料 / 代金 と 代金・流動性による価格影響)。満たさなければ拒否する (サイズは小さくしない)
    let sizedCost: number | undefined;
    if (p.costBpsAt) {
      const notional = D(entry).mul(qty).mul(cs).toNumber();
      const c = p.costBpsAt(notional);
      if (c === undefined || !Number.isFinite(c) || c < 0) return { ok: false, reason: `代金 ${notional.toFixed(2)} でのコストが計算できないため拒否` };
      const sized = this.edgeCheck(signal, c, L, p);
      if (!sized.ok) return { ok: false, reason: `代金 ${notional.toFixed(2)} ${inst.quoteCurrency} でのコスト: ${sized.reason}` };
      notes.push(`代金 ${notional.toFixed(2)} ${inst.quoteCurrency}: ${sized.note}`);
      sizedCost = c;
    }

    // 流動性の確認が要る資産クラス (プロファイルの requiresLiquidityCheck。meme)
    if (enabledProfile(inst.assetClass)?.requiresLiquidityCheck) {
      const liq = p.liquidityUsd;
      if (liq === undefined || !Number.isFinite(liq)) return { ok: false, reason: "ミームコインの流動性が不明のため拒否" };
      if (liq < L.memeMinLiquidityUsd) return { ok: false, reason: `流動性 $${Math.round(liq)} < 最低 $${L.memeMinLiquidityUsd}` };
      notes.push(`liquidity $${Math.round(liq)}`);
    }

    const recent = this.st.recentOrderTs.filter((t) => now - t < 60_000).length;
    if (recent >= L.maxOrdersPerMinute) return { ok: false, reason: `1分あたり発注数上限 ${L.maxOrdersPerMinute} に到達` };

    notes.push(`qty ${qty.toString()}`);
    return { ok: true, qty: qty.toString(), notes, ...(sizedCost !== undefined ? { costBps: sizedCost } : {}) };
  }
}
