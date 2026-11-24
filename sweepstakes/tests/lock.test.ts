// プロセス間ファイルロック・タイムゾーン境界・Windows 向けファイル置換のテスト (ネットワークアクセスなし)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Collector } from "../src/core/collector.js";
import { loadConfig } from "../src/core/config.js";
import { startOfDayInTimeZone } from "../src/core/guards.js";
import { acquireLock, DEFAULT_LOCK_STALE_MS, LockBusyError, withLock, type LockHandle } from "../src/core/lock.js";
import { collect, enter, runAll, type SweepContext } from "../src/core/service.js";
import { JobManager } from "../src/mcp/jobs.js";
import { fileProfileStore, replaceFileSync } from "../src/mcp/profileStore.js";
import { addCampaign, makeTestContext } from "./helpers/context.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmpLock = () => join(mkdtempSync(join(tmpdir(), "sweep-locktest-")), "sub", "browser.lock");
const handles: LockHandle[] = [];
const hold = (path: string, opts = {}) => {
  const h = acquireLock(path, { heartbeatMs: 0, ...opts });
  handles.push(h);
  return h;
};

afterEach(() => {
  for (const h of handles.splice(0)) h.release();
});

describe("acquireLock", () => {
  it("作成時に pid と開始時刻を書き、二重取得は LockBusyError、解放後は再取得できる", () => {
    const path = tmpLock();
    const h = hold(path, { purpose: "run" });
    const info = JSON.parse(readFileSync(path, "utf8"));
    expect(info.pid).toBe(process.pid);
    expect(info.purpose).toBe("run");
    expect(typeof info.startedAt).toBe("string");

    let err: unknown;
    try {
      acquireLock(path, { heartbeatMs: 0 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LockBusyError);
    expect((err as Error).message).toContain("他の処理が実行中");
    expect((err as LockBusyError).holder?.purpose).toBe("run");

    h.release();
    expect(existsSync(path)).toBe(false);
    h.release(); // 冪等
    hold(path);
    expect(existsSync(path)).toBe(true);
  });

  it("保持プロセスが存在しなければ stale として奪取する", () => {
    const path = tmpLock();
    hold(path).release();
    writeFileSync(path, JSON.stringify({ pid: 2_000_000_000, host: "x", purpose: "run", startedAt: "2026-01-01T00:00:00Z", token: "old" }));
    // host が違うと pid の生存確認はしない → 新しいので busy
    expect(() => acquireLock(path, { heartbeatMs: 0 })).toThrow(LockBusyError);
    const info = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...info, host: hostname() }));
    const h = hold(path);
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(h.info.token);
  });

  it("プロセスが生きていても最終更新から staleMs を超えたら奪取する", () => {
    const path = tmpLock();
    const old = hold(path);
    const past = new Date(Date.now() - DEFAULT_LOCK_STALE_MS - 60_000);
    utimesSync(path, past, past);
    const h = hold(path);
    expect(h.info.token).not.toBe(old.info.token);
    // 奪われた側の release は他人のロックを消さない
    old.release();
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(h.info.token);
  });

  it("内容が読めない (書き込み途中など) ロックは時間切れまで保持中とみなす", () => {
    const path = tmpLock();
    hold(path).release();
    writeFileSync(path, "");
    expect(() => acquireLock(path, { heartbeatMs: 0, isAlive: () => false })).toThrow(LockBusyError);
    const past = new Date(Date.now() - DEFAULT_LOCK_STALE_MS - 1);
    utimesSync(path, past, past);
    expect(() => hold(path)).not.toThrow();
  });

  it("ハートビートで mtime を更新する", async () => {
    const path = tmpLock();
    const h = hold(path, { heartbeatMs: 20 });
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(path, past, past);
    await new Promise((r) => setTimeout(r, 80));
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(10_000);
    h.release();
  });

  it("withLock は例外時も解放する", async () => {
    const path = tmpLock();
    await expect(withLock(path, { heartbeatMs: 0 }, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(existsSync(path)).toBe(false);
  });

  it("プロセスが解放せずに終了しても exit ハンドラで消える / SIGINT でも消える", async () => {
    const lockUrl = pathToFileURL(join(ROOT, "src/core/lock.ts")).href;
    const run = async (body: string, signal?: NodeJS.Signals) => {
      const path = tmpLock();
      const script = `import { acquireLock } from ${JSON.stringify(lockUrl)};\nacquireLock(${JSON.stringify(path)}, { heartbeatMs: 0 });\nconsole.log("locked");\n${body}`;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (d) => String(d).includes("locked") && resolve());
        child.on("exit", () => reject(new Error(`child exited early: ${err}`)));
      });
      expect(existsSync(path)).toBe(true);
      if (signal) child.kill(signal);
      const code = await new Promise<number | null>((r) => (child.exitCode !== null ? r(child.exitCode) : child.on("exit", (c) => r(c))));
      return { path, code };
    };
    const a = await run("setTimeout(() => process.exit(3), 500);");
    expect(a.code).toBe(3);
    expect(existsSync(a.path)).toBe(false);
    if (process.platform !== "win32") {
      const b = await run("setInterval(() => {}, 1000);", "SIGINT");
      expect(b.code).toBe(130);
      expect(existsSync(b.path)).toBe(false);
    }
  }, 30_000);
});

