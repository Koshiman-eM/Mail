import { randomUUID } from "node:crypto";
import { z } from "zod";
import { aiEnabled, askStructured, type AiOptions } from "../core/ai";
import { createLogger } from "../core/logger";
import type {
  AssetClass,
  CauseCode,
  Lesson,
  RegimeLabel,
  Store,
  TradeAttribution,
  TradeRecord,
  TradingMode,
} from "../core/types";
import { attributeTrade, CAUSE_LABEL, fmtNum, pct } from "./attribution";
import { buildReflectionPrompt, REFLECTION_SYSTEM } from "./prompts";
import type { ParamProposal, StrategyParamInfo } from "./tuner";

const log = createLogger("reflection");

/** ルールベースの閾値 */
export const REFLECTION_RULES = {
  /** 教訓を出すのに必要な最小件数 (グループ単位) */
  minGroupTrades: 10,
  /** 平均 R がこれ以下なら停止推奨 */
  badAvgR: -0.2,
  /** 平均 R がこれ以上なら好調 */
  goodAvgR: 0.3,
  /** 損失のうちこの割合以上を占める要因を「主要因」とする */
  dominantCauseShare: 0.3,
  /** 主要因の判定に必要な最小損失件数 */
  minLossesForCause: 5,
  /** 情報源が方向を誤らせた回数がこれ以上なら教訓化 */
  sourceMisledMin: 3,
  /** 損失サンプル件数 */
  lossSamples: 5,
  /** AI 出力の上限 */
  maxLessons: 8,
  maxProposals: 5,
  maxSourceNotes: 10,
} as const;

const STANDARD_PARAMS = ["stopAtr", "tpAtr", "trailAtr", "entryThreshold", "maxHoldBars"];
const ASSET_CLASSES = ["crypto", "meme", "fx", "stock"] as const;
const SCOPE_RE = /^(global|strategy:[\w.\-:]+|assetClass:(crypto|meme|fx|stock)|source:\S+|regime:(trend_up|trend_down|range|high_vol|low_liquidity))$/;

/** 要因ごとの対処の目安 (ルールベースの教訓文に使う) */
const CAUSE_ADVICE: Record<CauseCode, string> = {
  wrong_direction: "エントリー条件の厳格化 (entryThreshold 引き上げ) を検討",
  stop_too_tight: "損切り幅 (stopAtr) の拡大を検討",
  late_exit: "トレーリング幅・利確幅の短縮を検討",
  early_exit: "利確幅 (tpAtr) の拡大を検討",
  fee_drag: "期待値幅の小さいエントリーを避ける",
  slippage: "成行を減らし指値・流動性の高い時間帯を使う",
  regime_mismatch: "適合レジーム外でのエントリーを止める",
  news_shock: "重要イベント前後のエントリーを控える",
  intel_misled: "情報バイアスの影響度を下げる",
  time_decay: "保有時間の短縮・動かない銘柄の除外を検討",
  good_process: "現行ルールを維持",
};

export interface ReflectOptions {
  store: Store;
  now: number;
  windowMs: number;
  ai?: AiOptions;
  strategyRegimes?: Record<string, RegimeLabel[]>;
  /** 既知の戦略 (未知の strategyId・パラメータの提案を捨てる)。省略時は期間内のトレードと strategyRegimes の戦略を既知とする */
  getStrategy?: (strategyId: string) => StrategyParamInfo | undefined;
  /** 集計する取引の mode (学習状態は mode 別)。省略時は全 mode */
  mode?: TradingMode;
}

export interface GroupStats {
  key: string;
  strategyId: string;
  regime: RegimeLabel;
  assetClass: AssetClass;
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
  totalPnl: number;
  /** 要因コード別の件数 (その要因を含むトレード数) */
  causes: Partial<Record<CauseCode, number>>;
  /** 損失トレードに限った要因コード別の件数 */
  lossCauses: Partial<Record<CauseCode, number>>;
}

