/**
 * 情報の効き具合 (intelInfluence) の重み付き更新。
 *
 * SourceReliabilityTracker.updateInfluence (reliability.ts) は決済済みトレードだけで更新する (重み 1)。
 * 計画の片側バイアス (directionBias) で止めたシグナルは取引にならないため、そのままでは
 * 「情報に逆らったら実は良かった」という結果が情報の効き具合に戻らない。
 * ここでは direction_bias の仮想トレードの結果を、同じ kv キー・同じ尺度 (x = 情報バイアス × 方向, y = R) で
 * 控えめな重み (既定 0.25) で入れる。
 *
 * 重み w = 1 のときは reliability.ts の updateInfluence と同じ式になる:
 * - 件数 n には w を足す (重み付きの件数。縮小推定 n / (n + influencePriorN) に使う)
 * - 係数は序盤 w / n (重み付き単純平均)、以降は influenceAlpha × w
 * reliability.ts は別の担当が編集中のため、既存関数を書き換えずに別ファイルの関数として追加している。
 */
import type { AssetClass, Store, TradingMode } from "../core/types";
import { intelInfluenceKey, type IntelInfluenceState, type ReliabilityOptions } from "./reliability";

/** 仮想トレード由来の更新の件数・重みの合計 (表示・確認用。無ければ 0) */
export type WeightedInfluenceState = IntelInfluenceState & { shadowN?: number; shadowW?: number };

/** 仮想トレード 1 件の既定の重み (実際の取引は 1) */
export const DEFAULT_INFLUENCE_SHADOW_WEIGHT = 0.25;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * 情報の効き具合を重み w の観測 (x, y) で更新する。x = 情報バイアス (sentiment) × 取引方向 (+1 / −1)、y = R。
 * 不正な値・重み 0 以下は何もしない。更新後の状態を返す
 */
export function observeInfluenceWeighted(
  store: Store,
  mode: TradingMode,
  opts: Pick<ReliabilityOptions, "influenceAlpha" | "influencePriorN" | "maxInfluence" | "rClip">,
  assetClass: AssetClass,
  xRaw: number,
  rRaw: number,
  w: number,
  now: number,
): WeightedInfluenceState | undefined {
  if (!Number.isFinite(xRaw) || !(w > 0) || !Number.isFinite(w)) return undefined;
  const x = xRaw;
  const y = clamp(Number.isFinite(rRaw) ? rRaw : 0, -opts.rClip, opts.rClip);
  const key = intelInfluenceKey(mode, assetClass);
  const st: WeightedInfluenceState = store.kvGet<WeightedInfluenceState>(key) ?? {
    n: 0, mx: 0, my: 0, vx: 0, vy: 0, cxy: 0, corr: 0, value: 1, updatedAt: now,
  };
  st.n += w;
  const a = Math.min(1, Math.max(w / st.n, opts.influenceAlpha * w));
  const dx = x - st.mx;
  const dy = y - st.my;
  st.mx += a * dx;
  st.my += a * dy;
  st.vx = (1 - a) * (st.vx + a * dx * dx);
  st.vy = (1 - a) * (st.vy + a * dy * dy);
  st.cxy = (1 - a) * (st.cxy + a * dx * dy);
  st.corr = st.vx > 1e-12 && st.vy > 1e-12 ? clamp(st.cxy / Math.sqrt(st.vx * st.vy), -1, 1) : 0;
  const shrink = st.n / (st.n + opts.influencePriorN);
  st.value = clamp(1 + st.corr * shrink, 0, opts.maxInfluence);
  st.shadowN = (st.shadowN ?? 0) + 1;
  st.shadowW = (st.shadowW ?? 0) + w;
  st.updatedAt = now;
  store.kvSet(key, st);
  return { ...st };
}
