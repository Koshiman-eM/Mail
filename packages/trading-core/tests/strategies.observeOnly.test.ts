/** 観測専用 (OBSERVE_ONLY_STRATEGIES) の指定の解釈: `<id>` (全資産クラス) と `<id>:<資産クラス>` (そのクラスだけ) */
import { describe, expect, it } from "vitest";
import { formatObserveOnly, isObserveOnly, observeOnlyScope, observeOnlyWarnings, parseObserveOnly } from "../src/strategies/observeOnly";
import { DEFAULT_OBSERVE_ONLY_STRATEGIES } from "../src/core/config";

const KNOWN = ["scalp_rebound", "short_ema_trend", "scalp_micro"];

describe("parseObserveOnly / isObserveOnly", () => {
  it("id だけは全資産クラス、id:クラス はそのクラスだけ", () => {
    const r = parseObserveOnly(["scalp_rebound", "short_ema_trend:meme"], ["crypto", "meme"]);
    expect(isObserveOnly(r, "scalp_rebound", "crypto")).toBe(true);
    expect(isObserveOnly(r, "scalp_rebound", "meme")).toBe(true);
    expect(isObserveOnly(r, "short_ema_trend", "meme")).toBe(true);
    expect(isObserveOnly(r, "short_ema_trend", "crypto")).toBe(false);
    expect(isObserveOnly(r, "scalp_micro", "meme")).toBe(false);
  });

  it("既定は scalp_rebound (全クラス) と short_ema_trend の meme だけ", () => {
    const r = parseObserveOnly(DEFAULT_OBSERVE_ONLY_STRATEGIES.split(","), ["crypto", "meme"]);
    expect(isObserveOnly(r, "short_ema_trend", "meme")).toBe(true);
    expect(isObserveOnly(r, "short_ema_trend", "crypto")).toBe(false);
    expect(isObserveOnly(r, "scalp_rebound", "crypto")).toBe(true);
    expect(formatObserveOnly(r)).toBe("観測専用 (OBSERVE_ONLY_STRATEGIES): scalp_rebound (全クラス), short_ema_trend (meme のみ)");
    expect(observeOnlyScope(r, "short_ema_trend")).toBe("meme のみ");
    expect(observeOnlyScope(r, "scalp_rebound")).toBe("全クラス");
    expect(observeOnlyScope(r, "scalp_micro")).toBeUndefined();
  });

  it("空の一覧なら観測専用なし", () => {
    const r = parseObserveOnly([], ["crypto", "meme"]);
    expect(isObserveOnly(r, "scalp_rebound", "crypto")).toBe(false);
    expect(formatObserveOnly(r)).toBe("観測専用 (OBSERVE_ONLY_STRATEGIES): なし");
  });

  it("語彙に無い・有効でない資産クラスの指定は無視する (例外にしない)。クラスの大文字小文字は問わない", () => {
    const r = parseObserveOnly(["short_ema_trend:fx", "scalp_micro:memes", "scalp_rebound:MEME", ":meme", "short_ema_trend:"], ["crypto", "meme"]);
    expect(isObserveOnly(r, "short_ema_trend", "fx")).toBe(false);
    expect(isObserveOnly(r, "short_ema_trend", "crypto")).toBe(false);
    expect(isObserveOnly(r, "scalp_micro", "meme")).toBe(false);
    expect(isObserveOnly(r, "scalp_rebound", "meme")).toBe(true);
    expect(isObserveOnly(r, "scalp_rebound", "crypto")).toBe(false);
    expect(r.all.size).toBe(0);
  });
});

describe("observeOnlyWarnings", () => {
  it("既定・正しい指定は警告なし", () => {
    expect(observeOnlyWarnings("OBSERVE_ONLY_STRATEGIES", DEFAULT_OBSERVE_ONLY_STRATEGIES.split(","), KNOWN, ["crypto", "meme"])).toEqual([]);
  });

  it("未登録・廃止した id (クラス付きでも)・使えない資産クラス・id の無い指定を警告する", () => {
    const w = observeOnlyWarnings(
      "OBSERVE_ONLY_STRATEGIES", ["short_ema_trend:fx", "short_ema_trnd:meme", "long_momentum:crypto", "scalp_micro:memes", ":meme"], KNOWN, ["crypto", "meme"],
    );
    expect(w).toEqual([
      "OBSERVE_ONLY_STRATEGIES に廃止した戦略 id があります (無視されます): long_momentum",
      "OBSERVE_ONLY_STRATEGIES に未登録の戦略 id があります (無視されます): short_ema_trnd",
      "OBSERVE_ONLY_STRATEGIES に使えない資産クラスの指定があります (無視されます。使えるのは crypto / meme): short_ema_trend:fx, scalp_micro:memes",
      "OBSERVE_ONLY_STRATEGIES に戦略 id の無い指定があります (無視されます): :meme",
    ]);
  });
});
