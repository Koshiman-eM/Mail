/** 学習サービスへ渡すフック (パラメータ検証・任意時刻の価格) */
import { foldBoundaries, foldedBacktest } from "../backtest/evaluate";
import type { BacktestOptions } from "../backtest/types";
import { createLogger } from "../core/logger";
import {
  TIMEFRAME_MS, type AssetClass, type Candle, type Clock, type Horizon, type Instrument, type IntelBias, type MarketBrief, type MarketDataFeed,
  type Params, type Strategy, type Timeframe, type TradeRecord,
} from "../core/types";
import { DEFAULT_POST_EXIT_HORIZON_MS, type PriceAt } from "../learning/journal";
import type { ParamValidator, ValidationFold, ValidationRun } from "../learning/tuner";
import type { MarketHub } from "../market/hub";
import { fetchCandlesPaged, baseTimeframeOf } from "./backtestCommand";
import { intelBiasFor } from "./context";
import { isHoldLimitedHorizon } from "./tempo";

const log = createLogger("learningHooks");
const DAY = 86_400_000;

type HubLike = Pick<MarketHub, "watched" | "getView">;
/** 履歴を取得できる feed (fetchCandles の since でページングできるもの) */
export type HistoryFeed = Pick<MarketDataFeed, "fetchCandles">;

/**
 * 検証に使う履歴の長さ (戦略の主時間足の本数)。
 * - scalp (1m): 14 日分。1m の戦略はコスト条件で取引が少なく、3000 本 (約 2 日) では区間ごとの取引がほぼ 0 になる
 * - その他: 3000 本 (15m で約 31 日、1h で約 125 日、4h で約 500 日)。1d は maxHistoryMs (3 年) で頭打ち
 */
export const DEFAULT_VALIDATION_BARS: Record<Horizon, number> = { scalp: 14 * 1440, short: 3000, mid: 3000, long: 3000 };

/**
 * 取得した履歴のキャッシュ。キーは (venue, 銘柄, 時間足)。
 * 取得済みの範囲が要求の開始時刻を含めば ttlMs の間再利用する (ウォームアップの違う戦略どうしで同じ足を取り直さない)。
 * 失敗も failureTtlMs の間覚えて再取得しない (取得できない取引所を毎時叩かない)。
 */
export class HistoryCache {
  private readonly entries = new Map<string, { at: number; from: number; candles?: Candle[]; error?: string; pending?: Promise<Candle[] | undefined> }>();
  constructor(private readonly o: { ttlMs: number; failureTtlMs: number }) {}

  async get(key: string, now: number, from: number, load: () => Promise<Candle[]>): Promise<Candle[] | undefined> {
    for (const [k, e] of this.entries) {
      if (!e.pending && now - e.at >= (e.error ? this.o.failureTtlMs : this.o.ttlMs)) this.entries.delete(k);
    }
    const hit = this.entries.get(key);
    if (hit && (hit.error || hit.pending || hit.from <= from)) return hit.pending ?? hit.candles;
    const pending = load().then(
      (candles) => {
        this.entries.set(key, { at: now, from, candles });
        return candles;
      },
      (e: unknown) => {
        const error = e instanceof Error ? e.message : String(e);
        this.entries.set(key, { at: now, from, error });
        log.warn("検証用の履歴の取得に失敗 (この銘柄は当面検証に使わない)", { key, error });
        return undefined;
      },
    );
    this.entries.set(key, { at: now, from, pending });
    return pending;
  }

  /** テスト・状態表示用 */
  size(): number {
    return this.entries.size;
  }
}

export interface ValidatorOptions {
  /** 監視銘柄 (資産クラスが一致するものを検証に使う) */
  hub: Pick<MarketHub, "watched">;
  strategies: readonly Strategy[];
  clock: Clock;
  /** 銘柄の履歴を取得する feed。undefined の銘柄は検証に使わない */
  feedFor: (inst: Instrument) => HistoryFeed | undefined;
  /** 期間内のブリーフ (generatedAt の昇順)。検証のバックテストへ「その時点のバイアス」を渡すのに使う */
  briefsBetween?: (since: number, until: number) => MarketBrief[];
  /** 資産クラス別の情報の効き具合 (エンジンと同じく sentiment / confidence に掛ける。省略時 1) */
  intelInfluence?: (assetClass: AssetClass) => number;
  /** この時間より古いブリーフは「その時点の情報なし」とみなす (既定 6 時間) */
  briefMaxAgeMs?: number;
  /** 実運用と同じ見送り条件 (期待値幅 / コスト) で比較する */
  minEdgeToCostRatio?: number;
  riskPerTrade?: number;
  maxPositionPct?: number;
  /** 指値 (maker) の前提 (実運用の LIMIT_ENTRY / LIMIT_TAKE_PROFIT と同じ。省略時は従来の成行) */
  limitOrders?: BacktestOptions["limitOrders"];
  /**
   * 最大保有 (分。実運用の MAX_HOLD_MINUTES と同じ。0・省略で無効)。中期・長期以外の戦略の検証でシグナルの最大保有を縮める
   * (中期・長期は運用で新規エントリーしないので縮めない)
   */
  maxHoldMinutes?: number;
  /** 読みの管理 (実運用の THESIS_* と同じ。省略で従来の時間切れ) */
  thesis?: BacktestOptions["thesis"];
  /** 区間数 (既定 5) */
  folds?: number;
  /** 主時間足での履歴の本数 (horizon 別) */
  historyBars?: Partial<Record<Horizon, number>>;
  /** 履歴の期間の上限 (既定 3 年) */
  maxHistoryMs?: number;
  /** 要求した期間のうち最低限取得できている必要がある割合 (既定 0.5。新規上場などで足りない銘柄は使わない) */
  minCoverage?: number;
  /** 検証に使う銘柄数の上限 (既定 2。銘柄名の昇順) */
  maxSymbols?: number;
  /** 履歴のキャッシュ (省略時は新規。ttl 6 時間、失敗は 30 分) */
  cache?: HistoryCache;
  pageLimit?: number;
  maxPages?: number;
}

