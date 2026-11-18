"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, CheckCheck, Copy, ExternalLink, Link2, Loader2, Share2, ShieldAlert, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/components/api";
import { cn } from "@/lib/utils";
import { ChatUrlEditor } from "./ChatUrlEditor";
import { copyText, useAutoGrow, useCanShare, useFlash, type SendMode } from "./hooks";

export interface HandoffMessage {
  id: string;
  version: number;
  finalText: string | null;
  draftTextJa: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}
export interface HandoffSupplier {
  id: string;
  name: string;
  chatUrl: string | null;
  isBlacklisted: boolean;
}

const textareaId = (id: string) => `handoff-text-${id}`;

/**
 * 承認済み (APPROVED) メッセージの「手渡し」表示: 承認済み本文 (コピー元)・訳・業者チャット URL。
 * 操作ボタンは HandoffActions (モバイルでは画面下部に固定表示される)。
 */
export function HandoffText({ m, supplier }: { m: HandoffMessage; supplier: HandoffSupplier }) {
  const text = m.finalText ?? "";
  const ref = useAutoGrow(text, 400);
  const [editingUrl, setEditingUrl] = useState(false);
  return (
    <div className="space-y-2">
      <label htmlFor={textareaId(m.id)} className="block text-[11px] font-medium text-muted-foreground">
        承認済みの本文 (この内容を業者アプリで送ってください)
      </label>
      <textarea
        id={textareaId(m.id)}
        ref={ref}
        readOnly
        value={text}
        rows={3}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full resize-none rounded-md border border-input bg-card px-3 py-2 text-sm leading-relaxed shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
      />
      {m.draftTextJa && <p className="whitespace-pre-wrap rounded-md bg-card/70 px-3 py-2 text-xs leading-relaxed text-muted-foreground">訳: {m.draftTextJa}</p>}
      <p className="text-xs text-muted-foreground">
        {m.approvedBy} が {m.approvedAt && new Date(m.approvedAt).toLocaleString("ja-JP")} に承認。アプリからは自動送信されません。
      </p>
      {editingUrl ? (
        <ChatUrlEditor supplierId={supplier.id} chatUrl={supplier.chatUrl} onClose={() => setEditingUrl(false)} />
      ) : (
        !supplier.chatUrl && (
          <button type="button" className="inline-flex min-h-8 items-center gap-1 text-xs text-primary underline-offset-4 hover:underline" onClick={() => setEditingUrl(true)}>
            <Link2 className="h-3.5 w-3.5" /> 業者チャットの URL を登録
          </button>
        )
      )}
    </div>
  );
}

/**
 * 手渡し送信の操作: コピー / 共有シート / 業者チャットを開く / 送信しました / 取り消す。
 * 「送信しました」は既存の /send (承認再検証・CAS・ブラックリスト確認・監査ログ付き) を通して SENT を記録する。
 */
