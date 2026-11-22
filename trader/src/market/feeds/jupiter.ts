/**
 * Jupiter (Solana) の相場の feed (MarketDataFeed)。paper 用 (スワップは実行しない)。
 *
 * 価格:
 * - Price V3 を JUPITER_POLL_MS (既定 2.5 秒) ごとに、監視中の全 mint を 1 回 (50 件ずつ) で取る。
 *   API の上限 (キーなし 0.5 回/秒) を超えないよう、実際の間隔は effectivePollMs (上限の 80% まで。キーなしの 1 回なら 2.5 秒) 以上にする。fetchQuote は最後の一括取得の結果を返し、
 *   間隔が過ぎていれば先に取り直す (銘柄ごとに API を呼ばない)。
 * - 気配: 仲値 = 最新の価格、買い・売り気配 = 代わりのスリッページのモデル (estimateFillFallback) を代表的な約定代金
 *   (JUPITER_QUOTE_SIZE_USD、既定 $50) と流動性で評価した価格。見積もり API は毎回は呼ばない (約定のときだけ。jupiterFill.ts)。
 *   主要銘柄 (crypto: SOL・JUP) は経路の手数料が小さいので固定の bps を 5 にする (ミームは既定の 30。要確認: jupiter check の見積もり)。
 * - 一括取得が全部失敗したら fetchQuote は例外 (hub の lastError → 新規停止)。一部の mint だけ応答に無いときは例外にせず、
 *   前の気配 (古い時刻) を返す (エンジンが古い気配として新規を止める)。件数は status() と警告で知らせる。
 *
 * 足 (src/market/jupiter/candles.ts の PolledCandleStore):
 * - 価格から 1m の足 (出来高不明 volumeKnown: false)、上位足はその集約。hub には手元の足をそのまま返す (candlesAreLocal)。
 * - 起動後に裏で GeckoTerminal から履歴を取る (backfill。止めずに進め、戦略は足が揃うまでシグナルを出さない):
 *   各 mint の最良のプール → 1m (1 ページ) → 1m の集約で hub の本数 (historyBars) が足りない時間足 (15m / 1h / 4h / 5m) をその時間足で直接。
 *   順番は時間足ごとに全 mint (1m を全銘柄で先に)。
 * - 出来高: 1m の出来高を GeckoTerminal から銘柄を順に回して (GECKO_CALLS_PER_MIN の枠の中で) 取り、確定してから
 *   volumeLagMs (既定 3 分) 以上経った足にだけ入れる。
 *
 * リペイントしない (先読みしない) 約束:
 * - 一度返した確定足 (時間足ごと) は凍結し、以後 OHLC を変えない。後から変わりうるのは出来高だけで、
 *   「不明 (volumeKnown: false) → 分かった」への 1 回の変化に限る。出来高を使う戦略は不明な足があれば条件を満たさない (fail-closed) ので、
 *   不明の間に出来高を根拠にした判断は無い。分かった出来高は「その時点で分かっている過去の値」で、先読みではない (遅れて見えるだけ)。
 * - GeckoTerminal の高値・安値は使わない (返した足の高値・安値を書き換えるとスイング・ATR が後から変わるため)。
 * - 履歴 (backfill) は、凍結した最初の足より前にだけ足す (途中の空白には差し込まない)。1m の履歴はポーリングの最初の足より前だけ。
 * 結果として、1m の足を使う出来高の戦略 (scalp_momentum_burst・scalp_micro) は直近の足の出来高が常に不明なので、
 * Jupiter の銘柄では入らない (fail-closed。1m の足は出来高が分かる前に次の足へ置き換わる)。
 * short_breakout (1h) は Strategy.needsVolume = true で、出来高が分かるまで (足の確定から 10 分まで) エンジンが同じ足の評価を
 * 次のティックに持ち越す (評価済みにしない)。分かった時点で 1 回だけ評価し、10 分を過ぎても不明なら従来どおり入らない。
 */
import { redactedErrMsg } from "../../core/http";
import { TIMEFRAME_MS, type AssetClass, type Candle, type Instrument, type MarketDataFeed, type Quote, type Timeframe } from "../../core/types";
import { resamplePolled, PolledCandleStore, type PolledCandle } from "../jupiter/candles";
import type { JupiterClient } from "../jupiter/client";
import type { GeckoTerminalClient } from "../jupiter/gecko";
import { effectivePricePollMs, fetchPrices, type JupiterPrice } from "../jupiter/price";
import { DEFAULT_FALLBACK_SLIPPAGE, estimateFillFallback, type FallbackSlippageSettings } from "../jupiter/quote";
import { searchTokens, type JupiterToken } from "../jupiter/tokens";

