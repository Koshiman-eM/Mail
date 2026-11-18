import { D } from "../core/decimal";
import { createLogger, type Logger } from "../core/logger";
import type { Broker, BrokerPosition, ExitReason, OrderResult, PositionView, Quote, Store, TradeRecord } from "../core/types";
import type { OpenTrade, OpenTradeInput, TradeJournal } from "../learning/journal";

/** エントリー時に決まる決済ルール (TradeJournal に無い分) */
export interface ExitPlan {
  /** トレーリング幅 (0.01 = 1%) */
  trailingStopPct?: number;
  /** 最大保有時間 (0 / 未設定なら時間切れなし) */
  maxHoldMs?: number;
}

export interface ExitDecision {
  reason: ExitReason;
  /** 意図した決済価格 (ストップ価格・利確価格・判定時点の価格) */
  intendedPrice: number;
}

export interface CloseResult {
  status: "closed" | "rejected" | "error" | "none";
  trade?: TradeRecord;
  reason?: string;
}

export interface PositionManagerDeps {
  journal: TradeJournal;
  /** 銘柄の発注先 */
  brokerFor: (symbol: string) => Broker;
  /** 決済したトレードを学習へ渡す (learning.onTradeClosed) */
  onTradeClosed?: (t: TradeRecord) => unknown;
  /** 発注の記録 (risk.recordOrder) */
  onOrder?: (now: number) => void;
  store?: Store;
  logger?: Logger;
  /** 注文 clientId の接頭辞 */
  clientIdPrefix?: string;
  /** 決済時点の口座通貨換算 (監査ログに残し、レポートで使う) */
  toAccount?: (ccy: string) => number;
  quoteCurrencyOf?: (symbol: string) => string | undefined;
}

const PLANS_KEY = "positions:exitPlans";
const AUDIT_THROTTLE_MS = 60_000;

const midOf = (q: Quote) => (q.bid + q.ask) / 2;

/**
 * 保有ポジションの管理。1 銘柄 1 ポジション (PaperBroker が銘柄単位でネッティングするため)。
 * - 毎ティック: 価格を journal に反映し、損切り → 利確 → トレーリング → 時間切れ の順で決済を判定する。
 * - 戦略の flat シグナル・kill switch でも決済する。
 * - 決済は reduceOnly の成行。約定したら journal.close で TradeRecord を作り、学習へ渡す。
 */
export class PositionManager {
  private plans: Record<string, ExitPlan>;
  private seq = 0;
  private readonly closing = new Set<string>();
  private readonly lastAudit = new Map<string, number>();
  private readonly log: Logger;

  constructor(private readonly deps: PositionManagerDeps) {
    this.log = deps.logger ?? createLogger("positions");
    const saved = deps.store?.kvGet<Record<string, ExitPlan>>(PLANS_KEY) ?? {};
    const open = new Set(deps.journal.list().map((p) => p.id));
    this.plans = Object.fromEntries(Object.entries(saved).filter(([id]) => open.has(id)));
  }

  private persist(): void {
    this.deps.store?.kvSet(PLANS_KEY, this.plans);
  }

  get(symbol: string): OpenTrade | undefined {
    return this.deps.journal.find(symbol);
  }

  has(symbol: string): boolean {
    return this.get(symbol) !== undefined;
  }

  list(): OpenTrade[] {
    return this.deps.journal.list();
  }

  planOf(id: string): ExitPlan {
    return { ...(this.plans[id] ?? {}) };
  }

  /** トレーリングストップ価格 (当初ストップより有利な場合のみ) */
  trailingStop(p: OpenTrade): number | undefined {
    const pct = this.plans[p.id]?.trailingStopPct;
    if (!(pct !== undefined && pct > 0)) return undefined;
    if (p.direction === "long") {
      const s = p.highWater * (1 - pct);
      return s > p.initialStop ? s : undefined;
    }
    const s = p.lowWater * (1 + pct);
    return s < p.initialStop ? s : undefined;
  }

  /** 現在の実効ストップ (トレーリング込み) */
  currentStop(p: OpenTrade): number {
    return this.trailingStop(p) ?? p.initialStop;
  }

