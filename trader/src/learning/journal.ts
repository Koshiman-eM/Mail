import { randomUUID } from "node:crypto";
import { D, type Decimal } from "../core/decimal";
import type {
  AssetClass,
  EntryContext,
  ExitReason,
  Horizon,
  Store,
  TradeRecord,
  TradingMode,
} from "../core/types";

/** エントリー情報 */
export interface OpenTradeInput {
  /** 省略時は UUID */
  id?: string;
  mode: TradingMode;
  symbol: string;
  venue: string;
  assetClass: AssetClass;
  strategyId: string;
  horizon: Horizon;
  direction: "long" | "short";
  /** 数量 (正の値) */
  qty: number;
  entryTs: number;
  entryPrice: number;
  /** シグナル時点の想定価格 */
  intendedEntryPrice: number;
  initialStop: number;
  takeProfit?: number;
  entryContext: EntryContext;
  /** エントリー時の手数料 (決済時の fees に加算される) */
  entryFees?: number;
  /** 1 単位あたりの契約サイズ (FX/先物)。既定 1 */
  contractSize?: number;
  /** 約定を確認できず、建玉の照会・手動の申告から数量・価格を推定したエントリー */
  estimated?: boolean;
  /** paper で再現した空売り (TradeRecord.simulatedShort へ引き継ぐ) */
  simulatedShort?: boolean;
  /** エントリーの注文の種類 (TradeRecord.entryOrderType へ引き継ぐ) */
  entryOrderType?: "market" | "limit";
  /** エントリーの手数料の liquidity 別の内訳 (クオート通貨建て。entryFees の内訳) */
  feesByLiquidity?: FeesByLiquidity;
}

/** 手数料の liquidity 別の内訳 (クオート通貨建て。maker は受け取りなら負) */
export interface FeesByLiquidity {
  maker: number;
  taker: number;
}

/** 追跡中のポジション */
export interface OpenTrade extends OpenTradeInput {
  id: string;
  /** エントリー手数料の全額 (一部決済では按分せず、最後の決済の TradeRecord にまとめる) */
  entryFees: number;
  contractSize: number;
  /** 保有中の最高値・最安値 (エントリー価格を含む) */
  highWater: number;
  lowWater: number;
  lastPrice: number;
  lastTs: number;
  /** 一部決済 (reduce) の回数 */
  partials?: number;
  /**
   * 一部決済の累計 (decimal 文字列)。qty は残りの数量で、元の数量は qty + exitedQty。
   * 最後に全量を決済したとき、元の数量・加重平均の決済価格・合計損益で 1 件の TradeRecord にする
   */
  exitedQty?: string;
  /** Σ 決済数量 × 決済価格 (加重平均の決済価格用) */
  exitNotional?: string;
  /** Σ 決済数量 × 想定決済価格 */
  intendedExitNotional?: string;
  /** 一部決済の実現損益 (手数料控除前、クオート通貨建て) */
  realizedGross?: string;
  /** 一部決済の手数料 (クオート通貨建て) */
  exitFees?: string;
  /** 手数料の liquidity 別の累計 (エントリー + 一部決済。decimal 文字列) */
  makerFees?: string;
  takerFees?: string;
  /** 一部決済に指値 (利確の板置き) の約定を含む */
  exitLimit?: boolean;
}

export interface CloseTradeInput {
  /** open が返した id */
  id: string;
  exitPrice: number;
  /** 想定決済価格 (ストップ価格・利確価格・シグナル時点の価格)。省略時は exitPrice */
  intendedExitPrice?: number;
  exitTs: number;
  exitReason: ExitReason;
  /** 決済時の手数料 (クオート通貨建て)。open.entryFees と合算して TradeRecord.fees になる */
  fees?: number;
  /** 約定を確認できず推定した決済 (TradeRecord.estimated を付ける) */
  estimated?: boolean;
  /** 決済の手数料の liquidity 別の内訳 (fees の内訳) */
  feesByLiquidity?: FeesByLiquidity;
  /** 決済の注文の種類 (板に置いた利確の指値なら limit) */
  exitOrderType?: "market" | "limit";
  /** 読みの管理の記録 (TradeRecord にそのまま付ける。読みの管理を使った建玉だけ) */
  thesis?: TradeThesisFields;
}

/** TradeRecord の読みの管理の項目 */
export type TradeThesisFields = Pick<
  TradeRecord, "thesisExpectedMs" | "thesisDeadlineTs" | "thesisExtendedAt" | "thesisOutcome" | "thesisNetRAtDeadline" | "thesisStopExit"
>;

/** 一部決済の入力。qty は決済した数量 (正の値) */
export type ReduceTradeInput = Omit<CloseTradeInput, "id"> & { qty: number };

