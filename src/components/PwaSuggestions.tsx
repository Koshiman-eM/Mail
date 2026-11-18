"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BellRing, X } from "lucide-react";
import { Button } from "./ui/button";
import { InstallCard } from "./InstallPrompt";
import { useCanInstall, useIsStandalone } from "./pwa/install";
import { enablePush, usePushStatus } from "./pwa/push";
import { INSTALL_CARD_DISMISSED, PUSH_CARD_DISMISSED, readFlag, writeFlag } from "./pwa/storage";

function PushSuggestCard({ onDismiss, onEnabled }: { onDismiss: () => void; onEnabled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      await enablePush();
      onEnabled();
    } catch (e) {
      setError(e instanceof Error ? e.message : "通知を有効にできませんでした");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-5 flex items-start gap-3 rounded-xl border bg-card p-4 shadow-card">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
        <BellRing className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">この端末で通知を受け取りませんか？</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
          業者からの返信や価格・在庫の重要な変化を、アプリを閉じていてもお知らせします。
          <Link href="/settings?tab=notifications" className="ml-1 text-primary underline-offset-4 hover:underline">
            詳しく
          </Link>
        </p>
        {error && <p className="mt-2 text-[13px] text-destructive">{error}</p>}
        <Button size="sm" className="mt-3 h-10 px-4" onClick={enable} disabled={busy}>
          <BellRing className="h-4 w-4" aria-hidden="true" /> 通知を受け取る
        </Button>
      </div>
      <button onClick={onDismiss} className="-m-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent" aria-label="通知の案内を閉じる">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * モバイル向けの一度きりの案内カード (インストール → 通知の順に 1 枚だけ表示)。
 * 閉じた案内は localStorage に記録して再表示しない。lg 以上では表示しない。
 */
export function PwaSuggestions() {
  const canInstall = useCanInstall();
  const standalone = useIsStandalone();
  const push = usePushStatus();
  const [dismissed, setDismissed] = useState<{ install: boolean; push: boolean } | null>(null);
  useEffect(() => setDismissed({ install: readFlag(INSTALL_CARD_DISMISSED), push: readFlag(PUSH_CARD_DISMISSED) }), []);
  if (!dismissed) return null;

  let card: React.ReactNode = null;
  if (canInstall && !standalone && !dismissed.install) {
    card = (
      <InstallCard
        onDismiss={() => {
          writeFlag(INSTALL_CARD_DISMISSED);
          setDismissed({ ...dismissed, install: true });
        }}
      />
    );
  } else if (!push.loading && push.supported && !push.subscribed && push.permission !== "denied" && !dismissed.push) {
    const hidePush = () => {
      writeFlag(PUSH_CARD_DISMISSED);
      setDismissed({ ...dismissed, push: true });
    };
    card = <PushSuggestCard onDismiss={hidePush} onEnabled={hidePush} />;
  }
  return card ? <div className="lg:hidden">{card}</div> : null;
}
