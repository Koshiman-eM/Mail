import type { BacktestOptions } from "../backtest/types";
import type { Env } from "../core/config";
import type { TradingMode } from "../core/types";

/**
 * 実際に利確の指値を板に置くか (LIMIT_TAKE_PROFIT)。paper 専用: live では設定が true でも無効
 * (取消の失敗・照会の遅れで損切りが止まる・過剰決済になる経路を実弾に持ち込まない)。
 * 手組みの設定で未設定なら既定値 (false) と同じ扱い
 */
export function effectiveLimitTakeProfit(env: Partial<Pick<Env, "LIMIT_TAKE_PROFIT">>, mode: TradingMode): boolean {
  return mode !== "live" && (env.LIMIT_TAKE_PROFIT ?? false) === true;
}

/**
 * 設定 (LIMIT_ENTRY / LIMIT_TAKE_PROFIT / LIMIT_ENTRY_TIMEOUT_MS) からバックテストの指値の前提を作る
 * (CLI backtest・パラメータ検証が実運用と同じ前提で判断するため)。
 * 利確の指値は、その mode で実際に有効なときだけ前提にする (live では常に成行の利確 = エンジンと同じ)。
 * 手組みの設定で未設定なら既定値 (LIMIT_ENTRY は true、LIMIT_TAKE_PROFIT は false) と同じ扱い
 */
export function limitOrdersFromEnv(
  env: Partial<Pick<Env, "LIMIT_ENTRY" | "LIMIT_TAKE_PROFIT" | "LIMIT_ENTRY_TIMEOUT_MS">>,
  mode: TradingMode,
): NonNullable<BacktestOptions["limitOrders"]> {
  return {
    entry: env.LIMIT_ENTRY ?? true,
    takeProfit: effectiveLimitTakeProfit(env, mode),
    ...(env.LIMIT_ENTRY_TIMEOUT_MS !== undefined ? { entryTimeoutMs: env.LIMIT_ENTRY_TIMEOUT_MS } : {}),
  };
}