  /** 戦略へ渡すポジション情報 */
  view(p: OpenTrade): PositionView {
    return {
      symbol: p.symbol,
      qty: p.direction === "long" ? p.qty : -p.qty,
      avgPrice: p.entryPrice,
      openedAt: p.entryTs,
      strategyId: p.strategyId,
      stopLoss: this.currentStop(p),
      ...(p.takeProfit !== undefined ? { takeProfit: p.takeProfit } : {}),
      highWater: p.highWater,
      lowWater: p.lowWater,
    };
  }

  /** エントリーの約定後に登録する */
  open(input: OpenTradeInput, plan: ExitPlan): OpenTrade {
    if (this.has(input.symbol)) throw new Error(`${input.symbol} は既にポジションがあります (1 銘柄 1 ポジション)`);
    const p = this.deps.journal.open(input);
    this.plans[p.id] = {
      ...(plan.trailingStopPct !== undefined && plan.trailingStopPct > 0 ? { trailingStopPct: plan.trailingStopPct } : {}),
      ...(plan.maxHoldMs !== undefined && plan.maxHoldMs > 0 ? { maxHoldMs: plan.maxHoldMs } : {}),
    };
    this.persist();
    return p;
  }

  /** 決済判定 (副作用なし)。損切り → 利確 → トレーリング → 時間切れ の順 */
  checkExit(p: OpenTrade, quote: Quote, now: number): ExitDecision | undefined {
    const long = p.direction === "long";
    const { bid, ask } = quote;
    if (!(bid > 0) || !(ask > 0)) return undefined;
    const trail = this.trailingStop(p);
    const hit = (stop: number) => (long ? bid <= stop : ask >= stop);
    if (hit(p.initialStop)) {
      // 引き上げ済みのトレーリングストップを飛び越えて当初ストップまで動いた場合は、先に触れたトレーリング側で記録する
      return trail !== undefined ? { reason: "trailing", intendedPrice: trail } : { reason: "stop", intendedPrice: p.initialStop };
    }
    if (p.takeProfit !== undefined && (long ? bid >= p.takeProfit : ask <= p.takeProfit)) {
      return { reason: "take_profit", intendedPrice: p.takeProfit };
    }
    if (trail !== undefined && hit(trail)) return { reason: "trailing", intendedPrice: trail };
    const maxHold = this.plans[p.id]?.maxHoldMs;
    if (maxHold !== undefined && maxHold > 0 && now - p.entryTs >= maxHold) {
      return { reason: "time", intendedPrice: long ? bid : ask };
    }
    return undefined;
  }

  /** 毎ティックの処理: 価格反映 → 決済判定 → 必要なら決済 */
  async onQuote(symbol: string, quote: Quote, now: number): Promise<CloseResult> {
    const p0 = this.get(symbol);
    if (!p0) return { status: "none" };
    if (quote.bid > 0 && quote.ask > 0) this.deps.journal.mark(symbol, midOf(quote), now);
    const p = this.get(symbol)!;
    const d = this.checkExit(p, quote, now);
    if (!d) return { status: "none" };
    return this.close(symbol, d.reason, d.intendedPrice, now);
  }

