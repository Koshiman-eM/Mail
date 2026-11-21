/**
 * paper の口座 (ペーパーウォレット) のリセット (`npm run trader -- paper reset --equity <JPY> [--confirm]`)。
 *
 * 学習データ (取引の履歴・腕・要因分析・パラメータ調整・仮想トレード・予想・ニュースの答え合わせ・情報源の信頼度・
 * リスク設定の上書き `risk:limits:paper` など) は残し、paper の口座の状態だけを作り直す:
 *   - 保有中の建玉 (kv `journal:open:paper`) は最後に分かった価格 (無ければ建値) で、決済理由 `wallet_reset`・
 *     `learningExcluded: true` の取引として記帳上だけ閉じる (学習・成績の集計には使わない)
 *   - 決済計画 `positions:exitPlans:paper`・保留中の注文 `orders:pending:paper`・板に置いた利確 `orders:restingTp:paper`・
 *     適用待ちの解消要求 `orders:resolveRequests:paper` を空にする
 *   - PaperBroker のスナップショット `paper:snapshot` を新しい評価額 (現金のみ・建玉なし) で書き直す
 *   - RiskManager の状態 `risk:state:paper` を新しい評価額で初期化する (キルスイッチ・日次停止も解除)
 *   - 履歴 `paper:resets` に追記し、監査ログ `paper.wallet_reset` と評価額の記録 (新しい評価額) を残す
 * 書き込みは 1 つのトランザクションで行う。エンジン (paper) が動作中なら拒否する (動作中のエンジンが上書きするため)。
 */
import { isLearningExcludedTrade, type EquityPoint, type Store, type TradeRecord, type TradingMode } from "../core/types";
import { acquireEngineLock, ENGINE_LOCK_STALE_MS, engineLockKey, releaseEngineLock, type EngineLock, type LockOwner } from "../engine/lock";
import { pendingOrdersKey, resolveRequestsKey, restingTpKey } from "../engine/orders";
import type { PaperSnapshot } from "../execution/paper";
import { openKvKey, TradeJournal } from "../learning/journal";
import { riskStateKey } from "../risk/manager";
import { isoDayKey } from "../core/util";

/** PaperBroker のスナップショットの kv キー (engine.ts の PAPER_SNAPSHOT_KEY と同じ値) */
export const PAPER_SNAPSHOT_KV_KEY = "paper:snapshot";
/** 決済計画の kv キー (positions.ts の plansKey("paper") と同じ値) */
export const PAPER_EXIT_PLANS_KEY = "positions:exitPlans:paper";
/** リセットの履歴 (古い順) */
export const PAPER_RESETS_KEY = "paper:resets";
export const WALLET_RESET_AUDIT_TYPE = "paper.wallet_reset";
/** 口座のリセットで閉じた建玉の決済理由 */
export const WALLET_RESET_EXIT_REASON = "wallet_reset" as const;

const MODE: TradingMode = "paper";

/** リセットで書き換える kv のキー (これ以外は変えない) */
export const WALLET_RESET_KEYS: readonly string[] = [
  openKvKey(MODE),
  PAPER_EXIT_PLANS_KEY,
  pendingOrdersKey(MODE),
  restingTpKey(MODE),
  resolveRequestsKey(MODE),
  PAPER_SNAPSHOT_KV_KEY,
  riskStateKey(MODE),
  PAPER_RESETS_KEY,
];

export interface PaperResetRecord {
  at: number;
  /** リセット前の評価額 (記録が無ければ undefined) */
  fromEquity?: number;
  toEquity: number;
  /** 記帳上だけ閉じた建玉の数 */
  closedCount: number;
  by?: string;
}

/** リセットの履歴 (古い順。壊れた要素は無視) */
export function readPaperResets(store: Pick<Store, "kvGet">): PaperResetRecord[] {
  const v = store.kvGet<unknown>(PAPER_RESETS_KEY);
  if (!Array.isArray(v)) return [];
  return v.filter(
    (r): r is PaperResetRecord =>
      Boolean(r) && typeof r === "object" && Number.isFinite((r as PaperResetRecord).at) && Number.isFinite((r as PaperResetRecord).toEquity),
  );
}

/** 最新のリセット (無ければ undefined) */
export function latestPaperReset(store: Pick<Store, "kvGet">): PaperResetRecord | undefined {
  const all = readPaperResets(store);
  return all.length ? all.reduce((a, b) => (b.at >= a.at ? b : a)) : undefined;
}