export const JUPITER_VENUE = "jupiter";
/** 流動性 (トークン情報) をこれより古いなら「不明」とみなす (ミームの最低流動性は拒否、気配は流動性不明の bps) */
export const LIQUIDITY_MAX_AGE_MS = 3 * 3_600_000;
/** GeckoTerminal の失敗 (プールの検索・履歴) の再試行の間隔 (1 回目 5 分、2 回目 15 分、以後 60 分) */
export const GECKO_RETRY_BACKOFF_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 60 * 60_000];
const backoffMs = (failures: number) => GECKO_RETRY_BACKOFF_MS[Math.min(GECKO_RETRY_BACKOFF_MS.length - 1, Math.max(0, failures - 1))];
const JUPITER_QUOTE_CURRENCY = "USDC";
const USDC_DECIMALS = 6;
const MIN = 60_000;

/** 主要銘柄 (crypto) の代わりのスリッページ (SOL / USDC などは経路の手数料が小さい。要確認: jupiter check の見積もりの影響) */
const MAJOR_FALLBACK_SLIPPAGE: Readonly<FallbackSlippageSettings> = { ...DEFAULT_FALLBACK_SLIPPAGE, baseBps: 5, unknownLiquidityBps: 30 };

export function fallbackSettingsFor(cls: AssetClass): FallbackSlippageSettings {
  return { ...(cls === "crypto" ? MAJOR_FALLBACK_SLIPPAGE : DEFAULT_FALLBACK_SLIPPAGE) };
}

export interface JupiterTokenSpec {
  mint: string;
  symbol: string;
  decimals: number;
  assetClass: AssetClass;
  liquidityUsd?: number;
  source: "fixed" | "discovered";
}

export interface JupiterInstrumentOptions {
  quoteSizeUsd: number;
  networkFeeUsd: number;
  minNotionalUsd: number;
  /** 統一シンボル (既定 <SYMBOL>/USDC) */
  symbol?: string;
}

/** 片道の代わりのスリッページ (bps) */
export function fallbackBps(cls: AssetClass, sizeUsd: number, liquidityUsd: number | undefined): number {
  return estimateFillFallback("buy", sizeUsd, 1, liquidityUsd, fallbackSettingsFor(cls)).priceImpactBps;
}

/**
 * トークン → Instrument。数量の刻み・最小数量は decimals (最小単位 = 10^-decimals)、価格の刻みは USDC の最小単位を
 * トークンの最小単位で割った値 (10^-(6 + decimals))。手数料率は 0 (経路の手数料は見積もりの価格に含まれる)、
 * ネットワーク手数料は約定ごとの固定額 (fixedFeePerOrder)。空売りなし
 */
export function jupiterInstrument(t: JupiterTokenSpec, o: JupiterInstrumentOptions): Instrument {
  const lot = Number(`1e-${t.decimals}`);
  const spread = 2 * fallbackBps(t.assetClass, o.quoteSizeUsd, t.liquidityUsd);
  return {
    symbol: o.symbol ?? `${t.symbol.toUpperCase()}/${JUPITER_QUOTE_CURRENCY}`,
    venue: JUPITER_VENUE,
    assetClass: t.assetClass,
    baseCurrency: t.symbol.toUpperCase(),
    quoteCurrency: JUPITER_QUOTE_CURRENCY,
    tickSize: Number(`1e-${USDC_DECIMALS + t.decimals}`),
    lotSize: lot,
    minQty: lot,
    ...(o.minNotionalUsd > 0 ? { minNotional: o.minNotionalUsd } : {}),
    takerFeeRate: 0,
    makerFeeRate: 0,
    allowShort: false,
    fixedFeePerOrder: o.networkFeeUsd,
    costModel: { refNotional: o.quoteSizeUsd, spreadBps: Number(spread.toFixed(4)), slippageBps: 0 },
    meta: { mint: t.mint, decimals: t.decimals, source: t.source },
  };
}