export interface LossSample {
  tradeId: string;
  strategyId: string;
  symbol: string;
  assetClass: AssetClass;
  regime: RegimeLabel;
  direction: "long" | "short";
  rMultiple: number;
  netPnl: number;
  exitReason: TradeRecord["exitReason"];
  causes: string[];
  intel?: { sentiment: number; confidence: number; eventRisk: number; headlines: string[] };
}

export interface ReflectionStats {
  from: number;
  to: number;
  total: { n: number; wins: number; losses: number; winRate: number; avgR: number; totalPnl: number };
  groups: GroupStats[];
  byStrategy: GroupStats[];
  byAssetClass: GroupStats[];
  causes: Partial<Record<CauseCode, number>>;
  lossSamples: LossSample[];
  /** intel_misled のトレードで誤った方向を支持していた情報源ごとの回数 */
  misledSources: Record<string, number>;
}

export interface SourceNote {
  source: string;
  note: string;
  stance: "trust" | "neutral" | "distrust";
}

export interface ReflectionResult {
  lessons: Lesson[];
  proposals: ParamProposal[];
  sourceNotes: SourceNote[];
  stats: ReflectionStats;
  origin: "llm" | "rule" | "none";
}

const ReflectionSchema = z.object({
  lessons: z.array(z.object({ scope: z.string(), text: z.string(), evidence: z.string() })),
  proposals: z.array(
    z.object({
      strategyId: z.string(),
      assetClass: z.enum(ASSET_CLASSES),
      param: z.string(),
      direction: z.enum(["up", "down"]),
      reason: z.string(),
    }),
  ),
  sourceNotes: z.array(z.object({ source: z.string(), note: z.string(), stance: z.enum(["trust", "neutral", "distrust"]) })),
});
type ReflectionOutput = z.infer<typeof ReflectionSchema>;

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const rStr = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`;

class Acc {
  n = 0;
  wins = 0;
  losses = 0;
  sumR = 0;
  pnl = 0;
  causes: Partial<Record<CauseCode, number>> = {};
  lossCauses: Partial<Record<CauseCode, number>> = {};
  add(t: TradeRecord, a: TradeAttribution) {
    this.n++;
    if (a.outcome === "win") this.wins++;
    if (a.outcome === "loss") this.losses++;
    this.sumR += Number.isFinite(t.rMultiple) ? t.rMultiple : 0;
    this.pnl += Number.isFinite(t.netPnl) ? t.netPnl : 0;
    for (const code of new Set(a.causes.map((c) => c.code))) {
      this.causes[code] = (this.causes[code] ?? 0) + 1;
      if (a.outcome === "loss") this.lossCauses[code] = (this.lossCauses[code] ?? 0) + 1;
    }
  }
  stats(key: string, strategyId: string, regime: RegimeLabel, assetClass: AssetClass): GroupStats {
    return {
      key,
      strategyId,
      regime,
      assetClass,
      n: this.n,
      wins: this.wins,
      losses: this.losses,
      winRate: this.n ? this.wins / this.n : 0,
      avgR: this.n ? this.sumR / this.n : 0,
      totalPnl: this.pnl,
      causes: this.causes,
      lossCauses: this.lossCauses,
    };
  }
}

/**
 * 期間内のトレードを集計 (opts.mode の取引のうち、推定約定 estimated と paper で再現した空売り simulatedShort を除く)。
 * 振り返りの提案はパラメータ (買い・売り共通) の調整と教訓になるので、live で実行できない取引は混ぜない (tuner と同じ基準)
 */
export function computeReflectionStats(opts: ReflectOptions): ReflectionStats {
  const { store, now, windowMs } = opts;
  const from = now - windowMs;
  const trades = store
    .listTrades({ since: from, until: now, ...(opts.mode ? { mode: opts.mode } : {}) })
    .filter((t) => !t.estimated && !t.simulatedShort);
  const atts = new Map<string, TradeAttribution>();
  for (const t of trades) {
    atts.set(t.id, store.getAttribution(t.id) ?? attributeTrade(t, { strategyRegimes: opts.strategyRegimes }));
  }

  const total = new Acc();
  const groups = new Map<string, { acc: Acc; s: string; r: RegimeLabel; a: AssetClass }>();
  const byStrategy = new Map<string, Acc>();
  const byClass = new Map<AssetClass, Acc>();
  const misledSources: Record<string, number> = {};
  for (const t of trades) {
    const a = atts.get(t.id)!;
    const regime = t.entryContext?.regime?.label ?? "range";
    const key = `${t.strategyId}|${regime}|${t.assetClass}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { acc: new Acc(), s: t.strategyId, r: regime, a: t.assetClass }));
    g.acc.add(t, a);
    total.add(t, a);
    if (!byStrategy.has(t.strategyId)) byStrategy.set(t.strategyId, new Acc());
    byStrategy.get(t.strategyId)!.add(t, a);
    if (!byClass.has(t.assetClass)) byClass.set(t.assetClass, new Acc());
    byClass.get(t.assetClass)!.add(t, a);

    if (a.causes.some((c) => c.code === "intel_misled")) {
      const dir = t.direction === "long" ? 1 : -1;
      for (const [src, c] of Object.entries(t.entryContext.intel?.sourceContrib ?? {})) {
        if (dir * c > 0) misledSources[src] = (misledSources[src] ?? 0) + 1;
      }
    }
  }

  const lossSamples: LossSample[] = trades
    .filter((t) => atts.get(t.id)!.outcome === "loss")
    .sort((a, b) => a.rMultiple - b.rMultiple)
    .slice(0, REFLECTION_RULES.lossSamples)
    .map((t) => {
      const intel = t.entryContext.intel;
      return {
        tradeId: t.id,
        strategyId: t.strategyId,
        symbol: t.symbol,
        assetClass: t.assetClass,
        regime: t.entryContext.regime.label,
        direction: t.direction,
        rMultiple: t.rMultiple,
        netPnl: t.netPnl,
        exitReason: t.exitReason,
        causes: atts.get(t.id)!.causes.map((c) => `${c.code}: ${c.evidence}`),
        ...(intel
          ? {
              intel: {
                sentiment: intel.sentiment,
                confidence: intel.confidence,
                eventRisk: intel.eventRisk,
                headlines: store.getIntel(intel.sourceIds ?? []).slice(0, 3).map((i) => i.title),
              },
            }
          : {}),
      };
    });

  const tot = total.stats("total", "*", "range", "crypto");
  return {
    from,
    to: now,
    total: { n: tot.n, wins: tot.wins, losses: tot.losses, winRate: tot.winRate, avgR: tot.avgR, totalPnl: tot.totalPnl },
    groups: [...groups.entries()].map(([k, g]) => g.acc.stats(k, g.s, g.r, g.a)).sort((a, b) => b.n - a.n),
    byStrategy: [...byStrategy.entries()].map(([s, acc]) => acc.stats(`strategy:${s}`, s, "range", "crypto")),
    byAssetClass: [...byClass.entries()].map(([c, acc]) => acc.stats(`assetClass:${c}`, "*", "range", c)),
    causes: total.causes,
    lossSamples,
    misledSources,
  };
}

