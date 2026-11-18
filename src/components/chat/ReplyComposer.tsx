"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowDown, Languages, Loader2, Save, Send, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Select, Textarea } from "@/components/ui/input";
import { Tabs } from "@/components/ui/misc";
import { api } from "@/components/api";

export type ReplyLang = "zh" | "en";

type Target =
  /** 受信メッセージへの返信本文を設定 */
  | { kind: "inbound"; messageId: string }
  /** こちらから送る新しいメッセージ (threadId 省略で新規スレッド) */
  | { kind: "outbound"; supplierId: string; threadId?: string };

interface Props {
  target: Target;
  defaultLang: ReplyLang;
  initialText?: string;
  initialTextJa?: string;
  blacklisted?: boolean;
  onDone: (result: { threadId?: string }) => void;
  onCancel?: () => void;
}

/**
 * 手動返信の作成フォーム。
 * - 日本語で書いて中国語/英語へ翻訳 (訳文は編集可) するか、送信文を直接入力する
 * - 「下書き保存」: DRAFT_READY のまま保存 (後で承認・送信)
 * - 「承認して送信」: 確認ののち、書いた本人を承認者として記録してから送信 (送信時のガードはそのまま)
 */
export function ReplyComposer({ target, defaultLang, initialText = "", initialTextJa = "", blacklisted, onDone, onCancel }: Props) {
  const [mode, setMode] = useState<"ja" | "direct">(initialTextJa || !initialText ? "ja" : "direct");
  const [lang, setLang] = useState<ReplyLang>(defaultLang);
  const [ja, setJa] = useState(initialTextJa);
  const [text, setText] = useState(initialText);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const translate = useMutation({
    mutationFn: () => api<{ translation: string; stub: boolean }>("/api/chat/translate", { method: "POST", json: { text: ja, to: lang } }),
    onSuccess: (r) => {
      if (r.stub) setNotice("ANTHROPIC_API_KEY が未設定のため翻訳できません。送信文を直接入力してください。");
      else {
        setNotice(null);
        setText(r.translation);
      }
    },
  });

  const submit = useMutation({
    mutationFn: async (send: boolean) => {
      const textJa = mode === "ja" && ja.trim() ? ja.trim() : null;
      if (target.kind === "outbound") {
        return api<{ threadId: string }>("/api/chat/compose", {
          method: "POST",
          json: { supplierId: target.supplierId, threadId: target.threadId, text, textJa, lang, send },
        });
      }
      const drafted = await api<{ version: number; threadId: string }>(`/api/chat/messages/${target.messageId}/manual`, {
        method: "POST",
        json: { draftText: text, draftTextJa: textJa },
      });
      if (!send) return drafted;
      return api<{ threadId: string }>(`/api/chat/messages/${target.messageId}/approve-send`, {
        method: "POST",
        json: { expectedVersion: drafted.version, finalText: text },
      });
    },
    onSuccess: (r) => {
      setConfirming(false);
      onDone({ threadId: r.threadId });
    },
    onError: () => setConfirming(false),
  });

  const busy = submit.isPending;
  const canSubmit = text.trim().length > 0 && !busy;
  const langLabel = lang === "zh" ? "中国語" : "英語";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs<"ja" | "direct">
          value={mode}
          onChange={setMode}
          items={[
            { value: "ja", label: "日本語で書いて翻訳" },
            { value: "direct", label: "直接入力" },
          ]}
        />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          送信言語
          <Select className="h-8 w-24 text-xs" value={lang} onChange={(e) => setLang(e.target.value as ReplyLang)}>
            <option value="zh">中国語</option>
            <option value="en">英語</option>
          </Select>
        </label>
      </div>

      {mode === "ja" && (
        <div className="space-y-1.5">
          <Label htmlFor="composer-ja">日本語</Label>
          <Textarea id="composer-ja" rows={3} className="bg-card" value={ja} onChange={(e) => setJa(e.target.value)} placeholder="例: 300個で1個1.90ドルにしていただけますか？ロゴ印刷の追加費用も教えてください。" />
          <Button type="button" size="sm" variant="outline" className="bg-card" disabled={!ja.trim() || translate.isPending} onClick={() => translate.mutate()}>
            {translate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
            {langLabel}に翻訳
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          {translate.error && <p className="text-xs text-destructive">{translate.error.message}</p>}
          {notice && <p className="text-xs text-warning-ink">{notice}</p>}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="composer-text">送信する本文 ({langLabel})</Label>
        <Textarea id="composer-text" rows={4} className="bg-card" value={text} onChange={(e) => setText(e.target.value)} placeholder={mode === "ja" ? "翻訳結果がここに入ります (編集できます)" : "送信する本文を入力"} />
      </div>

      {confirming ? (
        <div className="space-y-2 rounded-lg bg-warning-soft px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-warning-ink">
            <ShieldAlert className="h-4 w-4" /> この本文をあなたの承認として記録し、サプライヤーへ送信します。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => submit.mutate(true)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} 承認して送信する
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              やめる
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!canSubmit || blacklisted} onClick={() => setConfirming(true)}>
            <Send className="h-4 w-4" /> 承認して送信
          </Button>
          <Button size="sm" variant="outline" className="bg-card" disabled={!canSubmit} onClick={() => submit.mutate(false)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} 下書き保存
          </Button>
          {onCancel && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
              キャンセル
            </Button>
          )}
          {blacklisted && <span className="text-xs text-destructive">ブラックリスト業者には送信できません</span>}
        </div>
      )}
      {submit.error && <p className="rounded-md bg-destructive-soft px-3 py-2 text-xs text-destructive">{submit.error.message}</p>}
    </div>
  );
}