export interface JupiterFeedOptions {
  client: JupiterClient;
  /** 無ければ履歴・出来高なし (ポーリングの足だけ) */
  gecko?: GeckoTerminalClient;
  now?: () => number;
  pollMs?: number;
  quoteSizeUsd?: number;
  networkFeeUsd?: number;
  minNotionalUsd?: number;
  /** hub が使う時間足 (backfill の対象) */
  timeframes?: readonly Timeframe[];
  /** hub が欲しい本数 (既定 300) */
  historyBars?: number;
  /** 保持する本数 (既定 2000) */
  maxCandles?: number;
  /** 出来高を入れる足の遅れ (既定 3 分) */
  volumeLagMs?: number;
  /** 同じ銘柄の出来高の取り直しの最短間隔 (既定 1 分) */
  volumeEveryMs?: number;
  onWarn?: (msg: string, data?: Record<string, unknown>) => void;
}

interface TokenState {
  spec: JupiterTokenSpec;
  inst: Instrument;
  token?: JupiterToken;
  liquidityUsd?: number;
  liquidityAt?: number;
  quote?: Quote;
  lastPrice?: JupiterPrice;
  /** ポーリングで最初に価格を入れた 1m の足 (これより前にだけ 1m の履歴を入れる) */
  firstPolledTs?: number;
  /** GeckoTerminal のプール (null = 見つからない・失敗。poolRetryAt 以降に取り直す) */
  pool?: string | null;
  poolFailures: number;
  poolRetryAt?: number;
  /** 取得済み (成功した) の履歴の時間足 */
  backfilled: Set<Timeframe>;
  /** 履歴の取得に失敗した時間足 (失敗回数と再試行の時刻) */
  backfillFail: Map<Timeframe, { failures: number; retryAt: number }>;
  /** GeckoTerminal の時間足ごとの履歴 (確定足) */
  geckoHist: Map<Timeframe, Candle[]>;
  /** 1m の出来高 (ts → 出来高。確定から volumeLagMs 以上経った足だけ) */
  geckoVol: Map<number, number>;
  volumeAt?: number;
  /** 凍結した足 (時間足ごと) */
  frozen: Map<Timeframe, Candle[]>;
  version: number;
  cache?: { key: string; tf: Map<Timeframe, Candle[]> };
  /** 新規エントリーを止める理由 (自動追加の銘柄が選別に落ちた等) */
  entryBlock?: string;
}

export interface JupiterFeedStatus {
  tokens: { symbol: string; mint: string; assetClass: AssetClass; source: string; price?: number; quoteAgeMs?: number; liquidityUsd?: number; pool?: string | null; backfilled: Timeframe[]; volumeAt?: number; entryBlock?: string }[];
  lastPollAt?: number;
  lastPollError?: string;
  missing: string[];
  invalid: string[];
  geckoCalls: number;
  geckoErrors: number;
}

const BACKFILL_ORDER: readonly Timeframe[] = ["1m", "15m", "1h", "4h", "5m"];

export class JupiterFeed implements MarketDataFeed {
  readonly venue = JUPITER_VENUE;
  readonly minIntervalMs = 0;
  /** hub に手元の足を毎回取り直させる (外部 API は呼ばない) */
  readonly candlesAreLocal = true;
  readonly pollMs: number;
  readonly quoteSizeUsd: number;
  readonly networkFeeUsd: number;
  readonly minNotionalUsd: number;
  private readonly now: () => number;
  private readonly store: PolledCandleStore;
  private readonly bySymbol = new Map<string, TokenState>();
  private readonly byMint = new Map<string, TokenState>();
  private tfs: Timeframe[];
  private readonly historyBars: number;
  private readonly maxCandles: number;
  private readonly volumeLagMs: number;
  private readonly volumeEveryMs: number;
  private lastPollAt?: number;
  private lastPollError?: string;
  private lastPollOk = new Set<string>();
  private lastMissing: string[] = [];
  private lastInvalid: string[] = [];
  private pollInflight?: Promise<void>;
  private job?: Promise<void>;
  private stopped = false;
  private geckoCalls = 0;
  private geckoErrors = 0;
  private readonly warnedAt = new Map<string, number>();

  constructor(private readonly o: JupiterFeedOptions) {
    this.now = o.now ?? Date.now;
    this.pollMs = o.pollMs ?? 2_500;
    this.quoteSizeUsd = o.quoteSizeUsd ?? 50;
    this.networkFeeUsd = o.networkFeeUsd ?? 0.02;
    this.minNotionalUsd = o.minNotionalUsd ?? 5;
    this.maxCandles = o.maxCandles ?? 2000;
    this.historyBars = o.historyBars ?? 300;
    this.volumeLagMs = o.volumeLagMs ?? 3 * MIN;
    this.volumeEveryMs = o.volumeEveryMs ?? MIN;
    this.tfs = [...new Set<Timeframe>(["1m", ...(o.timeframes ?? ["1m", "5m", "15m", "1h", "4h"])])].filter((tf) => tf !== "1s" && tf !== "1d" && tf !== "1w");
    this.store = new PolledCandleStore({ maxCandles: this.maxCandles });
  }

