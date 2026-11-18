import { D, type Dec } from "../decimal";
import { prisma } from "../db/prisma";

const TTL_MS = 60 * 60 * 1000;

/**
 * 最新の為替レート (1 base = ? JPY) を取得する。1時間キャッシュ。
 * 取得元は API キー不要の open.er-api.com。失敗時は直近のキャッシュへフォールバック。
 */
export async function getJpyRate(base: string): Promise<{ rate: Dec; fetchedAt: Date; source: string; stale: boolean }> {
  const b = base.toUpperCase();
  if (b === "JPY") return { rate: new D(1), fetchedAt: new Date(), source: "identity", stale: false };

  const cached = await prisma.fxRate.findFirst({ where: { base: b, quote: "JPY" }, orderBy: { fetchedAt: "desc" } });
  if (cached && Date.now() - cached.fetchedAt.getTime() < TTL_MS) {
    return { rate: new D(cached.rate.toString()), fetchedAt: cached.fetchedAt, source: cached.source, stale: false };
  }

  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${b}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`FX API ${res.status}`);
    const body = (await res.json()) as { result: string; rates?: Record<string, number> };
    const jpy = body.rates?.JPY;
    if (body.result !== "success" || !jpy) throw new Error("FX API 応答が不正です");
    // number → string 経由で Decimal 化 (API 値以上の精度は持たない)
    const rate = new D(String(jpy));
    const saved = await prisma.fxRate.create({ data: { base: b, quote: "JPY", rate: rate.toString(), source: "open.er-api.com" } });
    return { rate, fetchedAt: saved.fetchedAt, source: saved.source, stale: false };
  } catch (e) {
    if (cached) {
      return { rate: new D(cached.rate.toString()), fetchedAt: cached.fetchedAt, source: cached.source, stale: true };
    }
    throw e;
  }
}
