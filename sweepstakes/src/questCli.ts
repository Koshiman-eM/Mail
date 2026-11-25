// CLI の `quest` サブコマンド (引数パースは純粋関数としてテスト可能にする)
import { parseArgs } from "node:util";
import {
  addQuest,
  FLAG_LABELS,
  listQuests,
  QUEST_DISTRIBUTIONS,
  QUEST_REWARD_TYPES,
  updateQuest,
  type QuestDistribution,
  type QuestInput,
  type QuestMetrics,
  type QuestPatch,
  type QuestResult,
  type QuestRewardType,
  type SweepContext,
} from "./core/index.js";

export const QUEST_USAGE = `quest add <url> [オプション] [--fetch]   仮想通貨クエストを手動登録して詐欺チェック・採点
quest update <id> [オプション] [--clear <項目,...>]   登録済みクエストを更新して再採点
quest list                               期待値・時給の高い順 (価値不明は末尾)

  オプション:
    --title <文字列>          タイトル (--fetch 時は未指定ならページから補完)
    --reward-type <種別>      ${QUEST_REWARD_TYPES.join(" | ")} (既定: other)
    --amount <数値>           報酬額
    --currency <通貨>         USD | USDT | USDC | JPY | トークン記号
    --value-jpy <円>          円換算額を直接指定 (換算より優先)
    --winners <n>             当選数 / 先着枠
    --participants <n>        参加者数
    --distribution <方式>     ${QUEST_DISTRIBUTIONS.join(" | ")} (既定: raffle)
    --minutes <分>            所要時間
    --deadline <日付>         YYYY-MM-DD または ISO 8601
    --onchain / --no-onchain  オンチェーン操作 (トランザクション) が必要か
    --gas-jpy <円>            ガス代の見込み
    --notes <文字列>          メモ
    --fetch                   (add のみ) URL を 1 回だけ取得してタイトル補完・本文の詐欺チェック
    --clear <項目,...>        (update のみ) 値を消す: ${["amount", "currency", "value-jpy", "winners", "participants", "minutes", "deadline", "gas-jpy", "notes"].join(", ")}

  USD/USDT/USDC の円換算には環境変数 SWEEP_USDJPY (例: 150) が必要です。
  ウォレット署名・トランザクション・SNS 操作は自動化しません。todo の手順に従い手動で行ってください。`;

const OPTIONS = {
  title: { type: "string" },
  "reward-type": { type: "string" },
  amount: { type: "string" },
  currency: { type: "string" },
  "value-jpy": { type: "string" },
  winners: { type: "string" },
  participants: { type: "string" },
  distribution: { type: "string" },
  minutes: { type: "string" },
  deadline: { type: "string" },
  onchain: { type: "boolean" },
  "gas-jpy": { type: "string" },
  notes: { type: "string" },
  fetch: { type: "boolean" },
  clear: { type: "string" },
} as const;

const CLEARABLE: Readonly<Record<string, keyof QuestPatch>> = {
  amount: "rewardAmount",
  currency: "rewardCurrency",
  "value-jpy": "rewardValueJpy",
  winners: "winners",
  participants: "participants",
  minutes: "estMinutes",
  deadline: "deadline",
  "gas-jpy": "gasCostJpy",
  notes: "notes",
};

function num(v: string | undefined, name: string, integer = false): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v.replace(/[,_]/g, ""));
  if (v.trim() === "" || !Number.isFinite(n) || n < 0) throw new Error(`--${name} は 0 以上の数値で指定してください: ${v}`);
  if (integer && !Number.isInteger(n)) throw new Error(`--${name} は整数で指定してください: ${v}`);
  return n;
}

function parse(args: string[]) {
  return parseArgs({ args, allowPositionals: true, allowNegative: true, strict: true, options: OPTIONS });
}

type Values = ReturnType<typeof parse>["values"];