  private warn(key: string, msg: string, data?: Record<string, unknown>): void {
    const t = this.now();
    const last = this.warnedAt.get(key);
    if (last !== undefined && t - last < 10 * MIN) return;
    this.warnedAt.set(key, t);
    this.o.onWarn?.(msg, data);
  }

  /** hub が使う時間足 (backfill の対象)。setup が hub を作る前に決める */
  setTimeframes(tfs: readonly Timeframe[]): void {
    this.tfs = [...new Set<Timeframe>(["1m", ...tfs])].filter((tf) => tf !== "1s" && tf !== "1d" && tf !== "1w");
  }

  // ───────── 銘柄 ─────────

  /**
   * 銘柄を加える (既にあればその Instrument)。シンボルが他の mint と重なれば mint の先頭 4 文字を付ける。
   * forcedSymbol (前回の起動で使った統一シンボル。kv `jupiter:watch:<mode>`・paper のスナップショット) があれば、空いている限りそれを使う
   * (保有中の建玉のシンボル → mint の対応を再起動で変えないため。空いていなければ警告して通常の規則)
   */
  addToken(spec: JupiterTokenSpec, forcedSymbol?: string): Instrument {
    const have = this.byMint.get(spec.mint);
    if (have) return have.inst;
    const opts = { quoteSizeUsd: this.quoteSizeUsd, networkFeeUsd: this.networkFeeUsd, minNotionalUsd: this.minNotionalUsd };
    let inst: Instrument;
    if (forcedSymbol && !this.bySymbol.has(forcedSymbol)) inst = jupiterInstrument(spec, { ...opts, symbol: forcedSymbol });
    else {
      if (forcedSymbol) this.warn(`forced:${spec.mint}`, "前回のシンボルが他の銘柄に使われているため別のシンボルにします", { mint: spec.mint, symbol: forcedSymbol });
      inst = jupiterInstrument(spec, opts);
      if (this.bySymbol.has(inst.symbol)) inst = jupiterInstrument(spec, { ...opts, symbol: `${spec.symbol.toUpperCase()}-${spec.mint.slice(0, 4)}/${JUPITER_QUOTE_CURRENCY}` });
    }
    const st: TokenState = {
      spec, inst, poolFailures: 0, backfilled: new Set(), backfillFail: new Map(), geckoHist: new Map(), geckoVol: new Map(), frozen: new Map(), version: 0,
      ...(spec.liquidityUsd !== undefined ? { liquidityUsd: spec.liquidityUsd, liquidityAt: this.now() } : {}),
    };
    this.bySymbol.set(inst.symbol, st);
    this.byMint.set(spec.mint, st);
    return inst;
  }

  /** 銘柄を外す (足・気配も捨てる)。外したら true */
  removeToken(mint: string): boolean {
    const st = this.byMint.get(mint);
    if (!st) return false;
    this.byMint.delete(mint);
    this.bySymbol.delete(st.inst.symbol);
    this.store.delete(mint);
    // GeckoTerminal のキャッシュ (プール・足) も捨てる (自動探索で入れ替わる銘柄でメモリが増え続けないように)
    this.o.gecko?.forgetToken(mint, typeof st.pool === "string" ? st.pool : undefined);
    return true;
  }

  instrumentOf(mint: string): Instrument | undefined {
    return this.byMint.get(mint)?.inst;
  }

  mintOf(symbol: string): string | undefined {
    return this.bySymbol.get(symbol)?.spec.mint;
  }

  tokenOf(symbol: string): (JupiterTokenSpec & { liquidityUsd?: number; fallback: FallbackSlippageSettings }) | undefined {
    const st = this.bySymbol.get(symbol);
    if (!st) return undefined;
    const liq = this.freshLiquidity(st);
    return { ...st.spec, ...(liq !== undefined ? { liquidityUsd: liq } : { liquidityUsd: undefined }), fallback: fallbackSettingsFor(st.spec.assetClass) };
  }

  mints(): string[] {
    return [...this.byMint.keys()];
  }