/**
 * 成績の集計に使う取引: 学習・成績から除く取引 (wallet_reset) を除き、paper の取引は最新のリセット以降に決済したものだけ。
 * live の取引はそのまま。allTime なら期間で絞らない (除外する取引は除く)
 */
export function performanceTrades(trades: TradeRecord[], reset: Pick<PaperResetRecord, "at"> | undefined, opts: { allTime?: boolean } = {}): TradeRecord[] {
  return trades.filter(
    (t) => !isLearningExcludedTrade(t) && (opts.allTime || !reset || (t.mode ?? "paper") !== "paper" || t.exitTs >= reset.at),
  );
}

/** paper の評価額の記録をリセット以降に絞る (allTime なら絞らない) */
export function equitySinceReset(points: EquityPoint[], reset: Pick<PaperResetRecord, "at"> | undefined, opts: { allTime?: boolean } = {}): EquityPoint[] {
  if (opts.allTime || !reset) return points;
  return points.filter((p) => p.mode !== "paper" || p.ts >= reset.at);
}

// ───────── 事前の確認 ─────────

export class WalletResetError extends Error {}

/** 新しい評価額の検証 (正の有限数) */
export function validateResetEquity(raw: unknown): number {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().replace(/_/g, "") : "";
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(s)) throw new WalletResetError(`--equity には正の数値 (円) を指定してください (指定値: ${String(raw)})`);
  const n = Number(s);
  if (!Number.isFinite(n) || !(n > 0)) throw new WalletResetError(`--equity には正の数値 (円) を指定してください (指定値: ${String(raw)})`);
  return n;
}

/** TRADING_MODE=live (確認語の有無を問わず) または実効の mode が live なら拒否する */
export function assertPaperOnly(o: { tradingModeEnv?: string; mode: TradingMode }): void {
  if (o.mode === "live" || (o.tradingModeEnv ?? "").trim().toLowerCase() === "live") {
    throw new WalletResetError("paper reset は paper 専用です。TRADING_MODE=live では実行できません (実弾の口座はリセットできません)");
  }
}

/** paper のエンジンが動作中か (kv `engine:lock:paper` の heartbeat が staleMs 以内。時計の巻き戻りも動作中とみなす) */
export function paperEngineRunning(
  store: Pick<Store, "kvGet">,
  now: number,
  staleMs: number = ENGINE_LOCK_STALE_MS,
): { running: false } | { running: true; lock: EngineLock; message: string } {
  const l = store.kvGet<EngineLock>(engineLockKey(MODE));
  if (!l || typeof l !== "object" || typeof l.heartbeatAt !== "number") return { running: false };
  const age = now - l.heartbeatAt;
  if (age > staleMs) return { running: false };
  return {
    running: true,
    lock: l,
    message:
      `paper のエンジンが動作中です (pid ${l.pid}, host ${l.hostname}, 最終 heartbeat ${Math.max(0, Math.round(age / 1000))} 秒前)。` +
      "先に `sudo systemctl stop trader` でエンジンを止めてから実行してください (止めてから約 60 秒たっても拒否される場合はロックの heartbeat が残っています)",
  };
}

// ───────── 計画 (dry run) ─────────

export interface ResetPositionPlan {
  tradeId: string;
  symbol: string;
  strategyId: string;
  direction: "long" | "short";
  qty: number;
  entryPrice: number;
  exitPrice: number;
  /** quote: スナップショットの最後の気配 (仲値) / last: 建玉の最後の価格 / entry: 価格が分からないので建値 */
  priceSource: "quote" | "last" | "entry";
}

export interface WalletResetPlan {
  now: number;
  /** リセット前の評価額 (paper の最新の評価額の記録。無ければスナップショットの現金) */
  fromEquity?: number;
  fromEquitySource?: "equity" | "snapshot_cash";
  toEquity: number;
  positions: ResetPositionPlan[];
  /** スナップショットにあってエンジンが追跡していない建玉 (スナップショットの書き直しで消える) */
  untrackedSnapshotPositions: { symbol: string; qty: string }[];
  pendingOrders: number;
  restingTakeProfits: number;
  exitPlans: number;
  resolveRequests: number;
  restingSnapshotOrders: number;
  risk: { dayStartEquity?: number; peakEquity?: number; killSwitch?: string; haltedUntil?: number };
  /** 書き換える kv のキー */
  keys: readonly string[];
  previousResets: number;
}

