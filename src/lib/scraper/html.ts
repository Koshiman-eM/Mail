/**
 * 巨大・悪意のある HTML でも線形時間で動くタグ走査ヘルパー。
 * `<link[^>]+rel=...` のような正規表現は、閉じ `>` の無い入力でバックトラックが爆発する (ReDoS) ため使わない。
 */

/** 1 タグとして扱う最大長 (これより長い「タグ」は無視する) */
export const MAX_TAG_LENGTH = 4000;

/**
 * `<name ...>` の開始タグ文字列を先頭から順に返す (大文字小文字は区別しない)。
 * 各タグの終わり (`>`) の探索結果を使い回すため、全体で O(n)。
 */
export function* scanTags(html: string, name: string, maxLen = MAX_TAG_LENGTH): Generator<{ tag: string; start: number; end: number }> {
  const re = new RegExp(`<${name}(?=[\\s/>])`, "gi");
  let nextGt = -1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const start = m.index;
    if (nextGt < start) {
      nextGt = html.indexOf(">", start);
      if (nextGt === -1) return; // 以降に閉じ `>` は無い
    }
    if (nextGt - start <= maxLen) yield { tag: html.slice(start, nextGt + 1), start, end: nextGt + 1 };
    re.lastIndex = Math.max(re.lastIndex, start + 1);
  }
}

/** タグ文字列から属性値を取り出す (タグは MAX_TAG_LENGTH 以下なので正規表現でも安全) */
export function tagAttr(tag: string, attr: string): string | null {
  const m = tag.match(new RegExp(`[\\s"'/]${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** 最初に条件を満たすタグの属性値 */
export function findTagAttr(html: string, name: string, match: (tag: string) => boolean, attr: string): string | null {
  for (const { tag } of scanTags(html, name)) {
    if (!match(tag)) continue;
    const v = tagAttr(tag, attr);
    if (v) return v;
  }
  return null;
}
