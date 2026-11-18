/* 越境せどり Service Worker (ビルド不要のプレーン JS)
 *
 * - Web Push の受信と通知タップ時の画面遷移
 * - 静的アセット (/_next/static/, /icons/) のみキャッシュ (cache-first)
 * - ページ遷移はネットワークのみ。失敗時だけ簡易オフラインページを返す
 *   (ログインが必要な HTML や API レスポンスは一切キャッシュしない)
 * - 開発時 (sw.js?dev=1 で登録) はキャッシュを使わない
 */

const VERSION = "v1";
const STATIC_CACHE = `sedori-static-${VERSION}`;
const DEV = new URL(self.location.href).searchParams.get("dev") === "1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("sedori-") && (DEV || k !== STATIC_CACHE)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------------------
// ネットワーク
// ---------------------------------------------------------------------------

const OFFLINE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>オフライン | 越境せどり</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;background:#f9f9f7;color:#0b0b0b;padding:24px;box-sizing:border-box;text-align:center}
  @media (prefers-color-scheme:dark){body{background:#0d0d0d;color:#f0efec}p{color:#c3c2b7!important}}
  .logo{width:56px;height:56px;border-radius:14px;background:#256abf;color:#fff;font-weight:900;font-size:28px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}
  h1{font-size:20px;margin:0 0 8px}
  p{margin:0 0 20px;color:#52514e;font-size:14px;line-height:1.7}
  button{min-height:48px;padding:0 24px;border:0;border-radius:10px;background:#256abf;color:#fff;font-size:15px;font-weight:600}
</style></head>
<body><main>
  <div class="logo" aria-hidden="true">越</div>
  <h1>オフラインです</h1>
  <p>インターネットに接続されていません。<br>接続を確認してから再読み込みしてください。</p>
  <button type="button" onclick="location.reload()">再読み込み</button>
</main></body></html>`;

function isStaticAsset(url) {
  return url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // ページ遷移: 常にネットワーク。失敗したときだけオフラインページ (HTML はキャッシュしない)
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(
        () => new Response(OFFLINE_HTML, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }),
      ),
    );
    return;
  }

  // 静的アセット: cache-first (ファイル名にハッシュが付くため安全)。開発時はキャッシュしない
  if (!DEV && isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok && res.type === "basic") cache.put(req, res.clone()).catch(() => {});
        return res;
      })(),
    );
  }
  // それ以外 (API・SSE・RSC など) は介入しない = ブラウザ既定のネットワーク処理
});

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

function safeUrl(path) {
  try {
    const u = new URL(typeof path === "string" && path ? path : "/", self.location.origin);
    return u.origin === self.location.origin ? u.href : self.location.origin + "/";
  } catch {
    return self.location.origin + "/";
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "越境せどり";
  const critical = data.severity === "CRITICAL";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    lang: "ja",
    tag: data.tag || undefined,
    renotify: Boolean(critical && data.tag),
    requireInteraction: critical,
    vibrate: critical ? [200, 100, 200, 100, 200] : [120],
    timestamp: Date.now(),
    data: { url: safeUrl(data.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const same = all.find((c) => c.url === target);
      if (same) return same.focus();
      const client = all.find((c) => new URL(c.url).origin === self.location.origin);
      if (client) {
        try {
          const focused = await client.focus();
          if ("navigate" in focused) {
            const navigated = await focused.navigate(target);
            if (navigated) return navigated;
          }
          // 未制御のクライアントでは navigate できないので postMessage で依頼する
          focused.postMessage({ type: "navigate", url: target });
          return focused;
        } catch {
          /* フォールバックで新規ウィンドウ */
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});

// ブラウザ側で購読が更新された場合は、新しい購読をサーバーへ登録し直す
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch("/api/push/public-key", { credentials: "same-origin" });
        if (!res.ok) return;
        const { publicKey } = await res.json();
        const padding = "=".repeat((4 - (publicKey.length % 4)) % 4);
        const raw = atob((publicKey + padding).replace(/-/g, "+").replace(/_/g, "/"));
        const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        await fetch("/api/push/subscribe", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sub.toJSON()),
        });
      } catch {
        /* 次回アプリを開いたときに設定画面から再登録できる */
      }
    })(),
  );
});
