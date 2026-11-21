// 採点と仮想通貨クエストの詐欺チェック (純粋関数)
import type { CampaignInput, CampaignKind, QuestMeta } from "./types.js";

// ---------------------------------------------------------------------------
// リスクフラグ
// ---------------------------------------------------------------------------

/** 致命的なフラグ: 1 つでもあれば除外 */
export const FATAL_FLAGS: ReadonlySet<string> = new Set([
  "typosquat_domain",
  "seed_phrase_request",
  "unlimited_approval",
]);

/** 減点係数 (score に掛ける)。未知のフラグは 0.7 */
export const FLAG_PENALTY: Readonly<Record<string, number>> = {
  approval_request: 0.3,
  unofficial_domain: 0.6,
  requires_payment: 0.3,
  excessive_personal_info: 0.6,
  unknown_organizer: 0.7,
  entry_url_unverified: 0.5,
  unknown_platform: 0.7,
};
const DEFAULT_PENALTY = 0.7;

export const FLAG_LABELS: Readonly<Record<string, string>> = {
  typosquat_domain: "公式ドメインに似せた偽ドメインの疑い",
  seed_phrase_request: "シードフレーズ/秘密鍵の入力要求",
  unlimited_approval: "無制限のトークン承認要求",
  approval_request: "approve / setApprovalForAll の要求",
  unofficial_domain: "公式ドメイン以外",
  requires_payment: "支払いが必要",
  excessive_personal_info: "過剰な個人情報要求",
  unknown_organizer: "主催者不明",
  entry_url_unverified: "応募先 URL 未確認 (収集元の掲載ページのまま。要確認)",
  unknown_platform: "既知のクエストプラットフォーム以外のドメイン (要確認)",
};

/** 応募先 URL が確認できていない (自動応募の対象にしない) */
export const NEEDS_REVIEW_FLAG = "entry_url_unverified";

// ---------------------------------------------------------------------------
// 採点
// ---------------------------------------------------------------------------

const DEFAULT_MINUTES: Record<CampaignKind, number> = {
  web_form: 3,
  x: 1,
  instagram: 2,
  crypto_quest: 15,
};
const DEFAULT_PARTICIPANTS = 1000;

export interface ScoreInput {
  kind: CampaignKind;
  prizeValueJpy?: number | null;
  winners?: number | null;
  participants?: number | null;
  estMinutes?: number | null;
  deadline?: string | null;
  riskFlags?: string[];
  /** 手動登録クエストの追加情報 (あれば distribution 別の期待値で採点) */
  quest?: QuestMeta | null;
}

export interface ScoreResult {
  /** 1 分あたりの期待値 (円/分)。除外時は 0 */
  score: number;
  excluded: boolean;
  expired: boolean;
  reasons: string[];
  /** quest がある場合の期待値・時給 */
  questMetrics?: QuestMetrics;
}

// ---------------------------------------------------------------------------
// 仮想通貨クエストの期待値
// ---------------------------------------------------------------------------

/** 先着 (fcfs) で枠を超えている場合に期待値に掛ける係数 (「ほぼ 0」扱い) */
export const FCFS_OVERFLOW_FACTOR = 0.01;

export interface QuestMetrics {
  /** 期待値 (円)。価値不明・順位制は null */
  expectedValueJpy: number | null;
  /** 期待値 − ガス代 (円) */
  netValueJpy: number | null;
  /** 時給換算 (円/時) = 正味期待値 ÷ 所要分数 × 60 */
  hourlyJpy: number | null;
  /** 計算に使った所要分数 */
  minutes: number;
  gasCostJpy: number;
  valueUnknown: boolean;
  reasons: string[];
}