describe("service 関数の入口でのロック", () => {
  let ctx: SweepContext;
  afterEach(() => ctx?.store.close());

  const fake = (onFetch: () => void = () => undefined): Collector => ({
    name: "fake",
    fetch: async () => {
      onFetch();
      return [];
    },
  });

  it("collect / enter / runAll は他プロセスが保持中なら待たずに LockBusyError", async () => {
    ctx = makeTestContext();
    const other = hold(ctx.config.lockPath!, { purpose: "run" });
    let fetched = false;
    await expect(collect(ctx, [fake(() => (fetched = true))])).rejects.toBeInstanceOf(LockBusyError);
    expect(fetched).toBe(false);
    const c = addCampaign(ctx, { url: "http://127.0.0.1:9/never" });
    await expect(enter(ctx, c.id)).rejects.toBeInstanceOf(LockBusyError);
    await expect(runAll(ctx)).rejects.toBeInstanceOf(LockBusyError);
    other.release();
    await expect(collect(ctx, [fake()])).resolves.toMatchObject({ total: 0 });
  });

  it("実行中はロックを保持し、終了後 (例外時も) に解放する", async () => {
    ctx = makeTestContext();
    const path = ctx.config.lockPath!;
    let heldDuring = false;
    await collect(ctx, [fake(() => (heldDuring = existsSync(path)))]);
    expect(heldDuring).toBe(true);
    expect(existsSync(path)).toBe(false);
    await expect(enter(ctx, 99999)).rejects.toThrow("見つかりません");
    expect(existsSync(path)).toBe(false);
  });

  it("runAll は内部の enter でロックを取り直さない (自己 busy にならない)", async () => {
    let launched = 0;
    ctx = makeTestContext({}, {
      launchBrowser: async () => {
        launched++;
        throw new Error("ブラウザは起動しない (テスト)");
      },
    });
    addCampaign(ctx, { url: "http://127.0.0.1:9/form" });
    // enterUnlocked まで到達してブラウザ起動で失敗する = ロックの二重取得で止まっていない
    await expect(runAll(ctx)).rejects.toThrow("ブラウザは起動しない");
    expect(launched).toBe(1);
    expect(existsSync(ctx.config.lockPath!)).toBe(false);
  });

  it("browserLockHeld のコンテキストはロックを取らない / lockPath=null ならロックしない", async () => {
    ctx = makeTestContext();
    const h = hold(ctx.config.lockPath!);
    await expect(collect({ ...ctx, browserLockHeld: true }, [fake()])).resolves.toMatchObject({ total: 0 });
    h.release();
    await expect(collect({ ...ctx, config: { ...ctx.config, lockPath: null } }, [fake()])).resolves.toMatchObject({ total: 0 });
  });
});

describe("JobManager の lock オプション", () => {
  it("ロック取得に失敗したらジョブを作らずに投げる。ジョブ終了時 (失敗時も) に解放する", async () => {
    const path = tmpLock();
    const jobs = new JobManager();
    const other = hold(path);
    expect(() => jobs.start("collect", async () => 1, { lock: () => acquireLock(path, { heartbeatMs: 0 }) })).toThrow(LockBusyError);
    expect(jobs.list()).toHaveLength(0);
    expect(jobs.running).toBeNull();
    other.release();

    const ok = jobs.start("collect", async () => existsSync(path), { lock: () => acquireLock(path, { heartbeatMs: 0 }) });
    await ok.done;
    expect(ok.result).toBe(true);
    expect(existsSync(path)).toBe(false);

    const ng = jobs.start("run", async () => Promise.reject(new Error("x")), { lock: () => acquireLock(path, { heartbeatMs: 0 }) });
    await ng.done;
    expect(ng.status).toBe("failed");
    expect(existsSync(path)).toBe(false);
  });

  it("プロセス内で実行中ならロック取得関数を呼ばない (JobBusyError が先)", async () => {
    const jobs = new JobManager();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = jobs.start("collect", () => gate);
    let called = false;
    expect(() => jobs.start("run", async () => 1, { lock: () => ((called = true), { release: () => undefined }) })).toThrow("実行中");
    expect(called).toBe(false);
    release();
    await first.done;
  });
});

