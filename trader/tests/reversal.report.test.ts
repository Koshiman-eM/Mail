/** 転換で決済の集計・表示 (report / simulate / status)、要因分析・ParamTuner での扱い。すべて合成データ (オフライン) */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReportText, main } from "../src/cli";
import { loadConfig } from "../src/appConfig";
import { isSignalLikeExit, type EntryContext, type TradeRecord } from "../src/core/types";
import { EXIT_REASON_LABEL, renderReversalTable, summarizeReversal, tpCaptureOf } from "../src/engine/report";
import { formatSimulationReport, runSimulation } from "../src/simulation";
import { reversalDetailLabel } from "../src/engine/reversalExit";
import { thesisOutcomeOf } from "../src/engine/thesis";
import { attributeTrade } from "../src/learning/attribution";
import { TUNER_RULES } from "../src/learning/tuner";
import { MemoryStore } from "../src/storage/memory";
import { SqliteStore } from "../src/storage/sqlite";

const M = 60_000;
const T0 = Date.UTC(2026, 0, 5);

const ctx: EntryContext = {
  regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
  confidence: 0.6, expectedEdgeBps: 30, costBps: 10, params: {}, features: {}, riskMultiplier: 1, reason: "test",
};

/** 建値 100・損切り 97 (1R = 3)・利確 106 (2R)。exit は決済価格、fees は手数料 */
function trade(id: string, o: Partial<TradeRecord> & { exit?: number; fees?: number } = {}): TradeRecord {
  const dir = o.direction === "short" ? -1 : 1;
  const exit = o.exit ?? 102;
  const fees = o.fees ?? 0.2;
  const gross = dir * (exit - 100);
  const net = gross - fees;
  const { exit: _e, ...rest } = o;
  return {
    id, mode: "paper", symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", strategyId: "s", horizon: "scalp", direction: "long", qty: 1,
    entryTs: T0, entryPrice: 100, intendedEntryPrice: 100, exitTs: T0 + 15 * M, exitPrice: exit, intendedExitPrice: exit,
    initialStop: dir === 1 ? 97 : 103, takeProfit: dir === 1 ? 106 : 94, grossPnl: gross, fees, netPnl: net, returnPct: net / 100, rMultiple: net / 3,
    mfePct: 0.04, maePct: 0.005, exitReason: "reversal", entryContext: ctx, ...rest,
  };
}

const TRADES: TradeRecord[] = [
  // 押し安値割れ (買い): 含み益で決済 2 件 (うち 1 件は手数料負け)、含み損で 1 件
  trade("l1", { exit: 103 }), // 値動き +3 (利確まで 6 のうち 50%)、純 +2.8
  trade("l2", { exit: 100.1 }), // 値動き +0.1、純 −0.1 (負け)
  trade("l3", { exit: 99 }), // 値動き −1、純 −1.2
  // 戻り高値超え (売り): 含み益 1 件
  trade("s1", { direction: "short", exit: 97 }), // 値動き +3 (利確まで 6 のうち 50%)、純 +2.8
  // ほかの決済理由は数えない
  trade("tp", { exitReason: "take_profit", exit: 106 }),
];

