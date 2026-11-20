/**
 * 戦略・時間軸・腕のキーの「表示名」 (人間向けの表示専用)。
 *
 * 戦略 id (long_momentum / short_breakout など) の long / short は「長期 / 短期」の時間軸であって、
 * 売買の向き (買い / 売り) ではない。紛らわしいので、画面・レポートでは日本語の表示名を使う。
 * id・kv キー・env の値・ジャーナルの項目・腕のキーは一切変えない (学習データの互換性のため)。
 * 表示名に long / short / ロング / ショート を入れない (テストで検査する)。
 */
import type { RegimeLabel } from "../core/types";

/** 戦略 id → 表示名 (ラッパー (相場構造フィルター) は id を変えないので、同じ表示名が使える) */
export const STRATEGY_LABELS: Record<string, string> = {
  scalp_obi: "超短期・板の偏り",
  scalp_vwap_revert: "超短期・VWAP への回帰",
  scalp_momentum_burst: "超短期・急な動きに追随",
  scalp_micro: "超短期・瞬間の勢い",
  scalp_rebound: "超短期・下げの中の反発買い",
  scalp_pullback: "超短期・押し目買い / 戻り売り",
  short_ema_trend: "短期・EMA トレンド (15 分足)",
  short_rsi_revert: "短期・RSI 逆張り (15 分足)",
  short_breakout: "短期・ブレイクアウト (1 時間足)",
  mid_trend_follow: "中期・トレンドフォロー (4 時間足)",
  long_momentum: "長期・モメンタム (日足)",
  meme_momentum: "ミームコイン・勢い",
};

/** 戦略の表示名。未知の id は id そのまま */
export function strategyLabel(id: string): string {
  return STRATEGY_LABELS[id] ?? id;
}

/** 表示名と id を並べる (環境変数の設定は id で書くので、設定に関わる表示で使う)。例: 長期・モメンタム (日足) [long_momentum] */
export function strategyLabelWithId(id: string): string {
  return id in STRATEGY_LABELS ? `${STRATEGY_LABELS[id]} [${id}]` : id;
}

/** 時間軸 (Horizon) の表示名 */
export const HORIZON_LABELS: Record<string, string> = { scalp: "超短期", short: "短期", mid: "中期", long: "長期" };

/** 時間軸の表示名。未知の値はそのまま */
export function horizonLabel(h: string): string {
  return HORIZON_LABELS[h] ?? h;
}

/** レジーム (相場の状態) の表示名 */
export const REGIME_LABEL_JA: Record<RegimeLabel, string> = {
  trend_up: "上昇トレンド",
  trend_down: "下降トレンド",
  range: "レンジ",
  high_vol: "荒い値動き",
  low_liquidity: "流動性が低い",
};

/** paper で再現した空売りの腕の接尾辞 (learning/allocator.ts の SIMULATED_SHORT_ARM_SUFFIX と同じ値。循環参照を避けて持つ) */
const SIM_SHORT_SUFFIX = "|short";
const SIM_SHORT_TEXT = "空売り (paper 再現)";

/**
 * 腕のキー `<戦略>|<レジーム>|<資産クラス>[|short]` の表示名。
 * 例: `short_breakout|trend_up|crypto|short` → 短期・ブレイクアウト (1 時間足) / 上昇トレンド / crypto / 空売り (paper 再現)
 * 形が想定と違うキーはそのまま返す (表示だけの関数なので例外にしない)
 */
export function armLabel(key: string): string {
  const parts = key.split("|");
  if (parts.length < 3 || parts.length > 4) return key;
  const [strategy, regime, assetClass, tail] = parts;
  if (parts.length === 4 && `|${tail}` !== SIM_SHORT_SUFFIX) return key;
  const out = [strategyLabel(strategy), (REGIME_LABEL_JA as Record<string, string>)[regime] ?? regime, assetClass];
  if (parts.length === 4) out.push(SIM_SHORT_TEXT);
  return out.join(" / ");
}