export interface QuestMetricsInput {
  prizeValueJpy?: number | null;
  winners?: number | null;
  participants?: number | null;
  estMinutes?: number | null;
  quest: QuestMeta;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * distribution 別の期待値 (円):
 * - raffle: 価値 × 当選数 / max(参加者数, 1) (参加者数不明は 1000 人と仮定)
 * - fcfs: 参加者数 < 枠数 なら価値そのもの、枠以上なら価値 × FCFS_OVERFLOW_FACTOR
 * - all: 価値そのもの
 * - leaderboard: 不明
 * 正味 = 期待値 − ガス代、時給 = 正味 ÷ 所要分数 × 60
 */
export function questMetrics(c: QuestMetricsInput): QuestMetrics {
  const q = c.quest;
  const reasons: string[] = [];
  const minutes = Math.max(0.5, c.estMinutes ?? DEFAULT_MINUTES.crypto_quest);
  if (c.estMinutes == null) reasons.push(`所要時間不明 (${minutes} 分と仮定)`);
  const gas = Math.max(0, c.quest.gasCostJpy ?? 0);
  if (q.requiresOnchainTx && q.gasCostJpy == null) reasons.push("オンチェーン操作あり・ガス代不明 (0 円として計算)");
  const unknown = (why: string): QuestMetrics => {
    reasons.push(why);
    return { expectedValueJpy: null, netValueJpy: null, hourlyJpy: null, minutes, gasCostJpy: gas, valueUnknown: true, reasons };
  };
  if (c.prizeValueJpy == null) return unknown("報酬の価値不明");
  if (q.distribution === "leaderboard") return unknown("順位制 (leaderboard) のため期待値不明");
  const value = Math.max(0, c.prizeValueJpy);
  let ev: number;
  switch (q.distribution) {
    case "raffle": {
      const winners = Math.max(1, c.winners ?? 1);
      if (c.winners == null) reasons.push("当選数不明 (1 と仮定)");
      const p = Math.max(1, c.participants ?? DEFAULT_PARTICIPANTS);
      if (c.participants == null) reasons.push(`参加者数不明 (${DEFAULT_PARTICIPANTS} 人と仮定)`);
      ev = (value * Math.min(winners, p)) / p;
      break;
    }
    case "fcfs": {
      if (c.winners == null || c.participants == null) {
        reasons.push("先着: 枠数または参加者数が不明 (枠内に入れる前提で計算)");
        ev = value;
      } else if (c.participants < c.winners) {
        ev = value;
      } else {
        reasons.push(`先着枠 (${c.winners}) に対し参加者 ${c.participants} 人のためほぼ 0 (×${FCFS_OVERFLOW_FACTOR})`);
        ev = value * FCFS_OVERFLOW_FACTOR;
      }
      break;
    }
    default:
      ev = value;
  }
  if (gas > 0) reasons.push(`ガス代 ${gas} 円を差し引き`);
  const net = ev - gas;
  return {
    expectedValueJpy: round2(ev),
    netValueJpy: round2(net),
    hourlyJpy: Math.round((net / minutes) * 60),
    minutes,
    gasCostJpy: gas,
    valueUnknown: false,
    reasons,
  };
}

/** 締切 (日付のみなら当日 23:59:59 ローカル) を Date に */
export function deadlineToDate(deadline: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    const [y, m, d] = deadline.split("-").map(Number);
    return new Date(y!, m! - 1, d!, 23, 59, 59, 999);
  }
  const t = new Date(deadline);
  return Number.isNaN(t.getTime()) ? null : t;
}

export function isExpired(deadline: string | null | undefined, now: Date): boolean {
  if (!deadline) return false;
  const d = deadlineToDate(deadline);
  return d !== null && d.getTime() < now.getTime();
}

/**
 * 期待値 ≒ (賞品価値 × 当選数 / max(応募者数, 1)) ÷ 所要分数
 * 締切切れ・致命的リスクは除外、その他のリスクフラグは係数で減点。
 */