const lengthOf = (v: unknown) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0);

function exitPriceOf(p: { symbol: string; entryPrice: number; lastPrice?: number; lastTs?: number }, snap: PaperSnapshot | undefined): Pick<ResetPositionPlan, "exitPrice" | "priceSource"> {
  const q = snap?.quotes?.[p.symbol];
  const mid = q && Number.isFinite(q.bid) && Number.isFinite(q.ask) && q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : undefined;
  const last = typeof p.lastPrice === "number" && Number.isFinite(p.lastPrice) && p.lastPrice > 0 ? p.lastPrice : undefined;
  // 新しい方を使う (建玉の最後の価格は高値・安値が変わったときしか保存されないため、スナップショットの気配の方が新しいことが多い)
  if (mid !== undefined && (last === undefined || (q?.ts ?? 0) >= (p.lastTs ?? 0))) return { exitPrice: mid, priceSource: "quote" };
  if (last !== undefined) return { exitPrice: last, priceSource: "last" };
  return { exitPrice: p.entryPrice, priceSource: "entry" };
}

/** 何をするかを計算する (書き込まない) */
export function planWalletReset(store: Store, o: { equity: number; now: number }): WalletResetPlan {
  const toEquity = validateResetEquity(o.equity);
  const snap = store.kvGet<PaperSnapshot>(PAPER_SNAPSHOT_KV_KEY);
  const journal = new TradeJournal({ store, mode: MODE });
  const open = journal.list();
  const positions = open.map((p) => ({
    tradeId: p.id, symbol: p.symbol, strategyId: p.strategyId, direction: p.direction, qty: p.qty, entryPrice: p.entryPrice, ...exitPriceOf(p, snap),
  }));
  const tracked = new Set(open.map((p) => p.symbol));
  const untrackedSnapshotPositions = (snap?.positions ?? [])
    .filter((p) => !tracked.has(p.symbol) && Number(p.qty) !== 0)
    .map((p) => ({ symbol: p.symbol, qty: p.qty }));
  const lastEq = store.listEquity({ mode: MODE }).at(-1);
  const snapCash = snap && Number.isFinite(Number(snap.cash)) ? Number(snap.cash) : undefined;
  const fromEquity = lastEq?.equity ?? snapCash;
  const st = store.kvGet<{ dayStartEquity?: number; peakEquity?: number; killSwitch?: { reason?: string }; haltedUntil?: number }>(riskStateKey(MODE));
  return {
    now: o.now,
    ...(fromEquity !== undefined ? { fromEquity, fromEquitySource: lastEq ? ("equity" as const) : ("snapshot_cash" as const) } : {}),
    toEquity,
    positions,
    untrackedSnapshotPositions,
    pendingOrders: lengthOf(store.kvGet(pendingOrdersKey(MODE))),
    restingTakeProfits: lengthOf(store.kvGet(restingTpKey(MODE))),
    exitPlans: lengthOf(store.kvGet(PAPER_EXIT_PLANS_KEY)),
    resolveRequests: lengthOf(store.kvGet(resolveRequestsKey(MODE))),
    restingSnapshotOrders: snap?.resting?.length ?? 0,
    risk: {
      ...(typeof st?.dayStartEquity === "number" ? { dayStartEquity: st.dayStartEquity } : {}),
      ...(typeof st?.peakEquity === "number" ? { peakEquity: st.peakEquity } : {}),
      ...(st?.killSwitch ? { killSwitch: String(st.killSwitch.reason ?? "作動中") } : {}),
      ...(typeof st?.haltedUntil === "number" ? { haltedUntil: st.haltedUntil } : {}),
    },
    keys: WALLET_RESET_KEYS,
    previousResets: readPaperResets(store).length,
  };
}

