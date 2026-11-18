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
}

/** 追跡中のポジション */
export interface OpenTrade extends OpenTradeInput {
  id: string;
  entryFees: number;
  contractSize: number;
  /** 保有中の最高値・最安値 (エントリー価格を含む) */
  highWater: number;
  lowWater: number;
  lastPrice: number;
  lastTs: number;
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
}

const OPEN_KV_KEY = "journal:open";

/**
 * ポジションのライフサイクル追跡。open → mark (MFE/MAE 更新) → close で TradeRecord を作る。
 * store を渡すと、保有中ポジションを kv に保存 (再起動時に復元) し、close で saveTrade する。
 */
export class TradeJournal {
  private readonly open_ = new Map<string, OpenTrade>();
  private readonly store?: Store;

  constructor(opts: { store?: Store } = {}) {
    this.store = opts.store;
    const saved = this.store?.kvGet<OpenTrade[]>(OPEN_KV_KEY);
    for (const p of saved ?? []) this.open_.set(p.id, p);
  }

  open(input: OpenTradeInput): OpenTrade {
    if (!(input.qty > 0)) throw new Error(`qty は正の値が必要です: ${input.qty}`);
    if (!(input.entryPrice > 0)) throw new Error(`entryPrice が不正です: ${input.entryPrice}`);
    const id = input.id ?? randomUUID();
    if (this.open_.has(id)) throw new Error(`ポジション ${id} は既に追跡中です`);
    const p: OpenTrade = {
      ...input,
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
    const trade = buildTradeRecord(p, input);
    this.open_.delete(input.id);
    this.persist();
    this.store?.saveTrade(trade);
    return trade;
  }

  private persist() {
    this.store?.kvSet(OPEN_KV_KEY, [...this.open_.values()]);
  }
}

/** 損益・R・MFE/MAE の計算 (会計値は decimal) */
export function buildTradeRecord(p: OpenTrade, c: CloseTradeInput): TradeRecord {
  const dir = p.direction === "long" ? 1 : -1;
  const high = Math.max(p.highWater, c.exitPrice);
  const low = Math.min(p.lowWater, c.exitPrice);
  const units = D(p.qty).abs().mul(p.contractSize);
  const entry = D(p.entryPrice);

  const gross = D(c.exitPrice).minus(entry).mul(units).mul(dir);
  const fees = D(p.entryFees).plus(c.fees ?? 0);
  const net = gross.minus(fees);
  const notional = entry.mul(units).abs();
  const returnPct = notional.gt(0) ? net.div(notional) : D(0);
  const risk = entry.minus(p.initialStop).abs().mul(units);
  const rMultiple = risk.gt(0) ? net.div(risk) : D(0);

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
    qty: p.qty,
    entryTs: p.entryTs,
    entryPrice: p.entryPrice,
    intendedEntryPrice: p.intendedEntryPrice,
    exitTs: c.exitTs,
    exitPrice: c.exitPrice,
    intendedExitPrice: c.intendedExitPrice ?? c.exitPrice,
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
  };
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
