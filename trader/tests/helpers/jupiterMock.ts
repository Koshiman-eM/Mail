/**
 * Jupiter・GeckoTerminal・frankfurter のオフラインのモック (合成データ。実 API へは送信しない)。
 * 価格は mint ごとの決定的な関数 priceAt(mint, t) (サイン波 + ゆっくりした傾き)。GeckoTerminal の足も同じ関数から作る。
 */
import { createMockFetch, type RecordedCall } from "../fixtures/jupiter/mockFetch";

export interface MockToken {
  mint: string;
  symbol: string;
  decimals: number;
  price: number;
  liquidity?: number;
  holderCount?: number;
  organicScore?: number;
  topHoldersPct?: number;
  mintAuthorityDisabled?: boolean;
  createdAt?: string;
  isVerified?: boolean;
  /** 上下の幅 (割合、既定 0.01) */
  amp?: number;
  /** 1 時間あたりの傾き (割合、既定 0) */
  drift?: number;
}

export const SOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
export const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
export const MEMEA = "MemeAAAAbbbbCCCCddddEEEEffffGGGGhhhh1111";
export const MEMEB = "MemeBBBBccccDDDDeeeeFFFFggggHHHHjjjj2222";

export const DEFAULT_MOCK_TOKENS: MockToken[] = [
  { mint: SOL, symbol: "SOL", decimals: 9, price: 150, liquidity: 50_000_000, amp: 0.004, drift: 0.001 },
  { mint: BONK, symbol: "BONK", decimals: 5, price: 0.00002, liquidity: 2_000_000, amp: 0.02, drift: -0.002 },
];

export const poolOf = (mint: string) => `PooL${mint.slice(4, 40)}`.slice(0, 40);

export function priceAt(t: MockToken, ts: number): number {
  const amp = t.amp ?? 0.01;
  const h = ts / 3_600_000;
  const seed = t.mint.charCodeAt(5) + t.mint.charCodeAt(9);
  return t.price * (1 + amp * Math.sin(h * 2 * Math.PI * 1.3 + seed) + 0.4 * amp * Math.sin(ts / 97_000 + seed) + (t.drift ?? 0) * Math.sin(h / 8));
}

export function rawToken(t: MockToken): Record<string, unknown> {
  return {
    id: t.mint, symbol: t.symbol, name: t.symbol, decimals: t.decimals, usdPrice: t.price, liquidity: t.liquidity,
    holderCount: t.holderCount ?? 50_000, organicScore: t.organicScore ?? 90, organicScoreLabel: "high", isVerified: t.isVerified ?? true,
    audit: { mintAuthorityDisabled: t.mintAuthorityDisabled ?? true, freezeAuthorityDisabled: true, topHoldersPercentage: t.topHoldersPct ?? 10 },
    firstPool: { id: poolOf(t.mint), createdAt: t.createdAt ?? "2024-01-01T00:00:00Z" },
  };
}

export interface JupiterMockOptions {
  now: () => number;
  tokens?: MockToken[];
  /** toptrending / toporganicscore の応答 (既定は空) */
  trending?: () => MockToken[];
  /** true の間は price/v3 を 500 で失敗させる */
  failPrices?: () => boolean;
  /** 応答に含めない mint */
  omitPrices?: () => string[];
  /** swap/v1/quote を失敗させる */
  failQuote?: boolean;
  /** swap/v1/quote をこの mint (base) だけ失敗させる */
  failQuoteFor?: (mint: string) => boolean;
  /** 見積もりの不利な方向の影響 (片道 bps。既定 10) */
  quoteImpactBps?: (mint: string) => number;
  /** frankfurter の USD/JPY */
  usdJpy?: number;
}

const MIN = 60_000;
const TF_MS: Record<string, number> = { "minute:1": MIN, "minute:5": 5 * MIN, "minute:15": 15 * MIN, "hour:1": 3_600_000, "hour:4": 14_400_000 };

