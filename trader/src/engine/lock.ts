import { hostname as osHostname } from "node:os";
import { redactSecrets } from "../core/http";
import type { Store, TradingMode } from "../core/types";

/**
 * 同じ mode のエンジンの二重起動防止 (DB の kv `engine:lock:<mode>`)。
 * 起動時に既存のロックの heartbeat が staleMs 以内なら起動しない。古ければ奪取する (ログ・監査ログに記録)。
 * 動作中は heartbeatMs ごとに heartbeat を更新し、停止時に削除する。kv の読み書きはトランザクションで行う。
 */

export const ENGINE_LOCK_PREFIX = "engine:lock";
export const engineLockKey = (mode: TradingMode) => `${ENGINE_LOCK_PREFIX}:${mode}`;
/** heartbeat の更新間隔 */
export const ENGINE_LOCK_HEARTBEAT_MS = 15_000;
/** これより古い heartbeat のロックは停止したエンジンのものとみなして奪取する */
export const ENGINE_LOCK_STALE_MS = 60_000;

export interface EngineLock {
  pid: number;
  hostname: string;
  startedAt: number;
  heartbeatAt: number;
}

export interface LockOwner {
  pid: number;
  hostname: string;
  startedAt: number;
}

export type AcquireResult =
  | { ok: true; lock: EngineLock; stolen?: EngineLock }
  | { ok: false; holder: EngineLock; message: string };

const tx = <T>(store: Store, fn: () => T): T => (store.transaction ? store.transaction(fn) : fn());

const isLock = (v: unknown): v is EngineLock => {
  const l = v as EngineLock;
  return Boolean(l) && typeof l === "object" && typeof l.pid === "number" && typeof l.hostname === "string" &&
    typeof l.startedAt === "number" && typeof l.heartbeatAt === "number";
};

const sameOwner = (a: LockOwner, b: LockOwner) => a.pid === b.pid && a.hostname === b.hostname && a.startedAt === b.startedAt;

/** 同じホスト上で pid のプロセスが生きているか (権限不足 EPERM は「生きている」とみなす) */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** ロックを取得する。同じ mode のエンジンが動いていれば (heartbeat が staleMs 以内) ok: false */
export function acquireEngineLock(
  store: Store,
  mode: TradingMode,
  o: { now: number; pid?: number; hostname?: string; staleMs?: number; isPidAlive?: (pid: number) => boolean },
): AcquireResult {
  const key = engineLockKey(mode);
  const staleMs = o.staleMs ?? ENGINE_LOCK_STALE_MS;
  const lock: EngineLock = { pid: o.pid ?? process.pid, hostname: o.hostname ?? osHostname(), startedAt: o.now, heartbeatAt: o.now };
  return tx(store, () => {
    const cur = store.kvGet<unknown>(key);
    if (isLock(cur)) {
      const age = o.now - cur.heartbeatAt;
      // 同じホストで、記録された pid のプロセスが既に無い (または自分自身の pid の再利用) なら、
      // 異常終了の残骸なので heartbeat が新しくても奪取する (systemd の即時再起動で起動不能にならないように)
      const deadOnThisHost =
        cur.hostname === lock.hostname && (cur.pid === lock.pid || !(o.isPidAlive ?? pidAlive)(cur.pid));
      // 時計の巻き戻り (age < 0) も「動いている」側に倒す
      if (age <= staleMs && !deadOnThisHost) {
        return {
          ok: false as const,
          holder: cur,
          message: `同じ mode (${mode}) のエンジンが動いています (pid ${cur.pid}, host ${cur.hostname}, 最終 heartbeat ${Math.round(age / 1000)} 秒前)`,
        };
      }
      store.kvSet(key, lock);
      store.audit({ ts: o.now, type: "engine.lock_stolen", data: { mode, previous: cur, staleMs: age, pid: lock.pid, hostname: lock.hostname } });
      return { ok: true as const, lock, stolen: cur };
    }
    store.kvSet(key, lock);
    return { ok: true as const, lock };
  });
}

/** heartbeat を更新する。ロックが自分のものでなくなっていたら false (別のエンジンに奪取された) */
export function heartbeatEngineLock(store: Store, mode: TradingMode, owner: LockOwner, now: number): boolean {
  const key = engineLockKey(mode);
  return tx(store, () => {
    const cur = store.kvGet<unknown>(key);
    if (!isLock(cur) || !sameOwner(cur, owner)) return false;
    store.kvSet(key, { ...cur, heartbeatAt: now });
    return true;
  });
}

/** ロックを削除する (自分のものだけ)。削除したら true */
export function releaseEngineLock(store: Store, mode: TradingMode, owner: LockOwner): boolean {
  const key = engineLockKey(mode);
  return tx(store, () => {
    const cur = store.kvGet<unknown>(key);
    if (!isLock(cur) || !sameOwner(cur, owner)) return false;
    store.kvSet(key, undefined);
    return true;
  });
}

/** heartbeat の更新の例外がこの回数続いたらロックを失ったものとして扱う (stale 判定の 60 秒より前に止まる) */
export const ENGINE_LOCK_MAX_HEARTBEAT_ERRORS = 3;

/**
 * heartbeat を intervalMs ごとに更新する。ロックが自分のものでなくなった、または更新の例外が
 * ENGINE_LOCK_MAX_HEARTBEAT_ERRORS 回続いたら onLost を 1 回呼ぶ (一時的な例外は onError で知らせて再試行する)。
 * 戻り値の stop() でタイマーを止める (ロックは消さない。releaseEngineLock を別に呼ぶ)
 */
export function startEngineLockHeartbeat(
  store: Store,
  mode: TradingMode,
  owner: LockOwner,
  o: { now: () => number; intervalMs?: number; onLost: (reason: string) => void; onError?: (message: string, failures: number) => void },
): { stop(): void; beat(): void } {
  let lost = false;
  let failures = 0;
  const beat = () => {
    if (lost) return;
    let ok: boolean;
    try {
      ok = heartbeatEngineLock(store, mode, owner, o.now());
      failures = 0;
    } catch (e) {
      failures++;
      const msg = redactSecrets(e instanceof Error ? e.message : String(e));
      o.onError?.(msg, failures);
      if (failures < ENGINE_LOCK_MAX_HEARTBEAT_ERRORS) return;
      lost = true;
      o.onLost(`heartbeat の更新に ${failures} 回連続で失敗しました (${msg})`);
      return;
    }
    if (!ok) {
      lost = true;
      o.onLost("ロックが別のエンジンに奪取されました (heartbeat が遅れた可能性があります)");
    }
  };
  const timer = setInterval(beat, o.intervalMs ?? ENGINE_LOCK_HEARTBEAT_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer), beat };
}