  /** トークン情報 (tokens/v2/search の結果) */
  tokenInfo(mint: string): JupiterToken | undefined {
    return this.byMint.get(mint)?.token;
  }

  /** RiskManager の MEME_MIN_LIQUIDITY_USD の判定に使う流動性 (Jupiter のトークン情報の liquidity。無ければ undefined = 拒否) */
  liquidityUsd(symbol: string): number | undefined {
    const st = this.bySymbol.get(symbol);
    return st ? this.freshLiquidity(st) : undefined;
  }

  /** LIQUIDITY_MAX_AGE_MS (3 時間) より古い流動性は不明 (undefined) */
  private freshLiquidity(st: TokenState): number | undefined {
    if (st.liquidityUsd === undefined || st.liquidityAt === undefined) return undefined;
    return this.now() - st.liquidityAt <= LIQUIDITY_MAX_AGE_MS ? st.liquidityUsd : undefined;
  }

  /**
   * 予定の約定代金 (USD) での往復コスト (bps) = 2 × (代わりのモデルの片道 bps (その代金と流動性で評価) + ネットワーク手数料 / 代金)。
   * 気配の仮のスプレッド (JUPITER_QUOTE_SIZE_USD で評価) ではなく、実際のサイズのコストで期待値を確かめる (RiskManager)。
   * 銘柄が無い・代金が不正なら undefined
   */
  costBpsAt(symbol: string, notionalUsd: number): number | undefined {
    const st = this.bySymbol.get(symbol);
    if (!st || !(Number.isFinite(notionalUsd) && notionalUsd > 0)) return undefined;
    const oneWay = fallbackBps(st.spec.assetClass, notionalUsd, this.freshLiquidity(st));
    return 2 * oneWay + 2 * (this.networkFeeUsd / notionalUsd) * 10_000;
  }

  setEntryBlock(mint: string, reason: string | undefined): void {
    const st = this.byMint.get(mint);
    if (!st) return;
    if (reason) st.entryBlock = reason;
    else delete st.entryBlock;
  }

  entryBlock(symbol: string): string | undefined {
    return this.bySymbol.get(symbol)?.entryBlock;
  }

  /** トークン情報を入れる (流動性・decimals など) */
  applyTokenInfo(tokens: readonly JupiterToken[]): number {
    let n = 0;
    const t = this.now();
    for (const tok of tokens) {
      const st = this.byMint.get(tok.mint);
      if (!st) continue;
      st.token = tok;
      if (tok.liquidity !== undefined) {
        st.liquidityUsd = tok.liquidity;
        st.liquidityAt = t;
      }
      n++;
    }
    return n;
  }

  /** 監視中の mint のトークン情報を取り直す (tokens/v2/search を 100 件ずつ)。失敗は例外 */
  async refreshTokenInfo(): Promise<number> {
    const mints = this.mints();
    if (mints.length === 0) return 0;
    const r = await searchTokens(this.o.client, mints);
    return this.applyTokenInfo(r.tokens);
  }

  // ───────── MarketDataFeed ─────────

  async listInstruments(): Promise<Instrument[]> {
    return [...this.bySymbol.values()].map((s) => s.inst);
  }

  /**
   * 実際の価格の取得間隔 (ミリ秒) = max(pollMs, API の上限から決まる下限)。
   * 価格の取得は 50 件ごとに 1 回の呼び出しで、約定の見積もり・自動探索と同じ枠を共有するので、上限の 80% までしか使わない
   */
  effectivePollMs(): number {
    return effectivePricePollMs(this.pollMs, this.o.client.limiter?.ratePerSec ?? Number.POSITIVE_INFINITY, this.byMint.size);
  }

  /** 価格を一括で取り直す (間隔内なら何もしない。同時の呼び出しは 1 回にまとめる) */
  async refresh(force = false): Promise<void> {
    const t = this.now();
    // ループの刻み (SCALP_LOOP_MS) と同じ間隔だと、タイマーのわずかな遅れ・早まりで「間隔未満」になり 1 回おきに飛ばされる。
    // 間隔の 10% (最大 250ms) の余裕を見る (API の上限は limiter が別に守る)
    const interval = this.effectivePollMs();
    if (!force && this.lastPollAt !== undefined && t - this.lastPollAt < interval - Math.min(250, interval * 0.1)) return;
    if (this.pollInflight) return this.pollInflight;
    this.lastPollAt = t;
    const p = this.pollOnce().finally(() => {
      this.pollInflight = undefined;
    });
    this.pollInflight = p;
    return p;
  }

