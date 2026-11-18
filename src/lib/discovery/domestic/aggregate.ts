import { D, yen, type Dec } from "../../decimal";
import type { DomesticSample } from "./types";

/** 国内価格の採用に必要な最少件数 (外れ値除去後) */
export const MIN_DOMESTIC_SAMPLES = 3;
/** 中央値に対する許容範囲 (これより安い/高い販売例は別商品・まとめ売りとみなして除外) */
export const MIN_RATIO_TO_MEDIAN = "0.3";
export const MAX_RATIO_TO_MEDIAN = "3";

export const MULTIPACK_NOTE = "まとめ売り・セット商品や付属品の価格が混ざると相場がずれることがあります。根拠の販売例を確認してください。";

export type DomesticAggregate =
  | {
      ok: true;
      /** 採用価格 (円): 外れ値除去後の下位 25% 点 (保守的に低めを採用) */
      priceJpy: string;
      medianJpy: string;
      lowerQuartileJpy: string;
      upperQuartileJpy: string;
      total: number;
      used: number;
      dropped: number;
      /** 採用した販売例 (採用価格に近い順に最大 5 件) */
      samples: DomesticSample[];
    }
  | { ok: false; reason: string; total: number; used: number };

/** 線形補間の分位点 (sorted は昇順) */
export function quantile(sorted: Dec[], p: number): Dec {
  if (!sorted.length) throw new Error("empty");
  const pos = new D(sorted.length - 1).mul(p);
  const lo = pos.floor().toNumber();
  const hi = pos.ceil().toNumber();
  return sorted[lo].add(sorted[hi].sub(sorted[lo]).mul(pos.sub(lo)));
}

/**
 * 国内の販売例から採用価格を決める (純粋関数)。
 * 1. 価格が正のものだけ
 * 2. 全体の中央値の 30% 未満・300% 超を除外 (付属品・まとめ売り対策)
 * 3. 残りが 4 件以上なら IQR の外側 (Q1 − 1.5×IQR 未満 / Q3 + 1.5×IQR 超) を除外
 * 4. 残りが 3 件未満なら採用しない (NO_DOMESTIC_PRICE)
 * 5. 採用価格は下位 25% 点 (中央値より保守的。売値を高く見積もって赤字になるのを避ける)
 */
export function aggregateDomesticPrices(samples: DomesticSample[]): DomesticAggregate {
  const valid = samples
    .map((s) => ({ s, p: safeDec(s.priceJpy) }))
    .filter((x): x is { s: DomesticSample; p: Dec } => x.p !== null && x.p.gt(0));
  const total = samples.length;
  if (valid.length < MIN_DOMESTIC_SAMPLES) {
    return { ok: false, reason: `国内の販売例が ${valid.length} 件しか見つかりませんでした (${MIN_DOMESTIC_SAMPLES} 件以上必要)`, total, used: valid.length };
  }
  const sortedAll = valid.map((x) => x.p).sort((a, b) => a.comparedTo(b));
  const m0 = quantile(sortedAll, 0.5);
  let kept = valid.filter((x) => x.p.gte(m0.mul(MIN_RATIO_TO_MEDIAN)) && x.p.lte(m0.mul(MAX_RATIO_TO_MEDIAN)));
  if (kept.length >= 4) {
    const s = kept.map((x) => x.p).sort((a, b) => a.comparedTo(b));
    const q1 = quantile(s, 0.25);
    const q3 = quantile(s, 0.75);
    const iqr = q3.sub(q1);
    const lo = q1.sub(iqr.mul("1.5"));
    const hi = q3.add(iqr.mul("1.5"));
    kept = kept.filter((x) => x.p.gte(lo) && x.p.lte(hi));
  }
  if (kept.length < MIN_DOMESTIC_SAMPLES) {
    return {
      ok: false,
      reason: `価格のばらつきが大きく、相場を判断できる販売例が ${kept.length} 件しか残りませんでした (${MIN_DOMESTIC_SAMPLES} 件以上必要)`,
      total,
      used: kept.length,
    };
  }
  const sorted = kept.map((x) => x.p).sort((a, b) => a.comparedTo(b));
  const lq = yen(quantile(sorted, 0.25));
  const median = yen(quantile(sorted, 0.5));
  const uq = yen(quantile(sorted, 0.75));
  const nearest = [...kept].sort((a, b) => a.p.sub(lq).abs().comparedTo(b.p.sub(lq).abs())).slice(0, 5).map((x) => x.s);
  return {
    ok: true,
    priceJpy: lq.toFixed(0),
    medianJpy: median.toFixed(0),
    lowerQuartileJpy: lq.toFixed(0),
    upperQuartileJpy: uq.toFixed(0),
    total,
    used: kept.length,
    dropped: valid.length - kept.length,
    samples: nearest,
  };
}

function safeDec(v: string): Dec | null {
  try {
    const d = new D(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}
