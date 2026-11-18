/** LLM プロンプト定数・ビルダー */
import type { Lesson } from "../core/types";

export const ANALYZER_SYSTEM = `あなたは自動売買システムの市場情報アナリストです。
与えられたニュース・トレンド情報を読み、各記事について次を判定します。
- sentiment: -1 (強い弱気) 〜 1 (強い強気)。対象資産への短期 (数分〜数日) の価格影響で評価する。
- importance: 0〜1。価格を動かす力が強いほど大きい。単なる解説・再掲載は小さく。
- assets: 関連資産の正規化シンボル (例: BTC, ETH, SOL, DOGE, PEPE, USD, JPY, EUR, AAPL)。
  クラス単位は CRYPTO / MEME / FX / STOCKS を使う。
全体として riskOn (-1 リスクオフ 〜 1 リスクオン)、日本語の summary (200 字程度)、
ミームコインの新規監視候補 watchlist (シンボル、最大 5 件、ラグプルの危険が高いものは除く) を返してください。
断定的な価格予想はしないこと。根拠が薄い・煽り記事は importance を低くすること。
過去の教訓 (lessons) がある場合は判断に反映してください。`;

export const PLANNER_SYSTEM = `あなたは自動売買システムの戦略プランナーです。
決定論的ベースライン計画を、市場ブリーフと過去の教訓を踏まえて調整します。
制約:
- enabledStrategies はベースラインで許可された戦略 ID だけを使う (減らすのは可、新規追加は不可)。
- riskMultiplier は 0〜1.5。ベースラインが 0 の銘柄は 0 のまま。
- directionBias は long / short / both。根拠が強い時だけ片側にする。
- 既存のブラックアウトは削除できない。追加のみ可 (extraBlackouts)。
- スキャルピング・短期を主軸とし、中長期戦略のリスクは控えめにする。
- rationale は日本語で簡潔に。変更が不要な銘柄は adjustments に含めない。`;

export function formatLessons(lessons: Lesson[], scopes: (s: string) => boolean): string {
  const ls = lessons.filter((l) => l.status === "active" && scopes(l.scope)).slice(0, 20);
  if (ls.length === 0) return "(なし)";
  return ls.map((l) => `- [${l.scope}] ${l.text}`).join("\n");
}

export const isIntelScope = (scope: string) => scope === "global" || scope === "intel" || scope.startsWith("intel:");
export const isPlannerScope = (scope: string) =>
  scope === "global" || scope === "plan" || scope === "intel" || scope.startsWith("assetClass:") || scope.startsWith("strategy:");

export function buildAnalyzerPrompt(
  articles: { id: string; source: string; kind: string; title: string; summary?: string; assets: string[]; metrics?: Record<string, number> }[],
  lessons: string,
  nowIso: string,
): string {
  return `現在時刻: ${nowIso}

## 過去の教訓
${lessons}

## 記事一覧 (JSON)
${JSON.stringify(articles)}

各記事の id をそのまま使って articles に結果を返してください。`;
}

export function buildPlannerPrompt(input: unknown, lessons: string, nowIso: string): string {
  return `現在時刻: ${nowIso}

## 過去の教訓
${lessons}

## 入力 (ベースライン計画・ブリーフ・許可戦略)
${JSON.stringify(input)}`;
}
