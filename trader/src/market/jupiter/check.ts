/**
 * Jupiter / GeckoTerminal の応答の形を確かめる (ユーザーのサーバーで実際の応答を確認するため。CLI の `jupiter check` は後で配線する)。
 *
 * - 各エンドポイントを 1 回ずつ、読み取りだけで呼ぶ: Price V3 / Tokens V2 (search・tag・toptrending・recent) /
 *   swap/v1/quote (SOL → USDC の見積もりだけ) / (任意) ultra/v1/order (taker なし = 見積もりだけ) / GeckoTerminal のプールと OHLCV。
 * - swap・execute (署名・送信) は絶対に呼ばない (JupiterClient の assertReadOnlyPath も拒否する)。
 * - 既定の銘柄 (MAJOR_TOKENS・DEFAULT_MEME_TOKENS) の mint を search で引き、symbol が一致するか照合する。
 * - キーは表示しない (hasApiKey の有無だけ)。失敗のエラー文は伏せ字にしてから表示する。
 * - 公式資料と未照合の前提は JUPITER_UNVERIFIED_ITEMS として最後に表示する。
 */
import { redactedErrMsg } from "../../core/http";
import type { JupiterClient } from "./client";
import { DEFAULT_MEME_TOKENS, MAJOR_TOKENS, normalizeTokenSymbol, SOL_MINT, USDC_MINT, type KnownToken } from "./discovery";
import type { GeckoTerminalClient } from "./gecko";
import { JupiterShapeError } from "./parse";
import { fetchPrices } from "./price";
import { estimateFill, JupiterSwapQuoteProvider, JupiterUltraOrderProvider, type QuoteProvider } from "./quote";
import { fetchRecentTokens, fetchTokenCategory, fetchTokensByTag, searchTokens } from "./tokens";

/** 公式資料・実際の応答と未照合の前提 (要確認) */
export const JUPITER_UNVERIFIED_ITEMS: readonly string[] = [
  "キーなしの上限は 1 秒あたり約 0.5 回、キーありの上限はプールのプランしだい (既定 1 回/秒)",
  "Price V3 は 1 回に 50 件まで、応答は mint をキーにした { usdPrice, blockId, decimals, priceChange24h }。信頼できる価格の無いトークンは含まれない",
  "Tokens V2 の各項目 (organicScore 0〜100・audit.topHoldersPercentage は %・firstPool.createdAt は ISO 8601・isSus は true のときだけ)",
  "swap/v1/quote の priceImpactPct は割合 (0.01 = 1%) の想定。下の見積もりの行で参照価格から計算した影響と比べて確かめる",
  "routePlan の feeAmount は outAmount に織り込み済みの想定 (実効価格から二重に引かない)",
  "ultra/v1/order は taker なしなら見積もりだけでトランザクションを返さない想定",
  "GeckoTerminal の無料枠の上限 (1 分あたり 5〜30 回の記述。既定 10 回/分)、ohlcv_list は新しい順・取引の無い足は含まれない",
  "GeckoTerminal の before_timestamp の境界 (含む・含まない) は ts の重複除去でどちらでも動く",
  "既定の銘柄の mint (下の照合の結果を確認する)",
  "2026-11 に足した主要銘柄 (USDT・cbBTC・WBTC (Wormhole)・WETH (Wormhole)・JTO・PYTH・RAY) の mint と、既知の decimals (cbBTC 8・WBTC 8・WETH 8・JTO 9・PYTH 6・RAY 6)",
];

export interface JupiterCheckStep {
  name: string;
  ok: boolean;
  summary: string;
  issues: string[];
}

export interface JupiterCheckReport {
  ok: boolean;
  steps: JupiterCheckStep[];
  /** 既定の銘柄の照合 (mint → 応答の symbol。見つからなければ undefined) */
  tokenVerification: { mint: string; expected: string; actual?: string; ok: boolean }[];
}

export interface JupiterCheckOptions {
  out?: (s: string) => void;
  /** 照合する銘柄 (既定: 主要銘柄 + 既定のミームコイン) */
  knownTokens?: readonly KnownToken[];
  /** ultra/v1/order (taker なし) も呼ぶ (既定 false) */
  includeUltra?: boolean;
  /** GeckoTerminal の確認に使う mint (既定 BONK) */
  geckoMint?: string;
  /** 見積もりの SOL の数量 (最小単位、既定 0.1 SOL) */
  quoteLamports?: string;
  now?: () => number;
}

