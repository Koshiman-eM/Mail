/**
 * スワップの見積もり (quote) と、paper の約定で使う実効価格・スリッページの推定。
 *
 * - 見積もりの取得は QuoteProvider の裏に隠す。実装は 2 つ (どちらも公式資料の記述だけで未確認。要確認):
 *   - JupiterSwapQuoteProvider: `GET /swap/v1/quote?inputMint&outputMint&amount&slippageBps`
 *     応答は inAmount / outAmount / otherAmountThreshold (最小単位の整数の文字列) / priceImpactPct (文字列) /
 *     routePlan[] { swapInfo { label, ammKey, feeAmount, feeMint }, percent } / slippageBps / swapMode。
 *   - JupiterUltraOrderProvider: `GET /ultra/v1/order?inputMint&outputMint&amount` を taker なしで呼ぶ (見積もりだけ。
 *     taker を付けると署名用のトランザクションが返るので付けない = client の assertReadOnlyPath が拒否する)。
 *     いまの推奨が Ultra かもしれないため用意しただけで、既定は swap/v1/quote。
 * - スワップの実行 (swap / execute)・署名・送信は実装しない。
 * - estimateFill は純粋関数で、金額の計算は decimal.js (src/core/decimal.ts)。
 *   priceImpactPct の単位は「割合 (0.01 = 1%)」の想定 (要確認。名前は Pct だが資料の例は割合に見える)。
 *   参照価格 (Price V3 の usdPrice など) を渡せば、見積もりの実効価格と参照価格の差から影響を自前で計算し、priceImpactPct は使わない。
 * - routePlan の手数料 (feeAmount) は outAmount に織り込み済みの想定なので、実効価格からは引かない (表示・分析用に USD 換算するだけ)。
 * - 見積もりが取れないときの代わり: 固定の bps + 規模と流動性による影響 (定数積の AMM の近似: 影響 ≈ 2 × 金額 / 流動性)。
 */
import { z } from "zod";
import { D, Decimal } from "../../core/decimal";
import type { Side } from "../../core/types";
import type { JupiterClient } from "./client";
import { isRecord, issuesOf, JupiterShapeError, looseNum, looseStr, toAtomicString } from "./parse";

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  /** 入力トークンの最小単位の整数 (文字列) */
  amount: string;
  slippageBps: number;
}

export interface RouteLeg {
  label?: string;
  ammKey?: string;
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  feeAmount?: string;
  feeMint?: string;
  percent?: number;
}

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  /** 割合の想定 (要確認) */
  priceImpactPct?: number;
  slippageBps?: number;
  swapMode?: string;
  routePlan: RouteLeg[];
  contextSlot?: number;
  /** どの API から取ったか */
  provider: string;
}

export interface QuoteProvider {
  readonly name: string;
  /** signal: 中止 (時間切れの見積もりを捨てるとき)。見積もりの再試行は 1 回まで */
  getQuote(req: QuoteRequest, opts?: { signal?: AbortSignal }): Promise<SwapQuote>;
}

/** 見積もりの再試行の回数 (時間切れまでに次の機会が来るので 1 回まで) */
const QUOTE_RETRIES = 1;

const atomic = z.unknown().transform(toAtomicString).optional();

const legSchema = z.looseObject({
  swapInfo: z
    .unknown()
    .transform((v) => (isRecord(v) ? v : {}))
    .optional(),
  percent: looseNum,
});

const quoteSchema = z.looseObject({
  inputMint: z.string().min(1, "inputMint がありません"),
  outputMint: z.string().min(1, "outputMint がありません"),
  inAmount: atomic.refine((v) => v !== undefined && v !== "0", "inAmount が正の整数ではありません"),
  outAmount: atomic.refine((v) => v !== undefined && v !== "0", "outAmount が正の整数ではありません"),
  otherAmountThreshold: atomic,
  priceImpactPct: looseNum,
  slippageBps: looseNum,
  swapMode: looseStr,
  routePlan: z
    .unknown()
    .transform((v) => (Array.isArray(v) ? v : []))
    .optional(),
  contextSlot: looseNum,
});

