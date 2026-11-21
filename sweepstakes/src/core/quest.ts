// 仮想通貨クエストの手動登録まわりの純粋関数 (入力検証・円換算・ページ情報の抽出・並び順)
// ウォレット署名・トランザクション・SNS 操作の自動化は一切行わない。
import { deadlineToDate, questMetrics, type QuestMetrics } from "./score.js";
import {
  QUEST_DISTRIBUTIONS,
  QUEST_REWARD_TYPES,
  type Campaign,
  type CampaignInput,
  type QuestDistribution,
  type QuestMeta,
  type QuestRewardType,
  type QuestValueSource,
} from "./types.js";

/** addQuest の入力 (MCP からもこの形で渡す) */
export interface QuestInput {
  url: string;
  title?: string;
  /** 既定: other */
  rewardType?: QuestRewardType;
  rewardAmount?: number | null;
  /** USD / USDT / USDC / JPY / トークン記号 */
  rewardCurrency?: string | null;
  /** 円換算額を直接指定 (換算より優先) */
  rewardValueJpy?: number | null;
  winners?: number | null;
  participants?: number | null;
  /** 既定: raffle */
  distribution?: QuestDistribution;
  estMinutes?: number | null;
  /** YYYY-MM-DD または ISO 8601 */
  deadline?: string | null;
  requiresOnchainTx?: boolean;
  gasCostJpy?: number | null;
  notes?: string | null;
}

/** updateQuest の差分。undefined は変更なし、null は値を消す (url は変更不可) */
export type QuestPatch = Partial<Omit<QuestInput, "url">>;

export const USD_PEGGED_CURRENCIES: readonly string[] = ["USD", "USDT", "USDC"];
const VALUE_UNKNOWN_TYPES: ReadonlySet<QuestRewardType> = new Set(["points", "nft", "whitelist"]);

export class QuestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestInputError";
  }
}

function checkNum(name: string, v: number | null | undefined, opts: { integer?: boolean } = {}): void {
  if (v == null) return;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new QuestInputError(`${name} は 0 以上の数値で指定してください`);
  if (opts.integer && !Number.isInteger(v)) throw new QuestInputError(`${name} は整数で指定してください`);
}