/**
 * 時刻 → その時点で記録済みのバイアス (検証のバックテスト用)。
 * ts 以前で最新のブリーフ (maxAgeMs 以内) から、エンジンと同じ規則 (intelBiasFor) で銘柄のバイアスを作る。
 * 先読みしないよう、ts より後に作られたブリーフは使わない。
 */
export function intelTimeline(
  inst: Instrument,
  briefs: readonly MarketBrief[],
  influence: number,
  maxAgeMs: number,
): (ts: number) => IntelBias | undefined {
  const sorted = [...briefs].sort((a, b) => a.generatedAt - b.generatedAt);
  const memo = new Map<number, IntelBias | undefined>();
  return (ts) => {
    // ts 以下で最後のブリーフ (二分探索)
    let lo = 0;
    let hi = sorted.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].generatedAt <= ts) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (idx < 0 || ts - sorted[idx].generatedAt > maxAgeMs) return undefined;
    if (!memo.has(idx)) memo.set(idx, intelBiasFor(inst, sorted[idx].biases ?? {}, influence));
    return memo.get(idx);
  };
}

/**
 * パラメータ候補の検証: feed から長い履歴 (主時間足で数千本) を取得し、時間で k 区間に分けて区間ごとにバックテストする。
 * - 履歴は銘柄・時間足ごとにキャッシュ (既定 6 時間) し、現行と候補の比較で同じデータを使う (dataKey で確認)。
 * - 取得に失敗した・足りない銘柄は使わない。使える銘柄が無ければ undefined (調整しない。hub の短い足で代用しない)。
 * - 板が必須の戦略は履歴で再現できないので undefined。
 * - その時点で記録済みのブリーフがあれば、エンジンと同じ規則のバイアスを時刻順に渡す (meme_momentum は sentiment > 0 が必須)。
 */