  private async pollOnce(): Promise<void> {
    const mints = this.mints();
    this.lastPollOk = new Set();
    if (mints.length === 0) return;
    try {
      const r = await fetchPrices(this.o.client, mints, { now: this.now });
      this.lastPollError = undefined;
      for (const [mint, p] of r.prices) {
        const st = this.byMint.get(mint);
        if (!st) continue;
        st.lastPrice = p;
        const b = this.store.builder(mint);
        if (b.push(p.ts, p.usd) && st.firstPolledTs === undefined) st.firstPolledTs = Math.floor(p.ts / MIN) * MIN;
        st.quote = this.synthQuote(st, p);
        this.lastPollOk.add(mint);
      }
      this.lastMissing = r.missing;
      this.lastInvalid = r.invalid.map((i) => `${i.mint}: ${i.reason}`);
      const failed = r.failedChunks.flatMap((c) => c.mints);
      if (r.missing.length || r.invalid.length || failed.length) {
        this.warn("partial", "Jupiter の価格が一部の銘柄で取れません (その銘柄は気配が古くなり新規エントリーを止めます)", {
          missing: r.missing.map((m) => this.byMint.get(m)?.inst.symbol ?? m),
          invalid: this.lastInvalid.length,
          failed: failed.length,
        });
      }
    } catch (e) {
      this.lastPollError = redactedErrMsg(e);
      this.warn("poll", "Jupiter の価格の取得に失敗", { error: this.lastPollError });
    }
    this.maintain();
  }

  /** 仲値 = 価格、買い・売り気配 = 代表的な約定代金での代わりのスリッページ */
  private synthQuote(st: TokenState, p: JupiterPrice): Quote {
    const s = fallbackSettingsFor(st.spec.assetClass);
    const liq = this.freshLiquidity(st);
    const ask = estimateFillFallback("buy", this.quoteSizeUsd, p.usd, liq, s).effectivePrice;
    const bid = estimateFillFallback("sell", this.quoteSizeUsd, p.usd, liq, s).effectivePrice;
    return { ts: p.ts, bid, ask, last: p.usd };
  }

  async fetchQuote(symbol: string): Promise<Quote> {
    await this.refresh();
    const st = this.bySymbol.get(symbol);
    if (!st) throw new Error(`Jupiter: 未登録の銘柄 ${symbol}`);
    // 一括取得が全部失敗した: 例外 (hub の lastError で新規を止める。前の気配は hub に残る)
    if (this.lastPollError !== undefined && !this.lastPollOk.has(st.spec.mint)) throw new Error(`Jupiter の価格の取得に失敗: ${this.lastPollError}`);
    if (!st.quote) throw new Error(`Jupiter: ${symbol} の価格がまだありません`);
    // 一部だけ応答に無い: 前の気配 (古い時刻) を返す (エンジンが古い気配として新規を止める)
    return { ...st.quote };
  }

