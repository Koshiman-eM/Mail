"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { swUrl } from "./pwa/push";
import "./pwa/install"; // beforeinstallprompt をできるだけ早く捕捉する

const THEME_COLOR = { light: "#f9f9f7", dark: "#0d0d0d" } as const;

/** アプリ内テーマ (data-theme) に合わせてステータスバーの色を揃える */
function syncThemeColor() {
  const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    m.content = THEME_COLOR[theme];
  });
}

/**
 * Service Worker の登録と PWA 関連の常駐処理。
 * - 開発時は sw.js?dev=1 で登録し、SW 側でキャッシュを無効化する
 * - 通知タップで既存ウィンドウに画面遷移を依頼されたらルーターで遷移する
 */
export function PwaRegister() {
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const register = () => navigator.serviceWorker.register(swUrl(), { scope: "/" }).catch((e) => console.warn("[pwa] service worker の登録に失敗しました", e));
    if (document.readyState === "complete") void register();
    else window.addEventListener("load", register, { once: true });

    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (d?.type !== "navigate" || typeof d.url !== "string") return;
      const u = new URL(d.url, location.origin);
      if (u.origin === location.origin) router.push(u.pathname + u.search + u.hash);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("load", register);
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [router]);

  useEffect(() => {
    syncThemeColor();
    const mo = new MutationObserver(syncThemeColor);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, [path]);

  return null;
}
