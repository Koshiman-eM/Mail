// short_ema_trend の「急騰の天井を押し目と誤認して買う」仮説の確認 (読み取り専用。DB を書き換えない)。
// 使い方: node scripts/diagEmaTrend.mjs [--strategy short_ema_trend] [--all] [--db ./data/trader.db]
//   既定は paper の全期間 (リセット前も含む。件数を確保するため)。--since-reset で最新のリセット以降だけ。
//
// エントリー時の記録 (entryContext.features の ema9 / ema21 / adx / plusDI / minusDI / structOshiYasune と
// params.stopAtr、regime) から次の指標を計算し、指標の大小で 3 つに分けて成績を比べる。
//   - ATR (推定) = |基準価格 − 当初の損切り| / stopAtr  (基準価格 = エントリーの仲値。無ければ想定の約定価格)
//     ※ STRUCTURE_STOP_MODE=structure の取引は損切りが動いているので推定がずれる (既定は existing)
//   - EMA21 乖離 = (基準価格 − EMA21) / ATR   … 大きいほど平均から離れた (伸びた) ところで買っている
//   - EMA9 乖離  = (基準価格 − EMA9) / ATR
//   - 損切り幅 % = |基準価格 − 損切り| / 基準価格 … 大きいほど ATR が膨らんだ局面 (急騰の後)
//   - 押し安値までの距離 = (基準価格 − 押し安値) / ATR (構造フィルターの記録がある取引だけ)
//   - ボラのパーセンタイル (regime.volatilityPercentile) / ADX / +DI − −DI
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const strategy = opt("--strategy") ?? "short_ema_trend";
const db = new DatabaseSync(opt("--db") ?? "./data/trader.db", { readOnly: true });
let since = 0;
if (args.includes("--since-reset")) {
  const r = db.prepare("SELECT value FROM kv WHERE key='paper:resets'").get();
  const resets = r ? JSON.parse(r.value) : [];
  since = resets.reduce((m, x) => Math.max(m, x.at ?? 0), 0);
}

const fin = (x) => typeof x === "number" && Number.isFinite(x);
const rows = [];
for (const r of db.prepare("SELECT data FROM trades WHERE mode='paper' AND strategyId=? AND exitTs>=? ORDER BY entryTs").all(strategy, since)) {
  const t = JSON.parse(r.data);
  if (t.learningExcluded || t.direction !== "long") continue;
  const ctx = t.entryContext ?? {};
  const f = ctx.features ?? {};
  const stopAtr = Number(ctx.params?.stopAtr);
  const ref = fin(t.entryMid) && t.entryMid > 0 ? t.entryMid : t.intendedEntryPrice > 0 ? t.intendedEntryPrice : t.entryPrice;
  const stopDist = Math.abs(ref - t.initialStop);
  const atr = stopAtr > 0 ? stopDist / stopAtr : NaN;
  rows.push({
    t,
    cls: t.assetClass,
    R: Number(t.rMultiple),
    win: t.netPnl > 0,
    ext21: fin(f.ema21) && atr > 0 ? (ref - f.ema21) / atr : NaN,
    ext9: fin(f.ema9) && atr > 0 ? (ref - f.ema9) / atr : NaN,
    stopPct: ref > 0 ? (stopDist / ref) * 100 : NaN,
    oshi: fin(f.structOshiYasune) && f.structOshiYasune > 0 && atr > 0 ? (ref - f.structOshiYasune) / atr : NaN,
    volPct: Number(ctx.regime?.volatilityPercentile),
    adx: Number(f.adx),
    di: fin(f.plusDI) && fin(f.minusDI) ? f.plusDI - f.minusDI : NaN,
    regime: ctx.regime?.label ?? "?",
  });
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const fx = (x, d = 2) => (fin(x) ? x.toFixed(d) : "-");
const pct = (x) => (fin(x) ? (x * 100).toFixed(0) + "%" : "-");

console.log(`=== ${strategy} の買い: 「伸びすぎ」の指標と成績 (paper${since ? "、最新のリセット以降" : "、全期間"}) ===`);
const byCls = {};
for (const x of rows) (byCls[x.cls] ??= []).push(x);
for (const [c, g] of Object.entries(byCls)) console.log(`${c}: ${g.length} 件 / 勝率 ${pct(g.filter((x) => x.win).length / g.length)} / 平均 ${fx(avg(g.map((x) => x.R)))}R / 合計 ${fx(g.reduce((s, x) => s + x.R, 0), 1)}R`);
if (rows.length < 6) {
  console.log("件数が少ないため集計しません");
  process.exit(0);
}

// 指標ごとに 3 つ (小・中・大) に分けて比べる。勝ちと負けの平均も出す
const metrics = [
  ["ext21", "EMA21 乖離 (ATR)"],
  ["ext9", "EMA9 乖離 (ATR)"],
  ["stopPct", "損切り幅 (%)"],
  ["oshi", "押し安値までの距離 (ATR)"],
  ["volPct", "ボラのパーセンタイル"],
  ["adx", "ADX"],
  ["di", "+DI − −DI"],
];
for (const cls of [...Object.keys(byCls), "全部"]) {
  const g0 = cls === "全部" ? rows : byCls[cls];
  if (g0.length < 6) continue;
  console.log(`\n--- ${cls} (${g0.length} 件) ---`);
  console.log("指標                       勝ちの平均  負けの平均 | 小さい 1/3: 範囲 / 件 / 勝率 / 平均R | 中 1/3 | 大きい 1/3");
  for (const [k, name] of metrics) {
    const g = g0.filter((x) => fin(x[k])).sort((a, b) => a[k] - b[k]);
    if (g.length < 6) {
      console.log(`${name.padEnd(22)} (記録が ${g.length} 件のため省略)`);
      continue;
    }
    const w = g.filter((x) => x.win).map((x) => x[k]);
    const l = g.filter((x) => !x.win).map((x) => x[k]);
    const third = (i) => g.slice(Math.floor((g.length * i) / 3), Math.floor((g.length * (i + 1)) / 3));
    const cell = (s) =>
      `${fx(s[0][k], 1)}〜${fx(s[s.length - 1][k], 1)} / ${s.length} / ${pct(s.filter((x) => x.win).length / s.length)} / ${fx(avg(s.map((x) => x.R)))}`;
    console.log(`${name.padEnd(22)} ${fx(avg(w)).padStart(9)}  ${fx(avg(l)).padStart(9)} | ${cell(third(0))} | ${cell(third(1))} | ${cell(third(2))}`);
  }
}

console.log("\n--- 1 件ずつ (エントリー順) ---");
console.table(
  rows.map((x) => ({
    entry: new Date(x.t.entryTs).toISOString().slice(5, 16),
    sym: x.t.symbol.slice(0, 10),
    cls: x.cls,
    regime: x.regime,
    exit: x.t.exitReason,
    R: fx(x.R),
    ext21: fx(x.ext21, 1),
    ext9: fx(x.ext9, 1),
    "stop%": fx(x.stopPct, 1),
    oshi: fx(x.oshi, 1),
    volPct: fx(x.volPct),
    adx: fx(x.adx, 0),
  })),
);