describe("転換で決済の集計と表示", () => {
  it("表示名: 転換で決済 (買いは押し安値割れ / 売りは戻り高値超え)", () => {
    expect(EXIT_REASON_LABEL.reversal).toBe("転換で決済");
    expect(reversalDetailLabel("long")).toBe("押し安値割れ");
    expect(reversalDetailLabel("short")).toBe("戻り高値超え");
    expect(EXIT_REASON_LABEL.signal).toBe("シグナル");
  });

  it("方向別と合計: 件数・勝率・純損益・平均R・含み益で決済・勝ちの取引の利確までの距離のうち取れた割合", () => {
    const s = summarizeReversal(TRADES, () => 1);
    expect(s.rows.map((r) => [r.key, r.label, r.trades])).toEqual([
      ["long", "押し安値割れ (買い)", 3],
      ["short", "戻り高値超え (売り)", 1],
      ["total", "合計", 4],
    ]);
    const long = s.rows[0];
    expect(long.wins).toBe(1);
    expect(long.winRate).toBeCloseTo(1 / 3, 9);
    expect(long.netPnl).toBeCloseTo(2.8 - 0.1 - 1.2, 9);
    expect(long.avgR).toBeCloseTo((2.8 - 0.1 - 1.2) / 3 / 3, 9);
    // 含み益で決済 = 値動きでプラス (手数料前): l1 と l2
    expect(long.inProfit).toBe(2);
    // 勝ち (l1) の取れた割合: 値動き 3 / 利確まで 6 = 50%
    expect(long.tpCapture).toBeCloseTo(0.5, 9);
    expect(long.tpCaptureN).toBe(1);
    expect(s.total).toMatchObject({ trades: 4, wins: 2, inProfit: 3, tpCaptureN: 2 });
    expect(s.total.tpCapture).toBeCloseTo(0.5, 9);
    expect(tpCaptureOf(TRADES[3])).toBeCloseTo(0.5, 9);
    expect(tpCaptureOf({ ...TRADES[0], takeProfit: undefined })).toBeNaN();
  });

  it("表 (report / simulate 共通) と、0 件のときの表示", () => {
    const text = renderReversalTable(summarizeReversal(TRADES, () => 1), "JPY");
    expect(text).toMatch(/区分\s+取引数\s+勝率\s+純損益\(JPY\)\s+平均R\s+含み益で決済\s+利確までの距離のうち取れた割合 \(勝ち\)/);
    expect(text).toMatch(/押し安値割れ \(買い\)\s+3\s+33\.3%\s+\+1\s+0\.17\s+2 件\s+50\.0% \(1 件\)/);
    expect(text).toMatch(/合計\s+4\s+50\.0%/);
    expect(text).toContain("値動きの R ÷ 計画の利確の R");
    expect(renderReversalTable(summarizeReversal([TRADES[4]], () => 1), "JPY")).toBe("  (転換で決済した取引はまだありません)");
    // 空売り (paper 再現) は注記する
    const sim = renderReversalTable(summarizeReversal([...TRADES, trade("ss", { direction: "short", simulatedShort: true, exit: 98 })], () => 1), "JPY");
    expect(sim).toContain("うち空売り (paper 再現) 1 件");
  });

  it("report に「転換で決済」の節を出し、決済理由にも表示名を使う", () => {
    const store = new MemoryStore();
    for (const t of TRADES) store.saveTrade(t);
    const text = buildReportText(loadConfig({ NODE_ENV: "test", DB_PATH: "memory" }), store, T0 + 86_400_000);
    expect(text).toContain("■ 転換で決済 (REVERSAL_EXIT 有効)");
    expect(text).toMatch(/押し安値割れ \(買い\)\s+3/);
    expect(text).toMatch(/決済理由: .*転換で決済 4/);
    const off = buildReportText(loadConfig({ NODE_ENV: "test", DB_PATH: "memory", REVERSAL_EXIT: "false" }), store, T0 + 86_400_000);
    // 無効でも過去の取引の集計は出す
    expect(off).toContain("■ 転換で決済 (REVERSAL_EXIT 無効)");
    expect(off).toMatch(/合計\s+4/);
  });

  it("要因分析・ParamTuner: シグナル決済と同じ扱い (決済後にさらに伸びたら early_exit → tp_raise の根拠)", () => {
    expect(isSignalLikeExit("reversal")).toBe(true);
    expect(isSignalLikeExit("signal")).toBe(true);
    expect(isSignalLikeExit("stop")).toBe(false);
    const rule = TUNER_RULES.find((r) => r.id === "tp_raise")!;
    for (const exitReason of ["signal", "reversal"] as const) {
      const t = trade(`ee-${exitReason}`, { exitReason, exit: 101, postExitMovePct: 0.05 });
      const a = attributeTrade(t, { now: T0 });
      const early = a.causes.find((c) => c.code === "early_exit");
      expect(early).toBeDefined();
      expect(early!.evidence).toContain(exitReason === "reversal" ? "転換で決済後に" : "シグナル決済後に");
      expect(rule.evidence(t, a)).toBe(true);
    }
    // 時間切れの扱い (time_decay) にはしない
    const small = trade("td", { exit: 100.05, fees: 0, mfePct: 0.001 });
    expect(attributeTrade(small, { now: T0 }).causes.map((c) => c.code)).not.toContain("time_decay");
  });

  it("読みの答え合わせ: 期限前の転換で決済は「期限前に決着」、延長後なら延長", () => {
    expect(thesisOutcomeOf("reversal", false)).toBe("none");
    expect(thesisOutcomeOf("reversal", true)).toBe("extended");
  });
});

