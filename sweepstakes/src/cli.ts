#!/usr/bin/env node
// 懸賞ツール CLI (src/core の薄いラッパー)
import { parseArgs } from "node:util";
import {
  CAMPAIGN_KINDS,
  collect,
  createContext,
  enter,
  FixtureHtmlCollector,
  FLAG_LABELS,
  history,
  kindLabel,
  listCampaigns,
  mark,
  runAll,
  todo,
  type CampaignKind,
  type Collector,
  type EnterResult,
} from "./core/index.js";

const USAGE = `懸賞自動応募ツール

使い方: sweep <コマンド> [オプション]

  collect --html <file> [--html <file> ...]
                       懸賞情報を収集して採点・保存 (現在は例示用 HTML パーサーのみ)
  list [--kind <種別>]  キャンペーン一覧 (種別: ${CAMPAIGN_KINDS.join(" | ")})
  enter <id> [--submit] Webフォームに入力。既定は dry-run (送信直前で停止しスクリーンショット保存)
  run [--submit]        応募可能な Webフォーム懸賞を一括処理 (ガード適用)
  todo                  X / Instagram / 仮想通貨クエストの「今日やること」
  mark <id> [--note <メモ>]  手動タスクを完了として記録
  history [--limit <n>] 応募履歴

環境変数: SWEEP_DB, SWEEP_PROFILE, SWEEP_SCREENSHOT_DIR, SWEEP_MIN_INTERVAL_SEC,
          SWEEP_MAX_INTERVAL_SEC, SWEEP_DAILY_LIMIT, SWEEP_HEADLESS, SWEEP_CHROMIUM_PATH
`;

const STATUS_LABEL: Record<string, string> = {
  submitted: "送信済み",
  needs_manual: "要手動",
  failed: "失敗",
  skipped: "見送り",
  done_manual: "手動完了",
  dry_run: "dry-run",
  deferred: "保留(上限)",
  active: "対象",
  excluded: "除外",
  expired: "締切切れ",
  entered: "応募済み",
};

function pad(s: string, n: number): string {
  const w = [...s].reduce((acc, ch) => acc + (/[　-￿]/.test(ch) ? 2 : 1), 0);
  return s + " ".repeat(Math.max(0, n - w));
}

function printEnterResult(r: EnterResult): void {
  console.log(`#${r.campaignId} ${r.title}`);
  console.log(`  結果: ${STATUS_LABEL[r.status] ?? r.status}${r.recorded ? " (記録済み)" : ""}`);
  console.log(`  理由: ${r.reason}`);
  if (r.filled.length) {
    console.log("  入力した欄:");
    for (const f of r.filled) console.log(`    - ${f.label} [${f.key}] = ${f.value}`);
  }
  if (r.screenshotPath) console.log(`  スクリーンショット: ${r.screenshotPath}`);
}