/** 新しい評価額の空のスナップショット (PaperBroker.restore で読める形。注文番号の連番と換算レート・気配は引き継ぐ) */
export function freshPaperSnapshot(equity: number, prev?: PaperSnapshot): PaperSnapshot {
  return {
    version: 1,
    cash: validateResetEquity(equity).toString(),
    realizedPnl: "0",
    seq: typeof prev?.seq === "number" && Number.isFinite(prev.seq) ? prev.seq : 0,
    positions: [],
    resting: [],
    results: {},
    quotes: prev?.quotes && typeof prev.quotes === "object" ? prev.quotes : {},
    instruments: [],
    fxRates: prev?.fxRates && typeof prev.fxRates === "object" ? prev.fxRates : {},
  };
}

export interface WalletResetResult {
  plan: WalletResetPlan;
  closed: TradeRecord[];
  record: PaperResetRecord;
}

/** 書き込みのトランザクション。SQLite は BEGIN IMMEDIATE (書き込みロックを最初に取り、途中で SQLITE_BUSY にならない) */
function writeTx<T>(store: Store, fn: () => T): T {
  const st = store as Store & { immediateTransaction?: <R>(f: () => R) => R };
  if (typeof st.immediateTransaction === "function") return st.immediateTransaction(fn);
  return store.transaction ? store.transaction(fn) : fn();
}

/** SQLite のロック競合 (SQLITE_BUSY / database is locked) か */
export function isDbBusyError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown; errcode?: unknown } | null)?.errcode;
  return /SQLITE_BUSY|database is locked/i.test(msg) || code === 5 || (typeof code === "number" && (code & 0xff) === 5);
}

/**
 * リセットを実行する。呼び出し側で assertPaperOnly を済ませておくこと。
 * 1. エンジンと同じロック (kv `engine:lock:paper`) を取得する。取れなければ (エンジンが動作中・起動中) WalletResetError。
 *    リセットの間に起動したエンジンはロックを取れずに終了する (起動中のエンジンが古い状態を書き戻さない)
 * 2. 口座の書き換えを 1 トランザクションで行う
 * 3. ロックを返す (例外でも返す)
 */
export function executeWalletReset(
  store: Store,
  o: { equity: number; now: number; by?: string; staleMs?: number; pid?: number; hostname?: string; isPidAlive?: (pid: number) => boolean },
): WalletResetResult {
  validateResetEquity(o.equity);
  const acq = acquireEngineLock(store, MODE, {
    now: o.now,
    ...(o.staleMs !== undefined ? { staleMs: o.staleMs } : {}),
    ...(o.pid !== undefined ? { pid: o.pid } : {}),
    ...(o.hostname !== undefined ? { hostname: o.hostname } : {}),
    ...(o.isPidAlive ? { isPidAlive: o.isPidAlive } : {}),
  });
  if (!acq.ok) {
    throw new WalletResetError(`${acq.message}。先に \`sudo systemctl stop trader\` でエンジンを止めてから実行してください`);
  }
  const owner: LockOwner = { pid: acq.lock.pid, hostname: acq.lock.hostname, startedAt: acq.lock.startedAt };
  try {
    return writeTx(store, () => resetInTx(store, o));
  } finally {
    releaseEngineLock(store, MODE, owner);
  }
}