/** 入力値を検証する (不正なら QuestInputError) */
export function validateQuestFields(q: QuestPatch & { url?: string }): void {
  if (q.url !== undefined) {
    let u: URL;
    try {
      u = new URL(q.url);
    } catch {
      throw new QuestInputError(`URL が不正です: ${q.url}`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new QuestInputError("URL は http(s) で指定してください");
  }
  if (q.rewardType !== undefined && !QUEST_REWARD_TYPES.includes(q.rewardType)) {
    throw new QuestInputError(`rewardType は ${QUEST_REWARD_TYPES.join(" / ")} のいずれかです`);
  }
  if (q.distribution !== undefined && !QUEST_DISTRIBUTIONS.includes(q.distribution)) {
    throw new QuestInputError(`distribution は ${QUEST_DISTRIBUTIONS.join(" / ")} のいずれかです`);
  }
  checkNum("rewardAmount", q.rewardAmount);
  checkNum("rewardValueJpy", q.rewardValueJpy);
  checkNum("winners", q.winners, { integer: true });
  checkNum("participants", q.participants, { integer: true });
  checkNum("estMinutes", q.estMinutes);
  checkNum("gasCostJpy", q.gasCostJpy);
  if (q.deadline != null && (q.deadline.trim() === "" || deadlineToDate(q.deadline) === null)) {
    throw new QuestInputError(`deadline が不正です: ${q.deadline} (YYYY-MM-DD または ISO 8601)`);
  }
  if (q.rewardCurrency != null && !/^[A-Za-z0-9.$_-]{1,15}$/.test(q.rewardCurrency)) {
    throw new QuestInputError(`rewardCurrency が不正です: ${q.rewardCurrency}`);
  }
  if (q.requiresOnchainTx !== undefined && typeof q.requiresOnchainTx !== "boolean") {
    throw new QuestInputError("requiresOnchainTx は true / false で指定してください");
  }
}

export interface QuestValue {
  valueJpy: number | null;
  source: QuestValueSource;
  warnings: string[];
}

/**
 * 報酬の円換算。
 * 直接指定 > JPY > USD/USDT/USDC (SWEEP_USDJPY) の順。points/nft/whitelist・その他トークンは直接指定がなければ価値不明 (null)。
 */
export function questValueJpy(
  q: { rewardType: QuestRewardType; rewardAmount?: number | null; rewardCurrency?: string | null; rewardValueJpy?: number | null },
  usdJpy: number | null,
): QuestValue {
  if (q.rewardValueJpy != null) return { valueJpy: Math.round(q.rewardValueJpy), source: "direct", warnings: [] };
  if (VALUE_UNKNOWN_TYPES.has(q.rewardType)) {
    return { valueJpy: null, source: "unknown", warnings: [`${q.rewardType} は価値不明として扱います (分かる場合は rewardValueJpy で円換算額を指定)`] };
  }
  if (q.rewardAmount == null) return { valueJpy: null, source: "unknown", warnings: ["報酬額が未指定のため価値不明です"] };
  let cur = q.rewardCurrency?.toUpperCase() ?? null;
  const warnings: string[] = [];
  if (!cur && q.rewardType === "stablecoin") {
    cur = "USD";
    warnings.push("stablecoin の通貨が未指定のため USD 建てとみなしました");
  }
  if (!cur) return { valueJpy: null, source: "unknown", warnings: ["通貨が未指定のため価値不明です"] };
  if (cur === "JPY") return { valueJpy: Math.round(q.rewardAmount), source: "jpy", warnings };
  if (USD_PEGGED_CURRENCIES.includes(cur)) {
    if (usdJpy == null) {
      warnings.push(`SWEEP_USDJPY が未設定のため ${cur} を円換算できません (価値不明として扱います)`);
      return { valueJpy: null, source: "unknown", warnings };
    }
    return { valueJpy: Math.round(q.rewardAmount * usdJpy), source: "usdjpy", warnings };
  }
  warnings.push(`${cur} の円換算は行いません (価値不明。分かる場合は rewardValueJpy を指定)`);
  return { valueJpy: null, source: "unknown", warnings };
}

/** 賞品欄の表示用文字列 */
export function questPrizeLabel(q: { rewardType: QuestRewardType; rewardAmount?: number | null; rewardCurrency?: string | null }): string {
  const typeLabel: Record<QuestRewardType, string> = {
    token: "トークン",
    stablecoin: "ステーブルコイン",
    nft: "NFT",
    points: "ポイント",
    whitelist: "ホワイトリスト",
    other: "その他",
  };
  const amount = q.rewardAmount != null ? `${q.rewardAmount}${q.rewardCurrency ? " " + q.rewardCurrency.toUpperCase() : ""}` : "";
  return amount ? `${amount} (${typeLabel[q.rewardType]})` : typeLabel[q.rewardType];
}

/** 完全な QuestInput を CampaignInput に組み立てる (採点前) */
export function buildQuestCampaignInput(
  q: QuestInput & { rewardType: QuestRewardType; distribution: QuestDistribution },
  opts: { usdJpy: number | null; fetchedText?: string | null; fetchedAt?: string | null },
): { input: CampaignInput; warnings: string[] } {
  const v = questValueJpy(q, opts.usdJpy);
  const meta: QuestMeta = {
    rewardType: q.rewardType,
    rewardAmount: q.rewardAmount ?? null,
    rewardCurrency: q.rewardCurrency ? q.rewardCurrency.toUpperCase() : null,
    rewardValueJpyManual: q.rewardValueJpy ?? null,
    usdJpy: v.source === "usdjpy" ? opts.usdJpy : null,
    valueSource: v.source,
    distribution: q.distribution,
    requiresOnchainTx: q.requiresOnchainTx === true,
    gasCostJpy: q.gasCostJpy ?? null,
    fetchedAt: opts.fetchedAt ?? null,
  };
  return {
    input: {
      kind: "crypto_quest",
      source: "manual",
      title: q.title?.trim() || new URL(q.url).hostname + new URL(q.url).pathname,
      url: q.url,
      prize: questPrizeLabel(q),
      prizeValueJpy: v.valueJpy,
      winners: q.winners ?? null,
      participants: q.participants ?? null,
      deadline: q.deadline ?? null,
      estMinutes: q.estMinutes ?? null,
      conditions: {
        quest: meta,
        ...(q.notes ? { notes: q.notes } : {}),
        ...(opts.fetchedText ? { terms: opts.fetchedText } : {}),
      },
    },
    warnings: v.warnings,
  };
}

/** 登録済みキャンペーンから QuestInput を復元する (updateQuest 用) */
export function questInputFromCampaign(c: Campaign): QuestInput & { rewardType: QuestRewardType; distribution: QuestDistribution } {
  const m = c.conditions.quest;
  return {
    url: c.url,
    title: c.title,
    rewardType: m?.rewardType ?? "other",
    rewardAmount: m?.rewardAmount ?? null,
    rewardCurrency: m?.rewardCurrency ?? null,
    // 手動登録でないもの (quest メタなし) は保存済みの円換算額を直接指定扱いにする
    rewardValueJpy: m ? (m.rewardValueJpyManual ?? null) : (c.prizeValueJpy ?? null),
    winners: c.winners ?? null,
    participants: c.participants ?? null,
    distribution: m?.distribution ?? "raffle",
    estMinutes: c.estMinutes ?? null,
    deadline: c.deadline ?? null,
    requiresOnchainTx: m?.requiresOnchainTx ?? false,
    gasCostJpy: m?.gasCostJpy ?? null,
    notes: c.conditions.notes ?? null,
  };
}

/** patch を適用する (undefined のキーは変更しない) */
export function applyQuestPatch<T extends QuestInput>(base: T, patch: QuestPatch): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && k !== "url") out[k] = v;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// --fetch: ページからタイトル・説明・本文テキストを抽出
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function metaContent(html: string, prop: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (key?.toLowerCase() !== prop) continue;
    const content = tag.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/\bcontent\s*=\s*'([^']*)'/i)?.[1];
    if (content != null) return decodeEntities(content).trim() || null;
  }
  return null;
}