describe("simulate / status", () => {
  it("simulate: 「転換で決済」の節と設定。集計の件数は reversal の取引数と同じ。REVERSAL_EXIT=false なら reversal は 0 件", async () => {
    for (const on of [true, false]) {
      const store = new MemoryStore();
      const { report } = await runSimulation({
        hours: 2, stepMs: 30_000, seed: 2, store, env: { NODE_ENV: "test", TARGET_ENTRIES_PER_HOUR: "6", MAX_HOLD_MINUTES: "30", REVERSAL_EXIT: String(on) },
      });
      const trades = store.listTrades();
      const rev = trades.filter((t) => t.exitReason === "reversal").length;
      expect(report.reversal?.settings.enabled).toBe(on);
      expect(report.reversal!.summary.total.trades).toBe(rev);
      if (!on) expect(rev).toBe(0);
      const text = formatSimulationReport(report);
      expect(text).toContain(on ? "■ 転換で決済 (有効 (戦略の主時間足の 1 つ下の時間足のスイング 左右 3 本" : "■ 転換で決済 (無効 (従来どおり))");
    }
  }, 120_000);

  it("status: REVERSAL_* の設定を出す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reversal-status-"));
    const dbPath = join(dir, "t.db");
    // VENUES=synthetic では合成データ用の DB (<ベース名>-synthetic.db) を読む (既定の VENUES は jupiter)
    new SqliteStore(join(dir, "t-synthetic.db")).close();
    const keys = ["DB_PATH", "TRADING_MODE", "VENUES", "REVERSAL_EXIT", "REVERSAL_EXIT_PIVOT_N", "REVERSAL_EXIT_BUFFER_ATR", "REVERSAL_EXIT_STRATEGIES", "REVERSAL_EXIT_TF"];
    const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.DB_PATH = dbPath;
    delete process.env.TRADING_MODE;
    process.env.VENUES = "synthetic";
    process.env.REVERSAL_EXIT = "true";
    process.env.REVERSAL_EXIT_PIVOT_N = "4";
    process.env.REVERSAL_EXIT_BUFFER_ATR = "0.2";
    process.env.REVERSAL_EXIT_STRATEGIES = "scalp_pullback";
    delete process.env.REVERSAL_EXIT_TF;
    const out: string[] = [];
    const err: string[] = [];
    try {
      const code = await main(["status"], { out: (s) => out.push(s), err: (s) => err.push(s) });
      expect(err.join("\n")).toBe("");
      expect(code).toBe(0);
    } finally {
      for (const [k, v] of Object.entries(old)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
    const text = out.join("\n");
    expect(text).toContain(
      "転換で決済 (REVERSAL_EXIT): 有効 (戦略の主時間足の 1 つ下の時間足のスイング 左右 4 本 / 終値が水準を 0.2 ATR より大きく越えたら決済 / 対象 scalp_pullback)" +
        " — REVERSAL_EXIT=true / REVERSAL_EXIT_PIVOT_N=4 / REVERSAL_EXIT_BUFFER_ATR=0.2 / REVERSAL_EXIT_STRATEGIES=scalp_pullback",
    );
  });
});
