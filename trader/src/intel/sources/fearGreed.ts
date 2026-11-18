import type { IntelItem } from "../../core/types";
import { defaultFetchJson, intelId, num, type FetchJsonFn, type IntelSource } from "./common";

export const FNG_URL = "https://api.alternative.me/fng/?limit=2";
export const FNG_SOURCE = "fng:alternative.me";

/** Fear & Greed (純粋関数)。data[0] が最新 */
export function parseFearGreed(json: unknown, now: number): IntelItem[] {
  const data = ((json as any)?.data ?? []) as any[];
  const latest = data[0];
  const value = num(latest?.value);
  if (value === undefined) return [];
  const prev = num(data[1]?.value);
  const ts = num(latest.timestamp);
  const label = String(latest.value_classification ?? "");
  const metrics: Record<string, number> = { fng: value };
  if (prev !== undefined) metrics.fngPrev = prev;
  return [
    {
      id: intelId(FNG_SOURCE, String(ts ?? value)),
      source: FNG_SOURCE,
      kind: "metric",
      title: `Fear & Greed Index: ${value}${label ? ` (${label})` : ""}`,
      url: "https://alternative.me/crypto/fear-and-greed-index/",
      publishedAt: ts !== undefined ? ts * 1000 : now,
      fetchedAt: now,
      assets: ["CRYPTO"],
      importance: 0.4,
      metrics,
    },
  ];
}

export function createFearGreedSource(opts: { fetchJson?: FetchJsonFn } = {}): IntelSource {
  const get = opts.fetchJson ?? defaultFetchJson;
  return { id: FNG_SOURCE, fetch: async (now) => parseFearGreed(await get(FNG_URL), now) };
}
