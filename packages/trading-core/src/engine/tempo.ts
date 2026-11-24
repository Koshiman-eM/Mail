/**
 * テンポ (エントリー頻度の目標に対する遅れ) の計算。純粋なモジュール (時刻は引数で渡す。I/O・乱数なし)。
 *
 * 目的: 「おおむね targetPerHour 回/時 (例: 6 回 = 10 分に 1 回) エントリーしたい」という目標に対して、
 *   エントリーが途切れているときだけ、戦略と RiskManager の一部の条件を決められた範囲で緩める。
 *   - tempo は 0〜1。0 = 緩めない (従来どおり)、1 = 決められた下限まで緩める。
 *   - 緩めてよい条件と下限は呼び出し側 (戦略・RiskManager) が決める。ここでは「どれだけ緩めるか」だけを決める。
 *   - コスト控除後の期待値 > 0 などの安全側の条件は緩めない (呼び出し側の責任)。
 *     例外は探索 (tempoNetEdgeFloor の explore = true): テンポのモードで探索を許したときだけ、期待値の下限を
 *     往復コストの tempo 倍まで下げ、期待値 0 以下のシグナルを小さいサイズで試す (エンジンが TEMPO_EXPLORE_SIZE 倍にし、取引に印を付ける)。
 *
 * level(now) の定義:
 *   - interval = 60 / targetPerHour (分)。目標どおりなら interval ごとに 1 回エントリーする。
 *   - deficit = clamp(1 - n / target)。n は直近 windowMs のエントリー数、target は窓の長さに換算した目標回数
 *     (targetPerHour × windowMs / 1 時間。既定の 1 時間なら targetPerHour)。目標に届いていれば 0。
 *   - since = 最後のエントリーからの経過 (分)。エントリーが一度も無ければ、コントローラーの起点
 *     (コンストラクタの now、無ければ最初に渡された時刻) からの経過。
 *   - wait = clamp((since - interval) / interval)。最後のエントリーから interval 分は 0 で、その後 interval 分かけて 1 まで上がる。
 *   - tempo = deficit × wait。
 * capped(now): 直近 windowMs のエントリー数 ≥ ceil(target × capMultiplier) なら true (多すぎる。呼び出し側が新規を止める)。
 * targetPerHour が 0 以下・非有限なら無効 (tempo は常に 0、capped は常に false)。
 */

import { openDurationMs, type MarketCalendar } from "../core/calendar";

/** テンポで緩めるときのコスト倍率 (利確幅 / 往復コスト) の下限。これより下には緩めない */
export const TEMPO_COST_MULT_FLOOR = 1.5;

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** テンポを 0〜1 に収める (undefined・NaN は 0) */
export function clampTempo(tempo: number | undefined): number {
  if (tempo === undefined || !Number.isFinite(tempo)) return 0;
  return Math.min(1, Math.max(0, tempo));
}

/**
 * base を floor へ向けて tempo の割合だけ緩めた値: base - clamp(tempo) × (base - floor)。
 * - base ≥ floor なら結果は floor 〜 base (floor より下にはしない)。
 * - base < floor (設定がもともと下限より緩い) なら base のまま (締めも緩めもしない)。base が NaN なら NaN のまま。
 * - tempo が 0 (undefined・NaN を含む) なら base そのもの
 */
export function relaxToward(base: number, floor: number, tempo: number | undefined): number {
  if (!(base >= floor)) return base;
  const t = clampTempo(tempo);
  if (t === 0) return base;
  return Math.max(floor, base - t * (base - floor));
}

/**
 * 戦略の「コスト控除後の期待値 > 下限」の実効の下限 (探索)。
 * - explore が false: minNetEdgeBps そのもの (従来どおり。tempo によらない)。
 * - explore が true: minNetEdgeBps - clamp(tempo) × costBps。テンポが上がるほど、往復コストの tempo 倍まで
 *   期待値が 0 以下 (コスト負け) のシグナルも探索として通す (サイズはエンジンが TEMPO_EXPLORE_SIZE 倍に絞る)。
 *   costBps が非有限・負なら 0 として扱う (下限を下げない)。
 * explore はテンポのモードで探索を許したときだけ true (paper、または live で TEMPO_ALLOW_LIVE_EXPLORE=true)
 */
