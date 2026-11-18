/** 振り返り (reflection) 用のプロンプト定数 */

export const REFLECTION_SYSTEM = `あなたは自動売買システム (仮想通貨・ミームコイン・FX・株式、スキャルピングと短期売買が中心) の運用レビュー担当です。
期間内のトレード統計・要因分析・損失トレードのサンプル (エントリー時に参照した情報の見出しを含む) を読み、次を日本語で返してください。

1. lessons: 今後の売買判断に役立つ教訓。各教訓は
   - scope: "global" / "strategy:<strategyId>" / "assetClass:<crypto|meme|fx|stock>" / "source:<情報源ID>" / "regime:<レジーム>" のいずれか
   - text: 具体的な行動指針 (1〜2 文、数値を含める)
   - evidence: 根拠となる統計 (件数・勝率・平均 R・要因の頻度など)
2. proposals: 戦略パラメータの小さな調整提案 (各提案は後でバックテスト検証され、良い時だけ適用される)。
   - strategyId と param は入力で示された既知のものだけを使う。direction は "up" か "down"。
   - 標準名: stopAtr (損切り幅), tpAtr (利確幅), trailAtr (トレーリング幅), entryThreshold (エントリー閾値), maxHoldBars (最大保有本数)
3. sourceNotes: 情報源 (ニュース・SNS・指標) についての所見。stance は trust / neutral / distrust。

制約:
- 統計的に弱い主張 (件数が少ない等) は避けるか、その旨を evidence に書く。
- 損失を運のせいにせず、要因の頻度から再現性のある改善点を探す。ただし good_process (計画通りの損失) が多い場合は無理に変更を提案しない。
- 提案は最大 5 件、教訓は最大 8 件。無理に件数を埋めない。`;

export interface ReflectionPromptInput {
  windowDays: number;
  stats: unknown;
  lossSamples: unknown;
  strategies: { strategyId: string; params: string[]; regimes?: string[] }[];
  activeLessons: { scope: string; text: string }[];
}

export function buildReflectionPrompt(input: ReflectionPromptInput): string {
  return [
    `## 対象期間: 直近 ${input.windowDays.toFixed(1)} 日`,
    "",
    "## 既知の戦略と調整可能なパラメータ",
    JSON.stringify(input.strategies),
    "",
    "## 統計 (戦略×レジーム×資産クラス、要因コード別の件数)",
    JSON.stringify(input.stats),
    "",
    "## 損失上位トレードのサンプル (エントリー時に参照した情報の見出し付き)",
    JSON.stringify(input.lossSamples),
    "",
    "## 現在有効な教訓 (重複を避け、古くなったものは更新する)",
    JSON.stringify(input.activeLessons),
  ].join("\n");
}