/** reduce の結果: 全量の決済になった (closed) か、残りを追跡中 (reduced) か */
export type ReduceResult = { kind: "closed"; trade: TradeRecord } | { kind: "reduced"; position: OpenTrade };

/** 旧キー (mode なし)。paper 用として扱い、live では読まない */
export const LEGACY_OPEN_KV_KEY = "journal:open";
export const openKvKey = (mode: TradingMode) => `${LEGACY_OPEN_KV_KEY}:${mode}`;

/**
 * ポジションのライフサイクル追跡。open → mark (MFE/MAE 更新) → reduce (一部決済) / close で TradeRecord を作る。
 * store を渡すと、保有中ポジションを kv (mode 別のキー) に保存 (再起動時に復元) し、reduce / close で saveTrade する。
 * mode を指定すると、その mode のポジションだけを読み込み・受け付ける (paper と live の混在防止)。
 */
export class TradeJournal {
  private readonly open_ = new Map<string, OpenTrade>();
  private readonly store?: Store;
  readonly mode: TradingMode;
  private readonly strict: boolean;

  constructor(opts: { store?: Store; mode?: TradingMode } = {}) {
    this.store = opts.store;
    this.mode = opts.mode ?? "paper";
    this.strict = opts.mode !== undefined;
    let saved = this.store?.kvGet<OpenTrade[]>(openKvKey(this.mode));
    if (saved === undefined && this.mode === "paper") saved = this.store?.kvGet<OpenTrade[]>(LEGACY_OPEN_KV_KEY);
    for (const p of Array.isArray(saved) ? saved : []) {
      // 他の mode の追跡ポジションは読み込まない (旧キーに live が残っていても paper へ混ぜない)
      if (!p || typeof p.id !== "string" || (p.mode ?? "paper") !== this.mode) continue;
      this.open_.set(p.id, p);
    }
  }

  open(input: OpenTradeInput): OpenTrade {
    if (this.strict && input.mode !== this.mode) throw new Error(`mode が違います (journal=${this.mode}, input=${input.mode})`);
    if (!(input.qty > 0)) throw new Error(`qty は正の値が必要です: ${input.qty}`);
    if (!(input.entryPrice > 0)) throw new Error(`entryPrice が不正です: ${input.entryPrice}`);
    const id = input.id ?? randomUUID();
    if (this.open_.has(id)) throw new Error(`ポジション ${id} は既に追跡中です`);
    const { feesByLiquidity: fl, ...rest } = input;
    const p: OpenTrade = {
      ...rest,
      ...(fl ? { makerFees: D(fl.maker).toString(), takerFees: D(fl.taker).toString() } : {}),
      id,
      entryFees: input.entryFees ?? 0,
      contractSize: input.contractSize ?? 1,
      highWater: input.entryPrice,
      lowWater: input.entryPrice,
      lastPrice: input.entryPrice,
      lastTs: input.entryTs,
    };
    this.open_.set(id, p);
    this.persist();
    return { ...p };
  }

  /** 価格を反映して高値・安値 (MFE/MAE の元) を更新。更新したポジション数を返す */
  mark(symbol: string, price: number, ts: number): number {
    if (!(price > 0)) return 0;
    let n = 0;
    let changed = false;
    for (const p of this.open_.values()) {
      if (p.symbol !== symbol) continue;
      n++;
      if (price > p.highWater) {
        p.highWater = price;
        changed = true;
      }
      if (price < p.lowWater) {
        p.lowWater = price;
        changed = true;
      }
      p.lastPrice = price;
      p.lastTs = ts;
    }
    // 高値・安値が変わった時だけ永続化 (頻繁な書き込みを避ける)
    if (changed) this.persist();
    return n;
  }

  get(id: string): OpenTrade | undefined {
    const p = this.open_.get(id);
    return p ? { ...p } : undefined;
  }

  list(): OpenTrade[] {
    return [...this.open_.values()].map((p) => ({ ...p }));
  }

  find(symbol: string, strategyId?: string): OpenTrade | undefined {
    for (const p of this.open_.values()) {
      if (p.symbol === symbol && (strategyId === undefined || p.strategyId === strategyId)) return { ...p };
    }
    return undefined;
  }

  close(input: CloseTradeInput): TradeRecord {
    const p = this.open_.get(input.id);
    if (!p) throw new Error(`ポジション ${input.id} は追跡されていません`);
    if (!(input.exitPrice > 0)) throw new Error(`exitPrice が不正です: ${input.exitPrice}`);
    const trade = buildTradeRecord(p, input);
    this.open_.delete(input.id);
    this.persist();
    this.store?.saveTrade(trade);
    return trade;
  }