export function scoreCampaign(c: ScoreInput, now: Date = new Date()): ScoreResult {
  const reasons: string[] = [];
  const flags = c.riskFlags ?? [];
  const expired = isExpired(c.deadline, now);
  if (expired) reasons.push("締切切れ");
  const fatal = flags.filter((f) => FATAL_FLAGS.has(f));
  if (fatal.length) reasons.push(`致命的リスク: ${fatal.map((f) => FLAG_LABELS[f] ?? f).join(", ")}`);
  if (expired || fatal.length) {
    const qm = c.kind === "crypto_quest" && c.quest ? questMetrics({ ...c, quest: c.quest }) : undefined;
    return { score: 0, excluded: true, expired, reasons, ...(qm ? { questMetrics: qm } : {}) };
  }

  if (c.kind === "crypto_quest" && c.quest) {
    const qm = questMetrics({ ...c, quest: c.quest });
    reasons.push(...qm.reasons);
    let score = qm.valueUnknown ? 0 : qm.netValueJpy! / qm.minutes;
    for (const f of flags) {
      const p = FLAG_PENALTY[f] ?? DEFAULT_PENALTY;
      if (score > 0) score *= p; // 赤字 (負) はそのまま
      reasons.push(`減点: ${FLAG_LABELS[f] ?? f} (×${p})`);
    }
    return { score: round2(score), excluded: false, expired: false, reasons, questMetrics: qm };
  }

  const value = Math.max(0, c.prizeValueJpy ?? 0);
  const winners = Math.max(1, c.winners ?? 1);
  const participants = Math.max(1, c.participants ?? DEFAULT_PARTICIPANTS);
  const minutes = Math.max(0.5, c.estMinutes ?? DEFAULT_MINUTES[c.kind]);
  if (c.prizeValueJpy == null) reasons.push("賞品価値不明 (0 円として計算)");
  if (c.participants == null) reasons.push(`応募者数不明 (${DEFAULT_PARTICIPANTS} 人と仮定)`);

  let score = (value * Math.min(winners, participants)) / participants / minutes;
  for (const f of flags) {
    const p = FLAG_PENALTY[f] ?? DEFAULT_PENALTY;
    score *= p;
    reasons.push(`減点: ${FLAG_LABELS[f] ?? f} (×${p})`);
  }
  return { score: Math.round(score * 100) / 100, excluded: false, expired: false, reasons };
}

// ---------------------------------------------------------------------------
// 仮想通貨クエストの詐欺チェック
// ---------------------------------------------------------------------------

/** 既知の公式ドメイン (必要に応じて拡張する) */
export const KNOWN_OFFICIAL_DOMAINS: readonly string[] = [
  "ethereum.org",
  "metamask.io",
  "uniswap.org",
  "opensea.io",
  "coinbase.com",
  "binance.com",
  "bitflyer.com",
  "coincheck.com",
  "phantom.app",
  "galxe.com",
  "zealy.io",
  "layer3.xyz",
  "questn.com",
  "taskon.xyz",
  "intract.io",
  "quest3.xyz",
  "arbitrum.io",
  "optimism.io",
  "polygon.technology",
  "solana.com",
  "x.com",
  "twitter.com",
  "discord.com",
  "discord.gg",
];

/**
 * 既知の正規クエストプラットフォーム (サブドメインも含む)。
 * クエスト URL のホストがこれに該当しなければ unknown_platform (減点のみ)。
 */
export const QUEST_PLATFORM_DOMAINS: readonly string[] = [
  "galxe.com",
  "app.galxe.com",
  "zealy.io",
  "layer3.xyz",
  "app.layer3.xyz",
  "taskon.xyz",
  "intract.io",
  "questn.com",
  "quest3.xyz",
];

export function isKnownQuestPlatform(host: string, platforms: readonly string[] = QUEST_PLATFORM_DOMAINS): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return platforms.some((d) => h === d || h.endsWith("." + d));
}

const MULTI_LEVEL_TLDS = new Set(["co.jp", "ne.jp", "or.jp", "ac.jp", "co.uk", "com.au", "com.br", "co.kr"]);

