import type { IntelItem } from "../../core/types";
import { tagAssets } from "../assetTagger";
import { clamp, defaultFetchJson, intelId, num, type FetchJsonFn, type IntelSource } from "./common";

export const COINGECKO_SOURCE = "coingecko";
export const COINGECKO_URL = "https://api.coingecko.com/api/v3/search/trending";

export function parseCoinGeckoTrending(json: unknown, now: number): IntelItem[] {
  const coins = ((json as any)?.coins ?? []) as any[];
  const day = Math.floor(now / 86_400_000);
  const items: IntelItem[] = [];
  coins.forEach((c, idx) => {
    const it = c?.item;
    const symbol = String(it?.symbol ?? "").toUpperCase();
    if (!symbol) return;
    const change = num(it?.data?.price_change_percentage_24h?.usd);
    const tagged = tagAssets(`${it.name ?? ""} ${symbol}`);
    const metrics: Record<string, number> = { trendRank: idx + 1 };
    const rank = num(it.market_cap_rank);
    if (rank !== undefined) metrics.marketCapRank = rank;
    if (change !== undefined) metrics.priceChange24h = change;
    items.push({
      id: intelId(COINGECKO_SOURCE, `${it.id ?? symbol}:${day}`),
      source: COINGECKO_SOURCE,
      kind: "trending",
      title: `CoinGecko トレンド #${idx + 1}: ${it.name ?? symbol} (${symbol})`,
      url: it.id ? `https://www.coingecko.com/en/coins/${it.id}` : undefined,
      publishedAt: now,
      fetchedAt: now,
      assets: [...new Set([symbol, "CRYPTO", ...tagged])].sort(),
      sentiment: change !== undefined ? clamp(Math.tanh(change / 20) * 0.5, -1, 1) : undefined,
      importance: clamp(0.4 - idx * 0.02, 0.1, 0.4),
      metrics,
    });
  });
  return items;
}

export function createCoinGeckoSource(opts: { fetchJson?: FetchJsonFn } = {}): IntelSource {
  const get = opts.fetchJson ?? defaultFetchJson;
  return { id: COINGECKO_SOURCE, fetch: async (now) => parseCoinGeckoTrending(await get(COINGECKO_URL), now) };
}
