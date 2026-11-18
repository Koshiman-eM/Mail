"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/components/api";

/** 業者チャットページの URL を登録・変更・解除する小さなフォーム */
export function ChatUrlEditor({ supplierId, chatUrl, onClose }: { supplierId: string; chatUrl: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(chatUrl ?? "");
  const save = useMutation({
    mutationFn: (url: string | null) => api<{ chatUrl: string | null }>(`/api/suppliers/${supplierId}/chat-url`, { method: "PATCH", json: { chatUrl: url } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["threads"] });
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      onClose();
    },
  });
  return (
    <form
      className="w-full space-y-2 rounded-lg border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(value.trim() || null);
      }}
    >
      <label htmlFor={`chat-url-${supplierId}`} className="block text-xs font-medium text-muted-foreground">
        業者チャットの URL (Alibaba / 1688 / AliExpress のメッセージ画面、WeChat のリンクなど)
      </label>
      <Input
        id={`chat-url-${supplierId}`}
        type="url"
        inputMode="url"
        autoComplete="off"
        placeholder="https://message.alibaba.com/..."
        className="h-11 lg:h-9"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" className="h-10 lg:h-8" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} 保存
        </Button>
        {chatUrl && (
          <Button type="button" size="sm" variant="ghost" className="h-10 text-destructive lg:h-8" disabled={save.isPending} onClick={() => save.mutate(null)}>
            登録を解除
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" className="h-10 lg:h-8" disabled={save.isPending} onClick={onClose}>
          キャンセル
        </Button>
      </div>
      {save.error && <p className="text-xs text-destructive">{save.error.message}</p>}
    </form>
  );
}
