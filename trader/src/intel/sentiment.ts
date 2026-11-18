/** API キー無し時のフォールバック: キーワード辞書による sentiment / importance 推定 (純粋関数) */
import type { IntelItem } from "../core/types";

type Entry = [RegExp, number];

const EN: Entry[] = [
  [/\bsurg\w*/, 0.6], [/\bsoar\w*/, 0.6], [/\brall(?:y|ies|ied)\b/, 0.5], [/\bjump\w*/, 0.4], [/\bskyrocket\w*/, 0.7],
  [/\betf (?:approv\w*|green ?light)/, 0.8], [/\bapprov(?:al|ed)\b/, 0.3], [/\brecord high\b/, 0.7], [/\ball-time high\b/, 0.7],
  [/\bath\b/, 0.5], [/\bbullish\b/, 0.5], [/\bbreakout\b/, 0.4], [/\badoption\b/, 0.3], [/\bpartnership\b/, 0.3],
  [/\bupgrade\w*/, 0.3], [/\bgains?\b/, 0.3], [/\brate cuts?\b/, 0.4], [/\binflows?\b/, 0.4], [/\baccumulat\w*/, 0.3],
  [/\blists? on\b|\bnew listing\b/, 0.4], [/\bbeats? (?:expectations|estimates)\b/, 0.4],
  [/\bhack(?:s|ed|ing|er|ers)?\b/, -0.8], [/\bexploit(?:s|ed)?\b/, -0.8], [/\bban(?:s|ned|ning)?\b/, -0.6],
  [/\blawsuits?\b/, -0.6], [/\bsec sues\b/, -0.8], [/\bsues?\b|\bsued\b/, -0.5], [/\brug[- ]?pull\w*|\brugged\b|\brug\b/, -0.9],
  [/\bdelist\w*/, -0.8], [/\bcrash\w*/, -0.7], [/\bplunge\w*|\bplummet\w*/, -0.7], [/\btumbl\w*|\bslump\w*/, -0.5],
  [/\bsell-?off\b/, -0.6], [/\bbearish\b/, -0.5], [/\boutflows?\b/, -0.4], [/\bbankrupt\w*|\binsolven\w*/, -0.9],
  [/\bfraud\w*/, -0.8], [/\bscam\w*/, -0.7], [/\bliquidations?\b/, -0.4], [/\brate hikes?\b/, -0.4],
  [/\binvestigat\w*/, -0.4], [/\brecord low\b/, -0.6], [/\bfears?\b/, -0.3], [/\bwarns?\b|\bwarning\b/, -0.3],
  [/\bmisses? (?:expectations|estimates)\b/, -0.4], [/\barrest\w*/, -0.6],
];
const JP: Entry[] = [
  [/急騰/, 0.7], [/高騰/, 0.6], [/上昇/, 0.5], [/最高値/, 0.7], [/承認/, 0.4], [/好調/, 0.4], [/利下げ/, 0.4], [/反発/, 0.4],
  [/急落/, -0.7], [/暴落/, -0.8], [/下落/, -0.5], [/破綻/, -0.9], [/ハッキング/, -0.8], [/流出/, -0.6], [/禁止/, -0.6],
  [/規制/, -0.3], [/訴訟/, -0.6], [/上場廃止/, -0.8], [/詐欺/, -0.8], [/利上げ/, -0.4], [/逮捕/, -0.6],
];

/** 重要度を上げる固有名詞・イベント */
const HIGH_IMPACT = /\b(?:sec|fed|fomc|etf|binance|coinbase|blackrock|cpi|nfp|boj|ecb|tether)\b|日銀|ビットコインetf/;
const NEG_BEFORE = /(?:\bnot|\bno|\bnever|\bwithout|n't|\bfail(?:s|ed)? to|\bunlikely to|\bdenies|\bdenied|\brejects?|\brejected)\s+(?:\w+\s+){0,2}$/;
const NEG_AFTER_JP = /^.{0,3}(?:ない|せず|しない|否定)/;
const NEGATION_FACTOR = -0.6;

export interface SentimentResult {
  sentiment: number;
  importance: number;
}

export function estimateSentiment(rawText: string): SentimentResult {
  const text = rawText.toLowerCase();
  let sum = 0;
  let mass = 0;
  const scan = (entries: Entry[], jp: boolean) => {
    for (const [re, score] of entries) {
      const m = re.exec(text);
      if (!m) continue;
      let s = score;
      const negated = jp
        ? NEG_AFTER_JP.test(text.slice(m.index + m[0].length, m.index + m[0].length + 6))
        : NEG_BEFORE.test(text.slice(Math.max(0, m.index - 24), m.index));
      if (negated) s *= NEGATION_FACTOR;
      sum += s;
      mass += Math.abs(score);
    }
  };
  scan(EN, false);
  scan(JP, true);
  const sentiment = Math.max(-1, Math.min(1, Math.tanh(sum)));
  let importance = 0.15 + Math.min(0.55, mass * 0.35);
  if (HIGH_IMPACT.test(text)) importance += 0.2;
  return { sentiment, importance: Math.max(0, Math.min(1, importance)) };
}

/** sentiment/importance が未設定の項目だけ埋める (既存値は保持)。入力は変更しない */
export function applyFallbackSentiment(items: IntelItem[]): IntelItem[] {
  return items.map((it) => {
    if (it.sentiment !== undefined && it.importance !== undefined) return it;
    // メトリクス・カレンダーは本文センチメントを持たない
    if (it.kind === "metric" || it.kind === "calendar") return { ...it, importance: it.importance ?? 0.3 };
    const r = estimateSentiment(`${it.title} ${it.summary ?? ""}`);
    return { ...it, sentiment: it.sentiment ?? r.sentiment, importance: it.importance ?? r.importance };
  });
}