function describe(e: unknown): string[] {
  if (e instanceof JupiterShapeError) return ["応答の形が想定と違います:", ...e.issues.map((i) => `  - ${i}`)];
  return [`失敗: ${redactedErrMsg(e)}`];
}

/** 各エンドポイントを 1 回ずつ呼んで形を確かめる (読み取りだけ) */
export async function runJupiterCheck(client: JupiterClient, gecko: GeckoTerminalClient | undefined, opts: JupiterCheckOptions = {}): Promise<JupiterCheckReport> {
  const out = opts.out ?? (() => undefined);
  const now = opts.now ?? Date.now;
  const known = opts.knownTokens ?? [...MAJOR_TOKENS, ...DEFAULT_MEME_TOKENS];
  const steps: JupiterCheckStep[] = [];
  const tokenVerification: JupiterCheckReport["tokenVerification"] = [];

  const step = async <T>(name: string, fn: () => Promise<T>, summary: (v: T) => { text: string; issues?: string[]; ok?: boolean }): Promise<T | undefined> => {
    try {
      const v = await fn();
      const s = summary(v);
      const ok = s.ok ?? true;
      steps.push({ name, ok, summary: s.text, issues: s.issues ?? [] });
      out(`  ${ok ? "OK" : "NG"}  ${name}: ${s.text}`);
      for (const i of s.issues ?? []) out(`      - ${i}`);
      return v;
    } catch (e) {
      const [head, ...rest] = describe(e);
      steps.push({ name, ok: false, summary: head, issues: rest });
      out(`  NG  ${name}: ${head}`);
      for (const l of rest) out(`      ${l}`);
      return undefined;
    }
  };

  out(`Jupiter API の応答の確認 (読み取りだけ。swap・execute は呼びません。API キー: ${client.hasApiKey ? "あり (表示しません)" : "なし"})`);

  const prices = await step(
    "price/v3",
    () => fetchPrices(client, known.map((k) => k.mint), { now }),
    (r) => ({
      text: `${r.prices.size} 件の価格 / 応答に無い ${r.missing.length} 件 / 不正 ${r.invalid.length} 件`,
      issues: [...r.invalid.map((i) => `${i.mint}: ${i.reason}`), ...r.missing.map((m) => `${m}: 応答に無い`)],
      ok: r.prices.size > 0 && r.invalid.length === 0,
    }),
  );

  await step(
    "tokens/v2/search (既定の銘柄の照合)",
    () => searchTokens(client, known.map((k) => k.mint)),
    (r) => {
      const bySym = new Map(r.tokens.map((t) => [t.mint, t.symbol]));
      const issues: string[] = [];
      for (const k of known) {
        const actual = bySym.get(k.mint);
        // WIF は "$WIF" で登録されている。別名 (Wormhole の WETH の "ETH" など) も一致とみなす
        const ok = actual !== undefined && [k.symbol, ...(k.aliases ?? [])].some((x) => normalizeTokenSymbol(x) === normalizeTokenSymbol(actual));
        tokenVerification.push({ mint: k.mint, expected: k.symbol, ...(actual !== undefined ? { actual } : {}), ok });
        if (!ok) issues.push(`${k.symbol} (${k.mint}): ${actual === undefined ? "見つからない" : `symbol が ${actual}`}`);
      }
      for (const i of r.invalid) issues.push(`要素 ${i.index}: ${i.reason}`);
      return { text: `${r.tokens.length} 件 / 照合の不一致 ${tokenVerification.filter((v) => !v.ok).length} 件`, issues, ok: issues.length === 0 };
    },
  );

  await step("tokens/v2/tag?query=verified", () => fetchTokensByTag(client, "verified"), (r) => ({
    text: `${r.tokens.length} 件 / 読めない ${r.invalid.length} 件`, ok: r.tokens.length > 0,
  }));

  await step("tokens/v2/toptrending/1h", () => fetchTokenCategory(client, "toptrending", "1h", 5), (r) => {
    const t = r.tokens[0];
    const missing = t
      ? (["liquidity", "holderCount", "organicScore", "firstPool"] as const).filter((k) => t[k] === undefined).map((k) => `先頭の要素に ${k} が無い`)
      : [];
    if (t && t.audit.mintAuthorityDisabled === undefined) missing.push("先頭の要素に audit.mintAuthorityDisabled が無い");
    if (t && t.audit.topHoldersPercentage === undefined) missing.push("先頭の要素に audit.topHoldersPercentage が無い");
    return { text: `${r.tokens.length} 件 / 読めない ${r.invalid.length} 件${t ? ` / 先頭 ${t.symbol ?? t.mint}` : ""}`, issues: missing, ok: r.tokens.length > 0 };
  });

  // 読めない要素 (mint が無い等) は表示するだけ (実際の一覧にも混ざりうる)。1 件も読めなければ NG
  await step("tokens/v2/recent", () => fetchRecentTokens(client), (r) => ({
    text: `${r.tokens.length} 件 / 読めない ${r.invalid.length} 件`,
    issues: r.invalid.slice(0, 5).map((i) => `要素 ${i.index}: ${i.reason}`),
    ok: r.tokens.length > 0,
  }));

  const solUsd = prices?.prices.get(SOL_MINT)?.usd;
  const ctx = { baseMint: SOL_MINT, baseDecimals: 9, quoteMint: USDC_MINT, quoteDecimals: 6, ...(solUsd ? { referencePriceUsd: solUsd } : {}) };
  const quoteReq = { inputMint: SOL_MINT, outputMint: USDC_MINT, amount: opts.quoteLamports ?? "100000000", slippageBps: 50 };
  const providers: QuoteProvider[] = [new JupiterSwapQuoteProvider(client)];
  if (opts.includeUltra) providers.push(new JupiterUltraOrderProvider(client));
  for (const p of providers) {
    await step(`${p.name} (SOL → USDC の見積もりだけ)`, () => p.getQuote(quoteReq), (q) => {
      const sizeUsd = solUsd ? (Number(quoteReq.amount) / 1e9) * solUsd : (Number(q.outAmount) / 1e6);
      const est = estimateFill(q, "sell", sizeUsd, ctx);
      return {
        text:
          `outAmount ${q.outAmount} / 実効価格 $${est.effectivePrice.toFixed(4)} / 影響 ${est.priceImpactBps.toFixed(2)}bps` +
          ` (応答の priceImpactPct = ${q.priceImpactPct ?? "なし"}) / 経路 ${est.routeLabels.join(", ") || "不明"}`,
        issues: q.routePlan.length === 0 ? ["routePlan が空"] : [],
      };
    });
  }

  if (gecko) {
    const mint = opts.geckoMint ?? DEFAULT_MEME_TOKENS[0].mint;
    const pool = await step("geckoterminal tokens/{mint}/pools", () => gecko.bestPoolFor(mint), (p) => ({
      text: p ? `${p.name ?? p.address} (reserve $${Math.round(p.reserveUsd ?? 0)})` : "base のプールが見つからない",
      ok: p !== undefined,
    }));
    if (pool) {
      await step("geckoterminal pools/{pool}/ohlcv/minute", () => gecko.fetchOhlcvPage(pool.address, "1m", { limit: 10 }), (c) => {
        const asc = c.every((x, i) => i === 0 || c[i - 1].ts < x.ts);
        const last = c[c.length - 1];
        return {
          text: `${c.length} 本${last ? ` / 最新 ${new Date(last.ts).toISOString()} 終値 ${last.close}` : ""}`,
          issues: asc ? [] : ["昇順に並べ替えられていない"],
          ok: c.length > 0 && asc,
        };
      });
    }
  } else {
    out("  --  GeckoTerminal: クライアントが無いので省略");
  }

  out("公式資料・実際の応答と未照合の前提 (要確認):");
  for (const i of JUPITER_UNVERIFIED_ITEMS) out(`  - ${i}`);
  const ok = steps.every((s) => s.ok);
  out(ok ? "結果: すべて想定どおり" : `結果: ${steps.filter((s) => !s.ok).length} 件の項目が想定と違うか失敗`);
  return { ok, steps, tokenVerification };
}
