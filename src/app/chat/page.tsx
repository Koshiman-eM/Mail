"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/components/api";
import { cn } from "@/lib/utils";

type Status = "RECEIVED" | "DRAFT_READY" | "APPROVED" | "REJECTED" | "SENDING" | "SENT" | "SEND_FAILED";

interface Thread {
  threadId: string;
  supplier: { id: string; name: string; platform: string; isBlacklisted: boolean };
  lastText: string;
  lastAt: string;
  pending: number;
}
interface Message {
  id: string;
  supplierId: string;
  threadId: string;
  originalText: string;
  originalLang: string | null;
  translatedText: string | null;
  draftText: string | null;
  draftTextJa: string | null;
  finalText: string | null;
  status: Status;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  sentAt: string | null;
  version: number;
  createdAt: string;
}
interface Supplier {
  id: string;
  name: string;
}

const STATUS_LABEL: Record<Status, string> = {
  RECEIVED: "受信",
  DRAFT_READY: "承認待ち",
  APPROVED: "承認済み",
  REJECTED: "却下",
  SENDING: "送信中",
  SENT: "送信済み",
  SEND_FAILED: "送信失敗",
};
const STATUS_VARIANT: Record<Status, "secondary" | "warning" | "success" | "destructive" | "default" | "outline"> = {
  RECEIVED: "secondary",
  DRAFT_READY: "warning",
  APPROVED: "default",
  REJECTED: "outline",
  SENDING: "secondary",
  SENT: "success",
  SEND_FAILED: "destructive",
};

function MessageCard({ m, onChanged }: { m: Message; onChanged: () => void }) {
  const [edit, setEdit] = useState(m.finalText ?? m.draftText ?? "");
  const [reason, setReason] = useState("");
  useEffect(() => setEdit(m.finalText ?? m.draftText ?? ""), [m.finalText, m.draftText, m.version]);

  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: unknown }) =>
      api(`/api/chat/messages/${m.id}/${action}`, { method: "POST", json: body ?? {} }),
    onSuccess: onChanged,
    onError: onChanged,
  });
  const busy = act.isPending;
  const edited = m.draftText !== null && edit.trim() !== m.draftText.trim();

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-center justify-between">
          <Badge variant={STATUS_VARIANT[m.status]}>{STATUS_LABEL[m.status]}</Badge>
          <span className="text-xs text-muted-foreground">{new Date(m.createdAt).toLocaleString("ja-JP")}</span>
        </div>

        {/* 原文と翻訳を並列表示 */}
        <div className="grid gap-2 md:grid-cols-2">
          <div className="rounded-md bg-muted p-3">
            <p className="mb-1 text-[11px] font-medium text-muted-foreground">原文 ({m.originalLang ?? "?"})</p>
            <p className="whitespace-pre-wrap text-sm">{m.originalText}</p>
          </div>
          <div className="rounded-md bg-muted p-3">
            <p className="mb-1 text-[11px] font-medium text-muted-foreground">日本語訳</p>
            <p className="whitespace-pre-wrap text-sm">{m.translatedText ?? "—"}</p>
          </div>
        </div>

        {m.draftText !== null && m.status !== "SENT" && (
          <div className="space-y-2 rounded-md border border-dashed p-3">
            <p className="text-[11px] font-medium text-muted-foreground">AI 返信案 (送信される本文)</p>
            <Textarea value={edit} onChange={(e) => setEdit(e.target.value)} disabled={m.status !== "DRAFT_READY" || busy} rows={4} />
            {m.draftTextJa && (
              <p className="whitespace-pre-wrap rounded bg-muted p-2 text-xs text-muted-foreground">訳: {m.draftTextJa}</p>
            )}
            {edited && m.status === "DRAFT_READY" && <p className="text-xs text-amber-600">編集した本文で承認されます (日本語訳は元の案のものです)</p>}
          </div>
        )}

        {m.status === "SENT" && m.finalText && (
          <div className="ml-auto max-w-[90%] rounded-md bg-primary p-3 text-primary-foreground">
            <p className="mb-1 text-[11px] opacity-70">
              送信済み {m.sentAt && new Date(m.sentAt).toLocaleString("ja-JP")} / 承認: {m.approvedBy}
            </p>
            <p className="whitespace-pre-wrap text-sm">{m.finalText}</p>
            {m.draftTextJa && <p className="mt-1 whitespace-pre-wrap text-xs opacity-80">訳: {m.draftTextJa}</p>}
          </div>
        )}

        {m.status === "APPROVED" && (
          <p className="text-xs text-muted-foreground">
            {m.approvedBy} が {m.approvedAt && new Date(m.approvedAt).toLocaleString("ja-JP")} に承認しました。送信ボタンを押すまで送信されません。
          </p>
        )}
        {m.status === "REJECTED" && m.rejectedReason && <p className="text-xs text-muted-foreground">却下理由: {m.rejectedReason}</p>}

        <div className="flex flex-wrap gap-2">
          {["RECEIVED", "DRAFT_READY", "REJECTED", "SEND_FAILED"].includes(m.status) && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act.mutate({ action: "draft" })}>
              {m.status === "RECEIVED" ? <Sparkles className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
              {m.status === "RECEIVED" ? "AI 返信案を生成" : "返信案を再生成"}
            </Button>
          )}
          {m.status === "DRAFT_READY" && (
            <>
              <Button size="sm" disabled={busy || !edit.trim()} onClick={() => act.mutate({ action: "approve", body: { expectedVersion: m.version, finalText: edit } })}>
                <Check className="h-4 w-4" /> 承認
              </Button>
              <Input className="h-8 w-40" placeholder="却下理由 (任意)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act.mutate({ action: "reject", body: { expectedVersion: m.version, reason: reason || undefined } })}>
                <X className="h-4 w-4" /> 却下
              </Button>
            </>
          )}
          {m.status === "APPROVED" && (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (confirm("承認済みの本文をサプライヤーへ送信します。よろしいですか？")) act.mutate({ action: "send" });
                }}
              >
                <Send className="h-4 w-4" /> 送信
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act.mutate({ action: "reject", body: { expectedVersion: m.version, reason: "承認取消" } })}>
                承認を取り消す
              </Button>
            </>
          )}
        </div>
        {act.error && <p className="text-xs text-destructive">{act.error.message}</p>}
      </CardContent>
    </Card>
  );
}