describe("設定", () => {
  it("lockPath の既定は DB と同じディレクトリ、SWEEP_LOCK_PATH で上書き", () => {
    const c = loadConfig({ SWEEP_DB: join(tmpdir(), "a", "sweep.db") });
    expect(c.lockPath).toBe(join(tmpdir(), "a", "browser.lock"));
    expect(loadConfig({ SWEEP_LOCK_PATH: join(tmpdir(), "l.lock") }).lockPath).toBe(join(tmpdir(), "l.lock"));
  });

  it("タイムゾーンの既定は Asia/Tokyo、不正値はエラー", () => {
    expect(loadConfig({}).timeZone).toBe("Asia/Tokyo");
    expect(loadConfig({ SWEEP_TIMEZONE: "UTC" }).timeZone).toBe("UTC");
    expect(() => loadConfig({ SWEEP_TIMEZONE: "Mars/Base" })).toThrow("SWEEP_TIMEZONE");
  });
});

describe("startOfDayInTimeZone", () => {
  it("OS のタイムゾーンに関係なく日本時間の 0 時を返す", () => {
    // JST 2026-11-21 00:30 = UTC 2026-11-20 15:30
    expect(startOfDayInTimeZone(new Date("2026-11-20T15:30:00Z"), "Asia/Tokyo").toISOString()).toBe("2026-11-20T15:00:00.000Z");
    // JST 2026-11-20 23:59 = UTC 14:59 → 前日 0 時 (JST)
    expect(startOfDayInTimeZone(new Date("2026-11-20T14:59:59Z"), "Asia/Tokyo").toISOString()).toBe("2026-11-19T15:00:00.000Z");
    expect(startOfDayInTimeZone(new Date("2026-11-20T15:00:00Z"), "Asia/Tokyo").toISOString()).toBe("2026-11-20T15:00:00.000Z");
    expect(startOfDayInTimeZone(new Date("2026-11-20T14:59:59Z"), "UTC").toISOString()).toBe("2026-11-20T00:00:00.000Z");
  });

  it("夏時間のある地域でも当日 0 時になる", () => {
    // 2026-03-08 は米国の夏時間開始日 (0 時時点は EST = UTC-5)
    expect(startOfDayInTimeZone(new Date("2026-03-08T20:00:00Z"), "America/New_York").toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });
});

describe("replaceFileSync (Windows の一時的な rename 失敗対策)", () => {
  const errno = (code: string) => Object.assign(new Error(code), { code });

  it("EPERM / EBUSY は再試行して成功する", () => {
    let n = 0;
    replaceFileSync("a", "b", {
      retries: 3,
      delayMs: 1,
      rename: () => {
        if (n++ < 2) throw errno(n === 1 ? "EPERM" : "EBUSY");
      },
    });
    expect(n).toBe(3);
  });

  it("再試行しても失敗したら一時ファイルを消して投げる。再試行対象外のエラーは即座に投げる", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-rename-"));
    const tmp = join(dir, "t.tmp");
    writeFileSync(tmp, "x");
    let n = 0;
    expect(() => replaceFileSync(tmp, join(dir, "p.json"), { retries: 2, delayMs: 1, rename: () => (n++, (() => { throw errno("EACCES"); })()) })).toThrow("EACCES");
    expect(n).toBe(3);
    expect(existsSync(tmp)).toBe(false);
    writeFileSync(tmp, "x");
    n = 0;
    expect(() => replaceFileSync(tmp, join(dir, "p.json"), { retries: 5, rename: () => (n++, (() => { throw errno("ENOENT"); })()) })).toThrow("ENOENT");
    expect(n).toBe(1);
  });

  it("fileProfileStore は既存ファイルを上書きできる", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-profile-"));
    const store = fileProfileStore(join(dir, "profile.json"));
    store.write({ lastName: "山田" });
    store.write({ lastName: "佐藤" });
    expect(store.read()).toEqual({ lastName: "佐藤" });
  });
});