/** 簡易な登録ドメイン抽出 (Public Suffix List は使わない) */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const last2 = labels.slice(-2).join(".");
  return MULTI_LEVEL_TLDS.has(last2) ? labels.slice(-3).join(".") : last2;
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** 見た目が紛らわしい文字を正規化 (0→o, 1→l, rn→m, vv→w など) */
function deconfuse(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/0/g, "o")
    .replace(/[1i|]/g, "l")
    .replace(/5/g, "s")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/[аạ]/g, "a") // キリル文字・ベトナム語の a
    .replace(/[еẹ]/g, "e")
    .replace(/[оọ]/g, "o")
    .replace(/[рр]/g, "p")
    .replace(/с/g, "c");
}

export type DomainVerdict =
  | { kind: "official"; official: string }
  | { kind: "typosquat"; official: string; why: string }
  | { kind: "unknown" };

/** ホスト名を公式ドメイン一覧と比較する */
export function checkDomain(host: string, officials: readonly string[] = KNOWN_OFFICIAL_DOMAINS): DomainVerdict {
  const h = host.toLowerCase();
  const reg = registrableDomain(h);
  for (const o of officials) {
    if (reg === o || h === o || h.endsWith("." + o)) return { kind: "official", official: o };
  }
  if (/(^|\.)xn--/.test(h)) {
    // Punycode (IDN) は同形異字攻撃に使われやすい。公式名と似ていれば偽物扱い
    for (const o of officials) {
      const name = o.split(".")[0]!;
      if (name.length >= 4 && h.includes(name.slice(0, 3))) return { kind: "typosquat", official: o, why: "IDN (punycode) ドメイン" };
    }
  }
  const regName = reg.split(".")[0]!;
  for (const o of officials) {
    const oName = o.split(".")[0]!;
    if (oName.length < 4) continue; // x.com 等の短い名前は誤検知が多いので比較しない
    if (regName === oName) return { kind: "typosquat", official: o, why: `TLD 違い (${reg})` };
    if (deconfuse(regName) === deconfuse(oName)) return { kind: "typosquat", official: o, why: `紛らわしい文字 (${reg})` };
    const dist = levenshtein(regName, oName);
    if (dist > 0 && dist <= (oName.length >= 8 ? 2 : 1)) return { kind: "typosquat", official: o, why: `綴り違い (${reg})` };
    // uniswap-airdrop.com / claim-metamask.io のような公式名の埋め込み
    // ga1xe-claim.xyz のように紛らわしい文字で埋め込んだものも検出する
    if (regName !== oName && (regName.includes(oName) || deconfuse(regName).includes(deconfuse(oName))))
      return { kind: "typosquat", official: o, why: `公式名を含む別ドメイン (${reg})` };
  }
  return { kind: "unknown" };
}

const SEED_RE =
  /seed\s*phrase|recovery\s*phrase|secret\s*recovery|mnemonic|private\s*key|秘密鍵|シードフレーズ|リカバリーフレーズ|復元フレーズ|リカバリー?フレーズ|ニーモニック|12\s*(?:個の|words?|単語)/i;
