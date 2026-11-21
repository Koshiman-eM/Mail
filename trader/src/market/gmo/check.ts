/**
 * `npm run trader -- gmo check`: GMOコインの API の応答の形を確かめる (ユーザーがサーバーで実際の応答を確認するため)。
 *
 * - 公開 API (status / symbols / ticker / orderbooks / klines 1min・15min・4hour) を銘柄ごとに 1 回ずつ呼ぶ。
 * - GMO_API_KEY / GMO_API_SECRET があれば、非公開の読み取り専用 API (account/margin・positionSummary・activeOrders・
 *   latestExecutions) だけを呼ぶ。注文・取消 (POST) は絶対に呼ばない (GmoClient の GET の関数しか使わない)。
 * - キーや秘密情報は表示しない。想定と違う項目は「項目名: 内容」で表示する (GmoShapeError の issues)。
 */
import { redactSecrets } from "../../core/http";
import { GmoApiError, GmoClient, GmoShapeError, gmoToUnified, parseGmoSymbols, type GmoClientOptions } from "./client";
import { utcDayKey } from "../fileCandles";

export interface GmoCheckOptions {
  env: { GMO_API_KEY?: string; GMO_API_SECRET?: string; GMO_SYMBOLS?: string };
  out: (s: string) => void;
  /** テスト用 */
  clientOptions?: Omit<GmoClientOptions, "apiKey" | "apiSecret" | "allowPost">;
  now?: number;
}

const HOUR = 3_600_000;
const JST = 9 * HOUR;
const jstTime = (ms: number) => `${new Date(ms + JST).toISOString().slice(0, 16).replace("T", " ")} JST`;

function describeError(e: unknown): string[] {
  if (e instanceof GmoShapeError) return ["応答の形が想定と違います:", ...e.issues.map((i) => `  - ${i}`)];
  if (e instanceof GmoApiError) return [`取引所のエラー: ${e.message}`];
  return [`失敗: ${redactSecrets(e instanceof Error ? e.message : String(e))}`];
}

/**
 * check 用のクライアント。POST は許可しない (allowPost を false で上書きする) = 注文・取消は送信前に例外になる。
 * キーは非公開 API の読み取り (GET) だけに使う
 */
export function createGmoCheckClient(env: GmoCheckOptions["env"], clientOptions?: GmoCheckOptions["clientOptions"]): GmoClient {
  const key = env.GMO_API_KEY ?? "";
  const secret = env.GMO_API_SECRET ?? "";
  const hasKey = key !== "" && secret !== "";
  return new GmoClient({ ...(clientOptions ?? {}), ...(hasKey ? { apiKey: key, apiSecret: secret } : {}), allowPost: false });
}

/**
 * 公式資料と未照合の前提 (要確認)。`gmo check` の最後に表示する (応答の形では確かめられないので、資料・サポートで確かめる)
 */
export const GMO_UNVERIFIED_ITEMS: readonly string[] = [
  "timeInForce SOK (Post-only) は取引所現物だけで、レバレッジ銘柄では使えない想定。指値のエントリーは SOK を付けない通常の LIMIT (既定の FAS) で送る (post-only 無し)",
  "レバレッジ取引の取引手数料は maker / taker とも 0 の想定 (post-only でなくてもコストは変わらない)。建玉の管理料 (GMO_LEVERAGE_FEE_DAILY) は別",
  "clientOrderId は無い想定。orderId が分からない注文は発注時刻・方向・数量で有効注文と最近の約定 (latestExecutions は直近 1 日分の想定) から探す",
  "positionSummary の sumOrderQuantity は決済注文中の数量の想定 (決済できる数量 = 建玉 − sumOrderQuantity)",
  "executions の fee は正が支払い・負が受け取りの想定。executionType LIMIT の約定は maker とみなす",
  "account/margin の actualProfitLoss を評価額、availableAmount を余力として使う",
];

