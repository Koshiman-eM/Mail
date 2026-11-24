// 成績の原因分析 (読み取り専用。DB を書き換えない)。
// 使い方: node scripts/diagReport.mjs [--all | --days N] [--db ./data/trader.db]
//   既定は paper の最新の口座リセット以降。R はすべて当初リスク (|建値 − 当初ストップ|) 比。
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const db = new DatabaseSync(opt("--db") ?? "./data/trader.db", { readOnly: true });
const kv = (k) => {
  const r = db.prepare("SELECT value FROM kv WHERE key=?").get(k);
  return r ? JSON.parse(r.value) : undefined;
};

let since = 0;
let label = "全期間";
if (opt("--days")) {
  since = Date.now() - Number(opt("--days")) * 86400e3;
  label = `直近 ${opt("--days")} 日`;
} else if (!args.includes("--all")) {
  const resets = kv("paper:resets") ?? [];
  const last = resets.reduce((a, b) => (!a || b.at >= a.at ? b : a), undefined);
  if (last) {
    since = last.at;
    label = `最新のリセット (${new Date(last.at).toISOString().slice(0, 16)}Z) 以降`;
  }
}

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : NaN);
const avg = (a) => {
  const v = a.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
};
const sum = (a) => a.filter(Number.isFinite).reduce((s, x) => s + x, 0);
const f = (x, d = 2) => (Number.isFinite(x) ? (x >= 0 ? " " : "") + x.toFixed(d) : "   -");
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "-");
const pad = (s, n) => {
  s = String(s);
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - w));
};
const lpad = (s, n) => " ".repeat(Math.max(0, n - String(s).length)) + s;

// ───────── 取引 ─────────
const trades = db
  .prepare("SELECT data FROM trades WHERE mode='paper' AND exitTs>=? ORDER BY exitTs")
  .all(since)
  .map((r) => JSON.parse(r.data))
  .filter((t) => !t.learningExcluded);

const enrich = (t) => {
  const dir = t.direction === "long" ? 1 : -1;
  const riskPx = Math.abs(t.entryPrice - t.initialStop);
  const qty = num(t.qty);
  const riskAmt = riskPx * qty * (t.contractSize ?? 1);
  const mid = num(t.entryMid);
  const stopPct = t.entryPrice > 0 ? riskPx / t.entryPrice : NaN;
  const entryCostR = mid > 0 && riskPx > 0 ? (dir * (t.entryPrice - mid)) / riskPx : NaN;
  const exitSlipR = t.intendedExitPrice > 0 && riskPx > 0 ? (dir * (t.intendedExitPrice - t.exitPrice)) / riskPx : NaN;
  const grossR = riskAmt > 0 ? t.grossPnl / riskAmt : NaN;
  const feeR = riskAmt > 0 ? t.fees / riskAmt : NaN;
  const mfeR = Number.isFinite(num(t.mfeMidPct)) && stopPct > 0 ? t.mfeMidPct / stopPct : stopPct > 0 ? t.mfePct / stopPct : NaN;
  const maeR = Number.isFinite(num(t.maeMidPct)) && stopPct > 0 ? t.maeMidPct / stopPct : stopPct > 0 ? t.maePct / stopPct : NaN;
  return {
    t, R: num(t.rMultiple), grossR, feeR, entryCostR, exitSlipR,
    // 仲値で見た値動き (エントリーのコストを足し戻す。決済側のスプレッドは含んだまま)
    moveR: grossR + (Number.isFinite(entryCostR) ? entryCostR : 0),
    mfeR, maeR, stopBps: stopPct * 1e4, holdMin: (t.exitTs - t.entryTs) / 60000,
    costBps: num(t.entryContext?.costBps), edgeBps: num(t.entryContext?.expectedEdgeBps),
    win: t.netPnl > 0,
  };
};
const rows = trades.map(enrich);

const line = (name, g) =>
  [
    pad(name, 30), lpad(g.length, 4), lpad(pct(g.filter((x) => x.win).length / g.length), 5),
    lpad(f(avg(g.map((x) => x.R))), 6), lpad(f(sum(g.map((x) => x.R)), 1), 7),
    lpad(f(avg(g.map((x) => x.moveR))), 6), lpad(f(avg(g.map((x) => x.entryCostR))), 6), lpad(f(avg(g.map((x) => x.feeR))), 6),
    lpad(f(avg(g.map((x) => x.mfeR))), 6), lpad(f(avg(g.map((x) => x.maeR))), 6), lpad(avg(g.map((x) => x.holdMin)).toFixed(0), 5),
  ].join(" ");
const header = () =>
  console.log(
    [pad("", 30), lpad("件", 4), lpad("勝率", 5), lpad("平均R", 6), lpad("合計R", 7), lpad("値動R", 6), lpad("入口R", 6), lpad("手数R", 6), lpad("MFE", 6), lpad("MAE", 6), lpad("分", 5)].join(" "),
  );
const groupBy = (arr, key) => {
  const m = new Map();
  for (const x of arr) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return [...m.entries()].sort((a, b) => sum(a[1].map((x) => x.R)) - sum(b[1].map((x) => x.R)));
};