function resetInTx(store: Store, o: { equity: number; now: number; by?: string }): WalletResetResult {
  const plan = planWalletReset(store, o);
  const by = o.by ?? "cli";
  const journal = new TradeJournal({ store, mode: MODE });
  const closed: TradeRecord[] = [];
  for (const p of plan.positions) {
    closed.push(
      journal.close({
        id: p.tradeId,
        exitPrice: p.exitPrice,
        intendedExitPrice: p.exitPrice,
        exitTs: o.now,
        exitReason: WALLET_RESET_EXIT_REASON,
        fees: 0,
        learningExcluded: true,
      }),
    );
  }
  store.kvSet(openKvKey(MODE), []);
  store.kvSet(PAPER_EXIT_PLANS_KEY, {});
  store.kvSet(pendingOrdersKey(MODE), []);
  store.kvSet(restingTpKey(MODE), []);
  store.kvSet(resolveRequestsKey(MODE), undefined);
  store.kvSet(PAPER_SNAPSHOT_KV_KEY, freshPaperSnapshot(plan.toEquity, store.kvGet<PaperSnapshot>(PAPER_SNAPSHOT_KV_KEY)));
  // RiskManager の内部状態 (dayKey を含む) を新しい評価額で初期化する。上書きのリスク上限 (risk:limits:paper) は触らない
  store.kvSet(riskStateKey(MODE), { dayStartEquity: plan.toEquity, peakEquity: plan.toEquity, recentOrderTs: [], dayKey: isoDayKey(o.now) });
  const record: PaperResetRecord = {
    at: o.now,
    ...(plan.fromEquity !== undefined ? { fromEquity: plan.fromEquity } : {}),
    toEquity: plan.toEquity,
    closedCount: closed.length,
    by,
  };
  store.kvSet(PAPER_RESETS_KEY, [...readPaperResets(store), record]);
  store.saveEquity({ ts: o.now, equity: plan.toEquity, mode: MODE });
  store.audit({
    ts: o.now,
    type: WALLET_RESET_AUDIT_TYPE,
    data: {
      mode: MODE,
      by,
      fromEquity: plan.fromEquity ?? null,
      toEquity: plan.toEquity,
      closedCount: closed.length,
      closed: plan.positions.map((p) => ({ tradeId: p.tradeId, symbol: p.symbol, direction: p.direction, qty: p.qty, exitPrice: p.exitPrice, priceSource: p.priceSource })),
      untrackedSnapshotPositions: plan.untrackedSnapshotPositions,
      cleared: {
        pendingOrders: plan.pendingOrders, restingTakeProfits: plan.restingTakeProfits, exitPlans: plan.exitPlans,
        resolveRequests: plan.resolveRequests, restingSnapshotOrders: plan.restingSnapshotOrders,
      },
      previousRisk: plan.risk,
      keys: [...WALLET_RESET_KEYS],
    },
  });
  return { plan, closed, record };
}

// ───────── 表示 ─────────

const yen = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? "(記録なし)" : `${Math.round(x).toLocaleString("ja-JP")} 円`);
const iso = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
const PRICE_SOURCE_LABEL: Record<ResetPositionPlan["priceSource"], string> = { quote: "最後の気配の仲値", last: "建玉の最後の価格", entry: "価格不明のため建値" };

/** 計画の日本語の説明 (dry run と実行結果の両方で使う) */
export function formatWalletResetPlan(plan: WalletResetPlan): string[] {
  const lines = [
    `現在の評価額 (paper): ${yen(plan.fromEquity)}${plan.fromEquitySource === "snapshot_cash" ? " (評価額の記録が無いためスナップショットの現金)" : ""}`,
    `新しい評価額: ${yen(plan.toEquity)}`,
    `記帳上だけ閉じる建玉: ${plan.positions.length} 件 (決済理由「リセットで決済」、学習・成績の集計には使いません)`,
    ...plan.positions.map(
      (p) => `  ${p.symbol} ${p.direction === "long" ? "買い" : "売り"} ${p.qty} 建値 ${p.entryPrice} → ${p.exitPrice} (${PRICE_SOURCE_LABEL[p.priceSource]}) [${p.strategyId}] ${p.tradeId}`,
    ),
  ];
  if (plan.untrackedSnapshotPositions.length) {
    lines.push(`追跡外のペーパー口座の建玉 (消えます): ${plan.untrackedSnapshotPositions.map((p) => `${p.symbol} ${p.qty}`).join(", ")}`);
  }
  lines.push(
    `消す: 決済計画 ${plan.exitPlans} 件 / 保留中の注文 ${plan.pendingOrders} 件 / 板に置いた利確 ${plan.restingTakeProfits} 件 / 解消要求 ${plan.resolveRequests} 件 / ペーパー口座の指値 ${plan.restingSnapshotOrders} 件`,
    `リスク状態: 日初 ${yen(plan.risk.dayStartEquity)} / 最高 ${yen(plan.risk.peakEquity)}${plan.risk.killSwitch ? ` / キルスイッチ (${plan.risk.killSwitch})` : ""}` +
      `${plan.risk.haltedUntil !== undefined ? ` / 日次停止 ${iso(plan.risk.haltedUntil)} まで` : ""} → 日初・最高とも ${yen(plan.toEquity)}、停止なし`,
    `書き換える kv: ${plan.keys.join(", ")}`,
    "残すもの: 取引の履歴・腕・要因分析・パラメータ調整・振り返り・仮想トレード・予想・ニュースの答え合わせ・情報源の信頼度・リスク設定の上書き (risk:limits:paper)・指値の約定率",
  );
  if (plan.previousResets) lines.push(`これまでのリセット: ${plan.previousResets} 回`);
  return lines;
}
