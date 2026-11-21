/**
 * テスト用の runtime (アプリ・コアの試験で使う。ネット不要): 合成フィード (SyntheticFeed) + paper + MemoryStore + 仮想時計を
 * assembleRuntime で組み立てる。情報源・AI なし。設定はコアの環境変数だけ (アプリの設定を渡すこともできる)
 */
import { defineAppConfig, type AppConfig } from "../core/config";
import { enabledAssetClasses } from "../core/assetClasses";
import type { Clock } from "../core/types";
import { ClosedCandleCacheFeed } from "../engine/feedCache";
import { assembleRuntime, type AssembleOptions, type Runtime, type RuntimeAssembly } from "../engine/runtime";
import { defaultSyntheticSpecs, mulberry32, SyntheticFeed } from "../market/feeds/synthetic";
import { MemoryStore } from "../storage/memory";

export type TestClock = Clock & { t: number };

export interface TestRuntimeOptions {
  /** 合成フィードの銘柄 (既定 defaultSyntheticSpecs: BTC/USDT・ETH/USDT・PEPE/USDT) */
  specs?: ReturnType<typeof defaultSyntheticSpecs>;
  /** コアの環境変数 (NODE_ENV=test・DB_PATH=memory に足す) */
  env?: Record<string, string>;
  /** 設定 (渡せば env より優先。アプリの設定を使う試験) */
  config?: AppConfig;
  /** 開始時刻 (既定 2026-01-05 00:00 UTC) */
  start?: number;
  seed?: number;
  /** 合成フィードの履歴 (既定 2 日) */
  historyMs?: number;
  /** アプリの部品 (calendar・holdingCost・venueLeverageCaps・createLiveBrokers など。markets は合成フィード) */
  assembly?: Omit<RuntimeAssembly, "markets">;
  /** 組み立ての上書き (strategies・brokerSet・engine など) */
  opts?: AssembleOptions;
}

let coreTestDefinition: ReturnType<typeof defineAppConfig<{}>> | undefined;

/** コアの環境変数だけの設定 (アプリが選んだ資産クラス。未設定なら語彙の全部)。source をそのまま解析する */
export function coreConfig(source: Record<string, string | undefined> = {}): AppConfig {
  coreTestDefinition ??= defineAppConfig({ assetClasses: enabledAssetClasses(), shape: {} });
  return coreTestDefinition.loadConfig(source);
}

/** 既定値のリスク上限 (コアの環境変数の既定) */
export const coreDefaultRisk = () => coreConfig({}).risk;

/** テスト用の設定 (NODE_ENV=test・DB_PATH=memory・成行のエントリーに env を重ねる) */
export function testConfig(env: Record<string, string> = {}): AppConfig {
  return coreConfig({ NODE_ENV: "test", DB_PATH: "memory", LIMIT_ENTRY: "false", ...env });
}

/** 合成フィード + paper の runtime と仮想時計 */
export async function buildTestRuntime(o: TestRuntimeOptions = {}): Promise<{ runtime: Runtime; clock: TestClock; store: MemoryStore }> {
  const seed = o.seed ?? 3;
  const clock: TestClock = { t: o.start ?? Date.UTC(2026, 0, 5), now() { return this.t; } };
  const store = (o.opts?.store as MemoryStore | undefined) ?? new MemoryStore();
  const feed = new ClosedCandleCacheFeed(
    new SyntheticFeed({ seed, clock, historyMs: o.historyMs ?? 2 * 86_400_000, ...(o.specs ? { specs: o.specs } : {}) }),
    { clock },
  );
  const instruments = await feed.listInstruments();
  const runtime = await assembleRuntime(o.config ?? testConfig(o.env), { ...(o.assembly ?? {}), markets: [{ feed, instruments }] }, {
    clock, store, intelSources: [], ai: null, rng: mulberry32(seed ^ 0x5eed), ...(o.opts ?? {}),
  });
  return { runtime, clock, store };
}