function fieldsFromValues(v: Values): QuestPatch {
  const rewardType = v["reward-type"];
  if (rewardType !== undefined && !QUEST_REWARD_TYPES.includes(rewardType as QuestRewardType)) {
    throw new Error(`--reward-type は ${QUEST_REWARD_TYPES.join(" / ")} のいずれかです`);
  }
  const distribution = v.distribution;
  if (distribution !== undefined && !QUEST_DISTRIBUTIONS.includes(distribution as QuestDistribution)) {
    throw new Error(`--distribution は ${QUEST_DISTRIBUTIONS.join(" / ")} のいずれかです`);
  }
  const out: QuestPatch = {
    title: v.title,
    rewardType: rewardType as QuestRewardType | undefined,
    rewardAmount: num(v.amount, "amount"),
    rewardCurrency: v.currency,
    rewardValueJpy: num(v["value-jpy"], "value-jpy"),
    winners: num(v.winners, "winners", true),
    participants: num(v.participants, "participants", true),
    distribution: distribution as QuestDistribution | undefined,
    estMinutes: num(v.minutes, "minutes"),
    deadline: v.deadline,
    requiresOnchainTx: v.onchain,
    gasCostJpy: num(v["gas-jpy"], "gas-jpy"),
    notes: v.notes,
  };
  for (const k of Object.keys(out) as (keyof QuestPatch)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** `quest add <url> ...` の引数をパースする */
export function parseQuestAddArgs(args: string[]): { input: QuestInput; fetch: boolean } {
  const { values, positionals } = parse(args);
  if (values.clear !== undefined) throw new Error("--clear は quest update でのみ使えます");
  const url = positionals[0];
  if (!url) throw new Error("URL を指定してください: sweep quest add <url> [オプション]");
  if (positionals.length > 1) throw new Error(`余分な引数があります: ${positionals.slice(1).join(" ")}`);
  return { input: { url, ...fieldsFromValues(values) }, fetch: values.fetch === true };
}

/** `quest update <id> ...` の引数をパースする */
export function parseQuestUpdateArgs(args: string[]): { id: number; patch: QuestPatch } {
  const { values, positionals } = parse(args);
  if (values.fetch) throw new Error("--fetch は quest add でのみ使えます");
  const id = Number(positionals[0]);
  if (!positionals[0] || !Number.isInteger(id) || id <= 0) throw new Error("ID を数値で指定してください: sweep quest update <id> [オプション]");
  if (positionals.length > 1) throw new Error(`余分な引数があります: ${positionals.slice(1).join(" ")}`);
  const patch = fieldsFromValues(values);
  if (values.clear !== undefined) {
    for (const name of values.clear.split(",").map((s) => s.trim()).filter(Boolean)) {
      const key = CLEARABLE[name];
      if (!key) throw new Error(`--clear に指定できない項目です: ${name} (${Object.keys(CLEARABLE).join(", ")})`);
      if (patch[key] !== undefined) throw new Error(`--${name} と --clear ${name} は同時に指定できません`);
      (patch as Record<string, unknown>)[key] = null;
    }
  }
  if (!Object.keys(patch).length) throw new Error("変更する項目を指定してください");
  return { id, patch };
}

const yen = (n: number): string => `${Math.round(n).toLocaleString("ja-JP")}円`;

/** 期待値・時給の表示 (価値不明はその旨を表示) */
export function formatQuestMetrics(m: QuestMetrics | null): string {
  if (!m) return "期待値: (手動登録情報なし)";
  if (m.valueUnknown) return `期待値: 価値不明 / 時給: 価値不明${m.gasCostJpy ? ` / ガス代 ${yen(m.gasCostJpy)}` : ""}`;
  return `期待値: ${yen(m.expectedValueJpy!)}${m.gasCostJpy ? ` − ガス ${yen(m.gasCostJpy)} = ${yen(m.netValueJpy!)}` : ""} / 時給: ${yen(m.hourlyJpy!)}/時 (${m.minutes}分)`;
}

const STATUS: Record<string, string> = { active: "対象", excluded: "除外", expired: "締切切れ", entered: "完了" };

function printResult(r: QuestResult, verb: string, log: (s: string) => void): void {
  const c = r.campaign;
  log(`#${c.id} を${verb}しました: ${c.title}`);
  log(`  ${c.url}`);
  log(`  状態: ${STATUS[c.status] ?? c.status} / 報酬: ${c.prize}`);
  log(`  ${formatQuestMetrics(r.metrics)}`);
  if (r.excludedReason) log(`  [除外理由] ${r.excludedReason}`);
  else if (c.riskFlags.length) log(`  [注意] ${c.riskFlags.map((f) => FLAG_LABELS[f] ?? f).join(" / ")}`);
  for (const d of r.scamDetails) log(`    - ${d}`);
  for (const w of r.warnings) log(`  [警告] ${w}`);
  if (c.status === "active") log(`  手順は sweep todo で確認し、完了したら sweep mark ${c.id}`);
}

/** `quest` サブコマンドを実行する。戻り値は終了コード */
export async function runQuestCommand(ctx: SweepContext, args: string[], log: (s: string) => void = console.log): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add": {
      const { input, fetch } = parseQuestAddArgs(rest);
      printResult(await addQuest(ctx, input, { fetch }), "登録", log);
      return 0;
    }
    case "update": {
      const { id, patch } = parseQuestUpdateArgs(rest);
      printResult(updateQuest(ctx, id, patch), "更新", log);
      return 0;
    }
    case "list": {
      const items = listQuests(ctx);
      if (!items.length) return log("仮想通貨クエストはありません"), 0;
      for (const { campaign: c, metrics } of items) {
        log(`#${c.id} [${STATUS[c.status] ?? c.status}] ${c.title}  (締切 ${c.deadline?.slice(0, 10) ?? "なし"})`);
        log(`    ${formatQuestMetrics(metrics)} / スコア ${c.score.toFixed(2)}`);
        if (c.riskFlags.length) log(`    [${c.status === "excluded" ? "除外理由" : "注意"}] ${c.riskFlags.map((f) => FLAG_LABELS[f] ?? f).join(" / ")}`);
        log(`    ${c.url}`);
      }
      return 0;
    }
    default:
      log(QUEST_USAGE);
      return sub === undefined || sub === "help" ? 0 : 1;
  }
}