function lesson(now: number, scope: string, text: string, evidence: string, origin: Lesson["origin"]): Lesson {
  return { id: randomUUID(), createdAt: now, scope, text, evidence, origin, status: "active" };
}

const topCauses = (causes: Partial<Record<CauseCode, number>>, k = 3) =>
  (Object.entries(causes) as [CauseCode, number][])
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([c, n]) => `${c}(${CAUSE_LABEL[c]}) ${n} 件`)
    .join("、");

/** ルールベースの教訓 */
export function ruleLessons(stats: ReflectionStats, now: number): Lesson[] {
  const R = REFLECTION_RULES;
  const out: Lesson[] = [];
  const days = (stats.to - stats.from) / 86_400_000;

  // 戦略×レジーム×資産クラス
  for (const g of stats.groups) {
    if (g.n < R.minGroupTrades) continue;
    const ev = `勝率 ${pct(g.winRate)}、合計損益 ${fmtNum(g.totalPnl)}、主な要因: ${topCauses(g.causes) || "なし"}`;
    if (g.avgR <= R.badAvgR) {
      out.push(
        lesson(now, `strategy:${g.strategyId}`, `${g.strategyId} は ${g.regime} (${g.assetClass}) で ${g.n} 件 平均 ${rStr(g.avgR)} → このレジームでは停止推奨`, ev, "rule"),
      );
    } else if (g.avgR >= R.goodAvgR) {
      out.push(
        lesson(now, `strategy:${g.strategyId}`, `${g.strategyId} は ${g.regime} (${g.assetClass}) で ${g.n} 件 平均 ${rStr(g.avgR)} と好調 → 配分維持・増加を推奨`, ev, "rule"),
      );
    }
  }

  // 戦略ごとの主要な損失要因
  for (const s of stats.byStrategy) {
    if (s.losses < R.minLossesForCause) continue;
    const ranked = (Object.entries(s.lossCauses) as [CauseCode, number][])
      .filter(([c]) => c !== "good_process")
      .sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    if (!top || top[1] / s.losses < R.dominantCauseShare) continue;
    const [code, n] = top;
    out.push(
      lesson(
        now,
        `strategy:${s.strategyId}`,
        `${s.strategyId} の損失 ${s.losses} 件中 ${n} 件 (${pct(n / s.losses)}) が ${CAUSE_LABEL[code]} → ${CAUSE_ADVICE[code]}`,
        `全 ${s.n} 件 平均 ${rStr(s.avgR)}、損失要因: ${topCauses(s.lossCauses)}`,
        "rule",
      ),
    );
  }

  // 資産クラス
  for (const c of stats.byAssetClass) {
    if (c.n < R.minGroupTrades || c.avgR >= 0) continue;
    out.push(
      lesson(
        now,
        `assetClass:${c.assetClass}`,
        `${c.assetClass} は ${c.n} 件 平均 ${rStr(c.avgR)}・勝率 ${pct(c.winRate)} → リスク配分の縮小を検討`,
        `合計損益 ${fmtNum(c.totalPnl)}、主な要因: ${topCauses(c.causes) || "なし"}`,
        "rule",
      ),
    );
  }

  // 情報源
  for (const [src, n] of Object.entries(stats.misledSources)) {
    if (n < R.sourceMisledMin) continue;
    out.push(
      lesson(now, `source:${src}`, `情報源 ${src} の示唆に沿った ${n} 件で方向を誤った → この情報源の重みを下げる`, `intel_misled と判定されたトレードで ${src} がトレード方向を支持`, "rule"),
    );
  }

  // 全体
  if (stats.total.n > 0) {
    const t = stats.total;
    out.push(
      lesson(
        now,
        "global",
        `直近 ${days.toFixed(1)} 日: ${t.n} 件 勝率 ${pct(t.winRate)} 平均 ${rStr(t.avgR)}`,
        `合計損益 ${fmtNum(t.totalPnl)} (クオート通貨混在)、主な要因: ${topCauses(stats.causes) || "なし"}`,
        "rule",
      ),
    );
  }
  return out;
}