function parseId(v: string | undefined): number {
  const n = Number(v);
  if (!v || !Number.isInteger(n) || n <= 0) throw new Error("ID を数値で指定してください");
  return n;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      submit: { type: "boolean", default: false },
      kind: { type: "string" },
      html: { type: "string", multiple: true },
      note: { type: "string" },
      limit: { type: "string" },
    },
  });
  const ctx = createContext({ log: (m) => console.log(m) });
  try {
    switch (cmd) {
      case "collect": {
        const files = values.html ?? [];
        if (!files.length) {
          console.log("収集元が指定されていません。例: sweep collect --html tests/fixtures/campaign_list.html");
          console.log("(実在サイト用の Collector は未実装です。src/core/collector.ts の Collector インターフェースで追加してください)");
          return 1;
        }
        const collectors: Collector[] = files.map((f) => new FixtureHtmlCollector(f, `html:${f}`));
        const s = await collect(ctx, collectors);
        console.log(`収集完了: ${s.total} 件 (新規 ${s.added} / 更新 ${s.updated} / 除外 ${s.excluded} / 締切切れ ${s.expired})`);
        for (const e of s.errors) console.log(`  エラー: ${e}`);
        return s.errors.length ? 1 : 0;
      }
      case "list": {
        const kind = values.kind as CampaignKind | undefined;
        if (kind && !CAMPAIGN_KINDS.includes(kind)) throw new Error(`--kind は ${CAMPAIGN_KINDS.join(" / ")} のいずれかです`);
        const items = listCampaigns(ctx, { kind });
        if (!items.length) return console.log("キャンペーンはありません"), 0;
        console.log(`${pad("ID", 5)}${pad("種別", 18)}${pad("状態", 10)}${pad("スコア", 10)}${pad("締切", 12)}タイトル`);
        for (const c of items) {
          console.log(
            `${pad(String(c.id), 5)}${pad(kindLabel(c.kind), 18)}${pad(STATUS_LABEL[c.status] ?? c.status, 10)}${pad(c.score.toFixed(2), 10)}${pad(c.deadline?.slice(0, 10) ?? "-", 12)}${c.title}`,
          );
          if (c.riskFlags.length) console.log(`     [注意] ${c.riskFlags.map((f) => FLAG_LABELS[f] ?? f).join(" / ")}`);
        }
        return 0;
      }
      case "enter": {
        const id = parseId(positionals[0]);
        if (!values.submit) console.log("[dry-run] 送信はしません。実際に送信するには --submit を付けてください");
        const r = await enter(ctx, id, { submit: values.submit });
        printEnterResult(r);
        return r.status === "failed" ? 1 : 0;
      }
      case "run": {
        if (!values.submit) console.log("[dry-run] 送信はしません。実際に送信するには --submit を付けてください");
        const results = await runAll(ctx, { submit: values.submit });
        if (!results.length) console.log("処理対象の Webフォーム懸賞はありません");
        for (const r of results) printEnterResult(r);
        const count = (s: string) => results.filter((r) => r.status === s).length;
        console.log(
          `\n合計 ${results.length} 件: 送信 ${count("submitted")} / dry-run ${count("dry_run")} / 要手動 ${count("needs_manual")} / 見送り ${count("skipped")} / 失敗 ${count("failed")} / 上限保留 ${count("deferred")}`,
        );
        return 0;
      }
      case "todo": {
        const items = todo(ctx);
        if (!items.length) return console.log("今日やることはありません"), 0;
        console.log(`今日やること (${items.length} 件、締切が近い順 → スコア順)\n`);
        items.forEach((t, i) => {
          const c = t.campaign;
          const left = t.hoursLeft === null ? "締切なし" : t.hoursLeft < 24 ? `残り ${t.hoursLeft} 時間` : `残り ${Math.floor(t.hoursLeft / 24)} 日`;
          console.log(`${i + 1}. [#${c.id}] ${kindLabel(c.kind)}: ${c.title}  (${left} / スコア ${c.score.toFixed(2)})`);
          console.log(`   ${c.url}`);
          if (c.prize) console.log(`   賞品: ${c.prize}`);
          t.steps.forEach((s, j) => console.log(`   ${j + 1}) ${s}`));
          if (t.warnings.length) console.log(`   [注意] ${t.warnings.join(" / ")}`);
          console.log(`   完了したら: sweep mark ${c.id}\n`);
        });
        return 0;
      }
      case "mark": {
        const id = parseId(positionals[0]);
        const e = mark(ctx, id, values.note ?? "手動で完了");
        console.log(`#${id} を手動完了として記録しました (${e.createdAt})`);
        return 0;
      }
      case "history": {
        const limit = values.limit ? Number(values.limit) : 50;
        const items = history(ctx, { limit });
        if (!items.length) return console.log("履歴はありません"), 0;
        for (const h of items) {
          console.log(`${h.createdAt}  ${pad(STATUS_LABEL[h.status] ?? h.status, 10)} #${h.campaignId} ${h.title}`);
          if (h.reason) console.log(`    ${h.reason}`);
        }
        return 0;
      }
      default:
        console.error(`不明なコマンドです: ${cmd}\n`);
        console.log(USAGE);
        return 1;
    }
  } finally {
    ctx.store.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`エラー: ${(e as Error).message}`);
    process.exit(1);
  },
);