export function tempoNetEdgeFloor(minNetEdgeBps: number, tempo: number | undefined, costBps: number, explore: boolean): number {
  if (!explore) return minNetEdgeBps;
  const c = Number.isFinite(costBps) && costBps > 0 ? costBps : 0;
  return minNetEdgeBps - clampTempo(tempo) * c;
}

/**
 * 最大保有 (MAX_HOLD_MINUTES) で新規エントリーしない時間軸か (中期・長期)。
 * エンジンは観測専用と同じ扱い (仮想トレード hold_limit) にし、バックテストでは最大保有を縮めない (運用で入らないため)。
 * いま登録している戦略に中期・長期は無い (廃止した) が、時間軸による一般の規則として残している
 */
export function isHoldLimitedHorizon(horizon: string | undefined): boolean {
  return horizon === "mid" || horizon === "long";
}

/**
 * 戦略が最大保有 (MAX_HOLD_MINUTES) で新規エントリーしない (観測専用の hold_limit にする) か。
 * 決済を自分で管理する戦略 (Strategy.managesOwnExit。trend_4h・mid_trend_follow) は最大保有の上限を受けないので、時間軸が中期・長期でも対象外
 */
export function isHoldLimitedStrategy(s: { horizon: string; managesOwnExit?: true }): boolean {
  return s.managesOwnExit !== true && isHoldLimitedHorizon(s.horizon);
}

/**
 * シグナルの最大保有 (ms) を上限 limitMs までに縮める。maxHoldMs が 0 以下・非有限 (時間切れ無し) なら limitMs。
 * limitMs が無い・0 以下・非有限ならそのまま。純粋関数
 */
export function clampMaxHoldMs(maxHoldMs: number, limitMs: number | undefined): number {
  if (limitMs === undefined || !Number.isFinite(limitMs) || !(limitMs > 0)) return maxHoldMs;
  return Number.isFinite(maxHoldMs) && maxHoldMs > 0 ? Math.min(maxHoldMs, limitMs) : limitMs;
}

export interface TempoControllerOptions {
  /** 目標のエントリー数 (1 時間あたり)。0 以下で無効 */
  targetPerHour: number;
  /** エントリー数を数える窓 (ms、既定 1 時間) */
  windowMs?: number;
  /** 窓の中のエントリー数が target × これ (切り上げ) に達したら capped (既定 2) */
  capMultiplier?: number;
  /** 起点の時刻 (エントリーが一度も無いときの経過の基準)。省略時は最初に渡された時刻 */
  now?: number;
  /**
   * 取引時間のカレンダー。渡すと経過時間・窓を取引時間だけで測る (閉まっている間は不足も待ちも進めない)。
   * 省略時は実時間 (従来どおり。暗号資産)
   */
  calendar?: MarketCalendar;
}

export interface TempoSnapshot {
  /** 目標 (1 時間あたり) */
  target: number;
  /** 窓の長さに換算した目標回数 */
  targetInWindow: number;
  /** 目標の間隔 (分)。無効なら Infinity */
  intervalMin: number;
  /** 直近 windowMs のエントリー数 */
  entriesInWindow: number;
  /** capped になるエントリー数 (無効なら Infinity) */
  capAt: number;
  tempo: number;
  capped: boolean;
  /** 最後のエントリーからの経過 (分)。エントリーが一度も無ければ null */
  minutesSinceLastEntry: number | null;
}

/** エントリーの時刻からテンポを計算する。決定的 (時刻はすべて引数) */
export class TempoController {
  readonly targetPerHour: number;
  readonly windowMs: number;
  readonly capMultiplier: number;
  private start?: number;
  private lastEntryTs?: number;
  /** 窓の中のエントリーの時刻 (昇順) */
  private entries: number[] = [];
  private readonly calendar?: MarketCalendar;