/** AI 出力の検証・クランプ */
function sanitize(
  out: ReflectionOutput,
  now: number,
  known: Map<string, string[]>,
): { lessons: Lesson[]; proposals: ParamProposal[]; sourceNotes: SourceNote[] } {
  const R = REFLECTION_RULES;
  const lessons = out.lessons
    .filter((l) => l.text.trim() !== "")
    .slice(0, R.maxLessons)
    .map((l) => {
      const scope = l.scope.trim();
      return lesson(now, SCOPE_RE.test(scope) ? scope : "global", trunc(l.text.trim(), 400), trunc(l.evidence.trim(), 600), "llm");
    });
  const seen = new Set<string>();
  const proposals: ParamProposal[] = [];
  for (const p of out.proposals) {
    const params = known.get(p.strategyId);
    if (!params || !params.includes(p.param)) continue; // 未知の戦略・パラメータは捨てる
    const k = `${p.strategyId}|${p.assetClass}|${p.param}`;
    if (seen.has(k)) continue;
    seen.add(k);
    proposals.push({ strategyId: p.strategyId, assetClass: p.assetClass, param: p.param, direction: p.direction, reason: trunc(`[llm] ${p.reason.trim()}`, 300) });
    if (proposals.length >= R.maxProposals) break;
  }
  const sourceNotes = out.sourceNotes
    .filter((s) => s.source.trim() !== "" && s.note.trim() !== "")
    .slice(0, R.maxSourceNotes)
    .map((s) => ({ source: trunc(s.source.trim(), 100), note: trunc(s.note.trim(), 300), stance: s.stance }));
  return { lessons, proposals, sourceNotes };
}