export interface QuestPageInfo {
  title: string | null;
  description: string | null;
  /** script/style を除いた本文テキスト */
  text: string;
}

export function extractQuestPageInfo(html: string): QuestPageInfo {
  const ogTitle = metaContent(html, "og:title");
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = ogTitle ?? (titleTag ? decodeEntities(titleTag).replace(/\s+/g, " ").trim() || null : null);
  const description = metaContent(html, "og:description") ?? metaContent(html, "description");
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const text = decodeEntities(
    body
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  return { title, description, text };
}

/** 詐欺チェック用に保存するテキストの上限 */
export const FETCHED_TEXT_MAX = 5000;

// ---------------------------------------------------------------------------
// 一覧の並び順
// ---------------------------------------------------------------------------

export interface QuestListItem {
  campaign: Campaign;
  metrics: QuestMetrics | null;
}

/** 保存済みキャンペーンから期待値・時給を計算する (quest メタがない収集分は null) */
export function questMetricsOf(c: Campaign): QuestMetrics | null {
  return c.conditions.quest ? questMetrics({ ...c, quest: c.conditions.quest }) : null;
}

/**
 * 対象 (active) → それ以外 の順。同じグループ内は 時給 (円/時) の高い順 → 正味期待値の高い順、価値不明は末尾。
 * quest メタのない収集分は score (円/分 × 60) を時給とみなす。
 */
export function sortQuests(items: QuestListItem[]): QuestListItem[] {
  const hourly = (i: QuestListItem): number | null =>
    i.metrics ? i.metrics.hourlyJpy : i.campaign.prizeValueJpy == null ? null : i.campaign.score * 60;
  const net = (i: QuestListItem): number => i.metrics?.netValueJpy ?? 0;
  return [...items].sort((a, b) => {
    const ga = a.campaign.status === "active" ? 0 : 1;
    const gb = b.campaign.status === "active" ? 0 : 1;
    if (ga !== gb) return ga - gb;
    const ha = hourly(a);
    const hb = hourly(b);
    if ((ha === null) !== (hb === null)) return ha === null ? 1 : -1;
    if (ha !== null && hb !== null && ha !== hb) return hb - ha;
    if (net(a) !== net(b)) return net(b) - net(a);
    return a.campaign.id - b.campaign.id;
  });
}