console.log(`=== 成績の原因分析 (${label}, paper) ===`);
console.log("R = 当初リスク比。値動R = 仲値で見た値動き (エントリーのコストを除く)、入口R = エントリーのコスト (スプレッド・価格影響)、手数R = 手数料");
console.log("MFE / MAE = 最大含み益 / 最大含み損 (R、仲値)。平均R ≈ 値動R − 入口R − 手数R (決済側のずれは値動Rに含む)\n");
if (!rows.length) console.log("取引がありません");
else {
  const usd = sum(trades.filter((t) => /\/USDC?$/.test(t.symbol)).map((t) => t.netPnl));
  console.log(`取引 ${rows.length} 件 / 勝率 ${pct(rows.filter((x) => x.win).length / rows.length)} / 平均 ${f(avg(rows.map((x) => x.R)))}R / 合計 ${f(sum(rows.map((x) => x.R)), 1)}R / 純損益 (USDC 建て) ${usd.toFixed(2)}`);
  const wins = rows.filter((x) => x.win), losses = rows.filter((x) => !x.win);
  console.log(`勝ちの平均 ${f(avg(wins.map((x) => x.R)))}R / 負けの平均 ${f(avg(losses.map((x) => x.R)))}R / 損益分岐の勝率 ${pct(Math.abs(avg(losses.map((x) => x.R))) / (Math.abs(avg(losses.map((x) => x.R))) + avg(wins.map((x) => x.R))))}`);
  console.log(`損切り幅の中央値 ${[...rows.map((x) => x.stopBps)].sort((a, b) => a - b)[Math.floor(rows.length / 2)].toFixed(0)}bps / 往復コストの平均 ${avg(rows.map((x) => x.costBps)).toFixed(0)}bps / 期待値幅の平均 ${avg(rows.map((x) => x.edgeBps)).toFixed(0)}bps\n`);

  console.log("--- 全体 ---");
  header();
  console.log(line("全体", rows));
  console.log("\n--- 戦略 × 資産クラス × 向き ---");
  header();
  for (const [k, g] of groupBy(rows, (x) => `${x.t.strategyId}|${x.t.assetClass}|${x.t.direction === "long" ? "買" : "売"}`)) console.log(line(k, g));
  console.log("\n--- 決済理由 ---");
  header();
  for (const [k, g] of groupBy(rows, (x) => x.t.exitReason + (x.t.breakevenStopExit ? "(建値)" : x.t.thesisStopExit ? "(読み)" : ""))) console.log(line(k, g));
  console.log("\n--- 相場の状態 (エントリー時) ---");
  header();
  for (const [k, g] of groupBy(rows, (x) => `${x.t.entryContext?.regime?.label ?? "?"}|${x.t.assetClass}`)) console.log(line(k, g));
  console.log("\n--- 銘柄 (損失の大きい順に 10) ---");
  header();
  for (const [k, g] of groupBy(rows, (x) => x.t.symbol).slice(0, 10)) console.log(line(k, g));
  console.log("\n--- 時間帯 (UTC、4 時間ごと) ---");
  header();
  for (const [k, g] of groupBy(rows, (x) => {
    const h = new Date(x.t.entryTs).getUTCHours();
    const b = Math.floor(h / 4) * 4;
    return `${String(b).padStart(2, "0")}-${String(b + 4).padStart(2, "0")}時`;
  })) console.log(line(k, g));
  console.log("\n--- MFE (最大含み益) の分布: どこまで伸びてから負けたか ---");
  const buckets = [[-Infinity, 0.25], [0.25, 0.5], [0.5, 1], [1, 2], [2, Infinity]];
  for (const [lo, hi] of buckets) {
    const g = rows.filter((x) => x.mfeR >= lo && x.mfeR < hi);
    if (!g.length) continue;
    console.log(`MFE ${lo === -Infinity ? "<" : lo + "〜"}${hi === Infinity ? "" : hi}R: ${g.length} 件 / 勝率 ${pct(g.filter((x) => x.win).length / g.length)} / 平均 ${f(avg(g.map((x) => x.R)))}R`);
  }
}

// ───────── 仮想トレード (見送った・観測専用のシグナルの結果) ─────────
const shadows = db
  .prepare("SELECT data FROM shadow_trades WHERE mode='paper' AND exitTs>=?")
  .all(since)
  .map((r) => JSON.parse(r.data));
console.log(`\n--- 仮想トレード (見送ったシグナルが実際どうなったか) ${shadows.length} 件 ---`);
console.log(pad("理由 / 戦略", 44) + lpad("件", 5) + lpad("勝率", 6) + lpad("平均R", 7) + lpad("合計R", 8));
const sg = new Map();
for (const s of shadows) {
  const reason = String(s.reason).replace(/[0-9.]+/g, "#").slice(0, 22);
  const k = `${reason} / ${s.strategyId}|${s.assetClass}`;
  if (!sg.has(k)) sg.set(k, []);
  sg.get(k).push(s);
}
for (const [k, g] of [...sg.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 15)) {
  const r = g.map((s) => num(s.netR));
  console.log(pad(k, 44) + lpad(g.length, 5) + lpad(pct(g.filter((s) => s.netR > 0).length / g.length), 6) + lpad(f(avg(r)), 7) + lpad(f(sum(r), 1), 8));
}

// ───────── 見送り ─────────
const rejects = db.prepare("SELECT data FROM audit WHERE type='risk.reject' AND ts>=?").all(since);
const rc = new Map();
for (const r of rejects) {
  const e = JSON.parse(r.data);
  const d = e.data ?? e;
  const k = String(d.reason).replace(/[0-9.]+/g, "#").slice(0, 50);
  rc.set(k, (rc.get(k) ?? 0) + 1);
}
console.log(`\n--- リスク管理の見送り ${rejects.length} 件 (上位) ---`);
for (const [k, n] of [...rc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(lpad(n, 6) + "  " + k);
