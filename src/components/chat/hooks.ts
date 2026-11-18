"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/components/api";

export type SendMode = "handoff" | "mock" | "external";

/** サーバーの送信方式 (GET /api/chat/config)。取得前・失敗時は安全側の handoff として扱う */
export function useSendMode(): SendMode {
  const { data } = useQuery({
    queryKey: ["chat-config"],
    queryFn: () => api<{ sendMode: SendMode }>("/api/chat/config"),
    staleTime: 5 * 60_000,
  });
  return data?.sendMode ?? "handoff";
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** 入力に合わせて高さが伸びる textarea 用 (片手操作でもスクロールせずに全文を確認できる) */
export function useAutoGrow(value: string, maxPx = 320) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, maxPx)}px`;
    el.style.overflowY = el.scrollHeight + 2 > maxPx ? "auto" : "hidden";
  }, [value, maxPx]);
  return ref;
}

/** Web Share API (Android の共有シート) が使えるか。SSR との差異を避けるためマウント後に判定 */
export function useCanShare() {
  const [can, setCan] = useState(false);
  useEffect(() => setCan(typeof navigator !== "undefined" && typeof navigator.share === "function"), []);
  return can;
}

/** クリップボードへコピー。Clipboard API が使えない場合は一時 textarea + execCommand で代替 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 非 HTTPS や権限拒否 → 代替手段へ
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 一定時間だけ true になるフラグ (「コピーしました」表示用) */
export function useFlash(ms = 2000): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const fire = useCallback(() => {
    setOn(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, fire];
}