  /**
   * 一部決済。TradeRecord は作らず、決済した数量・損益・手数料・決済価格をポジションに累計して残りの追跡を続ける
   * (学習が 1 回のトレードを複数回として数えないように)。最後に全量を決済したときに、元の数量・加重平均の
   * 決済価格・合計損益で 1 件の TradeRecord を保存する。qty が保有数量以上なら close と同じ。
   */
  reduce(id: string, input: ReduceTradeInput): ReduceResult {
    const p = this.open_.get(id);
    if (!p) throw new Error(`ポジション ${id} は追跡されていません`);
    const qty = D(input.qty);
    if (!qty.isFinite() || !qty.gt(0)) throw new Error(`qty は正の値が必要です: ${input.qty}`);
    const { qty: _q, ...rest } = input;
    if (qty.gte(p.qty)) return { kind: "closed", trade: this.close({ ...rest, id }) };
    if (!(input.exitPrice > 0)) throw new Error(`exitPrice が不正です: ${input.exitPrice}`);
    const dir = p.direction === "long" ? 1 : -1;
    const intended = input.intendedExitPrice ?? input.exitPrice;
    p.exitedQty = D(p.exitedQty ?? 0).plus(qty).toString();
    p.exitNotional = D(p.exitNotional ?? 0).plus(qty.mul(input.exitPrice)).toString();
    p.intendedExitNotional = D(p.intendedExitNotional ?? 0).plus(qty.mul(intended)).toString();
    p.realizedGross = D(p.realizedGross ?? 0)
      .plus(D(input.exitPrice).minus(p.entryPrice).mul(qty).mul(p.contractSize).mul(dir))
      .toString();
    p.exitFees = D(p.exitFees ?? 0).plus(input.fees ?? 0).toString();
    if (input.feesByLiquidity) {
      p.makerFees = D(p.makerFees ?? 0).plus(input.feesByLiquidity.maker).toString();
      p.takerFees = D(p.takerFees ?? 0).plus(input.feesByLiquidity.taker).toString();
    }
    if (input.exitOrderType === "limit") p.exitLimit = true;
    p.qty = D(p.qty).minus(qty).toNumber();
    p.partials = (p.partials ?? 0) + 1;
    // 一部決済の価格も MFE/MAE に含める
    if (input.exitPrice > p.highWater) p.highWater = input.exitPrice;
    if (input.exitPrice < p.lowWater) p.lowWater = input.exitPrice;
    if (input.estimated) p.estimated = true;
    this.persist();
    return { kind: "reduced", position: { ...p } };
  }

  private persist() {
    this.store?.kvSet(openKvKey(this.mode), [...this.open_.values()]);
  }
}

/**
 * 損益・R・MFE/MAE の計算 (会計値は decimal)。
 * 一部決済の累計があれば、元の数量 (残り + 決済済み)・加重平均の決済価格・合計損益で 1 件にまとめる。
 */
export function buildTradeRecord(p: OpenTrade, c: CloseTradeInput): TradeRecord {
  const dir = p.direction === "long" ? 1 : -1;
  const high = Math.max(p.highWater, c.exitPrice);
  const low = Math.min(p.lowWater, c.exitPrice);
  const remain = D(p.qty).abs();
  const exited = D(p.exitedQty ?? 0);
  const totalQty = remain.plus(exited);
  const units = totalQty.mul(p.contractSize);
  const entry = D(p.entryPrice);
  const intendedExit = c.intendedExitPrice ?? c.exitPrice;

  const gross = D(p.realizedGross ?? 0).plus(D(c.exitPrice).minus(entry).mul(remain).mul(p.contractSize).mul(dir));
  const fees = D(p.entryFees).plus(p.exitFees ?? 0).plus(c.fees ?? 0);
  const net = gross.minus(fees);
  const notional = entry.mul(units).abs();
  const returnPct = notional.gt(0) ? net.div(notional) : D(0);
  const risk = entry.minus(p.initialStop).abs().mul(units);
  const rMultiple = risk.gt(0) ? net.div(risk) : D(0);
  // 一部決済があれば数量で加重平均した決済価格 (無ければ今回の価格そのもの)
  const partial = exited.gt(0) && totalQty.gt(0);
  const exitPrice = partial ? D(p.exitNotional ?? 0).plus(remain.mul(c.exitPrice)).div(totalQty).toNumber() : c.exitPrice;
  const intendedExitPrice = partial ? D(p.intendedExitNotional ?? 0).plus(remain.mul(intendedExit)).div(totalQty).toNumber() : intendedExit;

  const favorable = dir === 1 ? D(high).minus(entry) : entry.minus(low);
  const adverse = dir === 1 ? entry.minus(low) : D(high).minus(entry);
  const mfePct = nonNeg(favorable.div(entry));
  const maePct = nonNeg(adverse.div(entry));

  return {
    id: p.id,
    mode: p.mode,
    symbol: p.symbol,
    venue: p.venue,
    assetClass: p.assetClass,
    strategyId: p.strategyId,
    horizon: p.horizon,
    direction: p.direction,
    qty: partial ? totalQty.toNumber() : p.qty,
    entryTs: p.entryTs,
    entryPrice: p.entryPrice,
    intendedEntryPrice: p.intendedEntryPrice,
    exitTs: c.exitTs,
    exitPrice,
    intendedExitPrice,
    initialStop: p.initialStop,
    ...(p.takeProfit !== undefined ? { takeProfit: p.takeProfit } : {}),
    grossPnl: gross.toNumber(),
    fees: fees.toNumber(),
    netPnl: net.toNumber(),
    returnPct: returnPct.toNumber(),
    rMultiple: rMultiple.toNumber(),
    mfePct,
    maePct,
    exitReason: c.exitReason,
    entryContext: p.entryContext,
    ...(p.estimated || c.estimated ? { estimated: true } : {}),
    ...(p.simulatedShort ? { simulatedShort: true } : {}),
    ...(p.entryOrderType ? { entryOrderType: p.entryOrderType } : {}),
    ...(p.contractSize !== 1 ? { contractSize: p.contractSize } : {}),
    ...(p.exitLimit || c.exitOrderType === "limit" ? { exitOrderType: "limit" as const } : c.exitOrderType ? { exitOrderType: c.exitOrderType } : {}),
    ...(p.makerFees !== undefined || p.takerFees !== undefined || c.feesByLiquidity
      ? {
          makerFees: D(p.makerFees ?? 0).plus(c.feesByLiquidity?.maker ?? 0).toNumber(),
          takerFees: D(p.takerFees ?? 0).plus(c.feesByLiquidity?.taker ?? 0).toNumber(),
        }
      : {}),
    ...thesisFields(c.thesis),
  };
}