  constructor(opts: TempoControllerOptions) {
    const t = opts.targetPerHour;
    this.targetPerHour = Number.isFinite(t) && t > 0 ? t : 0;
    const w = opts.windowMs;
    this.windowMs = w !== undefined && Number.isFinite(w) && w > 0 ? w : HOUR_MS;
    const c = opts.capMultiplier;
    this.capMultiplier = c !== undefined && c > 0 ? c : 2;
    if (opts.now !== undefined && Number.isFinite(opts.now)) this.start = opts.now;
    if (opts.calendar) this.calendar = opts.calendar;
  }

  /** from から to までの経過 (ms)。カレンダーがあれば取引時間だけ */
  private elapsed(from: number, to: number): number {
    return this.calendar ? openDurationMs(this.calendar, from, to) : to - from;
  }

  /** 有効か (targetPerHour > 0) */
  get enabled(): boolean {
    return this.targetPerHour > 0;
  }

  /** 窓の長さに換算した目標回数 */
  private get targetInWindow(): number {
    return (this.targetPerHour * this.windowMs) / HOUR_MS;
  }

  private touch(now: number): void {
    if (this.start === undefined && Number.isFinite(now)) this.start = now;
  }

  private add(ts: number): void {
    if (!Number.isFinite(ts)) return;
    const a = this.entries;
    if (a.length === 0 || a[a.length - 1] <= ts) a.push(ts);
    else {
      let i = a.length;
      while (i > 0 && a[i - 1] > ts) i--;
      a.splice(i, 0, ts);
    }
    if (this.lastEntryTs === undefined || ts > this.lastEntryTs) this.lastEntryTs = ts;
  }

  /** windowMs より古い記録を捨てる */
  private prune(now: number): void {
    if (!Number.isFinite(now)) return;
    let k = 0;
    if (this.calendar) {
      // 取引時間で windowMs 以上前のエントリーを捨てる
      while (k < this.entries.length && this.entries[k] <= now && this.elapsed(this.entries[k], now) >= this.windowMs) k++;
    } else {
      const cut = now - this.windowMs;
      while (k < this.entries.length && this.entries[k] <= cut) k++;
    }
    if (k > 0) this.entries.splice(0, k);
  }

  /**
   * エントリーを記録する。エンジンは新しいポジションを実際に登録したとき (成行・指値の約定、一部約定、照会での確定) に
   * 1 ポジションにつき 1 回だけ呼ぶ (PositionManager の onOpened。発注しただけでは呼ばない)
   */
  recordEntry(ts: number): void {
    if (!Number.isFinite(ts)) return;
    this.touch(ts);
    this.add(ts);
    this.prune(Math.max(ts, this.lastEntryTs ?? ts));
  }

  /** 過去のエントリーの時刻を取り込む (再起動時に取引の記録から復元する)。非有限の値は無視 */
  seed(timestamps: readonly number[]): void {
    const valid = timestamps.filter((t) => Number.isFinite(t));
    if (valid.length === 0) return;
    for (const t of valid) this.add(t);
    this.touch(Math.min(...valid));
  }

  /** 窓 (now - windowMs, now] のエントリー数 */
  private countAt(now: number): number {
    this.prune(now);
    let n = 0;
    for (const t of this.entries) if (t <= now) n++;
    return n;
  }

  /** capped になるエントリー数 */
  private get capAt(): number {
    return this.enabled ? Math.ceil(this.targetInWindow * this.capMultiplier) : Infinity;
  }

  /** 0〜1 のテンポ (無効なら常に 0) */
  level(now: number): number {
    if (!this.enabled || !Number.isFinite(now)) return 0;
    this.touch(now);
    const n = this.countAt(now);
    const target = this.targetInWindow;
    const deficit = clamp01(1 - n / target);
    if (deficit === 0) return 0;
    const interval = 60 / this.targetPerHour;
    const ref = this.lastEntryTs ?? this.start ?? now;
    const since = this.elapsed(ref, now) / MIN_MS;
    const wait = clamp01((since - interval) / interval);
    return clamp01(deficit * wait);
  }

  /** 窓の中のエントリーが多すぎるか (無効なら常に false) */
  capped(now: number): boolean {
    if (!this.enabled || !Number.isFinite(now)) return false;
    this.touch(now);
    return this.countAt(now) >= this.capAt;
  }

