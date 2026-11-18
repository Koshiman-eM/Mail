import { createHash } from "node:crypto";
import { fetchJson, fetchText } from "../../core/http";
import type { EconEvent, IntelItem } from "../../core/types";

/** 情報源の共通インターフェース */
export interface IntelSource {
  id: string;
  fetch(now: number): Promise<IntelItem[]>;
  /** 経済指標を持つ情報源のみ実装 (直近 fetch で得たイベント) */
  events?(): EconEvent[];
}

export type FetchTextFn = (url: string) => Promise<string>;
export type FetchJsonFn = (url: string) => Promise<unknown>;

const UA = { "user-agent": "auto-trader-intel/0.1" };
export const defaultFetchText: FetchTextFn = (url) => fetchText(url, { headers: UA });
export const defaultFetchJson: FetchJsonFn = (url) => fetchJson(url, { headers: UA });

/** 情報源 + キーから安定 ID を作る */
export function intelId(source: string, key: string): string {
  return createHash("sha1").update(`${source}\n${key}`).digest("hex").slice(0, 16);
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 不明な JSON から有限数を取り出す */
export function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** HTML タグ・実体参照の簡易除去 */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
