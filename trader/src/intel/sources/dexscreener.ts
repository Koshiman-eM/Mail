import type { IntelItem } from "../../core/types";
import { clamp, defaultFetchJson, intelId, num, type FetchJsonFn, type IntelSource } from "./common";

export const DEX_SOURCE = "dexscreener";
const BASE = "https://api.dexscreener.com";
const MAX_TOKENS = 30;

export interface RugInputs {
  liquidityUsd?: number;
  ageMs?: number;
  buysH1?: number;
  sellsH1?: number;
}

/** ラグプル危険度の簡易判定 0〜1 (大きいほど危険) */
export function assessRugRisk(i: RugInputs): number {
  let r = 0;
  const liq = i.liquidityUsd;
  if (liq === undefined) r += 0.5;
  else if (liq < 5_000) r += 0.5;
  else if (liq < 25_000) r += 0.3;
  else if (liq < 100_000) r += 0.1;
  if (i.ageMs !== undefined) {
    if (i.ageMs < 3_600_000) r += 0.4;
    else if (i.ageMs < 86_400_000) r += 0.3;
  }
  const b = i.buysH1 ?? 0;
  const s = i.sellsH1 ?? 0;
  if (b + s >= 20 && Math.min(b, s) / Math.max(b, s) < 0.1) r += 0.25; // 売れない/買いのみ等の偏り
  return clamp(r, 0, 1);
}

/** ペア配列 → IntelItem。同一トークンは流動性最大のペアを採用 (純粋関数) */
export function parseDexPairs(json: unknown, now: number, boostByAddress: Record<string, number> = {}): IntelItem[] {
  if (!Array.isArray(json)) return [];
  const best = new Map<string, any>();
  for (const p of json as any[]) {
    const addr = String(p?.baseToken?.address ?? "");
    if (!addr || !p?.baseToken?.symbol) continue;
    const key = `${p.chainId}:${addr}`;
    const cur = best.get(key);
    if (!cur || (num(p.liquidity?.usd) ?? 0) > (num(cur.liquidity?.usd) ?? 0)) best.set(key, p);
  }
  const bucket = Math.floor(now / 3_600_000);
  const items: IntelItem[] = [];
  for (const p of best.values()) {
    const symbol = String(p.baseToken.symbol).toUpperCase();
    const liq = num(p.liquidity?.usd);
    const created = num(p.pairCreatedAt);
    const buys = num(p.txns?.h1?.buys);
    const sells = num(p.txns?.h1?.sells);
    const rug = assessRugRisk({
      liquidityUsd: liq,
      ageMs: created !== undefined ? now - created : undefined,
      buysH1: buys,
      sellsH1: sells,
    });
    const vol24 = num(p.volume?.h24) ?? 0;
    const ch1 = num(p.priceChange?.h1) ?? 0;
    const metrics: Record<string, number> = { rugRisk: rug, volumeH24: vol24 };
    const put = (k: string, v: number | undefined) => v !== undefined && (metrics[k] = v);
    put("liquidityUsd", liq);
    put("volumeM5", num(p.volume?.m5));
    put("volumeH1", num(p.volume?.h1));
    put("priceChangeM5", num(p.priceChange?.m5));
    put("priceChangeH1", num(p.priceChange?.h1));
    put("priceChangeH24", num(p.priceChange?.h24));
    put("buysH1", buys);
    put("sellsH1", sells);
    put("buysH24", num(p.txns?.h24?.buys));
    put("sellsH24", num(p.txns?.h24?.sells));
    put("priceUsd", num(p.priceUsd));
    if (created !== undefined) metrics.pairAgeHours = Math.max(0, (now - created) / 3_600_000);
    const boost = boostByAddress[String(p.baseToken.address)];
    put("boostAmount", boost);
    const baseImportance = clamp(Math.log10(vol24 + 1) / 7, 0.05, 1);
    items.push({
      id: intelId(DEX_SOURCE, `${p.pairAddress ?? p.baseToken.address}:${bucket}`),
      source: DEX_SOURCE,
      kind: "trending",
      title: `DEX トレンド ${symbol} (${p.chainId}) 1h ${ch1.toFixed(1)}% 流動性 $${Math.round(liq ?? 0)}`,
      url: p.url,
      publishedAt: now,
      fetchedAt: now,
      assets: [symbol, "MEME"],
      sentiment: clamp(Math.tanh(ch1 / 15) * (1 - rug), -1, 1),
      importance: clamp(baseImportance * (1 - 0.8 * rug), 0.02, 1),
      metrics,
    });
  }
  return items;
}

/** boosts の配列からトークン (chain, address) を重複なしで取り出す */
export function parseBoostTokens(...lists: unknown[]): { chainId: string; address: string; amount: number }[] {
  const seen = new Map<string, { chainId: string; address: string; amount: number }>();
  for (const l of lists) {
    if (!Array.isArray(l)) continue;
    for (const t of l as any[]) {
      const chainId = String(t?.chainId ?? "");
      const address = String(t?.tokenAddress ?? "");
      if (!chainId || !address) continue;
      const k = `${chainId}:${address}`;
      if (!seen.has(k)) seen.set(k, { chainId, address, amount: num(t.totalAmount) ?? num(t.amount) ?? 0 });
    }
  }
  return [...seen.values()];
}

export function createDexScreenerSource(opts: { fetchJson?: FetchJsonFn; maxTokens?: number } = {}): IntelSource {
  const get = opts.fetchJson ?? defaultFetchJson;
  const max = Math.min(opts.maxTokens ?? MAX_TOKENS, 60);
  return {
    id: DEX_SOURCE,
    fetch: async (now) => {
      const [top, latest] = await Promise.all([get(`${BASE}/token-boosts/top/v1`), get(`${BASE}/token-boosts/latest/v1`)]);
      const tokens = parseBoostTokens(top, latest).slice(0, max);
      const byChain = new Map<string, string[]>();
      for (const t of tokens) byChain.set(t.chainId, [...(byChain.get(t.chainId) ?? []), t.address]);
      const boost: Record<string, number> = Object.fromEntries(tokens.map((t) => [t.address, t.amount]));
      const items: IntelItem[] = [];
      for (const [chain, addrs] of byChain) {
        try {
          for (let i = 0; i < addrs.length; i += 30) {
            const pairs = await get(`${BASE}/tokens/v1/${chain}/${addrs.slice(i, i + 30).join(",")}`);
            items.push(...parseDexPairs(pairs, now, boost));
          }
        } catch {
          // 一部チェーンの失敗は無視 (取得できた分で続行)
        }
      }
      return items;
    },
  };
}