const APPROVE_RE = /setApprovalForAll|\bincreaseAllowance\b|\bapprove\s*\(|\bapprove\b[^。.\n]{0,30}(?:token|spend|allowance|contract|wallet)|トークン[^。\n]{0,15}承認|承認[^。\n]{0,10}(?:トランザクション|署名)|\bpermit2?\b/i;
const UNLIMITED_RE =
  /unlimited\s+(?:approval|allowance|spend)|infinite\s+(?:approval|allowance)|max(?:imum)?\s+allowance|無制限|上限なし[^。\n]{0,10}承認|2\s*\^\s*256|type\(uint256\)\.max|0x[fF]{16,}|115792089237316195423570985008687907853269984665640564039457584007913129639935/i;

export interface ScamCheckInput {
  url: string;
  /** 説明文・手順・規約などクエストのテキストすべて */
  text: string;
  /** クエスト内で誘導される URL (ウォレット接続先など) */
  linkedUrls?: string[];
}

export interface ScamCheckResult {
  flags: string[];
  fatal: boolean;
  details: string[];
}

export function checkCryptoScam(
  input: ScamCheckInput,
  officials: readonly string[] = KNOWN_OFFICIAL_DOMAINS,
  platforms: readonly string[] = QUEST_PLATFORM_DOMAINS,
): ScamCheckResult {
  const flags = new Set<string>();
  const details: string[] = [];
  let mainHost: string | null = null;
  try {
    mainHost = new URL(input.url).hostname;
  } catch {
    mainHost = null;
  }
  for (const u of [input.url, ...(input.linkedUrls ?? [])]) {
    let host: string;
    try {
      host = new URL(u).hostname;
    } catch {
      continue;
    }
    const v = checkDomain(host, officials);
    if (v.kind === "typosquat") {
      flags.add("typosquat_domain");
      details.push(`${host}: ${v.official} に似た偽ドメインの疑い (${v.why})`);
    }
  }
  // 既知のクエストプラットフォーム以外 (偽ドメイン判定済みのものは除く) は要確認として減点
  if (mainHost && !flags.has("typosquat_domain") && !isKnownQuestPlatform(mainHost, platforms)) {
    flags.add("unknown_platform");
    details.push(`${mainHost}: 既知のクエストプラットフォーム (${QUEST_PLATFORM_DOMAINS.slice(0, 3).join(", ")} 等) ではありません`);
  }
  const text = input.text ?? "";
  if (SEED_RE.test(text)) {
    flags.add("seed_phrase_request");
    details.push("シードフレーズ / 秘密鍵の入力を求める記述があります (公式が求めることはありません)");
  }
  if (UNLIMITED_RE.test(text)) {
    flags.add("unlimited_approval");
    details.push("無制限のトークン承認を求める記述があります");
  }
  if (APPROVE_RE.test(text)) {
    flags.add("approval_request");
    details.push("approve / setApprovalForAll 等のトークン承認を求める記述があります");
  }
  const list = [...flags];
  return { flags: list, fatal: list.some((f) => FATAL_FLAGS.has(f)), details };
}

/** Collector 出力に詐欺チェックと採点を適用し、DB に入れる形にする */
export function evaluateCampaign(
  input: CampaignInput,
  now: Date = new Date(),
  officials: readonly string[] = KNOWN_OFFICIAL_DOMAINS,
): CampaignInput & {
  riskFlags: string[];
  score: number;
  status: "active" | "excluded" | "expired";
  reasons: string[];
  scamDetails: string[];
  questMetrics?: QuestMetrics;
} {
  const flags = new Set(input.riskFlags ?? []);
  let scamDetails: string[] = [];
  if (input.kind === "crypto_quest") {
    const c = input.conditions ?? {};
    const text = [input.title, input.prize, c.terms, c.notes, ...(c.steps ?? []).map((s) => `${s.target ?? ""} ${s.text ?? ""}`)].join("\n");
    const linked = (c.steps ?? []).map((s) => s.target ?? "").filter((t) => /^https?:\/\//.test(t));
    const scam = checkCryptoScam({ url: input.url, text, linkedUrls: linked }, officials);
    for (const f of scam.flags) flags.add(f);
    scamDetails = scam.details;
  }
  const riskFlags = [...flags];
  const r = scoreCampaign({ ...input, riskFlags, quest: input.conditions?.quest }, now);
  const status = r.expired ? "expired" : r.excluded ? "excluded" : "active";
  return {
    ...input,
    riskFlags,
    score: r.score,
    status,
    reasons: r.reasons,
    scamDetails,
    ...(r.questMetrics ? { questMetrics: r.questMetrics } : {}),
  };
}
