"use client";

import { useState } from "react";
import { BellOff, BellRing, CircleCheck, CircleX, Info, Loader2, Send, Smartphone } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { disablePush, enablePush, sendTestPush, usePushStatus } from "./pwa/push";
import { isIos, useIsStandalone } from "./pwa/install";
import { writeFlag, PUSH_CARD_DISMISSED } from "./pwa/storage";

type Busy = "enable" | "disable" | "test" | null;

/** 設定 > 通知: この端末での Web Push の有効化・テスト・停止 */
export function PushSettings() {
  const status = usePushStatus();
  const standalone = useIsStandalone();
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const run = async (kind: Exclude<Busy, null>, fn: () => Promise<string>) => {
    setBusy(kind);
    setMessage(null);
    try {
      setMessage({ tone: "ok", text: await fn() });
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "処理に失敗しました" });
    } finally {
      setBusy(null);
      await status.refresh();
    }
  };

  const enable = () =>
    run("enable", async () => {
      await enablePush();
      writeFlag(PUSH_CARD_DISMISSED);
      return "この端末で通知を受け取れるようになりました。";
    });
  const disable = () =>
    run("disable", async () => {
      await disablePush();
      return "この端末への通知を停止しました。";
    });
  const test = () =>
    run("test", async () => {
      const r = await sendTestPush();
      if (r.sent === 0) throw new Error("送信先の端末がありません。もう一度「この端末で通知を受け取る」を押してください。");
      return `テスト通知を ${r.sent} 台の端末に送信しました。数秒で届きます。`;
    });

  const ios = typeof window !== "undefined" && isIos();

  let state: React.ReactNode;
  if (status.loading) state = <Badge variant="outline">確認中…</Badge>;
  else if (!status.supported) state = <Badge variant="outline">このブラウザは非対応</Badge>;
  else if (status.permission === "denied") state = <Badge variant="destructive"><CircleX className="h-3 w-3" /> ブロック中</Badge>;
  else if (status.subscribed) state = <Badge variant="success"><CircleCheck className="h-3 w-3" /> 受信中</Badge>;
  else state = <Badge variant="outline">未設定</Badge>;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card>
        <CardHeader>
          <CardTitle>
            <BellRing className="h-4 w-4" /> プッシュ通知
          </CardTitle>
          <CardDescription>
            業者からのメッセージ受信、返信案の準備完了、価格・在庫の重要な変化、再認証が必要になったときなどに、この端末へ通知します。設定は端末 (ブラウザ) ごとです。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">この端末の状態:</span>
            {state}
          </div>

          {!status.loading && !status.supported && (
            <p className="rounded-md bg-warning-soft px-3 py-2 text-[13px] leading-relaxed text-warning-ink">
              {ios && !standalone
                ? "iPhone / iPad では、Safari の共有メニューから「ホーム画面に追加」でアプリをインストールし、ホーム画面のアイコンから開くと通知を設定できます。"
                : "このブラウザはプッシュ通知に対応していません。Android の Chrome など対応ブラウザでお試しください。"}
            </p>
          )}
          {status.permission === "denied" && (
            <p className="rounded-md bg-destructive-soft px-3 py-2 text-[13px] leading-relaxed text-destructive">
              通知がブロックされています。ブラウザのアドレスバーの鍵アイコン (またはアプリ情報) から「通知」を許可してから、もう一度お試しください。
            </p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {!status.subscribed && (
              <Button className="h-11 sm:h-9" onClick={enable} disabled={!status.supported || status.permission === "denied" || busy !== null}>
                {busy === "enable" ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />} この端末で通知を受け取る
              </Button>
            )}
            {status.subscribed && (
              <>
                <Button className="h-11 sm:h-9" variant="outline" onClick={test} disabled={busy !== null}>
                  {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} テスト通知を送る
                </Button>
                <Button className="h-11 sm:h-9" variant="ghost" onClick={disable} disabled={busy !== null}>
                  {busy === "disable" ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellOff className="h-4 w-4" />} 通知を止める
                </Button>
              </>
            )}
          </div>
          {message && (
            <p role="status" className={message.tone === "ok" ? "text-sm text-success" : "text-sm text-destructive"}>
              {message.text}
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="self-start">
        <CardHeader>
          <CardTitle>
            <Smartphone className="h-4 w-4" /> 端末ごとの注意
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3 text-[13px] leading-relaxed text-muted-foreground">
            <li className="flex gap-2">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span>
                <span className="font-medium text-foreground">Android (Chrome)</span>: 一度許可すれば、アプリやブラウザを閉じていても通知が届きます。ホーム画面にインストールしておくと、通知のタップでアプリとして開きます。
              </span>
            </li>
            <li className="flex gap-2">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span>
                <span className="font-medium text-foreground">iPhone / iPad</span>: iOS 16.4 以降で、ホーム画面に追加したアプリからのみ通知を受け取れます (Safari のタブでは受け取れません)。
              </span>
            </li>
            <li className="flex gap-2">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span>省電力設定やおやすみモードによっては、通知が遅れたり表示されなかったりすることがあります。</span>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