/** 新しい教訓を保存し、同じ scope の古い有効な教訓を retired にする */
function saveLessons(store: Store, lessons: Lesson[]) {
  const ids = new Set(lessons.map((l) => l.id));
  for (const scope of new Set(lessons.map((l) => l.scope))) {
    for (const old of store.listLessons({ status: "active", scope })) {
      if (!ids.has(old.id)) store.saveLesson({ ...old, status: "retired" });
    }
  }
  for (const l of lessons) store.saveLesson(l);
}

/**
 * 定期的な振り返り。期間内のトレードを集計し、教訓 (store に保存) とパラメータ調整提案を返す。
 * AI 有効時は Claude の構造化出力、無効・失敗時はルールベース。提案の適用は呼び出し側 (tuner.propose) で検証する。
 */
export async function reflect(opts: ReflectOptions): Promise<ReflectionResult> {
  const { store, now } = opts;
  const stats = computeReflectionStats(opts);
  if (stats.total.n === 0) return { lessons: [], proposals: [], sourceNotes: [], stats, origin: "none" };

  // 既知の戦略 → 調整可能なパラメータ
  const candidates = new Set([...stats.byStrategy.map((s) => s.strategyId), ...Object.keys(opts.strategyRegimes ?? {})]);
  const known = new Map<string, string[]>();
  for (const id of candidates) {
    if (opts.getStrategy) {
      const info = opts.getStrategy(id);
      if (info) known.set(id, Object.keys(info.paramBounds).filter((k) => k in info.defaultParams));
    } else {
      known.set(id, STANDARD_PARAMS);
    }
  }

  let result: Omit<ReflectionResult, "stats"> | undefined;
  if (aiEnabled(opts.ai)) {
    try {
      const prompt = buildReflectionPrompt({
        windowDays: opts.windowMs / 86_400_000,
        stats: { total: stats.total, groups: stats.groups, causes: stats.causes, misledSources: stats.misledSources },
        lossSamples: stats.lossSamples,
        strategies: [...known.entries()].map(([strategyId, params]) => ({
          strategyId,
          params,
          regimes: opts.strategyRegimes?.[strategyId],
        })),
        activeLessons: store.listLessons({ status: "active", limit: 20 }).map((l) => ({ scope: l.scope, text: l.text })),
      });
      const out = await askStructured(opts.ai!, ReflectionSchema, REFLECTION_SYSTEM, prompt, "medium");
      const s = sanitize(out, now, known);
      result = { ...s, lessons: s.lessons.length ? s.lessons : ruleLessons(stats, now), origin: "llm" };
    } catch (e) {
      log.warn("AI 振り返りに失敗。ルールベースで続行", { error: String(e) });
    }
  }
  // ルールベースの提案は ParamTuner が要因頻度から直接行うため、ここでは出さない
  result ??= { lessons: ruleLessons(stats, now), proposals: [], sourceNotes: [], origin: "rule" };

  saveLessons(store, result.lessons);
  store.audit({
    ts: now,
    type: "learning.reflect",
    data: { ...(opts.mode ? { mode: opts.mode } : {}), origin: result.origin, trades: stats.total.n, lessons: result.lessons.length, proposals: result.proposals.length },
  });
  return { ...result, stats };
}
