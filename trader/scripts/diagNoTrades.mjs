// 取引が出ない原因の切り分け (読み取り専用)。使い方: node scripts/diagNoTrades.mjs [DBパス]
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2] ?? "./data/trader.db", { readOnly: true });
const since = Date.now() - 8 * 3600e3;
const q = (s, ...a) => db.prepare(s).all(...a);
console.log("== 直近8hの audit 種別 ==");
console.table(q("SELECT type, COUNT(*) n FROM audit WHERE ts>? GROUP BY type ORDER BY n DESC LIMIT 25", since));
console.log("== risk.reject の理由 ==");
const rows = q("SELECT data FROM audit WHERE type='risk.reject' AND ts>?", since);
const c = {};
for (const r of rows) { const e = JSON.parse(r.data); const d = e.data ?? e; const k = String(d.reason).replace(/[0-9.]+/g, '#').slice(0, 70); c[k] = (c[k] ?? 0) + 1; }
console.table(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([reason, n]) => ({ reason, n })));
console.log("== engine.skip_summary (見送り理由の合計) ==");
const sk = {};
for (const r of q("SELECT data FROM audit WHERE type='engine.skip_summary' AND ts>?", since)) {
  const e = JSON.parse(r.data); const rs = (e.data ?? e).reasons ?? {};
  for (const [k, v] of Object.entries(rs)) sk[k.slice(0, 70)] = (sk[k.slice(0, 70)] ?? 0) + (v.count ?? 1);
}
console.table(Object.entries(sk).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([reason, n]) => ({ reason, n })));
console.log("== 最後の equity ==");
console.table(q("SELECT ts, mode FROM equity ORDER BY ts DESC LIMIT 2"));
