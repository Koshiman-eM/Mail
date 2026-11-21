/** タイトル・本文から関連資産を正規化して付与する */

export interface TagOptions {
  /** 追加辞書: キーワード → 付与する資産。英数字は単語一致 (大小無視)、それ以外は部分一致 */
  extra?: Record<string, string[]>;
}

interface Rule {
  assets: string[];
  /** 大小無視 */
  ci?: string[];
  /** 大小区別 (ティッカー・略語) */
  cs?: string[];
  /** 日本語など部分一致 */
  jp?: string[];
  re?: RegExp;
}

const MEME = (sym: string, ci: string[], extra: Partial<Rule> = {}): Rule => ({ assets: [sym, "MEME"], ci, ...extra });

const RULES: Rule[] = [
  { assets: ["BTC"], ci: ["bitcoin", "btc"], jp: ["ビットコイン"] },
  { assets: ["ETH"], ci: ["ethereum", "ether", "eth"], jp: ["イーサリアム", "イーサ"] },
  { assets: ["SOL"], ci: ["solana"], cs: ["SOL"], jp: ["ソラナ"] },
  { assets: ["XRP"], ci: ["ripple", "xrp"], jp: ["リップル"] },
  { assets: ["BNB"], ci: ["bnb", "binance coin"] },
  { assets: ["ADA"], ci: ["cardano"], cs: ["ADA"] },
  { assets: ["AVAX"], ci: ["avalanche", "avax"] },
  { assets: ["LINK"], ci: ["chainlink"], cs: ["LINK"] },
  MEME("DOGE", ["dogecoin", "doge"], { jp: ["ドージコイン"] }),
  MEME("SHIB", ["shiba inu", "shib"]),
  MEME("PEPE", ["pepe"]),
  MEME("BONK", ["bonk"]),
  MEME("WIF", ["dogwifhat"], { cs: ["WIF"] }),
  MEME("FLOKI", ["floki"]),
  { assets: ["MEME"], ci: ["memecoin", "memecoins", "meme coin", "meme coins", "pump.fun"], jp: ["ミームコイン"] },
  {
    assets: ["CRYPTO"],
    ci: ["crypto", "cryptocurrency", "cryptocurrencies", "stablecoin", "altcoin", "defi", "blockchain"],
    jp: ["仮想通貨", "暗号資産"],
  },
  {
    assets: ["USD"],
    cs: ["Fed", "FOMC", "NFP", "CPI", "PCE", "FRB"],
    ci: ["federal reserve", "powell", "nonfarm", "treasury yields"],
    jp: ["ドル", "米連邦準備"],
    re: /(?<!(?:australian|canadian|new zealand|hong kong|singapore) )\bdollars?\b/i,
  },
  { assets: ["JPY"], ci: ["boj", "bank of japan", "yen"], jp: ["日銀", "日本銀行", "円"] },
  { assets: ["EUR"], ci: ["ecb", "euro", "eurozone", "lagarde"], jp: ["ユーロ"] },
  { assets: ["GBP"], ci: ["bank of england", "sterling", "boe"], jp: ["ポンド"] },
  { assets: ["AUD"], ci: ["rba", "aussie", "australian dollar"] },
  { assets: ["CAD"], ci: ["loonie", "canadian dollar"] },
  { assets: ["CHF"], ci: ["swiss franc", "snb"] },
  { assets: ["NZD"], ci: ["rbnz", "kiwi", "new zealand dollar"] },
  { assets: ["CNY"], ci: ["yuan", "pboc", "renminbi"], jp: ["人民元"] },
  // 株式市場全体のニュース (リスクオン指数の材料。株式の取引はしない)
  { assets: ["STOCKS"], ci: ["stocks", "wall street", "s&p 500", "nasdaq", "dow jones", "equities"], jp: ["株式", "株価"] },
];

const CURRENCIES = new Set(["USD", "JPY", "EUR", "GBP", "AUD", "CAD", "CHF", "NZD", "CNY"]);
const CRYPTO_BASES = new Set(["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "AVAX", "LINK", "DOGE", "SHIB", "PEPE", "BONK", "WIF", "FLOKI"]);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isAscii = (s: string) => /^[\x20-\x7e]+$/.test(s);

/** 単語境界つき (英数字の連続に埋もれていない) 一致 */
function wordRe(kw: string, ci: boolean): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${esc(kw)}(?![A-Za-z0-9])`, ci ? "i" : "");
}

interface Compiled {
  assets: string[];
  tests: RegExp[];
  jp: string[];
}
const compile = (r: Rule): Compiled => ({
  assets: r.assets,
  tests: [...(r.ci ?? []).map((k) => wordRe(k, true)), ...(r.cs ?? []).map((k) => wordRe(k, false)), ...(r.re ? [r.re] : [])],
  jp: r.jp ?? [],
});
const COMPILED = RULES.map(compile);

export function tagAssets(text: string, opts: TagOptions = {}): string[] {
  const out = new Set<string>();
  for (const c of COMPILED) {
    if (c.tests.some((t) => t.test(text)) || c.jp.some((k) => text.includes(k))) c.assets.forEach((a) => out.add(a));
  }
  for (const [kw, assets] of Object.entries(opts.extra ?? {})) {
    const hit = isAscii(kw) ? wordRe(kw, true).test(text) : text.includes(kw);
    if (hit) assets.forEach((a) => out.add(a));
  }
  // クラス単位の擬似資産を自動付与
  const list = [...out];
  if (list.some((a) => CRYPTO_BASES.has(a))) out.add("CRYPTO");
  return [...out].sort();
}
