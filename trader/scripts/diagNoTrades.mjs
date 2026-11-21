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
for (const r of rows) { const d = JSON.parse(r.data); const k = String(d.reason).slice(0, 60); c[k] = (c[k] ?? 0) + 1; }
console.table(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([reason, n]) => ({ reason, n })));
console.log("== 最後の equity ==");
console.table(q("SELECT ts, mode FROM equity ORDER BY ts DESC LIMIT 2"));
