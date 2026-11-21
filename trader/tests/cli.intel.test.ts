/** `trader intel` の IntelService: 情報源の信頼度はエンジンと同じ mode 別キーを読む (旧キーを読まない)。オフライン */
import { describe, expect, it } from "vitest";
import { createCliIntelService } from "../src/cli";
import { loadConfig, type AppConfig } from "../src/appConfig";
import type { IntelItem, SourceReliability } from "../src/core/types";
import type { IntelSource } from "../src/intel/sources/common";
import { SOURCE_RELIABILITY_KV_KEY, sourceReliabilityKey } from "../src/learning/reliability";
import { MemoryStore } from "../src/storage/memory";

const NOW = 1_800_000_000_000;
const item: IntelItem = {
  id: "1", source: "rss:a", kind: "news", title: "Bitcoin surges to record high", publishedAt: NOW - 60_000, fetchedAt: NOW, assets: ["BTC", "CRYPTO"],
};
const source: IntelSource = { id: "s", fetch: async () => [item] };
const rel = (weight: number): Record<string, SourceReliability> => ({ "rss:a": { source: "rss:a", n: 1, hits: 1, ewmaScore: 0, weight, updatedAt: NOW } });

/** kv の読み取りキーを記録する MemoryStore */
function recordingStore() {
  const store = new MemoryStore();
  const reads: string[] = [];
  const kvGet = store.kvGet.bind(store);
  store.kvGet = (<T,>(key: string) => {
    reads.push(key);
    return kvGet<T>(key);
  }) as typeof store.kvGet;
  return { store, reads };
}

async function sentimentWith(config: AppConfig, kv: Record<string, Record<string, SourceReliability>>) {
  const { store, reads } = recordingStore();
  for (const [k, v] of Object.entries(kv)) store.kvSet(k, v);
  const svc = createCliIntelService(config, store, [source]);
  const brief = await svc.refresh(NOW);
  return { sentiment: brief.biases.BTC.sentiment, reads };
}

describe("trader intel: 情報源の信頼度のキー", () => {
  const paper = loadConfig({});

  it("設定の mode (paper) のキー intel:sourceReliability:paper を読み、旧キーは読まない", async () => {
    expect(paper.mode).toBe("paper");
    const { reads } = await sentimentWith(paper, {});
    expect(reads).toContain(sourceReliabilityKey("paper"));
    expect(reads).not.toContain(SOURCE_RELIABILITY_KV_KEY);
  });

  it("mode 別キーの信頼度が分析に効き、旧キーの値は効かない", async () => {
    const hi = await sentimentWith(paper, { [sourceReliabilityKey("paper")]: rel(2), [SOURCE_RELIABILITY_KV_KEY]: rel(0.2) });
    const lo = await sentimentWith(paper, { [sourceReliabilityKey("paper")]: rel(0.2), [SOURCE_RELIABILITY_KV_KEY]: rel(2) });
    expect(hi.sentiment).toBeGreaterThan(lo.sentiment);
  });

  it("live なら intel:sourceReliability:live を読む (paper の学習を持ち込まない)", async () => {
    const live: AppConfig = { ...paper, mode: "live" };
    const { reads } = await sentimentWith(live, { [sourceReliabilityKey("paper")]: rel(2) });
    expect(reads).toContain(sourceReliabilityKey("live"));
    expect(reads).not.toContain(sourceReliabilityKey("paper"));
    expect(reads).not.toContain(SOURCE_RELIABILITY_KV_KEY);
  });
});
