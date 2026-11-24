// プロセス間のファイルロック (Linux / Windows 共通)
//
// ブラウザ操作・収集 (collect / enter / run) を、CLI の定期実行と MCP サーバーの間で排他する。
// - fs.openSync(path, "wx") で排他的に作成し、pid・開始時刻などを JSON で書く
// - 保持中は一定間隔で mtime を更新 (ハートビート)。長時間の run でも奪われないようにする
// - 保持プロセスが存在しない、または最終更新から staleMs (既定 2 時間) を超えたら stale として奪取する
// - 取得できなければ LockBusyError を即座に投げる (待たない)
// - 解放は release()。保険としてプロセス終了 (exit) と SIGINT / SIGTERM / SIGBREAK でも解放する
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, utimesSync, writeSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export const DEFAULT_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000;

export interface LockInfo {
  pid: number;
  host: string;
  /** 何の処理か (collect / enter / run など) */
  purpose: string;
  startedAt: string;
  token: string;
}

export class LockBusyError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holder: LockInfo | null,
  ) {
    const who = holder ? `${holder.purpose} / pid ${holder.pid} / 開始 ${holder.startedAt}` : "詳細不明";
    super(`他の処理が実行中です (${who})。完了してから再実行してください`);
    this.name = "LockBusyError";
  }
}

export interface LockOptions {
  purpose?: string;
  /** 最終更新からこの時間を超えたロックは stale とみなす */
  staleMs?: number;
  /** mtime を更新する間隔。0 で無効 */
  heartbeatMs?: number;
  now?: () => Date;
  /** プロセスの生存確認 (テスト用に差し替え可) */
  isAlive?: (pid: number) => boolean;
}

export interface LockHandle {
  readonly path: string;
  readonly info: LockInfo;
  /** 冪等。自分のロックのときだけファイルを消す */
  release(): void;
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // シグナル 0 は存在確認のみ (Windows でも可)
    return true;
  } catch (e) {
    // EPERM: 存在するが権限がない
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): { info: LockInfo | null; raw: string; mtimeMs: number } | null {
  try {
    const raw = readFileSync(path, "utf8");
    const mtimeMs = statSync(path).mtimeMs;
    let info: LockInfo | null = null;
    try {
      const v = JSON.parse(raw) as Partial<LockInfo>;
      if (v && typeof v.pid === "number" && typeof v.token === "string") info = v as LockInfo;
    } catch {
      info = null; // 書き込み途中 or 壊れている
    }
    return { info, raw, mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 終了時の解放 (保持中のロックがあるときだけハンドラを登録)
// ---------------------------------------------------------------------------

const held = new Set<LockHandle>();
const SIGNALS: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
const SIGNAL_CODE: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGBREAK: 21 };

function releaseAll(): void {
  for (const h of [...held]) h.release();
}

const onExit = () => releaseAll();
const onSignal = (sig: NodeJS.Signals) => {
  releaseAll();
  // 他にハンドラがなければ既定の動作 (終了) を再現する。MCP サーバーなど独自の終了処理がある場合は任せる
  if (process.listenerCount(sig) === 0) process.exit(128 + (SIGNAL_CODE[sig] ?? 1));
};

function installHandlers(): void {
  process.on("exit", onExit);
  for (const s of SIGNALS) process.on(s, onSignal);
}

function removeHandlers(): void {
  process.off("exit", onExit);
  for (const s of SIGNALS) process.off(s, onSignal);
}

// onSignal 内の listenerCount は自分を外した後に数えたいので、解放時にハンドラを外す
function track(h: LockHandle): void {
  if (held.size === 0) installHandlers();
  held.add(h);
}

function untrack(h: LockHandle): void {
  held.delete(h);
  if (held.size === 0) removeHandlers();
}

// ---------------------------------------------------------------------------

/**
 * ロックを取得する。取得できなければ LockBusyError (待たない)。
 * 同じプロセス内でも二重取得はできない (再入不可)。入れ子にしないこと。
 */
export function acquireLock(path: string, opts: LockOptions = {}): LockHandle {
  const now = opts.now ?? (() => new Date());
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const isAlive = opts.isAlive ?? processAlive;
  mkdirSync(dirname(path), { recursive: true });

  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    purpose: opts.purpose ?? "browser",
    startedAt: now().toISOString(),
    token: randomUUID(),
  };
  const body = JSON.stringify(info);

  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const cur = readLock(path);
      if (!cur) continue; // 直前に解放された
      const age = now().getTime() - cur.mtimeMs;
      const otherHost = cur.info !== null && cur.info.host !== info.host;
      const dead = cur.info !== null && !otherHost && !isAlive(cur.info.pid);
      // 内容が読めない (書き込み途中など) ものは、時間切れまでは保持中とみなす
      const stale = dead || age > staleMs;
      if (!stale) throw new LockBusyError(path, cur.info);
      // 判定後に別プロセスが奪取していないか確認してから消す
      const again = readLock(path);
      if (again && again.raw === cur.raw) {
        try {
          unlinkSync(path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      continue;
    }
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }

    let released = false;
    let timer: NodeJS.Timeout | undefined;
    const handle: LockHandle = {
      path,
      info,
      release() {
        if (released) return;
        released = true;
        if (timer) clearInterval(timer);
        untrack(handle);
        const cur = readLock(path);
        if (cur?.info?.token === info.token) {
          try {
            unlinkSync(path);
          } catch {
            // 既に消えている・消せない場合は stale 判定に任せる
          }
        }
      },
    };
    if (heartbeatMs > 0) {
      timer = setInterval(() => {
        try {
          const t = now();
          utimesSync(path, t, t);
        } catch {
          // 無視 (次回の更新で再試行)
        }
      }, heartbeatMs);
      timer.unref();
    }
    track(handle);
    return handle;
  }
  throw new LockBusyError(path, readLock(path)?.info ?? null);
}

/** ロックを取得して fn を実行し、終了後 (例外時も) に解放する */
export async function withLock<T>(path: string, opts: LockOptions, fn: () => Promise<T>): Promise<T> {
  const h = acquireLock(path, opts);
  try {
    return await fn();
  } finally {
    h.release();
  }
}