  /** ポジションを成行 (reduceOnly) で決済する */
  async close(symbol: string, reason: ExitReason, intendedPrice: number, now: number): Promise<CloseResult> {
    const p = this.get(symbol);
    if (!p) return { status: "none", reason: "ポジションがありません" };
    if (this.closing.has(p.id)) return { status: "none", reason: "決済中" };
    this.closing.add(p.id);
    try {
      const broker = this.deps.brokerFor(symbol);
      const long = p.direction === "long";
      const prefix = this.deps.clientIdPrefix ?? "eng";
      let res: OrderResult;
      try {
        res = await broker.placeOrder({
          clientId: `${prefix}-x-${now}-${++this.seq}`,
          symbol,
          side: long ? "sell" : "buy",
          type: "market",
          qty: D(p.qty).toString(),
          reduceOnly: true,
          strategyId: p.strategyId,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.auditThrottled(`err|${symbol}`, now, "engine.exit_error", { symbol, reason, error: msg });
        this.log.error("決済注文に失敗", { symbol, reason, error: msg });
        return { status: "error", reason: msg };
      }
      this.deps.onOrder?.(now);
      if (res.fills.length === 0) {
        this.auditThrottled(`rej|${symbol}`, now, "engine.exit_rejected", { symbol, reason, status: res.status, detail: res.reason });
        this.log.warn("決済注文が約定しませんでした", { symbol, reason, status: res.status, detail: res.reason });
        return { status: "rejected", reason: res.reason ?? res.status };
      }
      let qty = D(0);
      let notional = D(0);
      let fee = D(0);
      for (const f of res.fills) {
        qty = qty.plus(f.qty);
        notional = notional.plus(D(f.price).mul(f.qty));
        fee = fee.plus(f.fee);
      }
      const exitPrice = qty.gt(0) ? notional.div(qty).toNumber() : res.fills[res.fills.length - 1].price;
      if (qty.lt(p.qty)) this.log.warn("決済が一部約定のみ", { symbol, filled: qty.toString(), qty: p.qty });
      const trade = this.deps.journal.close({
        id: p.id,
        exitPrice,
        intendedExitPrice: intendedPrice,
        exitTs: now,
        exitReason: reason,
        fees: fee.toNumber(),
      });
      delete this.plans[p.id];
      this.persist();
      this.deps.onTradeClosed?.(trade);
      const ccy = this.deps.quoteCurrencyOf?.(symbol);
      const fxRate = ccy && this.deps.toAccount ? this.deps.toAccount(ccy) : NaN;
      this.deps.store?.audit({
        ts: now,
        type: "engine.exit",
        data: {
          tradeId: trade.id,
          symbol,
          strategyId: trade.strategyId,
          direction: trade.direction,
          reason,
          exitPrice,
          intendedExitPrice: intendedPrice,
          netPnl: trade.netPnl,
          rMultiple: Number(trade.rMultiple.toFixed(3)),
          ...(Number.isFinite(fxRate) && fxRate > 0 ? { fxRate, netPnlAccount: D(trade.netPnl).mul(fxRate).toNumber() } : {}),
        },
      });
      return { status: "closed", trade };
    } finally {
      this.closing.delete(p.id);
    }
  }

  /** 全ポジションを決済 (kill switch 等) */
  async closeAll(reason: ExitReason, now: number, quoteOf: (symbol: string) => Quote | undefined): Promise<CloseResult[]> {
    const out: CloseResult[] = [];
    for (const p of this.list()) {
      const q = quoteOf(p.symbol);
      const intended = q ? (p.direction === "long" ? q.bid : q.ask) : p.lastPrice;
      out.push(await this.close(p.symbol, reason, intended, now));
    }
    return out;
  }

  /**
   * 起動時の整合チェック。ブローカーに建玉が無い (または方向が逆の) 追跡中ポジションは
   * 最終価格で手仕舞い済みとして journal から外す (学習には渡さない)。
   */
  reconcile(brokerPositions: BrokerPosition[], now: number): { orphaned: string[]; untracked: string[] } {
    const bySymbol = new Map(brokerPositions.map((b) => [b.symbol, Number(b.qty)]));
    const orphaned: string[] = [];
    for (const p of this.list()) {
      const q = bySymbol.get(p.symbol) ?? 0;
      const ok = p.direction === "long" ? q > 0 : q < 0;
      if (ok) continue;
      this.deps.journal.close({ id: p.id, exitPrice: p.lastPrice, exitTs: now, exitReason: "manual" });
      delete this.plans[p.id];
      orphaned.push(p.symbol);
      this.deps.store?.audit({ ts: now, type: "engine.position_orphaned", data: { tradeId: p.id, symbol: p.symbol, brokerQty: q } });
    }
    if (orphaned.length) this.persist();
    const tracked = new Set(this.list().map((p) => p.symbol));
    const untracked = brokerPositions.filter((b) => Number(b.qty) !== 0 && !tracked.has(b.symbol)).map((b) => b.symbol);
    return { orphaned, untracked };
  }

  private auditThrottled(key: string, now: number, type: string, data: Record<string, unknown>) {
    const last = this.lastAudit.get(key);
    if (last !== undefined && now - last < AUDIT_THROTTLE_MS) return;
    this.lastAudit.set(key, now);
    this.deps.store?.audit({ ts: now, type, data });
  }
}
