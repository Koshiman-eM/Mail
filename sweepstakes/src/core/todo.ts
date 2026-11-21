// X / Instagram / 仮想通貨クエストの「今日やること」リスト (純粋関数)
// フォロー・RT・いいね・コメント・ウォレット署名などの自動操作は一切行わない。
import { deadlineToDate, FLAG_LABELS, isExpired, questMetrics, type QuestMetrics } from "./score.js";
import type { Campaign, ConditionStep, Entry } from "./types.js";

const KIND_LABEL: Record<Campaign["kind"], string> = {
  web_form: "Webフォーム",
  x: "X",
  instagram: "Instagram",
  crypto_quest: "仮想通貨クエスト",
};

export function kindLabel(k: Campaign["kind"]): string {
  return KIND_LABEL[k];
}

function stepText(kind: Campaign["kind"], s: ConditionStep): string {
  const t = s.target ? ` ${s.target}` : "";
  const extra = s.text ? ` (${s.text})` : "";
  switch (s.action) {
    case "follow":
      return `${s.target ?? "主催アカウント"} をフォローする${extra}`;
    case "repost":
      return kind === "instagram" ? `投稿${t} をストーリーズでシェアする${extra}` : `投稿${t} をリポスト (RT) する${extra}`;
    case "like":
      return `投稿${t} にいいねする${extra}`;
    case "comment":
      return `投稿${t} にコメントする${s.text ? `: 「${s.text}」` : ""}`;
    case "quote":
      return `投稿${t} を引用投稿する${s.text ? `: 「${s.text}」` : ""}`;
    case "hashtag":
      return `ハッシュタグ ${s.text ?? s.target ?? ""} を付けて投稿する`;
    case "visit":
      return `${s.target ?? "指定ページ"} を開いて内容を確認する${extra}`;
    case "join_discord":
      return `Discord${t} に参加する${extra}`;
    case "connect_wallet":
      return `ウォレットを接続する${t} ※署名内容を必ず目視確認。approve / setApprovalForAll / シードフレーズ入力は拒否${extra}`;
    default:
      return s.text ?? s.target ?? "(手順不明: ページを確認)";
  }
}

/** 仮想通貨クエストの手順の先頭に必ず付ける安全注意 */
export const CRYPTO_SAFETY_NOTES: readonly string[] = [
  "[安全] 懸賞専用のウォレットで行う (資産の入ったメインウォレットは接続しない)",
  "[安全] シードフレーズ / 秘密鍵は絶対に入力しない (公式が求めることはありません)",
  "[安全] approve / setApprovalForAll / 無制限承認の署名は拒否する",
];

/** オンチェーン操作がある場合のガス代の注意 */
export function gasNote(gasCostJpy: number | null | undefined): string {
  return gasCostJpy != null
    ? `[ガス代] オンチェーン操作あり: 約 ${gasCostJpy} 円 (期待値から差し引き済み)`
    : "[ガス代] オンチェーン操作あり: ガス代不明 (署名前にウォレットの表示で確認)";
}

/** conditions を人間向けの手順リストに整形する */
export function formatSteps(c: Pick<Campaign, "kind" | "conditions" | "url">): string[] {
  const steps: string[] = [];
  if (c.kind === "crypto_quest") {
    steps.push(...CRYPTO_SAFETY_NOTES);
    if (c.conditions.quest?.requiresOnchainTx) steps.push(gasNote(c.conditions.quest.gasCostJpy));
  }
  const actions = (c.conditions.steps ?? []).map((s) => stepText(c.kind, s));
  steps.push(...actions);
  if (!actions.length) steps.push(`${c.url} を開いて応募条件を確認する`);
  if (c.conditions.notes) steps.push(`注意: ${c.conditions.notes}`);
  return steps;
}

export interface TodoItem {
  campaign: Campaign;
  steps: string[];
  /** 締切までの残り時間 (時間)。締切なしは null */
  hoursLeft: number | null;
  warnings: string[];
  /** 手動登録クエストの期待値・時給 */
  questMetrics?: QuestMetrics;
}

/**
 * 手動タスクを「締切が近い順 → スコア順」で並べる。
 * 除外・締切切れ・手動完了済みは含めない。
 */
export function buildTodoList(campaigns: Campaign[], entries: Entry[], now: Date = new Date()): TodoItem[] {
  const done = new Set(entries.filter((e) => e.status === "done_manual" || e.status === "submitted").map((e) => e.campaignId));
  return campaigns
    .filter((c) => c.kind !== "web_form")
    .filter((c) => c.status === "active" && !done.has(c.id) && !isExpired(c.deadline, now))
    .map((c) => {
      const d = c.deadline ? deadlineToDate(c.deadline) : null;
      return {
        campaign: c,
        steps: formatSteps(c),
        hoursLeft: d ? Math.max(0, Math.round(((d.getTime() - now.getTime()) / 3_600_000) * 10) / 10) : null,
        warnings: c.riskFlags.map((f) => FLAG_LABELS[f] ?? f),
        ...(c.kind === "crypto_quest" && c.conditions.quest ? { questMetrics: questMetrics({ ...c, quest: c.conditions.quest }) } : {}),
      };
    })
    .sort((a, b) => {
      // 締切は日単位で比較し、同じ日ならスコアの高い順
      const da = a.hoursLeft === null ? Number.POSITIVE_INFINITY : Math.floor(a.hoursLeft / 24);
      const db = b.hoursLeft === null ? Number.POSITIVE_INFINITY : Math.floor(b.hoursLeft / 24);
      if (da !== db) return da - db;
      return b.campaign.score - a.campaign.score;
    });
}