/** 結果が 0 なら全部想定どおり、1 なら想定と違う項目か失敗がある */
export async function runGmoCheck(o: GmoCheckOptions): Promise<number> {
  const out = o.out;
  const key = o.env.GMO_API_KEY ?? "";
  const secret = o.env.GMO_API_SECRET ?? "";
  const hasKey = key !== "" && secret !== "";
  const client = createGmoCheckClient(o.env, o.clientOptions);
  const symbols = parseGmoSymbols(o.env.GMO_SYMBOLS || "BTC_JPY,ETH_JPY,XRP_JPY");
  const now = o.now ?? Date.now();
  let problems = 0;

  /** 1 項目を確かめて表示する。成功時の要約を返す関数を受け取る */
  const step = async <T>(label: string, fn: () => Promise<T>, summary: (v: T) => string): Promise<T | undefined> => {
    try {
      const v = await fn();
      out(`  OK  ${label}: ${summary(v)}`);
      return v;
    } catch (e) {
      problems++;
      const [head, ...rest] = describeError(e);
      out(`  NG  ${label}: ${head}`);
      for (const l of rest) out(`      ${l}`);
      return undefined;
    }
  };

  out("GMOコイン API の応答の確認 (注文・取消は呼びません。キーは表示しません)");
  out(`対象のレバレッジ銘柄: ${symbols.join(", ")}`);
  out("");
  out("[公開 API]");
  await step("GET /v1/status", () => client.getStatus(), (v) => `status=${v.status}`);
  const syms = await step("GET /v1/symbols", () => client.getSymbols(), (v) => `${v.length} 銘柄`);
  // klines の日付: 1hour 以下は前日 (日本時間 6:00 区切りで確定済みの日) の YYYYMMDD、4hour 以上は今年 (日本時間) の YYYY
  const dayKey = utcDayKey(now + 3 * HOUR - 24 * HOUR);
  const yearKey = String(new Date(now + JST).getUTCFullYear());

  for (const g of symbols) {
    const base = gmoToUnified(g)!.split("/")[0];
    out("");
    out(`[${g}]`);
    if (syms) {
      const row = syms.find((r) => r.symbol === g);
      if (row) {
        out(`  OK  symbols の ${g}: takerFee=${row.takerFee} makerFee=${row.makerFee} minOrderSize=${row.minOrderSize} sizeStep=${row.sizeStep} tickSize=${row.tickSize}`);
      } else {
        problems++;
        out(`  NG  symbols に ${g} がありません`);
      }
      out(`  ${syms.some((r) => r.symbol === base) ? "OK " : "--  "} symbols の現物銘柄 ${base}: ${syms.some((r) => r.symbol === base) ? "あり" : "なし (klines のフォールバック先が無い)"}`);
    }
    await step(`GET /v1/ticker?symbol=${g}`, () => client.getTicker(g), (v) => {
      const t = v.find((x) => x.symbol === g);
      if (!t) throw new GmoShapeError("/v1/ticker", [`data: ${g} の要素がありません`]);
      return `bid=${t.bid} ask=${t.ask} last=${t.last} (${jstTime(t.timestamp)})`;
    });
    await step(`GET /v1/orderbooks?symbol=${g}`, () => client.getOrderbooks(g), (v) => `asks ${v.asks.length} 件 / bids ${v.bids.length} 件 (最良 ask=${v.asks[0]?.price ?? "-"} bid=${v.bids[0]?.price ?? "-"})`);
    for (const [interval, date] of [["1min", dayKey], ["15min", dayKey], ["4hour", yearKey]] as const) {
      const r = await step(`GET /v1/klines?symbol=${g}&interval=${interval}&date=${date}`, () => client.getKlines(g, interval, date), (v) =>
        v.length ? `${v.length} 本 (先頭 ${jstTime(v[0].openTime)} 〜 末尾 ${jstTime(v[v.length - 1].openTime)})` : "0 本",
      );
      if (!r || r.length === 0) {
        out(`      → 現物銘柄 ${base} の klines を試します (フォールバック先)`);
        await step(`GET /v1/klines?symbol=${base}&interval=${interval}&date=${date}`, () => client.getKlines(base, interval, date), (v) =>
          v.length ? `${v.length} 本 (先頭 ${jstTime(v[0].openTime)} 〜 末尾 ${jstTime(v[v.length - 1].openTime)})` : "0 本",
        );
      }
    }
  }
  out("");
  out(`  (1min の先頭の足の時刻で日付ファイルの区切りが分かります: 06:00 JST なら日本時間 6:00 区切り)`);

  out("");
  if (!hasKey) {
    out("[非公開 API] GMO_API_KEY / GMO_API_SECRET が未設定のため省略します");
  } else {
    out("[非公開 API (読み取り専用)]");
    const listSummary = (v: { list: unknown[] }) => (v.list.length ? `${v.list.length} 件` : "0 件 (要素が無いため各項目の形は未検証)");
    await step("GET /v1/account/margin", () => client.getMargin(), (v) => `actualProfitLoss=${v.actualProfitLoss} availableAmount=${v.availableAmount} margin=${v.margin} profitLoss=${v.profitLoss}`);
    for (const g of symbols) {
      await step(`GET /v1/positionSummary?symbol=${g}`, () => client.getPositionSummary(g), (v) =>
        v.list.length ? v.list.map((p) => `${p.side} 建玉 ${p.sumPositionQuantity} (決済注文中 ${p.sumOrderQuantity}) 平均 ${p.averagePositionRate}`).join(" / ") : listSummary(v),
      );
      await step(`GET /v1/activeOrders?symbol=${g}`, () => client.getActiveOrders(g, 1, 10), listSummary);
      await step(`GET /v1/latestExecutions?symbol=${g}`, () => client.getLatestExecutions(g, 1, 10), listSummary);
    }
  }
  out("");
  out("[要確認 (公式資料と未照合の前提。応答の形では確かめられないので、資料で確かめてください)]");
  for (const item of GMO_UNVERIFIED_ITEMS) out(`  -   ${item}`);
  out("");
  out(problems === 0 ? "結果: すべて想定どおりの形でした" : `結果: 想定と違う・失敗した項目が ${problems} 件あります (上の NG を確認してください)`);
  return problems === 0 ? 0 : 1;
}