/** 見積もりの応答を読む (純粋関数)。数量・mint が無ければ JupiterShapeError */
export function parseSwapQuote(raw: unknown, provider = "swap/v1/quote"): SwapQuote {
  const r = quoteSchema.safeParse(raw);
  if (!r.success) throw new JupiterShapeError(provider, issuesOf(r.error, "(応答)"));
  const q = r.data;
  const routePlan: RouteLeg[] = [];
  for (const item of q.routePlan ?? []) {
    const l = legSchema.safeParse(item);
    if (!l.success) continue;
    const s = l.data.swapInfo ?? {};
    const leg: RouteLeg = {};
    const str = (k: string) => (typeof s[k] === "string" && s[k] !== "" ? (s[k] as string) : undefined);
    const label = str("label");
    const ammKey = str("ammKey");
    const inputMint = str("inputMint");
    const outputMint = str("outputMint");
    const inAmount = toAtomicString(s.inAmount);
    const outAmount = toAtomicString(s.outAmount);
    const feeAmount = toAtomicString(s.feeAmount);
    const feeMint = str("feeMint");
    if (label) leg.label = label;
    if (ammKey) leg.ammKey = ammKey;
    if (inputMint) leg.inputMint = inputMint;
    if (outputMint) leg.outputMint = outputMint;
    if (inAmount) leg.inAmount = inAmount;
    if (outAmount) leg.outAmount = outAmount;
    if (feeAmount) leg.feeAmount = feeAmount;
    if (feeMint) leg.feeMint = feeMint;
    if (l.data.percent !== undefined) leg.percent = l.data.percent;
    routePlan.push(leg);
  }
  const out: SwapQuote = { inputMint: q.inputMint, outputMint: q.outputMint, inAmount: q.inAmount!, outAmount: q.outAmount!, routePlan, provider };
  if (q.otherAmountThreshold !== undefined) out.otherAmountThreshold = q.otherAmountThreshold;
  if (q.priceImpactPct !== undefined) out.priceImpactPct = q.priceImpactPct;
  if (q.slippageBps !== undefined) out.slippageBps = q.slippageBps;
  if (q.swapMode !== undefined) out.swapMode = q.swapMode;
  if (q.contextSlot !== undefined) out.contextSlot = q.contextSlot;
  return out;
}

function validateRequest(req: QuoteRequest): void {
  if (!/^\d+$/.test(req.amount) || /^0+$/.test(req.amount)) throw new Error(`見積もりの amount は正の整数の文字列にしてください (${req.amount})`);
  if (!(Number.isInteger(req.slippageBps) && req.slippageBps >= 0 && req.slippageBps <= 10_000)) throw new Error(`slippageBps が不正です (${req.slippageBps})`);
  if (req.inputMint === req.outputMint) throw new Error("inputMint と outputMint が同じです");
}

/** `GET /swap/v1/quote` (要確認) */
export class JupiterSwapQuoteProvider implements QuoteProvider {
  readonly name = "swap/v1/quote";
  constructor(private readonly client: JupiterClient) {}
  async getQuote(req: QuoteRequest, opts: { signal?: AbortSignal } = {}): Promise<SwapQuote> {
    validateRequest(req);
    const raw = await this.client.getJson("/swap/v1/quote", {
      inputMint: req.inputMint, outputMint: req.outputMint, amount: req.amount, slippageBps: req.slippageBps,
    }, { retries: QUOTE_RETRIES, ...(opts.signal ? { signal: opts.signal } : {}) });
    return parseSwapQuote(raw, this.name);
  }
}

