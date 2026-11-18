"use client";

import { useSyncExternalStore } from "react";

/** Chrome (Android / デスクトップ) の beforeinstallprompt イベント */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// モジュール読み込み時点で捕捉する (コンポーネントのマウントより先に発火することがあるため)
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // ブラウザ既定のミニバーを抑止し、アプリ内のボタンから表示する
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** インストール可能 (beforeinstallprompt を受け取り済み) か */
export function useCanInstall(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => deferred !== null,
    () => false,
  );
}

/** インストールダイアログを表示する。受け入れられたら true */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null; // prompt() は 1 イベントにつき 1 回しか呼べない
  emit();
  await e.prompt();
  const { outcome } = await e.userChoice;
  return outcome === "accepted";
}

const STANDALONE_QUERY = "(display-mode: standalone)";

function readStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia(STANDALONE_QUERY).matches;
}

function subscribeStandalone(l: () => void) {
  const mq = window.matchMedia(STANDALONE_QUERY);
  mq.addEventListener("change", l);
  return () => mq.removeEventListener("change", l);
}

/** インストール済みアプリ (スタンドアロン表示) で動いているか */
export function useIsStandalone(): boolean {
  return useSyncExternalStore(subscribeStandalone, readStandalone, () => false);
}

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
