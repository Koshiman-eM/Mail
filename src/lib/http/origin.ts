/**
 * 状態を変更するリクエストが同一オリジンからのものか判定する (CSRF 対策)。
 * Render などのリバースプロキシ配下では Next が認識する自分のオリジン (内部アドレス) と
 * ブラウザが送る Origin が一致しないため、Host / X-Forwarded-Host と公開 URL も同一とみなす。
 */
export function isSameOrigin(
  origin: string | null,
  opts: { requestOrigin: string; host?: string | null; forwardedHost?: string | null; publicUrls?: (string | undefined)[] },
): boolean {
  if (!origin) return true; // Origin を送らない同一オリジンの古いブラウザ・サーバー間通信
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.protocol !== "https:" && o.protocol !== "http:") return false;
  if (o.origin === opts.requestOrigin) return true;
  const hosts = new Set<string>();
  const fwd = opts.forwardedHost?.split(",")[0]?.trim();
  if (fwd) hosts.add(fwd.toLowerCase());
  if (opts.host) hosts.add(opts.host.trim().toLowerCase());
  for (const u of opts.publicUrls ?? []) {
    if (!u) continue;
    try {
      hosts.add(new URL(u).host.toLowerCase());
    } catch {
      /* 無視 */
    }
  }
  return hosts.has(o.host.toLowerCase());
}