/** `GET /ultra/v1/order` を taker なしで (見積もりだけ。要確認)。slippageBps は Ultra 側が決める想定なので送らない */
export class JupiterUltraOrderProvider implements QuoteProvider {
  readonly name = "ultra/v1/order";
  constructor(private readonly client: JupiterClient) {}
  async getQuote(req: QuoteRequest, opts: { signal?: AbortSignal } = {}): Promise<SwapQuote> {
    validateRequest(req);
    const raw = await this.client.getJson(
      "/ultra/v1/order",
      { inputMint: req.inputMint, outputMint: req.outputMint, amount: req.amount },
      { retries: QUOTE_RETRIES, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    return parseSwapQuote(raw, this.name);
  }
}

// ───────── 実効価格の推定 ─────────

export interface FillContext {
  /** 売買するトークン (ミームコインなど) */
  baseMint: string;
  baseDecimals: number;
  /** 支払い・受け取りに使うトークン (USDC など) */
  quoteMint: string;
  quoteDecimals: number;
  /** quote トークンの USD 価格 (既定 1 = USDC) */
  quoteUsd?: number;
  /** base の参照価格 (USD。仲値の代わり)。あれば影響をここから計算する */
  referencePriceUsd?: number;
  /** priceImpactPct の単位 (既定 fraction = 0.01 が 1%。要確認) */
  priceImpactUnit?: "fraction" | "percent";
}

export interface FillEstimate {
  source: "quote" | "fallback";
  side: Side;
  sizeUsd: number;
  /** base 1 単位あたりの USD 建ての実効価格 */
  effectivePrice: number;
  /** base の数量 (sizeUsd / effectivePrice) */
  qty: number;
  /** 参照価格 (仲値) に対する不利な方向の差 (bps)。手数料を含む (参照価格があるとき) */
  priceImpactBps: number;
  /** 見積もりの許容スリッページ */
  slippageBps?: number;
  /** 許容スリッページいっぱいの最悪の価格 (otherAmountThreshold から。見積もりの金額のままのときだけ) */
  worstPrice?: number;
  /** routePlan の手数料の USD 換算 (base・quote の手数料だけ。outAmount に織り込み済み) */
  routeFeesUsd?: number;
  routeFeeBps?: number;
  /** USD に換算できなかった手数料の数 */
  unpricedFeeLegs: number;
  routeLabels: string[];
  /** 見積もりの金額と sizeUsd が違い、影響を比例で伸縮した */
  scaled: boolean;
  notes: string[];
}

const pow10 = (n: number) => D(10).pow(n);
const bpsOf = (x: Decimal) => x.mul(10_000);

/**
 * 見積もりから実効価格を推定する (純粋関数・decimal)。
 * - buy: quote トークン → base (inputMint = quoteMint)、sell: base → quote (inputMint = baseMint)。違えば例外。
 * - sizeUsd が見積もりの金額と 1% 以上違えば、影響 (bps) を金額に比例させて伸縮する (scaled: true)。
 */
export function estimateFill(quote: SwapQuote, side: Side, sizeUsd: number, ctx: FillContext): FillEstimate {
  if (!(Number.isFinite(sizeUsd) && sizeUsd > 0)) throw new Error(`sizeUsd は正の数にしてください (${sizeUsd})`);
  const wantIn = side === "buy" ? ctx.quoteMint : ctx.baseMint;
  const wantOut = side === "buy" ? ctx.baseMint : ctx.quoteMint;
  if (quote.inputMint !== wantIn || quote.outputMint !== wantOut) throw new Error(`見積もりの方向が ${side} と一致しません (${quote.inputMint} → ${quote.outputMint})`);
  const quoteUsd = D(ctx.quoteUsd ?? 1);
  if (!quoteUsd.isFinite() || quoteUsd.lte(0)) throw new Error("quoteUsd は正の数にしてください");
  const notes: string[] = [];
  const baseScale = pow10(ctx.baseDecimals);
  const quoteScale = pow10(ctx.quoteDecimals);
  const inAmt = D(quote.inAmount);
  const outAmt = D(quote.outAmount);

  // 見積もりの金額での実効価格 (USD / base) と金額 (USD)
  let pq: Decimal;
  let baseQty: Decimal;
  let usdLeg: Decimal;
  if (side === "buy") {
    usdLeg = inAmt.div(quoteScale).mul(quoteUsd);
    baseQty = outAmt.div(baseScale);
    pq = usdLeg.div(baseQty);
  } else {
    baseQty = inAmt.div(baseScale);
    usdLeg = outAmt.div(quoteScale).mul(quoteUsd);
    pq = usdLeg.div(baseQty);
  }
  const ref = ctx.referencePriceUsd !== undefined && Number.isFinite(ctx.referencePriceUsd) && ctx.referencePriceUsd > 0 ? D(ctx.referencePriceUsd) : undefined;
  const quoteSizeUsd = side === "buy" ? usdLeg : baseQty.mul(ref ?? pq);

  // 見積もりの金額での影響 (bps、不利な方向が正)
  let impactQ: Decimal;
  if (ref) {
    impactQ = side === "buy" ? bpsOf(pq.div(ref).minus(1)) : bpsOf(D(1).minus(pq.div(ref)));
  } else if (quote.priceImpactPct !== undefined) {
    impactQ = D(quote.priceImpactPct).abs().mul(ctx.priceImpactUnit === "percent" ? 100 : 10_000);
    notes.push("参照価格が無いので priceImpactPct を使用 (単位は要確認)");
  } else {
    impactQ = D(0);
    notes.push("参照価格も priceImpactPct も無いので影響は 0 とみなした");
  }
  // 仲値: 参照価格、無ければ見積もりの価格から影響を戻して推定
  const mid = ref ?? (side === "buy" ? pq.div(D(1).plus(impactQ.div(10_000))) : pq.div(D(1).minus(impactQ.div(10_000))));

  const ratio = D(sizeUsd).div(quoteSizeUsd);
  const scaled = ratio.minus(1).abs().gt(0.01);
  let effective: Decimal;
  let impact: Decimal;
  if (!scaled) {
    effective = pq;
    impact = impactQ;
  } else {
    impact = impactQ.mul(ratio);
    if (side === "sell" && impact.gte(10_000)) impact = D(9_999);
    effective = side === "buy" ? mid.mul(D(1).plus(impact.div(10_000))) : mid.mul(D(1).minus(impact.div(10_000)));
    notes.push(`見積もりの金額 $${quoteSizeUsd.toDecimalPlaces(2).toString()} から比例で伸縮`);
  }

  // 許容スリッページいっぱいの価格 (見積もりの金額のまま・ExactIn の想定)
  let worstPrice: number | undefined;
  if (!scaled && quote.otherAmountThreshold !== undefined && quote.otherAmountThreshold !== "0" && (quote.swapMode ?? "ExactIn") === "ExactIn") {
    const th = D(quote.otherAmountThreshold);
    worstPrice = (side === "buy" ? usdLeg.div(th.div(baseScale)) : th.div(quoteScale).mul(quoteUsd).div(baseQty)).toNumber();
  }

  // 手数料の USD 換算 (base / quote の mint のものだけ)
  let feesUsd = D(0);
  let priced = 0;
  let unpriced = 0;
  const labels: string[] = [];
  for (const leg of quote.routePlan) {
    if (leg.label && !labels.includes(leg.label)) labels.push(leg.label);
    if (!leg.feeAmount || leg.feeAmount === "0") continue;
    if (leg.feeMint === ctx.baseMint) {
      feesUsd = feesUsd.plus(D(leg.feeAmount).div(baseScale).mul(mid));
      priced++;
    } else if (leg.feeMint === ctx.quoteMint) {
      feesUsd = feesUsd.plus(D(leg.feeAmount).div(quoteScale).mul(quoteUsd));
      priced++;
    } else unpriced++;
  }
  if (scaled) feesUsd = feesUsd.mul(ratio);

  const est: FillEstimate = {
    source: "quote",
    side,
    sizeUsd,
    effectivePrice: effective.toNumber(),
    qty: D(sizeUsd).div(effective).toNumber(),
    priceImpactBps: impact.toDecimalPlaces(4).toNumber(),
    unpricedFeeLegs: unpriced,
    routeLabels: labels,
    scaled,
    notes,
  };
  if (quote.slippageBps !== undefined) est.slippageBps = quote.slippageBps;
  if (worstPrice !== undefined && Number.isFinite(worstPrice)) est.worstPrice = worstPrice;
  if (priced > 0) {
    est.routeFeesUsd = feesUsd.toDecimalPlaces(8).toNumber();
    est.routeFeeBps = bpsOf(feesUsd.div(sizeUsd)).toDecimalPlaces(4).toNumber();
  }
  return est;
}

// ───────── 見積もりが無いときの代わり ─────────

export interface FallbackSlippageSettings {
  /** 固定のコスト (bps。LP 手数料 ~25bps + 片側のスプレッドの想定) */
  baseBps: number;
  /** 影響の倍率 (影響 ≈ 倍率 × 2 × 金額 / 流動性) */
  impactMult: number;
  /** 流動性が分からないときの影響 (bps) */
  unknownLiquidityBps: number;
  /** 合計の上限 (bps) */
  maxBps: number;
}

export const DEFAULT_FALLBACK_SLIPPAGE: Readonly<FallbackSlippageSettings> = {
  baseBps: 30,
  impactMult: 1,
  unknownLiquidityBps: 150,
  maxBps: 1500,
};

/** 見積もりが無いときの実効価格 (純粋関数・decimal)。参照価格 (仲値) に不利な方向の bps を掛ける */
export function estimateFillFallback(
  side: Side,
  sizeUsd: number,
  referencePriceUsd: number,
  liquidityUsd: number | undefined,
  s: FallbackSlippageSettings = DEFAULT_FALLBACK_SLIPPAGE,
): FillEstimate {
  if (!(Number.isFinite(sizeUsd) && sizeUsd > 0)) throw new Error(`sizeUsd は正の数にしてください (${sizeUsd})`);
  if (!(Number.isFinite(referencePriceUsd) && referencePriceUsd > 0)) throw new Error(`referencePriceUsd は正の数にしてください (${referencePriceUsd})`);
  const notes: string[] = [];
  let impact: Decimal;
  if (liquidityUsd !== undefined && Number.isFinite(liquidityUsd) && liquidityUsd > 0) {
    impact = D(s.impactMult).mul(2).mul(sizeUsd).div(liquidityUsd).mul(10_000);
  } else {
    impact = D(s.unknownLiquidityBps);
    notes.push("流動性が不明なので固定の影響を使用");
  }
  let total = D(s.baseBps).plus(impact);
  const cap = D(Math.min(s.maxBps, 9_999));
  if (total.gt(cap)) {
    total = cap;
    notes.push(`上限 ${cap.toString()}bps で打ち切り`);
  }
  const ref = D(referencePriceUsd);
  const eff = side === "buy" ? ref.mul(D(1).plus(total.div(10_000))) : ref.mul(D(1).minus(total.div(10_000)));
  return {
    source: "fallback",
    side,
    sizeUsd,
    effectivePrice: eff.toNumber(),
    qty: D(sizeUsd).div(eff).toNumber(),
    priceImpactBps: total.toDecimalPlaces(4).toNumber(),
    unpricedFeeLegs: 0,
    routeLabels: [],
    scaled: false,
    notes,
  };
}

/** sizeUsd の見積もりの要求を作る (buy は quote トークンの金額、sell は参照価格で base の数量に換算。最小単位に切り捨て) */
export function buildQuoteRequest(side: Side, sizeUsd: number, ctx: FillContext, slippageBps: number): QuoteRequest {
  if (!(Number.isFinite(sizeUsd) && sizeUsd > 0)) throw new Error(`sizeUsd は正の数にしてください (${sizeUsd})`);
  let amount: Decimal;
  if (side === "buy") {
    amount = D(sizeUsd).div(ctx.quoteUsd ?? 1).mul(pow10(ctx.quoteDecimals)).floor();
  } else {
    const ref = ctx.referencePriceUsd;
    if (!(ref !== undefined && Number.isFinite(ref) && ref > 0)) throw new Error("sell の見積もりには referencePriceUsd が必要です");
    amount = D(sizeUsd).div(ref).mul(pow10(ctx.baseDecimals)).floor();
  }
  if (amount.lte(0)) throw new Error("見積もりの数量が最小単位未満です");
  return {
    inputMint: side === "buy" ? ctx.quoteMint : ctx.baseMint,
    outputMint: side === "buy" ? ctx.baseMint : ctx.quoteMint,
    amount: amount.toFixed(0),
    slippageBps,
  };
}

/**
 * 見積もりを取って推定する。取れない (provider なし・通信・形の違い・方向の違い) ときは代わりのモデルで推定する。
 * 代わりのモデルには参照価格が必要 (無ければ例外)
 */
export async function quoteAndEstimate(
  provider: QuoteProvider | undefined,
  side: Side,
  sizeUsd: number,
  ctx: FillContext,
  o: { slippageBps?: number; liquidityUsd?: number; fallback?: FallbackSlippageSettings } = {},
): Promise<FillEstimate> {
  let reason = "見積もりの取得先なし";
  if (provider) {
    try {
      const q = await provider.getQuote(buildQuoteRequest(side, sizeUsd, ctx, o.slippageBps ?? 100));
      return estimateFill(q, side, sizeUsd, ctx);
    } catch (e) {
      reason = `見積もりを取れません (${e instanceof Error ? e.name : "Error"})`;
    }
  }
  const ref = ctx.referencePriceUsd;
  if (ref === undefined) throw new Error(`${reason}。代わりの推定には referencePriceUsd が必要です`);
  const est = estimateFillFallback(side, sizeUsd, ref, o.liquidityUsd, o.fallback ?? DEFAULT_FALLBACK_SLIPPAGE);
  est.notes.unshift(reason);
  return est;
}
