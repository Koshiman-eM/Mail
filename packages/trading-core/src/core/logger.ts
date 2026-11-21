/** 最小限の構造化ロガー。テスト中は warn 以上のみ出力 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = (): number =>
  ORDER[(process.env.LOG_LEVEL as Level) ?? (process.env.NODE_ENV === "test" ? "warn" : "info")] ?? 20;

function emit(level: Level, scope: string, msg: string, data?: Record<string, unknown>) {
  if (ORDER[level] < threshold()) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const out = data && Object.keys(data).length ? `${line} ${JSON.stringify(data)}` : line;
  (level === "error" || level === "warn" ? console.error : console.log)(out);
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, d?: Record<string, unknown>) => emit("debug", scope, m, d),
    info: (m: string, d?: Record<string, unknown>) => emit("info", scope, m, d),
    warn: (m: string, d?: Record<string, unknown>) => emit("warn", scope, m, d),
    error: (m: string, d?: Record<string, unknown>) => emit("error", scope, m, d),
  };
}
export type Logger = ReturnType<typeof createLogger>;
