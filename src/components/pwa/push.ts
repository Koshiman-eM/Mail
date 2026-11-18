"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

export type PushPermission = "default" | "granted" | "denied";

export interface PushStatus {
  /** 確認中 */
  loading: boolean;
  /** このブラウザが Web Push に対応しているか */
  supported: boolean;
  permission: PushPermission;
  /** この端末で購読済みか */
  subscribed: boolean;
}

export function isPushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Service Worker の準備完了を待つ (登録されていなければ登録する) */
async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (!existing) await navigator.serviceWorker.register(swUrl(), { scope: "/" });
  return navigator.serviceWorker.ready;
}

export function swUrl() {
  return process.env.NODE_ENV === "production" ? "/sw.js" : "/sw.js?dev=1";
}

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

/** 通知の許可を求め、この端末を購読してサーバーへ登録する */
export async function enablePush(): Promise<void> {
  if (!isPushSupported()) throw new Error("このブラウザはプッシュ通知に対応していません");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("通知が許可されませんでした。ブラウザのサイト設定から通知を許可してください。");
  const reg = await getRegistration();
  const { publicKey } = await api<{ publicKey: string }>("/api/push/public-key");
  const key = base64UrlToBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    // サーバーの鍵が変わった場合は作り直す
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api("/api/push/subscribe", { method: "POST", json: sub.toJSON() });
}

/** この端末の購読を解除する */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api("/api/push/unsubscribe", { method: "POST", json: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

export function sendTestPush() {
  return api<{ sent: number; removed: number; failed: number }>("/api/push/test", { method: "POST" });
}

/** この端末のプッシュ通知の状態 */
export function usePushStatus() {
  const [status, setStatus] = useState<PushStatus>({ loading: true, supported: false, permission: "default", subscribed: false });
  const refresh = useCallback(async () => {
    if (!isPushSupported()) {
      setStatus({ loading: false, supported: false, permission: "default", subscribed: false });
      return;
    }
    const sub = await currentSubscription().catch(() => null);
    setStatus({ loading: false, supported: true, permission: Notification.permission as PushPermission, subscribed: Boolean(sub) && Notification.permission === "granted" });
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { ...status, refresh };
}
