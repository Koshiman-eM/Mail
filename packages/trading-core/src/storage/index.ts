import type { Store } from "../core/types";
import { MemoryStore } from "./memory";
import { SqliteStore } from "./sqlite";

export { MemoryStore } from "./memory";
export { SqliteStore } from "./sqlite";

/** パスから Store を作る。"memory" ならメモリ実装、それ以外 (":memory:" 含む) は SQLite */
export function createStore(path: string): Store {
  return path === "memory" ? new MemoryStore() : new SqliteStore(path);
}
