import { isSignalLikeExit, isTimeLikeExit, type Cause, type CauseCode, type RegimeLabel, type TradeAttribution, type TradeRecord } from "../core/types";
import { clamp } from "../core/util";

/**
 * トレードの損益要因分析 (純粋関数)。比率・リターンはすべて小数 (0.01 = 1%)。
 */

/** 閾値 (根拠はコメント) */
export const ATTRIBUTION_THRESHOLDS = {
  /** |returnPct| がこれ未満なら引き分け扱い (0.1bp) */
  breakevenReturn: 0.00001,
  /** 手数料がグロス損益の絶対値のこの割合を超えたら fee_drag */
  feeShareOfGross: 0.5,
  /** 不利方向スリッページ (bps) が想定コスト (costBps) のこの倍数を超えたら slippage */
  slippageCostMult: 1.0,
  /**
   * slippage と判定する最小値 (bps)。PaperBroker の既定は片道 2bps (往復 4bps) なので、
   * 想定内のずれを拾わないよう、それを超える水準 (6bps) にする。コスト見積りが 0 の時の誤検知防止も兼ねる
   */
  slippageMinBps: 6,
  /** late_exit の対象となる「十分な含み益」: MFE がコストのこの倍数以上 */
  lateExitMfeCostMult: 2,
  /**
   * 同: MFE がストップ幅のこの割合以上 (0.5R)。wrongDirMfeStopFrac (0.25) との間を空け、
   * 小さく有利に動いた後の計画通りの損切りを good_process として残す
   */
  lateExitMinMfeStopFrac: 0.5,
  /** 十分な含み益のこの割合を超えて吐き出したら late_exit (損失なら常に該当) */
  lateExitGiveback: 0.6,
  /** MFE がストップ幅のこの割合未満なら「一度も有利に動かなかった」(wrong_direction) */
  wrongDirMfeStopFrac: 0.25,
  /** 戦略が明示的に対応していない限り不利とみなすレジーム */
  hostileRegimes: ["high_vol", "low_liquidity"] as RegimeLabel[],
  /** eventRisk がこれ以上なら news_shock */
  newsEventRisk: 0.7,
  /** MAE がボラティリティ (ATR/価格) のこの倍数を超えたら news_shock */
  newsMaeVolMult: 3,
  /** 情報バイアス (sentiment×confidence) がトレード方向へこれ以上強ければ intel_misled 候補 */
  intelMisledBias: 0.3,
  /** time 決済で |returnPct| がストップ幅のこの割合未満なら time_decay */
  timeDecayStopFrac: 0.5,
  /** ストップ幅が無い場合: |returnPct| がコストのこの倍数未満なら time_decay */
  timeDecayCostMult: 2,
  /** early_exit の最小伸び (ストップ幅比)。ノイズ除外 */
  earlyExitMinStopFrac: 0.25,
} as const;

/** 要因ごとの基本重み (正規化前)。損益への影響が直接的なものほど大きい */
export const CAUSE_BASE_WEIGHT: Record<CauseCode, number> = {
  wrong_direction: 1.0,
  stop_too_tight: 1.0,
  news_shock: 0.9,
  late_exit: 0.8,
  fee_drag: 0.8,
  intel_misled: 0.7,
  regime_mismatch: 0.7,
  early_exit: 0.6,
  slippage: 0.6,
  time_decay: 0.5,
  good_process: 1.0,
};

/** 要因の日本語ラベル */
export const CAUSE_LABEL: Record<CauseCode, string> = {
  wrong_direction: "方向感の誤り",
  stop_too_tight: "損切りが近すぎ",
  late_exit: "利益の取り逃し",
  early_exit: "早すぎる利確",
  fee_drag: "手数料負け",
  slippage: "約定ずれ",
  regime_mismatch: "レジーム不一致",
  news_shock: "突発ニュース・イベント",
  intel_misled: "情報バイアスの誤り",
  time_decay: "時間切れ",
  good_process: "判断は妥当",
};

export interface AttributionOptions {
  /** strategyId → 適合レジーム */
  strategyRegimes?: Record<string, RegimeLabel[]>;
  /** 分析時刻 (省略時は exitTs) */
  now?: number;
}

const T = ATTRIBUTION_THRESHOLDS;
const finite = (x: number | undefined | null): x is number => typeof x === "number" && Number.isFinite(x);

export const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const bps = (x: number) => `${x.toFixed(1)}bps`;
export const fmtNum = (x: number) =>
  Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : Number(x.toPrecision(3)).toString();

export function tradeOutcome(t: TradeRecord): TradeAttribution["outcome"] {
  if (!finite(t.netPnl) || t.netPnl === 0) return "breakeven";
  if (finite(t.returnPct) && t.returnPct !== 0 && Math.abs(t.returnPct) < T.breakevenReturn) return "breakeven";
  return t.netPnl > 0 ? "win" : "loss";
}

