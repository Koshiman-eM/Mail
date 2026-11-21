// 懸賞ツールの共通型定義

export type CampaignKind = "web_form" | "x" | "instagram" | "crypto_quest";
export const CAMPAIGN_KINDS: readonly CampaignKind[] = ["web_form", "x", "instagram", "crypto_quest"];

/** active: 対象 / excluded: 採点・詐欺チェックで除外 / expired: 締切切れ / entered: 応募済み */
export type CampaignStatus = "active" | "excluded" | "expired" | "entered";

/** 手動タスクの 1 手順 */
export type StepAction =
  | "follow"
  | "repost"
  | "like"
  | "comment"
  | "quote"
  | "hashtag"
  | "visit"
  | "join_discord"
  | "connect_wallet"
  | "custom";

export interface ConditionStep {
  action: StepAction;
  /** @アカウント, 投稿URL, Discord招待URL など */
  target?: string;
  /** コメント文・ハッシュタグ・自由記述 */
  text?: string;
}

export interface Conditions {
  steps?: ConditionStep[];
  /** 応募規約・注意書き (自動応募禁止の検出に使う) */
  terms?: string;
  notes?: string;
  /** 収集元でのタグ (例: 「クイズ」「食品」「WEB応募可」) */
  tags?: string[];
  /** 収集元の掲載ページ URL (url は応募先。両者が異なる場合に保存) */
  sourceUrl?: string;
}

export interface Campaign {
  id: number;
  kind: CampaignKind;
  source: string;
  title: string;
  url: string;
  prize: string;
  prizeValueJpy?: number | null;
  winners?: number | null;
  participants?: number | null;
  /** ISO 8601 (日付のみの場合はその日の終わりまで有効とみなす) */
  deadline?: string | null;
  conditions: Conditions;
  estMinutes?: number | null;
  riskFlags: string[];
  score: number;
  status: CampaignStatus;
  createdAt: string;
  updatedAt: string;
}

/** Collector が返す、まだ DB に入っていないキャンペーン */
export type CampaignInput = Omit<Campaign, "id" | "score" | "status" | "createdAt" | "updatedAt" | "riskFlags"> & {
  riskFlags?: string[];
};

export type EntryStatus = "submitted" | "needs_manual" | "failed" | "skipped" | "done_manual";

export interface Entry {
  id: number;
  campaignId: number;
  status: EntryStatus;
  reason: string;
  createdAt: string;
}

export type Gender = "male" | "female" | "other";

export interface Profile {
  lastName: string;
  firstName: string;
  lastNameKana: string;
  firstNameKana: string;
  email: string;
  phone: string;
  zip: string;
  prefecture: string;
  city: string;
  address1: string;
  address2: string;
  /** YYYY-MM-DD */
  birthday: string;
  gender: Gender | string;
}
