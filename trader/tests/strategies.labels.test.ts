import { describe, expect, it } from "vitest";
import { ALL_STRATEGIES, configuredStrategies } from "../src/strategies/registry";
import { armLabel, HORIZON_LABELS, STRATEGY_LABELS, strategyLabel, strategyLabelWithId } from "../src/strategies/labels";
import { structureSettingsFromEnv } from "../src/structure/settings";
import { coreConfig as loadConfig } from "../src/testing/runtime";

describe("戦略の表示名 (表示専用。id は変えない)", () => {
  it("全戦略に表示名があり、long / short / ロング / ショート を含まない", () => {
    for (const s of ALL_STRATEGIES) {
      const label = STRATEGY_LABELS[s.id];
      expect(label, s.id).toBeTruthy();
      expect(label).not.toMatch(/long|short|ロング|ショート/i);
    }
    for (const label of [...Object.values(STRATEGY_LABELS), ...Object.values(HORIZON_LABELS)]) {
      expect(label).not.toMatch(/long|short|ロング|ショート/i);
    }
  });

  it("表示名の先頭は時間軸の表示名", () => {
    for (const s of ALL_STRATEGIES) {
      expect(STRATEGY_LABELS[s.id].startsWith(HORIZON_LABELS[s.horizon]), s.id).toBe(true);
    }
  });

  it("相場構造のラッパーを掛けても同じ id (同じ表示名)", () => {
    const wrapped = configuredStrategies(structureSettingsFromEnv(loadConfig({ STRUCTURE_MODE: "filter" }).env));
    expect(wrapped.map((s) => s.id)).toEqual(ALL_STRATEGIES.map((s) => s.id));
    for (const s of wrapped) expect(strategyLabel(s.id)).toBe(STRATEGY_LABELS[s.id]);
  });

  it("押し目買い・戻り売りの 3 つ (1 分足・5 分足・15 分足) は時間足で区別する。表示名は重複しない", () => {
    expect(strategyLabel("scalp_pullback")).toBe("超短期・押し目買い / 戻り売り (1 分足)");
    expect(strategyLabel("pullback_5m")).toBe("短期・押し目買い / 戻り売り (5 分足)");
    expect(strategyLabel("pullback_15m")).toBe("短期・押し目買い / 戻り売り (15 分足)");
    expect(strategyLabelWithId("pullback_5m")).toBe("短期・押し目買い / 戻り売り (5 分足) [pullback_5m]");
    expect(armLabel("pullback_15m|trend_down|crypto|short")).toBe("短期・押し目買い / 戻り売り (15 分足) / 下降トレンド / crypto / 空売り (paper 再現)");
    const ids = ALL_STRATEGIES.map((s) => s.id);
    for (const id of ["scalp_pullback", "pullback_5m", "pullback_15m"]) expect(ids).toContain(id);
    const labels = ALL_STRATEGIES.map((s) => STRATEGY_LABELS[s.id]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("未知の id はそのまま、id 併記は [id] を付ける", () => {
    expect(strategyLabel("unknown_x")).toBe("unknown_x");
    expect(strategyLabelWithId("unknown_x")).toBe("unknown_x");
    expect(strategyLabelWithId("short_breakout")).toBe("短期・ブレイクアウト (1 時間足) [short_breakout]");
    // 廃止した戦略 (古い記録の腕・取引) は id のまま表示する
    for (const id of ["mid_trend_follow", "long_momentum", "meme_momentum"]) {
      expect(strategyLabel(id)).toBe(id);
      expect(strategyLabelWithId(id)).toBe(id);
    }
    expect(armLabel("long_momentum|trend_up|crypto")).toBe("long_momentum / 上昇トレンド / crypto");
    expect(Object.keys(STRATEGY_LABELS).sort()).toEqual(ALL_STRATEGIES.map((s) => s.id).sort());
  });

  it("腕のキーを日本語にし、末尾の |short は「空売り (paper 再現)」にする", () => {
    expect(armLabel("short_breakout|trend_up|crypto")).toBe("短期・ブレイクアウト (1 時間足) / 上昇トレンド / crypto");
    expect(armLabel("short_breakout|range|crypto|short")).toBe("短期・ブレイクアウト (1 時間足) / レンジ / crypto / 空売り (paper 再現)");
    expect(armLabel("weird")).toBe("weird");
    expect(armLabel("a|b|c|d")).toBe("a|b|c|d");
  });
});