function GoalEditor({ supplierId }: { supplierId: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["goal", supplierId],
    queryFn: () => api<{ targetUnitPrice: string | null; currency: string | null; targetMoq: number | null; wantsOem: boolean; notes: string | null } | null>(`/api/chat/goals?supplierId=${supplierId}`),
  });
  const [g, setG] = useState({ targetUnitPrice: "", currency: "USD", targetMoq: "", wantsOem: false, notes: "" });
  useEffect(() => {
    if (data)
      setG({
        targetUnitPrice: data.targetUnitPrice ?? "",
        currency: data.currency ?? "USD",
        targetMoq: data.targetMoq ? String(data.targetMoq) : "",
        wantsOem: data.wantsOem,
        notes: data.notes ?? "",
      });
  }, [data]);
  const save = useMutation({
    mutationFn: () =>
      api("/api/chat/goals", {
        method: "PUT",
        json: {
          supplierId,
          targetUnitPrice: g.targetUnitPrice || null,
          currency: g.currency || null,
          targetMoq: g.targetMoq ? Number(g.targetMoq) : null,
          wantsOem: g.wantsOem,
          notes: g.notes || null,
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["goal", supplierId] }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">交渉ゴール (AI 返信案に反映)</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label>目標単価</Label>
          <Input value={g.targetUnitPrice} onChange={(e) => setG({ ...g, targetUnitPrice: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label>通貨</Label>
          <Input value={g.currency} onChange={(e) => setG({ ...g, currency: e.target.value.toUpperCase() })} />
        </div>
        <div className="space-y-1">
          <Label>目標MOQ</Label>
          <Input value={g.targetMoq} onChange={(e) => setG({ ...g, targetMoq: e.target.value })} />
        </div>
        <label className="flex items-end gap-2 pb-2 text-xs">
          <input type="checkbox" checked={g.wantsOem} onChange={(e) => setG({ ...g, wantsOem: e.target.checked })} /> OEM 希望
        </label>
        <div className="col-span-2 space-y-1">
          <Label>補足</Label>
          <Input value={g.notes} onChange={(e) => setG({ ...g, notes: e.target.value })} />
        </div>
        <Button size="sm" className="col-span-2" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isSuccess ? "保存しました" : "保存"}
        </Button>
      </CardContent>
    </Card>
  );
}

/** 受信メッセージの手動取り込み (業者チャットからのコピー&ペースト) */
function IngestForm({ threadId, supplierId, onDone }: { threadId?: string; supplierId?: string; onDone: (threadId: string) => void }) {
  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: () => api<Supplier[]>("/api/suppliers") });
  const [sid, setSid] = useState(supplierId ?? "");
  const [tid, setTid] = useState(threadId ?? "");
  const [text, setText] = useState("");
  useEffect(() => {
    if (supplierId) setSid(supplierId);
    if (threadId) setTid(threadId);
  }, [supplierId, threadId]);
  const ingest = useMutation({
    mutationFn: () => api("/api/chat/messages", { method: "POST", json: { supplierId: sid, threadId: tid || `thread-${sid}`, text } }),
    onSuccess: () => {
      setText("");
      onDone(tid || `thread-${sid}`);
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">受信メッセージを取り込む</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {!supplierId && (
          <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={sid} onChange={(e) => setSid(e.target.value)}>
            <option value="">業者を選択</option>
            {suppliers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        {!threadId && <Input placeholder="スレッドID (任意)" value={tid} onChange={(e) => setTid(e.target.value)} />}
        <Textarea placeholder="業者からのメッセージ原文 (中国語・英語)" value={text} onChange={(e) => setText(e.target.value)} rows={3} />
        <Button size="sm" className="w-full" disabled={!sid || !text.trim() || ingest.isPending} onClick={() => ingest.mutate()}>
          翻訳して返信案を作成
        </Button>
        {ingest.error && <p className="text-xs text-destructive">{ingest.error.message}</p>}
      </CardContent>
    </Card>
  );
}

function Chat() {
  const qc = useQueryClient();
  const router = useRouter();
  const sp = useSearchParams();
  const active = sp.get("thread");
  const threads = useQuery({ queryKey: ["threads"], queryFn: () => api<Thread[]>("/api/chat/threads"), refetchInterval: 15_000 });
  const messages = useQuery({
    queryKey: ["messages", active],
    queryFn: () => api<Message[]>(`/api/chat/messages?threadId=${encodeURIComponent(active!)}`),
    enabled: !!active,
  });
  const thread = threads.data?.find((t) => t.threadId === active);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["threads"] });
    qc.invalidateQueries({ queryKey: ["messages"] });
  };
  const select = (id: string) => router.push(`/chat?thread=${encodeURIComponent(id)}`);

  return (
    <div className="grid gap-4 md:grid-cols-[280px_1fr]">
      <aside className="space-y-3">
        <h1 className="text-xl font-bold">業者チャット</h1>
        <ul className="divide-y rounded-lg border">
          {threads.data?.length === 0 && <li className="p-3 text-sm text-muted-foreground">スレッドはありません</li>}
          {threads.data?.map((t) => (
            <li key={t.threadId}>
              <button className={cn("w-full p-3 text-left text-sm hover:bg-accent", t.threadId === active && "bg-accent")} onClick={() => select(t.threadId)}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{t.supplier.name}</span>
                  {t.pending > 0 && <Badge variant="warning">{t.pending}</Badge>}
                </div>
                <p className="truncate text-xs text-muted-foreground">{t.lastText}</p>
              </button>
            </li>
          ))}
        </ul>
        {!active && <IngestForm onDone={(id) => { refresh(); select(id); }} />}
      </aside>

      <section className="space-y-3">
        {!active && <p className="text-sm text-muted-foreground">左のスレッドを選択してください。</p>}
        {thread && (
          <>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{thread.supplier.name}</h2>
              <Badge variant="outline">{thread.supplier.platform}</Badge>
              {thread.supplier.isBlacklisted && <Badge variant="destructive">ブラックリスト (送信不可)</Badge>}
            </div>
            <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
              <div className="space-y-3">
                {messages.data?.map((m) => <MessageCard key={m.id} m={m} onChanged={refresh} />)}
              </div>
              <div className="space-y-3">
                <GoalEditor supplierId={thread.supplier.id} />
                <IngestForm threadId={thread.threadId} supplierId={thread.supplier.id} onDone={refresh} />
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense>
      <Chat />
    </Suspense>
  );
}