  snapshot(now: number): TempoSnapshot {
    const tempo = this.level(now);
    const capped = this.capped(now);
    const entriesInWindow = Number.isFinite(now) ? this.countAt(now) : this.entries.length;
    return {
      target: this.targetPerHour,
      targetInWindow: this.targetInWindow,
      intervalMin: this.enabled ? 60 / this.targetPerHour : Infinity,
      entriesInWindow,
      capAt: this.capAt,
      tempo,
      capped,
      minutesSinceLastEntry: this.lastEntryTs !== undefined && Number.isFinite(now) ? (now - this.lastEntryTs) / MIN_MS : null,
    };
  }
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/** ダッシュボード・status・simulate に出すテンポの状態 */
export interface TempoStatusView {
  /** テンポのモード (TARGET_ENTRIES_PER_HOUR > 0) か */
  enabled: boolean;
  /** 目標 (回/時。無効なら 0) */
  target: number;
  /** 直近 1 時間 (窓) のエントリー数 */
  entriesInWindow: number;
  /** 新規エントリーを止めるエントリー数 (無効なら null) */
  capAt: number | null;
  /** 0〜1 */
  tempo: number;
  /** 上限に達して新規エントリーを止めている */
  capped: boolean;
  /** 最後のエントリーからの経過 (分。無ければ null) */
  minutesSinceLastEntry: number | null;
  /** 探索を許すか (paper、または live で TEMPO_ALLOW_LIVE_EXPLORE=true) */
  exploreAllowed: boolean;
}

/** コントローラー (無ければテンポのモードではない) の現在の状態。決定的 (時刻は引数) */
export function tempoStatusView(tc: TempoController | undefined, now: number, exploreAllowed: boolean): TempoStatusView {
  if (!tc || !tc.enabled) {
    return { enabled: false, target: 0, entriesInWindow: 0, capAt: null, tempo: 0, capped: false, minutesSinceLastEntry: null, exploreAllowed };
  }
  const snap = tc.snapshot(now);
  return {
    enabled: true,
    target: snap.target,
    entriesInWindow: snap.entriesInWindow,
    capAt: Number.isFinite(snap.capAt) ? snap.capAt : null,
    tempo: snap.tempo,
    capped: snap.capped,
    minutesSinceLastEntry: snap.minutesSinceLastEntry,
    exploreAllowed,
  };
}

/**
 * 再起動時にコントローラーへ取り込むエントリー時刻: 決済済みの取引のうち (now - windowMs, now] にエントリーしたものと、
 * 保有中のポジションのエントリー時刻 (窓より古くても「最後のエントリー」の基準になる)。非有限・未来の時刻は除く
 */
export function tempoSeedTimestamps(
  closedEntryTs: readonly number[],
  openEntryTs: readonly number[],
  now: number,
  windowMs: number = HOUR_MS,
): number[] {
  const since = now - windowMs;
  return [
    ...closedEntryTs.filter((t) => Number.isFinite(t) && t > since && t <= now),
    ...openEntryTs.filter((t) => Number.isFinite(t) && t <= now),
  ];
}

/** 1 行の表示: 目標 n 回/時・直近 1 時間 n 回・テンポ x.xx・上限到達・探索 可/不可・最大保有 n 分 */
export function formatTempoLine(v: TempoStatusView, maxHoldMinutes: number): string {
  const hold = maxHoldMinutes > 0 ? `最大保有 ${+maxHoldMinutes.toFixed(1)} 分` : "最大保有 無効";
  if (!v.enabled) return `テンポ: 無効 (TARGET_ENTRIES_PER_HOUR=0)・${hold}`;
  const since = v.minutesSinceLastEntry === null ? "" : ` (最後のエントリーから ${v.minutesSinceLastEntry.toFixed(0)} 分)`;
  return (
    `テンポ: 目標 ${+v.target.toFixed(2)} 回/時・直近 1 時間 ${v.entriesInWindow} 回${since}・テンポ ${v.tempo.toFixed(2)}・` +
    `${v.capped ? `上限到達 (${v.capAt} 回)` : `上限 ${v.capAt ?? "-"} 回`}・探索 ${v.exploreAllowed ? "可" : "不可"}・${hold}`
  );
}
