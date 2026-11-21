/**
 * trader の simulate: コアの runSimulation (src/engine/simulate.ts) に、trader の設定 (VENUES=synthetic・WATCHLIST なし) と
 * buildRuntime (合成フィード) を渡す
 */
import { loadConfig, type AppConfig } from "./appConfig";
import {
  assertSimulationDb as coreAssertSimulationDb, runSimulation as coreRunSimulation,
  type SimulationOptions, type SimulationRuntimeFactory,
} from "./engine/simulate";
import { buildRuntime, syntheticDbPath, type Runtime } from "./engine/setup";

export * from "./engine/simulate";

/** trader の simulate の部品 */
const TRADER_SIMULATION_FACTORY: SimulationRuntimeFactory = {
  loadConfig: (env) => loadConfig(env),
  simulationEnv: { VENUES: "synthetic", WATCHLIST: "" },
  // 実運転用の DB_PATH と、その合成データ用 (<ベース名>-synthetic.db) は使えない
  guardedDbPaths: (config) => [syntheticDbPath(config.env.DB_PATH)],
  buildRuntime: (config, opts) => buildRuntime(config as AppConfig, opts),
};

/** 合成データ + 仮想時計による高速ペーパー運転 (factory 省略時は trader の部品) */
export async function runSimulation(
  o: Omit<SimulationOptions, "factory"> & { factory?: SimulationRuntimeFactory } = {},
): Promise<Awaited<ReturnType<typeof coreRunSimulation>> & { runtime: Runtime }> {
  const r = await coreRunSimulation({ ...o, factory: o.factory ?? TRADER_SIMULATION_FACTORY });
  return r as typeof r & { runtime: Runtime };
}

/** simulate が使えない DB か (DB_PATH と合成データ用の DB は拒否) */
export function assertSimulationDb(db: string, env: Record<string, string | undefined>): void {
  coreAssertSimulationDb(TRADER_SIMULATION_FACTORY, db, env);
}