  /** 手元の足 (確定足。凍結した値)。外部 API は呼ばない */
  async fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    const st = this.bySymbol.get(symbol);
    if (!st) return [];
    const all = this.candlesFor(st, tf, this.now());
    const out = since !== undefined ? all.filter((c) => c.ts >= since) : all;
    return out.slice(-Math.max(1, limit)).map((c) => ({ ...c }));
  }

  private candlesFor(st: TokenState, tf: Timeframe, now: number): Candle[] {
    const key = `${Math.floor(now / MIN)}|${st.version}`;
    if (st.cache?.key !== key) st.cache = { key, tf: new Map() };
    const hit = st.cache.tf.get(tf);
    if (hit) return hit;
    const out = this.freeze(st, tf, this.fresh(st, tf, now));
    st.cache.tf.set(tf, out);
    return out;
  }

  /** 今の時点の足 (凍結前): 1m (出来高を補う) とその集約、さらに古い分は GeckoTerminal の時間足の履歴 */
  private fresh(st: TokenState, tf: Timeframe, now: number): Candle[] {
    const base = this.store.candles(st.spec.mint, "1m", now).map((c): PolledCandle => {
      if (c.volumeKnown) return c;
      const v = st.geckoVol.get(c.ts);
      return v !== undefined ? { ...c, volume: v, volumeKnown: true } : c;
    });
    const res: Candle[] = tf === "1m" ? base : base.length ? resamplePolled(base, tf, { from: "1m", now }) : [];
    const hist = st.geckoHist.get(tf);
    if (!hist || hist.length === 0) return res;
    const first = res.length ? res[0].ts : Infinity;
    const ms = TIMEFRAME_MS[tf];
    const older = hist.filter((c) => c.ts < first && c.ts + ms <= now);
    return older.length ? [...older, ...res] : res;
  }

  /**
   * 凍結: 一度返した足は OHLC を変えない。変えてよいのは出来高の「不明 → 分かった」だけ。
   * 新しい足は末尾に、履歴は最初の足より前にだけ足す
   */
  private freeze(st: TokenState, tf: Timeframe, fresh: readonly Candle[]): Candle[] {
    const prev = st.frozen.get(tf) ?? [];
    let out: Candle[];
    if (prev.length === 0) out = fresh.map((c) => ({ ...c }));
    else {
      const firstTs = prev[0].ts;
      const lastTs = prev[prev.length - 1].ts;
      const idx = new Map(prev.map((c, i) => [c.ts, i]));
      const before: Candle[] = [];
      const after: Candle[] = [];
      out = prev.slice();
      for (const c of fresh) {
        const i = idx.get(c.ts);
        if (i !== undefined) {
          const f = out[i];
          if (f.volumeKnown === false && c.volumeKnown !== false) out[i] = { ...f, volume: c.volume, volumeKnown: true };
        } else if (c.ts > lastTs) after.push({ ...c });
        else if (c.ts < firstTs) before.push({ ...c });
      }
      out = [...before, ...out, ...after];
    }
    if (out.length > this.maxCandles) out = out.slice(out.length - this.maxCandles);
    st.frozen.set(tf, out);
    return out;
  }

  // ───────── GeckoTerminal (裏の取得) ─────────

  /** 裏の取得を始める (動いていれば何もしない)。価格の取得のたびに呼ぶ */
  maintain(): void {
    if (!this.o.gecko || this.job || this.stopped) return;
    this.job = this.runJob().finally(() => {
      this.job = undefined;
    });
  }

  /** 裏の取得が終わるまで待つ (テスト用) */
  async idle(): Promise<void> {
    while (this.job) await this.job;
  }

  stop(): void {
    this.stopped = true;
  }

  private async runJob(): Promise<void> {
    for (let guard = 0; guard < 1000 && !this.stopped; guard++) {
      const task = this.nextTask();
      if (!task) return;
      try {
        await task();
      } catch (e) {
        this.geckoErrors++;
        this.warn("gecko", "GeckoTerminal の取得に失敗 (次の機会に再試行)", { error: redactedErrMsg(e) });
      }
    }
  }

  /** 次の取得 (プール → 履歴 (1m を全銘柄で先に) → 出来高 (最も古い銘柄から))。無ければ undefined */
  private nextTask(): (() => Promise<void>) | undefined {
    const gecko = this.o.gecko!;
    const states = [...this.byMint.values()];
    const t = this.now();
    const noPool = states.find((s) => s.pool === undefined || (s.pool === null && s.poolRetryAt !== undefined && t >= s.poolRetryAt));
    if (noPool) {
      return async () => {
        this.geckoCalls++;
        // 失敗・見つからないときは 5 分 → 15 分 → 60 分 (以後 60 分ごと) の後に取り直す
        const fail = () => {
          noPool.pool = null;
          noPool.poolFailures++;
          noPool.poolRetryAt = this.now() + backoffMs(noPool.poolFailures);
        };
        let p;
        try {
          p = await gecko.bestPoolFor(noPool.spec.mint);
        } catch (e) {
          fail();
          throw e;
        }
        if (!p) {
          fail();
          this.warn(`nopool:${noPool.spec.mint}`, "GeckoTerminal にプールが見つからない銘柄 (後で取り直します。それまで履歴・出来高なし)", { symbol: noPool.inst.symbol });
          return;
        }
        noPool.pool = p.address;
        noPool.poolFailures = 0;
        delete noPool.poolRetryAt;
      };
    }
    for (const tf of BACKFILL_ORDER) {
      if (!this.tfs.includes(tf) || !this.needsGeckoHistory(tf)) continue;
      const st = states.find((s) => {
        if (typeof s.pool !== "string" || s.backfilled.has(tf)) return false;
        const f = s.backfillFail.get(tf);
        return f === undefined || t >= f.retryAt;
      });
      if (st) return () => this.backfill(st, tf);
    }
    let best: TokenState | undefined;
    for (const s of states) {
      if (typeof s.pool !== "string" || !s.backfilled.has("1m")) continue;
      if (s.volumeAt !== undefined && t - s.volumeAt < this.volumeEveryMs) continue;
      if (!best || (s.volumeAt ?? -Infinity) < (best.volumeAt ?? -Infinity)) best = s;
    }
    if (best) {
      const st = best;
      return () => this.mergeVolume(st);
    }
    return undefined;
  }

  /** その時間足の履歴を GeckoTerminal から直接取るか (1m は常に。ほかは 1m の 1 ページ (1000 本) の集約で足りないとき) */
  needsGeckoHistory(tf: Timeframe): boolean {
    if (tf === "1m") return true;
    return this.historyBars * TIMEFRAME_MS[tf] > Math.min(this.maxCandles, 1000) * MIN;
  }

  private async backfill(st: TokenState, tf: Timeframe): Promise<void> {
    const pool = st.pool as string;
    this.geckoCalls++;
    const ms = TIMEFRAME_MS[tf];
    const want = tf === "1m" ? Math.min(1000, this.maxCandles) : Math.min(1000, this.historyBars + 5);
    let rows: Candle[];
    try {
      rows = await this.o.gecko!.fetchOhlcv(pool, tf, { limit: want, maxPages: 1 });
    } catch (e) {
      // 失敗した時間足は 5 分 → 15 分 → 60 分の後に取り直す (成功するまで取得済みにしない)
      const f = st.backfillFail.get(tf);
      const failures = (f?.failures ?? 0) + 1;
      st.backfillFail.set(tf, { failures, retryAt: this.now() + backoffMs(failures) });
      throw e;
    }
    st.backfilled.add(tf);
    st.backfillFail.delete(tf);
    if (!this.byMint.has(st.spec.mint)) return;
    const t = this.now();
    const closed = rows.filter((c) => c.ts + ms <= t);
    if (tf === "1m") {
      const until = st.firstPolledTs ?? Math.floor(t / MIN) * MIN;
      this.store.builder(st.spec.mint).seed(closed.filter((c) => c.ts < until), true);
    } else {
      st.geckoHist.set(tf, closed.map((c) => ({ ...c })));
    }
    st.version++;
  }

  /** 1m の出来高を入れる (確定してから volumeLagMs 以上経った足だけ。取引の無い分は出来高 0) */
  private async mergeVolume(st: TokenState): Promise<void> {
    const pool = st.pool as string;
    const t0 = this.now();
    st.volumeAt = t0;
    this.geckoCalls++;
    const rows = await this.o.gecko!.fetchOhlcv(pool, "1m", { limit: 60, maxPages: 1 });
    if (!this.byMint.has(st.spec.mint) || rows.length === 0) return;
    const cutoff = this.now() - this.volumeLagMs;
    const byTs = new Map(rows.map((c) => [c.ts, c.volume]));
    for (let ts = rows[0].ts; ts + MIN <= cutoff; ts += MIN) st.geckoVol.set(ts, byTs.get(ts) ?? 0);
    const keepFrom = t0 - this.maxCandles * MIN;
    for (const k of st.geckoVol.keys()) if (k < keepFrom) st.geckoVol.delete(k);
    st.version++;
  }

  status(): JupiterFeedStatus {
    const t = this.now();
    return {
      tokens: [...this.bySymbol.values()].map((s) => ({
        symbol: s.inst.symbol,
        mint: s.spec.mint,
        assetClass: s.spec.assetClass,
        source: s.spec.source,
        ...(s.lastPrice ? { price: s.lastPrice.usd } : {}),
        ...(s.quote ? { quoteAgeMs: t - s.quote.ts } : {}),
        ...(s.liquidityUsd !== undefined ? { liquidityUsd: s.liquidityUsd } : {}),
        ...(s.pool !== undefined ? { pool: s.pool } : {}),
        backfilled: [...s.backfilled],
        ...(s.volumeAt !== undefined ? { volumeAt: s.volumeAt } : {}),
        ...(s.entryBlock ? { entryBlock: s.entryBlock } : {}),
      })),
      ...(this.lastPollAt !== undefined ? { lastPollAt: this.lastPollAt } : {}),
      ...(this.lastPollError ? { lastPollError: this.lastPollError } : {}),
      missing: [...this.lastMissing],
      invalid: [...this.lastInvalid],
      geckoCalls: this.geckoCalls,
      geckoErrors: this.geckoErrors,
    };
  }
}
