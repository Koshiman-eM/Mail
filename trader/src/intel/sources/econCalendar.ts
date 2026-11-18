import type { EconEvent, IntelItem } from "../../core/types";
import { defaultFetchJson, intelId, type FetchJsonFn, type IntelSource } from "./common";

export const ECON_SOURCE = "calendar:ff";
export const ECON_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

const CURRENCIES = new Set(["USD", "JPY", "EUR", "GBP", "AUD", "CAD", "CHF", "NZD", "CNY"]);
const IMPACT: Record<string, EconEvent["impact"]> = { high: "high", medium: "medium", low: "low" };

/** 経済指標 JSON → EconEvent[] (Holiday/Non-Economic は除外) */
export function parseEconEvents(json: unknown): EconEvent[] {
  if (!Array.isArray(json)) return [];
  const out: EconEvent[] = [];
  for (const r of json as any[]) {
    const impact = IMPACT[String(r?.impact ?? "").toLowerCase()];
    const ts = Date.parse(String(r?.date ?? ""));
    const title = String(r?.title ?? "").trim();
    if (!impact || !Number.isFinite(ts) || !title) continue;
    const country = String(r.country ?? "").toUpperCase();
    out.push({ ts, title, currency: CURRENCIES.has(country) ? country : undefined, impact, source: ECON_SOURCE });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export function econEventsToItems(events: EconEvent[], now: number): IntelItem[] {
  return events.map((e) => ({
    id: intelId(ECON_SOURCE, `${e.ts}:${e.currency ?? ""}:${e.title}`),
    source: ECON_SOURCE,
    kind: "calendar" as const,
    title: `${e.currency ?? "ALL"} ${e.title} (${e.impact})`,
    publishedAt: e.ts,
    fetchedAt: now,
    assets: e.currency ? [e.currency, "FX"] : ["FX"],
    importance: e.impact === "high" ? 0.9 : e.impact === "medium" ? 0.5 : 0.2,
  }));
}

export function createEconCalendarSource(opts: { fetchJson?: FetchJsonFn } = {}): IntelSource {
  const get = opts.fetchJson ?? defaultFetchJson;
  let last: EconEvent[] = [];
  return {
    id: ECON_SOURCE,
    fetch: async (now) => {
      last = parseEconEvents(await get(ECON_URL));
      return econEventsToItems(last, now);
    },
    events: () => last,
  };
}