/** 読みの管理の項目 (値のあるものだけ) */
function thesisFields(t: TradeThesisFields | undefined): TradeThesisFields {
  if (!t) return {};
  const out: TradeThesisFields = {};
  if (t.thesisExpectedMs !== undefined) out.thesisExpectedMs = t.thesisExpectedMs;
  if (t.thesisDeadlineTs !== undefined) out.thesisDeadlineTs = t.thesisDeadlineTs;
  if (t.thesisExtendedAt !== undefined) out.thesisExtendedAt = t.thesisExtendedAt;
  if (t.thesisOutcome !== undefined) out.thesisOutcome = t.thesisOutcome;
  if (t.thesisNetRAtDeadline !== undefined && Number.isFinite(t.thesisNetRAtDeadline)) out.thesisNetRAtDeadline = t.thesisNetRAtDeadline;
  if (t.thesisStopExit === true) out.thesisStopExit = true;
  return out;
}

/** 負なら 0 */
const nonNeg = (v: Decimal) => (v.gt(0) ? v.toNumber() : 0);

/** エグジット後の値動きを測る既定の時間 (時間軸別) */
export const DEFAULT_POST_EXIT_HORIZON_MS: Record<Horizon, number> = {
  scalp: 15 * 60_000,
  short: 4 * 3_600_000,
  mid: 86_400_000,
  long: 7 * 86_400_000,
};

export type PriceAt = (symbol: string, ts: number) => number | undefined;

/**
 * エグジット後の値動き postExitMovePct を後から埋める。
 * postExitMovePct = 方向 × (エグジット + horizon 時点の価格 − exitPrice) / exitPrice (エントリー方向に有利なら正)。
 * priceAt が undefined を返したトレード、now 指定時に horizon が未経過のトレードはスキップ (次回再試行)。
 * 更新したトレード (更新後の値) を返す。
 */
export function fillPostExitMoves(
  store: Store,
  priceAt: PriceAt,
  horizonMsByHorizon: Partial<Record<Horizon, number>> = DEFAULT_POST_EXIT_HORIZON_MS,
  opts: { now?: number; since?: number } = {},
): TradeRecord[] {
  const horizons = { ...DEFAULT_POST_EXIT_HORIZON_MS, ...horizonMsByHorizon };
  const updated: TradeRecord[] = [];
  for (const t of store.listTrades({ since: opts.since, until: opts.now })) {
    if (t.postExitMovePct !== undefined && t.postExitMovePct !== null) continue;
    const h = horizons[t.horizon];
    if (!(h > 0) || !(t.exitPrice > 0)) continue;
    const at = t.exitTs + h;
    if (opts.now !== undefined && at > opts.now) continue;
    const price = priceAt(t.symbol, at);
    if (price === undefined || !(price > 0)) continue;
    const dir = t.direction === "long" ? 1 : -1;
    const move = (dir * (price - t.exitPrice)) / t.exitPrice;
    store.updateTrade(t.id, { postExitMovePct: move });
    updated.push({ ...t, postExitMovePct: move });
  }
  return updated;
}
