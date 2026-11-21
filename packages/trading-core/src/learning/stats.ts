/**
 * 学習の合否・差し戻し判定に使う統計検定 (純粋関数, number で計算する。会計値ではない)。
 * - 符号検定 (区間ごとの勝ち負け): signTestPValue
 * - Welch の t 検定 (平均の差, 分散が等しいと仮定しない): welchLessPValue
 * - 2 標本の比率の差の z 検定: proportionGreaterPValue
 */

export interface SampleStats {
  n: number;
  mean: number;
  /** 不偏分散 (n - 1 で割る)。n < 2 なら 0 */
  variance: number;
}

/** 有限値だけで平均・不偏分散を計算する */
export function sampleStats(xs: readonly number[]): SampleStats {
  const v = xs.filter((x) => Number.isFinite(x));
  const n = v.length;
  if (n === 0) return { n: 0, mean: 0, variance: 0 };
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, variance };
}

/** 標準正規分布の累積分布関数 (Abramowitz-Stegun 7.1.26 の erf 近似, 誤差 < 1.5e-7) */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** ln Γ(x) (Lanczos 近似, x > 0) */
function lnGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** 正則化不完全ベータ関数の連分数 (Numerical Recipes betacf) */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** 正則化不完全ベータ関数 I_x(a, b) */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student の t 分布 (自由度 df) の累積分布関数 */
export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  if (!(df > 0)) return normalCdf(t);
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/**
 * 符号検定の片側 p 値: 勝ち wins / 負け losses (引き分けは除く) のとき、
 * 「勝ちと負けが同じ確率 (二項分布 p = 0.5)」の下で勝ちが wins 回以上になる確率。
 * 比較できる区間が無ければ 1。
 */
export function signTestPValue(wins: number, losses: number): number {
  const n = wins + losses;
  if (n <= 0) return 1;
  let p = 0;
  // C(n, k) / 2^n を対数で足す (n は区間数なので小さいが、念のため桁あふれを避ける)
  for (let k = wins; k <= n; k++) p += Math.exp(lnChoose(n, k) - n * Math.LN2);
  return Math.min(1, p);
}

function lnChoose(n: number, k: number): number {
  return lnFactorial(n) - lnFactorial(k) - lnFactorial(n - k);
}
function lnFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

export interface WelchResult {
  t: number;
  df: number;
  /** 片側 p 値 (H1: a の平均 < b の平均) */
  p: number;
}

/**
 * Welch の t 検定 (片側, H1: mean(a) < mean(b))。
 * 両方の分散が 0 のときは平均の大小だけで決める (差があれば p = 0、なければ 1)。
 * どちらかの件数が 2 未満なら検定できないので p = 1。
 */
export function welchLessPValue(a: SampleStats, b: SampleStats): WelchResult {
  if (a.n < 2 || b.n < 2) return { t: 0, df: 0, p: 1 };
  const va = Math.max(0, a.variance) / a.n;
  const vb = Math.max(0, b.variance) / b.n;
  const se2 = va + vb;
  if (!(se2 > 0)) {
    const lower = a.mean < b.mean;
    return { t: lower ? -Infinity : 0, df: a.n + b.n - 2, p: lower ? 0 : 1 };
  }
  const t = (a.mean - b.mean) / Math.sqrt(se2);
  // Welch-Satterthwaite の自由度
  const denom = (va * va) / (a.n - 1) + (vb * vb) / (b.n - 1);
  const df = denom > 0 ? (se2 * se2) / denom : a.n + b.n - 2;
  return { t, df, p: studentTCdf(t, df) };
}

/**
 * 2 標本の比率の z 検定 (片側, H1: x1/n1 > x2/n2)。プールした比率で標準誤差を計算する。
 * どちらかの件数が 0、またはプール比率が 0 / 1 (差が出ようがない) なら p = 1。
 */
export function proportionGreaterPValue(x1: number, n1: number, x2: number, n2: number): number {
  if (!(n1 > 0) || !(n2 > 0)) return 1;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pool = (x1 + x2) / (n1 + n2);
  if (!(pool > 0) || !(pool < 1)) return 1;
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  return 1 - normalCdf((p1 - p2) / se);
}
