"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowDown, Check, Languages, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Select, Textarea } from "@/components/ui/input";
import { Tabs } from "@/components/ui/misc";
import { api } from "@/components/api";
import { useAutoGrow } from "./hooks";

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
  /** status: 作成/保存後の状態 (承認した場合は APPROVED → 手渡しパネルへ) */
  onDone: (result: { threadId?: string; messageId?: string; status?: string }) => void;
  onCancel?: () => void;
}

/**
 * 手動返信の作成フォーム。
 * - 日本語で書いて中国語/英語へ翻訳 (訳文は編集可) するか、送信文を直接入力する
 * - 「下書き保存」: DRAFT_READY のまま保存 (後で承認)
 * - 「承認する」: 書いた本人を承認者として記録し APPROVED にする。アプリからは送信しない。
 *   続けて手渡しパネル (コピー/共有/チャットを開く → 「送信しました」) で業者アプリから送り、記録する。
 */
export function ReplyComposer({ target, defaultLang, initialText = "", initialTextJa = "", blacklisted, onDone, onCancel }: Props) {
  const [mode, setMode] = useState<"ja" | "direct">(initialTextJa || !initialText ? "ja" : "direct");
  const [lang, setLang] = useState<ReplyLang>(defaultLang);
  const [ja, setJa] = useState(initialTextJa);
  const [text, setText] = useState(initialText);
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

  const jaRef = useAutoGrow(ja, 240);
  const textRef = useAutoGrow(text, 320);

  const submit = useMutation({
    mutationFn: async (approve: boolean) => {
      const textJa = mode === "ja" && ja.trim() ? ja.trim() : null;
      if (target.kind === "outbound") {
        return api<{ id: string; threadId: string; status: string }>("/api/chat/compose", {
          method: "POST",
          json: { supplierId: target.supplierId, threadId: target.threadId, text, textJa, lang, send: approve },
        });
      }
      const drafted = await api<{ id: string; version: number; threadId: string; status: string }>(`/api/chat/messages/${target.messageId}/manual`, {
        method: "POST",
        json: { draftText: text, draftTextJa: textJa },
      });
      if (!approve) return drafted;
      // 送信前提の承認のみ (ブラックリスト業者は拒否)。送信は手渡しパネルから
      return api<{ id: string; threadId: string; status: string }>(`/api/chat/messages/${target.messageId}/approve-send`, {
        method: "POST",
        json: { expectedVersion: drafted.version, finalText: text },
      });
    },
    onSuccess: (r) => onDone({ threadId: r.threadId, messageId: r.id, status: r.status }),
  });

  const busy = submit.isPending;
  const canSubmit = text.trim().length > 0 && !busy;
  const langLabel = lang === "zh" ? "中国語" : "英語";

  const big = "h-11 lg:h-8";

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
          <Select className="h-9 w-24 text-xs lg:h-8" value={lang} onChange={(e) => setLang(e.target.value as ReplyLang)}>
            <option value="zh">中国語</option>
            <option value="en">英語</option>
          </Select>
        </label>
      </div>

      {mode === "ja" && (
        <div className="space-y-1.5">
          <Label htmlFor="composer-ja">日本語</Label>
          <Textarea
            id="composer-ja"
            ref={jaRef}
            rows={2}
            enterKeyHint="enter"
            className="min-h-[64px] resize-none bg-card text-base lg:text-sm"
            value={ja}
            onChange={(e) => setJa(e.target.value)}
            placeholder="例: 300個で1個1.90ドルにしていただけますか？ロゴ印刷の追加費用も教えてください。"
          />
          <Button type="button" size="sm" variant="outline" className={`${big} w-full bg-card sm:w-auto`} disabled={!ja.trim() || translate.isPending} onClick={() => translate.mutate()}>
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
        <Textarea
          id="composer-text"
          ref={textRef}
          rows={3}
          className="min-h-[80px] resize-none bg-card text-base lg:text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={mode === "ja" ? "翻訳結果がここに入ります (編集できます)" : "送信する本文を入力"}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className={`${big} min-w-0 flex-1 sm:flex-none`} disabled={!canSubmit || blacklisted} onClick={() => submit.mutate(true)}>
          {busy && submit.variables === true ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} 承認する
        </Button>
        <Button size="sm" variant="outline" className={`${big} min-w-0 flex-1 bg-card sm:flex-none`} disabled={!canSubmit} onClick={() => submit.mutate(false)}>
          {busy && submit.variables === false ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} 下書き保存
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" className={big} disabled={busy} onClick={onCancel}>
            キャンセル
          </Button>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        「承認する」とあなたの承認として記録されます。アプリからは自動送信されず、次の画面で本文をコピー/共有して業者アプリから送ります。
      </p>
      {blacklisted && <p className="text-xs text-destructive">ブラックリスト業者には送信できません</p>}
      {submit.error && <p className="rounded-md bg-destructive-soft px-3 py-2 text-xs text-destructive">{submit.error.message}</p>}
    </div>
  );
}
