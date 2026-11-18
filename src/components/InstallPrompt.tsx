"use client";

import { Download, Smartphone, X } from "lucide-react";
import { Button } from "./ui/button";
import { promptInstall, useCanInstall, useIsStandalone } from "./pwa/install";

/** トップバーの「アプリとしてインストール」ボタン (インストール可能なときだけ表示) */
export function InstallButton() {
  const canInstall = useCanInstall();
  const standalone = useIsStandalone();
  if (!canInstall || standalone) return null;
  return (
    <Button variant="soft" size="sm" className="h-9 px-2.5 sm:px-3" onClick={() => void promptInstall()} aria-label="アプリとしてインストール" title="アプリとしてインストール">
      <Download className="h-4 w-4" aria-hidden="true" />
      <span className="hidden sm:inline">アプリとしてインストール</span>
    </Button>
  );
}

/** 閉じられるインストール案内カード (表示判定は PwaSuggestions が行う) */
export function InstallCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="mb-5 flex items-start gap-3 rounded-xl border bg-card p-4 shadow-card">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
        <Smartphone className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">ホーム画面に追加できます</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">アプリとしてインストールすると、全画面で素早く起動でき、通知も受け取りやすくなります。</p>
        <Button size="sm" className="mt-3 h-10 px-4" onClick={() => void promptInstall()}>
          <Download className="h-4 w-4" aria-hidden="true" /> アプリとしてインストール
        </Button>
      </div>
      <button onClick={onDismiss} className="-m-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent" aria-label="インストールの案内を閉じる">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
