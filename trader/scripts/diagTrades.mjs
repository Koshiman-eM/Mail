// 直近の取引を 1 件ずつ表示する (読み取り専用)。方向感の誤りの切り分け用。
// 使い方: node scripts/diagTrades.mjs [件数 (既定 40)] [DBパス]
import { DatabaseSync } from "node:sqlite";
const n = Number(process.argv[2] ?? 40);
const db = new DatabaseSync(process.argv[3] ?? "./data/trader.db", { readOnly: true });
const rows = db.prepare("SELECT data FROM trades WHERE mode='paper' ORDER BY exitTs DESC LIMIT ?").all(n);
const attr = db.prepare("SELECT data FROM attributions WHERE tradeId=?");
const bp = (x) => (Number.isFinite(x) ? (x * 1e4).toFixed(0) : "-");
const out = [];
for (const r of rows) {
  const t = JSON.parse(r.data);
  const a = attr.get(t.id);
  const causes = a ? (JSON.parse(a.data).causes ?? []).map((c) => c.code).join(",") : "";
  const stop = t.entryPrice > 0 ? Math.abs(t.entryPrice - t.initialStop) / t.entryPrice : NaN;
  const slip = t.intendedEntryPrice > 0 ? (t.entryPrice - t.intendedEntryPrice) / t.intendedEntryPrice * (t.direction === "long" ? 1 : -1) : NaN;
  out.push({
    time: new Date(t.exitTs).toISOString().slice(5, 16),
    sym: t.symbol.slice(0, 10),
    strat: t.strategyId.replace("scalp_", "s_").replace("short_", "sh_").slice(0, 14),
    dir: t.direction[0] + (t.simulatedShort ? "*" : ""),
    regime: t.entryContext?.regime?.label ?? "",
    "hold(m)": Math.round((t.exitTs - t.entryTs) / 60000),
    exit: t.exitReason,
    R: Number(t.rMultiple ?? 0).toFixed(2),
    "stop(bp)": bp(stop),
    "mfe(bp)": bp(t.mfePct),
    "mae(bp)": bp(t.maePct),
    "cost(bp)": Number(t.entryContext?.costBps ?? NaN).toFixed(0),
    "slip(bp)": bp(slip),
    "spr(bp)": Number(t.entryContext?.regime?.spreadBps ?? NaN).toFixed(0),
    causes,
  });
}
console.table(out.reverse());