interface RawCause {
  code: CauseCode;
  /** 深刻度 1〜2 (基本重みに掛ける) */
  severity: number;
  evidence: string;
}

export function attributeTrade(trade: TradeRecord, opts: AttributionOptions = {}): TradeAttribution {
  const t = trade;
  const ctx = t.entryContext;
  const outcome = tradeOutcome(t);
  const win = outcome === "win";
  const loss = outcome === "loss";
  const dir = t.direction === "long" ? 1 : -1;
  const costBps = Math.max(0, ctx?.costBps ?? 0);
  const costPct = costBps / 1e4;
  const stopWidthPct = t.entryPrice > 0 ? Math.abs(t.entryPrice - t.initialStop) / t.entryPrice : 0;
  const grossRetPct = t.entryPrice > 0 ? (dir * (t.exitPrice - t.entryPrice)) / t.entryPrice : 0;
  const mfe = Math.max(0, t.mfePct ?? 0);
  const mae = Math.max(0, t.maePct ?? 0);
  const post = finite(t.postExitMovePct) ? t.postExitMovePct : undefined;
  const raw: RawCause[] = [];
  const add = (code: CauseCode, severity: number, evidence: string) =>
    raw.push({ code, severity: clamp(Number.isFinite(severity) ? severity : 2, 1, 2), evidence });

  // fee_drag: グロスは勝ちなのにネットが負け、または手数料がグロス損益に比べて大きい
  {
    const g = t.grossPnl;
    const f = t.fees;
    const share = Math.abs(g) > 0 ? f / Math.abs(g) : Number.POSITIVE_INFINITY;
    if ((g > 0 && t.netPnl <= 0) || (f > 0 && f > T.feeShareOfGross * Math.abs(g))) {
      add(
        "fee_drag",
        share / T.feeShareOfGross,
        `グロス損益 ${fmtNum(g)} に対し手数料 ${fmtNum(f)}${Number.isFinite(share) ? ` (グロス比 ${pct(share)})` : ""}、ネット ${fmtNum(t.netPnl)}`,
      );
    }
  }

  // slippage: 想定価格に対する不利方向の約定ずれ (エントリー+エグジット)
  if (t.intendedEntryPrice > 0 && t.intendedExitPrice > 0) {
    const entrySlip = Math.max(0, (dir * (t.entryPrice - t.intendedEntryPrice)) / t.intendedEntryPrice) * 1e4;
    const exitSlip = Math.max(0, (dir * (t.intendedExitPrice - t.exitPrice)) / t.intendedExitPrice) * 1e4;
    const slip = entrySlip + exitSlip;
    const limit = Math.max(T.slippageCostMult * costBps, T.slippageMinBps);
    if (slip > limit) {
      add(
        "slippage",
        slip / limit,
        `不利方向の約定ずれ ${bps(slip)} (エントリー ${bps(entrySlip)} / エグジット ${bps(exitSlip)})、想定コスト ${bps(costBps)}`,
      );
    }
  }

  // stop_too_tight: ストップで刈られた後、ストップ幅以上に有利方向へ戻った
  if (t.exitReason === "stop" && post !== undefined && stopWidthPct > 0 && post >= stopWidthPct) {
    add("stop_too_tight", post / stopWidthPct, `ストップ (幅 ${pct(stopWidthPct)}) で決済後、${pct(post)} 有利方向へ戻った`);
  }

  // late_exit: 十分な含み益があったのに損失、または大半を吐き出した
  {
    const minMfe = Math.max(T.lateExitMfeCostMult * costPct, T.lateExitMinMfeStopFrac * stopWidthPct);
    const substantialMfe = mfe > 0 && mfe >= minMfe;
    const giveback = mfe > 0 ? (mfe - grossRetPct) / mfe : 0;
    if (substantialMfe && (loss || giveback > T.lateExitGiveback)) {
      add(
        "late_exit",
        giveback / T.lateExitGiveback,
        `最大含み益 ${pct(mfe)} (コスト ${pct(costPct)}) から決済時 ${pct(grossRetPct)} まで戻した (吐き出し ${pct(giveback)})`,
      );
    }
  }

  // early_exit: 利確・シグナル決済の後、実現リターン以上に伸びた (転換で決済 reversal もシグナル決済と同じ扱い)
  if ((t.exitReason === "take_profit" || isSignalLikeExit(t.exitReason)) && post !== undefined && post > 0) {
    const need = Math.max(Math.abs(t.returnPct), costPct, T.earlyExitMinStopFrac * stopWidthPct);
    if (post >= need) {
      const what = t.exitReason === "take_profit" ? "利確" : t.exitReason === "reversal" ? "転換で決済" : "シグナル決済";
      add("early_exit", need > 0 ? post / need : 2, `${what}後にさらに ${pct(post)} 伸びた (実現リターン ${pct(t.returnPct)})`);
    }
  }

  // wrong_direction: 損失かつ一度も十分に有利へ動かなかった
  let wrongDirection = false;
  if (loss) {
    const limit = stopWidthPct > 0 ? T.wrongDirMfeStopFrac * stopWidthPct : costPct;
    if (mfe < limit) {
      wrongDirection = true;
      add(
        "wrong_direction",
        mae >= stopWidthPct && stopWidthPct > 0 ? 1.5 : 1,
        `最大含み益 ${pct(mfe)} (基準 ${pct(limit)} 未満)、最大含み損 ${pct(mae)} — 一度も有利に動かなかった`,
      );
    }
  }

  // regime_mismatch: 適合レジーム外、または高ボラ/低流動性でのエントリー (勝ちトレードは対象外)
  if (!win && ctx?.regime) {
    const label = ctx.regime.label;
    const allowed = opts.strategyRegimes?.[t.strategyId];
    const notAllowed = allowed !== undefined && allowed.length > 0 && !allowed.includes(label);
    const hostile = T.hostileRegimes.includes(label) && !(allowed?.includes(label) ?? false);
    if (notAllowed || hostile) {
      add(
        "regime_mismatch",
        notAllowed && hostile ? 1.5 : 1,
        (notAllowed
          ? `エントリー時のレジーム ${label} は戦略の適合レジーム [${allowed!.join(", ")}] 外`
          : `高ボラ/低流動性レジーム ${label} でのエントリー`) +
          ` (トレンド ${(ctx.regime.trend ?? 0).toFixed(2)}, ボラ ${pct(ctx.regime.volatility ?? 0)}, スプレッド ${bps(ctx.regime.spreadBps ?? 0)})`,
      );
    }
  }

  // news_shock: 損失かつ重要イベントの近く、またはボラに対して異常な逆行
  if (loss) {
    const eventRisk = ctx?.intel?.eventRisk ?? 0;
    const vol = ctx?.regime?.volatility ?? 0;
    const byEvent = eventRisk >= T.newsEventRisk;
    const byMae = vol > 0 && mae > T.newsMaeVolMult * vol;
    if (byEvent || byMae) {
      const parts: string[] = [];
      if (byEvent) parts.push(`イベントリスク ${eventRisk.toFixed(2)}`);
      if (byMae) parts.push(`最大含み損 ${pct(mae)} がボラ ${pct(vol)} の ${(mae / vol).toFixed(1)} 倍`);
      add("news_shock", byMae ? mae / (T.newsMaeVolMult * vol) : 1, parts.join("、"));
    }
  }

  // intel_misled: 情報バイアスがトレード方向へ強く出ていたのに方向を誤った
  if (wrongDirection && ctx?.intel) {
    const bias = (ctx.intel.sentiment ?? 0) * (ctx.intel.confidence ?? 0);
    if (dir * bias >= T.intelMisledBias) {
      add(
        "intel_misled",
        (dir * bias) / T.intelMisledBias,
        `情報バイアス ${bias.toFixed(2)} (sentiment ${ctx.intel.sentiment.toFixed(2)} × confidence ${ctx.intel.confidence.toFixed(2)}) が ${t.direction} を支持したが逆行`,
      );
    }
  }

  // time_decay: 時間切れ決済で値幅が小さい (読みの管理の決済 = 途中・期限で読み外れ・延長の上限も時間切れと同じ扱い)
  if (isTimeLikeExit(t.exitReason)) {
    const ret = Math.abs(t.returnPct);
    const limit = stopWidthPct > 0 ? T.timeDecayStopFrac * stopWidthPct : T.timeDecayCostMult * costPct;
    if (ret < limit) {
      add("time_decay", 1, `${t.exitReason === "time" ? "時間切れ決済" : `時間切れ決済 (読みの管理: ${t.exitReason})`}、リターン ${pct(t.returnPct)} (基準 ±${pct(limit)} 未満)`);
    }
  }

  if (raw.length === 0) {
    add(
      "good_process",
      1,
      win
        ? `計画通りの利益 (${t.rMultiple.toFixed(2)}R)`
        : loss
          ? `計画通りの損切り (${t.rMultiple.toFixed(2)}R) — 想定内の損失`
          : `ほぼ損益なし (${pct(t.returnPct)})`,
    );
  }

  const total = raw.reduce((s, c) => s + CAUSE_BASE_WEIGHT[c.code] * c.severity, 0);
  const causes: Cause[] = raw
    .map((c) => ({ code: c.code, weight: (CAUSE_BASE_WEIGHT[c.code] * c.severity) / total, evidence: c.evidence }))
    .sort((a, b) => b.weight - a.weight);

  return { tradeId: t.id, outcome, causes, createdAt: opts.now ?? t.exitTs };
}