export function HandoffActions({
  m,
  supplier,
  sendMode,
  onChanged,
  compact,
  className,
}: {
  m: HandoffMessage;
  supplier: HandoffSupplier;
  sendMode: SendMode;
  onChanged: () => void;
  /** 画面下部の固定バー用のコンパクト表示 */
  compact?: boolean;
  className?: string;
}) {
  const text = m.finalText ?? "";
  const canShare = useCanShare();
  const [copied, flashCopied] = useFlash();
  const [hint, setHint] = useState<string | null>(null);
  const [confirmExternal, setConfirmExternal] = useState(false);

  const send = useMutation({
    mutationFn: () => api(`/api/chat/messages/${m.id}/send`, { method: "POST", json: {} }),
    onSettled: () => {
      setConfirmExternal(false);
      onChanged();
    },
  });
  const undo = useMutation({
    mutationFn: () => api(`/api/chat/messages/${m.id}/reject`, { method: "POST", json: { expectedVersion: m.version, reason: "承認取消 (未送信)" } }),
    onSettled: onChanged,
  });
  const busy = send.isPending || undo.isPending;

  const onCopy = async () => {
    setHint(null);
    if (await copyText(text)) {
      flashCopied();
      return;
    }
    // 最終手段: 本文を選択状態にして長押しコピーを促す
    const el = document.getElementById(textareaId(m.id)) as HTMLTextAreaElement | null;
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.focus();
      el.select();
    }
    setHint("自動でコピーできませんでした。本文を長押ししてコピーしてください。");
  };
  const onShare = async () => {
    setHint(null);
    try {
      await navigator.share({ text });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setHint("共有できませんでした。「コピー」を使ってください。");
    }
  };

  const big = "h-11 lg:h-9";
  /** 360px 幅でも 3 つ並ぶよう、モバイルではアイコンの下にラベル */
  const tile = "h-14 min-w-0 flex-col gap-0.5 px-1 text-[11px] lg:h-9 lg:flex-row lg:gap-1.5 lg:px-3 lg:text-sm";
  const primaryLabel = sendMode === "external" ? "送信する" : "送信しました";

  return (
    <div className={cn("space-y-2", className)}>
      <div className={cn("grid gap-2", canShare ? "grid-cols-3" : "grid-cols-2", !compact && "lg:flex lg:flex-wrap")}>
        <Button type="button" variant="outline" className={tile} onClick={onCopy} disabled={!text}>
          {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
          <span className="max-w-full truncate">{copied ? "コピー済み" : "コピー"}</span>
        </Button>
        {canShare && (
          <Button type="button" variant="outline" className={tile} onClick={onShare} disabled={!text}>
            <Share2 className="h-4 w-4" />
            <span className="max-w-full truncate">アプリで送る</span>
          </Button>
        )}
        {supplier.chatUrl ? (
          <Button asChild variant="outline" className={tile}>
            <a href={supplier.chatUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" />
              <span className="max-w-full truncate">チャットを開く</span>
            </a>
          </Button>
        ) : (
          <Button type="button" variant="outline" className={tile} disabled title="業者チャットの URL が未登録です">
            <ExternalLink className="h-4 w-4" />
            <span className="max-w-full truncate">チャット未登録</span>
          </Button>
        )}
      </div>

      {confirmExternal ? (
        <div className="space-y-2 rounded-lg bg-warning-soft px-3 py-2">
          <p className="flex items-center gap-1.5 text-xs text-warning-ink">
            <ShieldAlert className="h-4 w-4 shrink-0" /> 承認済みの本文をアプリからサプライヤーへ送信します。
          </p>
          <div className="flex gap-2">
            <Button className={cn(big, "flex-1 lg:flex-none")} disabled={busy} onClick={() => send.mutate()}>
              {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCheck className="h-4 w-4" />} 送信する
            </Button>
            <Button variant="ghost" className={big} disabled={busy} onClick={() => setConfirmExternal(false)}>
              やめる
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            className={cn(big, "min-w-0 basis-full sm:basis-auto sm:flex-1 lg:flex-none")}
            disabled={busy || supplier.isBlacklisted || !text}
            onClick={() => (sendMode === "external" ? setConfirmExternal(true) : send.mutate())}
          >
            {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCheck className="h-4 w-4" />} {primaryLabel}
          </Button>
          <Button variant="ghost" className={cn(compact ? "h-9 lg:h-9" : big, "shrink-0 px-3 text-xs")} disabled={busy} onClick={() => undo.mutate()}>
            {undo.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} まだ送っていない / 取り消す
          </Button>
        </div>
      )}

      {!compact && sendMode !== "external" && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          コピー/共有で業者アプリ (Alibaba・1688・AliExpress・WeChat など) に貼り付けて送信し、送ったら「送信しました」を押して記録してください。
          {sendMode === "mock" && " (開発モード: 記録はモックアダプターで行われ、外部には送信されません)"}
        </p>
      )}
      {supplier.isBlacklisted && <p className="text-xs text-destructive">ブラックリスト業者には送信できません</p>}
      {hint && <p className="text-xs text-warning-ink">{hint}</p>}
      {(send.error || undo.error) && <p className="rounded-md bg-destructive-soft px-3 py-2 text-xs text-destructive">{(send.error ?? undo.error)!.message}</p>}
    </div>
  );
}
