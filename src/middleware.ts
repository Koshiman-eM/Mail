import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "sedori_sid";
const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/setup", "/api/auth/status"];

/**
 * Edge で動く一次チェック: セッション Cookie が無ければログイン画面 / 401 へ。
 * Cookie の有効性 (DB 照合) は各 API ハンドラーの requireUser() で必ず検証する。
 * また、状態を変更する API リクエストは同一オリジンからのものに限定する (CSRF 対策)。
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (isApi && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.get("origin");
    if (origin && origin !== req.nextUrl.origin) {
      return NextResponse.json({ error: "不正なオリジンからのリクエストです" }, { status: 403 });
    }
  }

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();

  if (isApi) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // PWA の静的ファイル (manifest / service worker / アイコン) はログイン前でも取得できる必要がある
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|sw.js|icons/).*)"],
};
