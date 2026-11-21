/**
 * trader の発注先の選び方。paper は単一の PaperBroker (src/execution/brokerSet.ts の createPaperBrokerSet)。
 * live の発注先 (実口座アダプター) はまだ無い (GMOコインは廃止。Jupiter の実弾は次の段階)ので、live は常に例外にする (fail-closed)。
 * 実口座アダプターを加えるときは、そのコンストラクタで assertLive (src/execution/guard.ts) を呼び、
 * ここの live の分岐で liveBrokerSet (venue → アダプター) を返す
 */
import type { AppConfig } from "../core/config";
import type { Instrument } from "../core/types";
import { createPaperBrokerSet, type BrokerDeps, type BrokerSet } from "./brokerSet";

export type { BrokerDeps, BrokerSet } from "./brokerSet";

/**
 * live の発注先 (実口座アダプター) が無いことを知らせる文言 (起動を止めるときに出す)。
 * GMOコインは廃止した。Solana の DEX アグリゲーター Jupiter の実弾は次の段階で実装する
 */
export const LIVE_UNSUPPORTED_MESSAGE = "live の発注先は未対応です (Jupiter の実弾は次の段階で実装予定)";

/** paper: 全 venue を単一の PaperBroker で処理。live: 実口座アダプターが無いので常に例外 */
export function createBrokers(config: Pick<AppConfig, "env" | "mode">, instruments: Instrument[], deps: BrokerDeps = {}): BrokerSet {
  if (config.mode === "live") throw new Error(LIVE_UNSUPPORTED_MESSAGE);
  return createPaperBrokerSet(config, instruments, deps);
}
