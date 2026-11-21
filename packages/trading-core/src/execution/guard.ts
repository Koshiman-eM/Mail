/**
 * 実口座アダプターの安全ガード。
 * resolveMode() の結果が "live" で、かつ NODE_ENV=test でないときだけ生成を許可する。
 */
export interface LiveGuard {
  /** resolveMode(...).mode の結果をそのまま渡す */
  mode: "paper" | "live" | "backtest";
}

export class LiveModeRequiredError extends Error {
  constructor(adapter: string, reason: string) {
    super(`${adapter}: 実口座アダプターは生成できません (${reason})`);
    this.name = "LiveModeRequiredError";
  }
}

export function assertLive(adapter: string, g: LiveGuard | undefined): void {
  if (!g || g.mode !== "live") throw new LiveModeRequiredError(adapter, `mode=${g?.mode ?? "未指定"}`);
  if (process.env.NODE_ENV === "test") throw new LiveModeRequiredError(adapter, "NODE_ENV=test");
}
