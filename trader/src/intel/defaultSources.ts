/** trader (暗号資産) の既定の情報源一式: RSS (暗号資産 + 経済ニュース)・Fear&Greed・CryptoPanic・CoinGecko・経済指標 */
import type { TagOptions } from "./assetTagger";
import { createCoinGeckoSource } from "./sources/coingecko";
import type { FetchJsonFn, FetchTextFn, IntelSource } from "./sources/common";
import { createCryptoPanicSource } from "./sources/cryptopanic";
import { createEconCalendarSource } from "./sources/econCalendar";
import { createFearGreedSource } from "./sources/fearGreed";
import { createRssSources } from "./sources/rss";

/** trader の既定の RSS (NEWS_RSS_FEEDS の先頭 "=" で置き換え、それ以外は追加) */
export const TRADER_RSS_FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  "https://feeds.bbci.co.uk/news/business/rss.xml",
];

/** 既定の情報源一式 (CRYPTOPANIC_TOKEN 未設定なら cryptopanic は含まれない) */
export function createDefaultSources(
  opts: { env?: Record<string, string | undefined>; fetchText?: FetchTextFn; fetchJson?: FetchJsonFn; tag?: TagOptions } = {},
): IntelSource[] {
  const env = opts.env ?? process.env;
  const list: (IntelSource | undefined)[] = [
    ...createRssSources({ env: env.NEWS_RSS_FEEDS, defaults: TRADER_RSS_FEEDS, fetchText: opts.fetchText, tag: opts.tag }),
    createFearGreedSource({ fetchJson: opts.fetchJson }),
    createCryptoPanicSource({ token: env.CRYPTOPANIC_TOKEN, fetchJson: opts.fetchJson }),
    createCoinGeckoSource({ fetchJson: opts.fetchJson }),
    createEconCalendarSource({ fetchJson: opts.fetchJson }),
  ];
  return list.filter((s): s is IntelSource => Boolean(s));
}
