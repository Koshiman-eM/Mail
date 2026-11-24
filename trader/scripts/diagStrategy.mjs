// 指定した戦略の過去の成績 (実取引と仮想トレード) をまとめる (読み取り専用。DB を書き換えない)。
// 廃止した戦略 (mid_trend_follow・long_momentum など) の記録も DB に残っているので見られる。
// 使い方: node scripts/diagStrategy.mjs mid_trend_follow [long_momentum ...] [--db ./data/trader.db]
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "./data/trader.db";
const ids = args.filter((a, i) => !a.startsWith("--") && !(dbIdx >= 0 && i === dbIdx + 1));
if (!ids.length) {
  console.log("使い方: node scripts/diagStrategy.mjs <戦略 id> [<戦略 id> ...] [--db パス]");
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });

const fin = (x) => typeof x === "number" && Number.isFinite(x);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const fx = (x, d = 2) => (fin(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "-");
const pct = (x) => (fin(x) ? (x * 100).toFixed(0) + "%" : "-");
const pf = (rs) => {
  const g = rs.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const l = -rs.filter((r) => r < 0).reduce((s, r) => s + r, 0);
  return l > 0 ? (g / l).toFixed(2) : g > 0 ? "∞" : "-";
};
const day = (ts) => new Date(ts).toISOString().slice(0, 10);
const summary = (rs) => `${rs.length} 件 / 勝率 ${pct(rs.filter((r) => r > 0).length / rs.length)} / 平均 ${fx(avg(rs))}R / 合計 ${fx(rs.reduce((s, r) => s + r, 0), 1)}R / PF ${pf(rs)}`;
const groupPrint = (rows, keyFn, title) => {
  const m = new Map();
  for (const x of rows) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x.R);
  }
  console.log(`  ${title}:`);
  for (const [k, rs] of [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) console.log(`    ${String(k).padEnd(34)} ${summary(rs)}`);
};

for (const id of ids) {
  console.log(`\n=== ${id} ===`);
  // ───────── 実取引 (paper と live、学習から除外した記帳上の決済は除く) ─────────
  const trades = db
    .prepare("SELECT data FROM trades WHERE strategyId=? ORDER BY entryTs")
    .all(id)
    .map((r) => JSON.parse(r.data))
    .filter((t) => !t.learningExcluded && fin(Number(t.rMultiple)))
    .map((t) => ({ t, R: Number(t.rMultiple) }));
  if (!trades.length) console.log("実取引: なし");
  else {
    console.log(`実取引: ${summary(trades.map((x) => x.R))}  (${day(trades[0].t.entryTs)} 〜 ${day(trades[trades.length - 1].t.exitTs)})`);
    groupPrint(trades, (x) => `${x.t.mode}|${x.t.venue}|${x.t.assetClass}`, "mode | 取引先 | 資産クラス");
    groupPrint(trades, (x) => `${x.t.direction}${x.t.simulatedShort ? " (空売り再現)" : ""}`, "向き");
    groupPrint(trades, (x) => x.t.symbol, "銘柄");
    groupPrint(trades, (x) => x.t.entryContext?.regime?.label ?? "?", "相場の状態");
    groupPrint(trades, (x) => x.t.exitReason, "決済理由");
    groupPrint(trades, (x) => day(x.t.entryTs).slice(0, 7), "月");
    const holdH = avg(trades.map((x) => (x.t.exitTs - x.t.entryTs) / 3600e3));
    console.log(`  平均保有 ${holdH.toFixed(1)} 時間 / 勝ちの平均 ${fx(avg(trades.filter((x) => x.R > 0).map((x) => x.R)))}R / 負けの平均 ${fx(avg(trades.filter((x) => x.R <= 0).map((x) => x.R)))}R`);
    console.table(
      trades.slice(-25).map((x) => ({
        entry: day(x.t.entryTs) + new Date(x.t.entryTs).toISOString().slice(10, 16),
        mode: x.t.mode,
        sym: x.t.symbol.slice(0, 12),
        dir: x.t.direction[0] + (x.t.simulatedShort ? "*" : ""),
        regime: x.t.entryContext?.regime?.label ?? "",
        "hold(h)": ((x.t.exitTs - x.t.entryTs) / 3600e3).toFixed(1),
        exit: x.t.exitReason,
        R: fx(x.R),
      })),
    );
  }
  // ───────── 仮想トレード (見送り・観測専用・最大保有の対象外など) ─────────
  const shadows = db
    .prepare("SELECT data FROM shadow_trades WHERE strategyId=?")
    .all(id)
    .map((r) => JSON.parse(r.data))
    .filter((s) => fin(Number(s.netR)))
    .map((s) => ({ s, R: Number(s.netR) }));
  if (!shadows.length) console.log("仮想トレード: なし");
  else {
    console.log(`仮想トレード: ${summary(shadows.map((x) => x.R))}  (${day(Math.min(...shadows.map((x) => x.s.entryTs)))} 〜 ${day(Math.max(...shadows.map((x) => x.s.exitTs)))})`);
    groupPrint(shadows, (x) => String(x.s.reason).replace(/[0-9.]+/g, "#").slice(0, 34), "見送り理由");
    groupPrint(shadows, (x) => `${x.s.mode}|${x.s.assetClass}|${x.s.direction}${x.s.simulatedShort ? "*" : ""}`, "mode | 資産クラス | 向き");
    groupPrint(shadows, (x) => x.s.symbol, "銘柄");
    groupPrint(shadows, (x) => x.s.exitReason, "決済理由");
  }
  // ───────── 腕 (kv。戦略×レジーム×資産クラス) ─────────
  const armRows = db.prepare("SELECT key, value FROM kv WHERE key LIKE 'learning:%' OR key LIKE 'allocator:%' OR key LIKE 'arms:%'").all();
  const hits = [];
  for (const r of armRows) {
    try {
      const v = JSON.parse(r.value);
      const walk = (o, path) => {
        if (!o || typeof o !== "object") return;
        for (const [k, val] of Object.entries(o)) {
          if (k.startsWith(id + "|")) hits.push({ kv: r.key, arm: k, ...(val && typeof val === "object" ? { n: val.n ?? val.count ?? val.trades, mean: val.mean ?? val.meanR } : {}) });
          else walk(val, path + "." + k);
        }
      };
      walk(v, "");
    } catch {
      /* 読めない値は飛ばす */
    }
  }
  if (hits.length) {
    console.log("  腕 (kv):");
    for (const h of hits.slice(0, 20)) console.log(`    ${h.kv}  ${h.arm}  件数 ${h.n ?? "-"}  平均 ${fin(h.mean) ? h.mean.toFixed(3) : "-"}`);
  }
}
