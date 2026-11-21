/** 時刻 (ms) を値に持つ Map から、maxAgeMs より古いエントリを削除する (間引き用キャッシュの肥大化防止) */
export function sweepOld(map: Map<string, number>, now: number, maxAgeMs: number): void {
  for (const [k, ts] of map) {
    if (now - ts > maxAgeMs) map.delete(k);
  }
}

export interface TerminalMapOptions<V> {
  /** 確定済み (これ以上変化しない) の値か。false のものは絶対に削除しない */
  isTerminal: (v: V) => boolean;
  maxEntries?: number;
  maxAgeMs?: number;
  now?: () => number;
  /** 削除されたキー (関連する別 Map の掃除用) */
  onEvict?: (key: string) => void;
}

/**
 * 注文結果などの冪等性キャッシュ。確定済みのエントリだけを、件数上限 (古い順) と保持時間で削除する。
 * 未確定 (open など) のエントリは件数・時間にかかわらず残す (二重発注防止)。
 * Map の API はそのまま使える (set 時に削除を判定する)。
 */
export class TerminalMap<V> extends Map<string, V> {
  private readonly ts = new Map<string, number>();
  private lastPrune = 0;
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private readonly clockFn: () => number;

  constructor(private readonly opt: TerminalMapOptions<V>) {
    super();
    this.maxEntries = opt.maxEntries ?? 2000;
    this.maxAgeMs = opt.maxAgeMs ?? 24 * 3_600_000;
    this.clockFn = opt.now ?? Date.now;
  }

  override set(key: string, value: V): this {
    super.set(key, value);
    // 更新のたびに時刻を更新 (挿入順も末尾へ) する
    this.ts.delete(key);
    this.ts.set(key, this.clockFn());
    this.maybePrune();
    return this;
  }

  override delete(key: string): boolean {
    this.ts.delete(key);
    return super.delete(key);
  }

  override clear(): void {
    this.ts.clear();
    super.clear();
  }

  private maybePrune(): void {
    const now = this.clockFn();
    if (this.size <= this.maxEntries && now - this.lastPrune < 10 * 60_000) return;
    this.prune(now);
  }

  /** 削除した件数を返す */
  prune(now = this.clockFn()): number {
    this.lastPrune = now;
    let removed = 0;
    let over = this.size - this.maxEntries;
    for (const [k, t] of this.ts) {
      const v = super.get(k);
      if (v === undefined || !this.opt.isTerminal(v)) continue;
      if (now - t > this.maxAgeMs || over > 0) {
        super.delete(k);
        this.ts.delete(k);
        this.opt.onEvict?.(k);
        removed++;
        over--;
      }
    }
    return removed;
  }
}

/** 注文結果が確定済みか (open / partially_filled は未確定) */
export function isTerminalOrder(r: { status: string }): boolean {
  return r.status === "filled" || r.status === "canceled" || r.status === "rejected";
}
