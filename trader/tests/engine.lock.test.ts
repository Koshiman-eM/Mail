import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireEngineLock, ENGINE_LOCK_HEARTBEAT_MS, engineLockKey, heartbeatEngineLock, releaseEngineLock, startEngineLockHeartbeat,
} from "../src/engine/lock";
import { MemoryStore } from "../src/storage/memory";

describe("エンジンの二重起動防止ロック (kv engine:lock:<mode>)", () => {
  afterEach(() => vi.useRealTimers());

  it("取得・heartbeat・解放 (自分のロックだけを更新・削除する)", () => {
    const store = new MemoryStore();
    const r = acquireEngineLock(store, "live", { now: 1_000, pid: 11, hostname: "h1" });
    expect(r.ok).toBe(true);
    const owner = { pid: 11, hostname: "h1", startedAt: 1_000 };
    expect(acquireEngineLock(store, "live", { now: 50_000, pid: 22, hostname: "h2" })).toMatchObject({ ok: false, holder: { pid: 11 } });
    expect(heartbeatEngineLock(store, "live", owner, 55_000)).toBe(true);
    expect(store.kvGet(engineLockKey("live"))).toMatchObject({ heartbeatAt: 55_000, startedAt: 1_000 });
    // heartbeat が更新されていれば 60 秒を過ぎても (起動から) 奪取されない
    expect(acquireEngineLock(store, "live", { now: 100_000, pid: 22, hostname: "h2" }).ok).toBe(false);
    // 別の持ち主は更新・削除できない
    const other = { pid: 22, hostname: "h2", startedAt: 1_000 };
    expect(heartbeatEngineLock(store, "live", other, 56_000)).toBe(false);
    expect(releaseEngineLock(store, "live", other)).toBe(false);
    expect(releaseEngineLock(store, "live", owner)).toBe(true);
    expect(store.kvGet(engineLockKey("live"))).toBeUndefined();
  });

  it("古いロックは奪取し、元の持ち主の heartbeat は失敗 (ロックを失った) になる", () => {
    const store = new MemoryStore();
    acquireEngineLock(store, "paper", { now: 0, pid: 1, hostname: "a" });
    const r = acquireEngineLock(store, "paper", { now: 60_001, pid: 2, hostname: "b" });
    expect(r).toMatchObject({ ok: true, stolen: { pid: 1 } });
    expect(store.listAudit({ type: "engine.lock_stolen" })[0].data).toMatchObject({ mode: "paper", previous: { pid: 1 } });
    expect(heartbeatEngineLock(store, "paper", { pid: 1, hostname: "a", startedAt: 0 }, 60_002)).toBe(false);
  });

  it("書き込みはトランザクションの中で行う", () => {
    const store = new MemoryStore();
    const spy = vi.spyOn(store, "transaction");
    acquireEngineLock(store, "live", { now: 0 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("heartbeat は 15 秒ごと。奪取されたら onLost、例外は 3 回続いたら onLost", () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    acquireEngineLock(store, "live", { now: 0, pid: 1, hostname: "a" });
    const owner = { pid: 1, hostname: "a", startedAt: 0 };
    let t = 0;
    const onLost = vi.fn();
    const onError = vi.fn();
    const hb = startEngineLockHeartbeat(store, "live", owner, { now: () => t, onLost, onError });
    t = 15_000;
    vi.advanceTimersByTime(ENGINE_LOCK_HEARTBEAT_MS);
    expect(store.kvGet(engineLockKey("live"))).toMatchObject({ heartbeatAt: 15_000 });
    const orig = store.kvGet.bind(store);
    const kvGet = vi.spyOn(store, "kvGet").mockImplementation(() => {
      throw new Error("database is locked");
    });
    vi.advanceTimersByTime(2 * ENGINE_LOCK_HEARTBEAT_MS);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onLost).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ENGINE_LOCK_HEARTBEAT_MS);
    expect(onLost).toHaveBeenCalledTimes(1);
    kvGet.mockRestore();
    void orig;
    hb.stop();

    // 奪取された場合はすぐに onLost
    const store2 = new MemoryStore();
    acquireEngineLock(store2, "live", { now: 0, pid: 1, hostname: "a" });
    const lost2 = vi.fn();
    const hb2 = startEngineLockHeartbeat(store2, "live", owner, { now: () => 61_000, onLost: lost2 });
    acquireEngineLock(store2, "live", { now: 61_000, pid: 9, hostname: "z" });
    vi.advanceTimersByTime(ENGINE_LOCK_HEARTBEAT_MS);
    expect(lost2).toHaveBeenCalledTimes(1);
    expect(lost2.mock.calls[0][0]).toMatch(/奪取/);
    hb2.stop();
  });
  it("同じホストで記録された pid が既に無いなら、heartbeat が新しくても奪取する (異常終了直後の再起動)", () => {
    const store = new MemoryStore();
    acquireEngineLock(store, "paper", { now: 1_000, pid: 11, hostname: "h1" });
    // 生きている: 起動しない
    expect(acquireEngineLock(store, "paper", { now: 5_000, pid: 22, hostname: "h1", isPidAlive: () => true }).ok).toBe(false);
    // 死んでいる: 奪取
    const r = acquireEngineLock(store, "paper", { now: 6_000, pid: 22, hostname: "h1", isPidAlive: () => false });
    expect(r.ok).toBe(true);
    // 自分の pid の再利用 (コンテナ再起動で同じ pid) も奪取
    const r2 = acquireEngineLock(store, "paper", { now: 7_000, pid: 22, hostname: "h1", isPidAlive: () => true });
    expect(r2.ok).toBe(true);
    // 別ホストの pid は確かめられないので従来どおり heartbeat で判定
    expect(acquireEngineLock(store, "paper", { now: 8_000, pid: 33, hostname: "h2", isPidAlive: () => false }).ok).toBe(false);
  });
});
