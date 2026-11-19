import type { IntelItem } from "../../core/types";
import { tagAssets } from "../assetTagger";
import { clamp, defaultFetchJson, intelId, num, stripHtml, type FetchJsonFn, type IntelSource } from "./common";

export const CRYPTOPANIC_SOURCE = "cryptopanic";

/** votes から sentiment (-1〜1) を推定。票が無ければ undefined */
export function votesToSentiment(votes: Record<string, unknown> | undefined): number | undefined {
  if (!votes) return undefined;
  const g = (k: string) => num(votes[k]) ?? 0;
  const pos = g("positive") + g("liked");
  const neg = g("negative") + g("disliked") + g("toxic");
  const total = pos + neg;
  if (total === 0) return undefined;
  // 票が少ないときは 0 へ縮める
  return clamp(((pos - neg) / (total + 3)), -1, 1);
}

export function parseCryptoPanic(json: unknown, now: number): IntelItem[] {
  const results = ((json as any)?.results ?? []) as any[];
  const items: IntelItem[] = [];
  for (const r of results) {
    const title = stripHtml(String(r?.title ?? ""));
    if (!title) continue;
    const t = Date.parse(String(r.published_at ?? r.created_at ?? ""));
    const codes = ((r.instruments ?? r.currencies ?? []) as any[])
      .map((c) => String(c?.code ?? "").toUpperCase())
      .filter(Boolean);
    const votes = r.votes as Record<string, unknown> | undefined;
    const important = num(votes?.important) ?? 0;
    const summary = r.description ? stripHtml(String(r.description)).slice(0, 500) : undefined;
    items.push({
      id: intelId(CRYPTOPANIC_SOURCE, String(r.id ?? r.slug ?? title)),
      source: CRYPTOPANIC_SOURCE,
      kind: "news",
      title,
      summary,
      url: r.original_url ?? r.url ?? undefined,
      publishedAt: Number.isFinite(t) ? t : now,
      fetchedAt: now,
      assets: [...new Set([...codes, ...tagAssets(title), "CRYPTO"])].sort(),
      sentiment: votesToSentiment(votes),
      importance: clamp(0.3 + important / 20, 0, 1),
    });
  }
  return items;
}

/** メッセージからトークンを伏せる (生の値と encodeURIComponent した値の両方) */
export function redactToken(msg: string, token: string): string {
  let out = msg;
  for (const t of new Set([token, encodeURIComponent(token)])) {
    if (t) out = out.split(t).join("***");
  }
  return out;
}

/** トークン未設定なら undefined (無効) */
export function createCryptoPanicSource(
  opts: { token?: string; fetchJson?: FetchJsonFn } = {},
): IntelSource | undefined {
  const token = opts.token ?? process.env.CRYPTOPANIC_TOKEN;
  if (!token) return undefined;
  const get = opts.fetchJson ?? defaultFetchJson;
  const url = `https://cryptopanic.com/api/developer/v2/posts/?auth_token=${encodeURIComponent(token)}&public=true`;
  return {
    id: CRYPTOPANIC_SOURCE,
    fetch: async (now) => {
      try {
        return parseCryptoPanic(await get(url), now);
      } catch (e) {
        // エラーメッセージに含まれるトークン (生・URL エンコード済み) を伏せる
        throw new Error(redactToken(e instanceof Error ? e.message : String(e), token));
      }
    },
  };
}