export function createJupiterMock(o: JupiterMockOptions) {
  const tokens = () => [...(o.tokens ?? DEFAULT_MOCK_TOKENS), ...(o.trending?.() ?? [])];
  const find = (mint: string) => tokens().find((t) => t.mint === mint);
  const route = (call: RecordedCall) => {
    const p = call.path;
    if (call.url.startsWith("https://api.frankfurter.app")) return { body: { amount: 1, base: "USD", date: "2026-11-20", rates: { JPY: o.usdJpy ?? 155.5 } } };
    if (p === "/price/v3") {
      if (o.failPrices?.()) return { status: 500, body: { error: "boom" } };
      const omit = new Set(o.omitPrices?.() ?? []);
      const ids = (call.query.get("ids") ?? "").split(",");
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        const t = find(id);
        if (t && !omit.has(id)) out[id] = { usdPrice: priceAt(t, o.now()), decimals: t.decimals };
      }
      return { body: out };
    }
    if (p === "/tokens/v2/search") {
      const qs = (call.query.get("query") ?? "").split(",");
      return { body: tokens().filter((t) => qs.includes(t.mint) || qs.some((q) => q.toUpperCase() === t.symbol.toUpperCase())).map(rawToken) };
    }
    if (p === "/tokens/v2/toptrending/1h" || p === "/tokens/v2/toporganicscore/1h") return { body: (o.trending?.() ?? []).map(rawToken) };
    if (p === "/swap/v1/quote") {
      if (o.failQuote) return { status: 500, body: { error: "no route" } };
      const inMint = call.query.get("inputMint")!;
      const outMint = call.query.get("outputMint")!;
      const amount = BigInt(call.query.get("amount")!);
      const base = inMint === USDC ? find(outMint)! : find(inMint)!;
      if (o.failQuoteFor?.(base.mint)) return { status: 500, body: { error: "no route" } };
      const px = priceAt(base, o.now());
      // 影響 10bps (既定) の見積もり
      const k = (o.quoteImpactBps?.(base.mint) ?? 10) / 10_000;
      let outAmount: bigint;
      if (inMint === USDC) outAmount = BigInt(Math.floor((Number(amount) / 1e6 / (px * (1 + k))) * 10 ** base.decimals));
      else outAmount = BigInt(Math.floor((Number(amount) / 10 ** base.decimals) * px * (1 - k) * 1e6));
      return {
        body: {
          inputMint: inMint, outputMint: outMint, inAmount: amount.toString(), outAmount: outAmount.toString(), otherAmountThreshold: outAmount.toString(),
          swapMode: "ExactIn", slippageBps: 100, priceImpactPct: "0.001", routePlan: [{ swapInfo: { label: "MockAMM", ammKey: "x", feeAmount: "0", feeMint: inMint }, percent: 100 }],
        },
      };
    }
    const m = /^\/api\/v2\/networks\/solana\/tokens\/([^/]+)\/pools$/.exec(p);
    if (m) {
      const t = find(m[1]);
      if (!t) return { body: { data: [] } };
      return {
        body: {
          data: [{
            id: `solana_${poolOf(t.mint)}`, type: "pool",
            attributes: { address: poolOf(t.mint), name: `${t.symbol} / USDC`, reserve_in_usd: String(t.liquidity ?? 1e6) },
            relationships: { base_token: { data: { id: `solana_${t.mint}` } }, quote_token: { data: { id: `solana_${USDC}` } } },
          }],
        },
      };
    }
    const oh = /^\/api\/v2\/networks\/solana\/pools\/([^/]+)\/ohlcv\/(minute|hour)$/.exec(p);
    if (oh) {
      const t = tokens().find((x) => poolOf(x.mint) === oh[1]);
      const ms = TF_MS[`${oh[2]}:${call.query.get("aggregate")}`];
      if (!t || !ms) return { status: 404, body: {} };
      const limit = Number(call.query.get("limit") ?? 100);
      const before = call.query.get("before_timestamp");
      const end = before !== null ? Number(before) * 1000 : o.now();
      const rows: number[][] = [];
      for (let ts = Math.floor(end / ms) * ms; rows.length < limit; ts -= ms) {
        const op = priceAt(t, ts);
        const cl = priceAt(t, ts + ms - 1);
        rows.push([ts / 1000, op, Math.max(op, cl) * 1.001, Math.min(op, cl) * 0.999, cl, 1000 + (ts / MIN) % 17]);
      }
      return { body: { data: { attributes: { ohlcv_list: rows } } } };
    }
    return { status: 404, body: { error: `mock: ${p}` } };
  };
  return createMockFetch(route, o.now);
}

/** ミリ秒の秒の境界まで丸めた fake の時計 (engine の Clock と sleep を共有) */
export function mkClock(t: number) {
  const c = { t, now: () => c.t, sleep: async (_ms: number) => undefined };
  return c;
}