export function createParamValidator(o: ValidatorOptions): ParamValidator {
  const cache = o.cache ?? new HistoryCache({ ttlMs: 6 * 3_600_000, failureTtlMs: 30 * 60_000 });
  const folds = Math.max(2, Math.round(o.folds ?? 5));
  const maxHistoryMs = o.maxHistoryMs ?? 3 * 365 * DAY;
  const maxSymbols = Math.max(1, o.maxSymbols ?? 2);
  const briefMaxAgeMs = o.briefMaxAgeMs ?? 6 * 3_600_000;
  const minCoverage = Math.min(1, Math.max(0, o.minCoverage ?? 0.5));

  return async (strategyId: string, assetClass: AssetClass, params: Params): Promise<ValidationRun | undefined> => {
    const s = o.strategies.find((x) => x.id === strategyId);
    if (!s || s.requiresBook) return undefined;
    const now = o.clock.now();
    const base: Timeframe = baseTimeframeOf(s);
    const baseMs = TIMEFRAME_MS[base];
    const primaryMs = TIMEFRAME_MS[s.primaryTimeframe];
    const bars = Math.max(1, Math.round(o.historyBars?.[s.horizon] ?? DEFAULT_VALIDATION_BARS[s.horizon]));
    const leadMs = (s.warmup + 50) * primaryMs;
    const spanMs = Math.min(bars * primaryMs, maxHistoryMs);
    const until = Math.floor(now / baseMs) * baseMs;
    const from = until - spanMs - leadMs;

    const insts = o.hub
      .watched()
      .filter((i) => i.assetClass === assetClass && o.feedFor(i))
      .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
      .slice(0, maxSymbols);
    const loaded: { inst: Instrument; candles: Candle[] }[] = [];
    for (const inst of insts) {
      const feed = o.feedFor(inst)!;
      const key = `${inst.venue}|${inst.symbol}|${base}`;
      // 同じ時間足の他の戦略 (ウォームアップが違う) とも共有できるよう、主時間足 300 本分を余分に取る
      const cached = await cache.get(key, now, from, () =>
        fetchCandlesPaged(feed, inst.symbol, base, from - 300 * primaryMs, until, { pageLimit: o.pageLimit ?? 1000, maxPages: o.maxPages ?? 80 }),
      );
      const candles = cached?.filter((c) => c.ts >= from);
      // 要求した期間の minCoverage (既定 50%) 以上を取れなかった銘柄は使わない (短い履歴で代用しない)
      const covered = candles && candles.length > 0 ? candles[candles.length - 1].ts + baseMs - candles[0].ts : 0;
      if (candles && covered >= leadMs + Math.max(minCoverage * spanMs, folds * 20 * primaryMs)) {
        loaded.push({ inst, candles });
      }
    }
    if (loaded.length === 0) return undefined;

    // 全銘柄に共通の期間を k 等分する (区間の境界は現行・候補で同じ)
    const start = Math.max(...loaded.map((l) => l.candles[0].ts)) + leadMs;
    const end = Math.min(...loaded.map((l) => l.candles[l.candles.length - 1].ts + baseMs));
    if (end - start < folds * 20 * primaryMs) return undefined;
    const bounds = foldBoundaries(start, end, folds);
    const briefs = o.briefsBetween ? o.briefsBetween(start - leadMs - briefMaxAgeMs, end) : [];
    // エグジット後の値動きは実運用の計測 (journal の horizon) に合わせる (要因の基準比率をそろえるため)
    const postExitBars = Math.max(1, Math.round(DEFAULT_POST_EXIT_HORIZON_MS[s.horizon] / primaryMs));

    const agg: ValidationFold[] = bounds.slice(0, -1).map((b, i) => ({ from: b, to: bounds[i + 1], trades: 0, sumR: 0 }));
    const trades: TradeRecord[] = [];
    for (const { inst, candles } of loaded) {
      const intel = briefs.length ? intelTimeline(inst, briefs, o.intelInfluence?.(inst.assetClass) ?? 1, briefMaxAgeMs) : undefined;
      const runs = foldedBacktest(s, params, inst, candles, bounds, {
        baseTimeframe: base,
        postExitBars,
        ...(intel ? { intel } : {}),
        ...(o.minEdgeToCostRatio !== undefined ? { minEdgeToCostRatio: o.minEdgeToCostRatio } : {}),
        ...(o.riskPerTrade !== undefined ? { riskPerTrade: o.riskPerTrade } : {}),
        ...(o.maxPositionPct !== undefined ? { maxPositionPct: o.maxPositionPct } : {}),
        ...(o.limitOrders ? { limitOrders: o.limitOrders } : {}),
        ...(o.maxHoldMinutes !== undefined && o.maxHoldMinutes > 0 && !isHoldLimitedHorizon(s.horizon) ? { maxHoldMinutes: o.maxHoldMinutes } : {}),
        ...(o.thesis ? { thesis: o.thesis } : {}),
      });
      runs.forEach((r, i) => {
        agg[i].trades += r.trades.length;
        agg[i].sumR += r.trades.reduce((sum, t) => sum + (Number.isFinite(t.rMultiple) ? t.rMultiple : 0), 0);
        trades.push(...r.trades);
      });
    }
    const dataKey = [
      base,
      ...loaded.map((l) => `${l.inst.symbol}:${l.candles[0].ts}:${l.candles[l.candles.length - 1].ts}:${l.candles.length}`),
      bounds.join(","),
      `briefs:${briefs.length}`,
    ].join("|");
    return { dataKey, folds: agg, trades };
  };
}

/**
 * 任意時刻の価格: hub の 1m 確定足のうち ts を含む足の終値。
 * 履歴の範囲外 (古すぎる・まだ確定していない) なら undefined (学習側が次回再試行する)。
 */
export function createPriceAt(hub: HubLike, clock: Clock): PriceAt {
  return (symbol, ts) => priceFromCandles(hub.getView(symbol, clock.now())?.candles["1m"], ts);
}

/** 1m 確定足 (昇順) のうち ts を含む足の終値。範囲外なら undefined */
export function priceFromCandles(c: readonly Candle[] | undefined, ts: number): number | undefined {
  if (!c || c.length === 0) return undefined;
  const ms = TIMEFRAME_MS["1m"];
  if (ts < c[0].ts || ts >= c[c.length - 1].ts + ms) return undefined;
  // ts 以下で最後の足 (二分探索)
  let lo = 0;
  let hi = c.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c[mid].ts <= ts) lo = mid;
    else hi = mid - 1;
  }
  const px = c[lo].close;
  return px > 0 ? px : undefined;
}
