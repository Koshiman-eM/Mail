"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, Check, Inbox, Languages, Loader2, Plus, RotateCcw, Search, Send, ShieldAlert, Sparkles, Target, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox, Input, Label, Select, Textarea, UnitInput } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import { PLATFORM_LABEL, api, relTime } from "@/components/api";
import { CHAT_STATUS, FLOW_STEPS, type ChatStatusKey } from "@/components/chatStatus";
import { cn } from "@/lib/utils";

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
  status: ChatStatusKey;
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

const LANG: Record<string, string> = { zh: "中国語", en: "英語", ja: "日本語" };

function FlowStepper({ status }: { status: ChatStatusKey }) {
  const idx = FLOW_STEPS.findIndex((s) => s.match.includes(status));
  const failed = status === "SEND_FAILED" || status === "REJECTED";
  return (
    <ol className="flex items-center gap-1 text-[11px]" aria-label="承認フロー">
      {FLOW_STEPS.map((s, i) => {
        const done = i < idx || status === "SENT";
        const current = i === idx && status !== "SENT";
        return (
          <li key={s.key} className="flex items-center gap-1">
            <span
              className={cn(
                "flex items-center gap-1 rounded-full px-2 py-0.5 font-medium",
                done && "text-success",
                current && (failed ? "bg-destructive-soft text-destructive" : "bg-primary-soft text-primary"),
                !done && !current && "text-muted-foreground",
              )}
            >
              {done && <Check className="h-3 w-3" />}
              {s.label}
            </span>
            {i < FLOW_STEPS.length - 1 && <span className="h-px w-3 bg-border" />}
          </li>
        );
      })}
    </ol>
  );
}

function MessageCard({ m, blacklisted, onChanged }: { m: Message; blacklisted: boolean; onChanged: () => void }) {
  const [edit, setEdit] = useState(m.finalText ?? m.draftText ?? "");
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  useEffect(() => setEdit(m.finalText ?? m.draftText ?? ""), [m.finalText, m.draftText, m.version]);

  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: unknown }) => api(`/api/chat/messages/${m.id}/${action}`, { method: "POST", json: body ?? {} }),
    onSettled: () => {
      setConfirmSend(false);
      setRejecting(false);
      onChanged();
    },
  });
  const busy = act.isPending;
  const edited = m.draftText !== null && edit.trim() !== m.draftText.trim();
  const st = CHAT_STATUS[m.status];

  return (
    <article className="space-y-3">
      {/* 受信メッセージ */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border bg-card p-4 shadow-card">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <FlowStepper status={m.status} />
            <span className="text-[11px] text-muted-foreground">{new Date(m.createdAt).toLocaleString("ja-JP")}</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">原文 ({LANG[m.originalLang ?? ""] ?? m.originalLang ?? "不明"})</p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.originalText}</p>
            </div>
            <div className="border-t pt-3 md:border-l md:border-t-0 md:pl-3 md:pt-0">
              <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <Languages className="h-3 w-3" /> 日本語訳
              </p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.translatedText ?? "—"}</p>
            </div>
          </div>
        </div>
      </div>

      {/* 返信 (送信済み) */}
      {m.status === "SENT" && m.finalText && (
        <div className="ml-auto max-w-[90%] rounded-2xl rounded-tr-sm bg-primary p-4 text-primary-foreground shadow-card md:max-w-[75%]">
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.finalText}</p>
          {m.draftTextJa && <p className="mt-2 whitespace-pre-wrap border-t border-white/20 pt-2 text-xs opacity-85">{m.draftTextJa}</p>}
          <p className="mt-2 text-[11px] opacity-70">
            送信 {m.sentAt && new Date(m.sentAt).toLocaleString("ja-JP")} ・ 承認 {m.approvedBy}
          </p>
        </div>
      )}

      {/* 返信案 (承認フロー) */}
      {m.status !== "SENT" && (
        <div className="ml-auto rounded-2xl rounded-tr-sm border border-dashed border-primary/40 bg-primary-soft/30 p-4 md:ml-10">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-primary" /> 返信案
            </p>
            <Badge variant={st.variant}>{st.label}</Badge>
          </div>

          {m.draftText === null ? (
            <p className="text-sm text-muted-foreground">まだ返信案がありません。</p>
          ) : (
            <>
              <Textarea value={edit} onChange={(e) => setEdit(e.target.value)} disabled={m.status !== "DRAFT_READY" || busy} rows={4} aria-label="送信される本文" className="bg-card" />
              {m.draftTextJa && <p className="mt-2 whitespace-pre-wrap rounded-md bg-card/70 px-3 py-2 text-xs leading-relaxed text-muted-foreground">訳: {m.draftTextJa}</p>}
              {edited && m.status === "DRAFT_READY" && <p className="mt-1.5 text-xs text-warning-ink">本文を編集しました。この内容で承認されます (日本語訳は元の案のものです)。</p>}
            </>
          )}

          {m.status === "APPROVED" && (
            <p className="mt-2 text-xs text-muted-foreground">
              {m.approvedBy} が {m.approvedAt && new Date(m.approvedAt).toLocaleString("ja-JP")} に承認。送信ボタンを押すまで送信されません。
            </p>
          )}
          {m.status === "REJECTED" && m.rejectedReason && <p className="mt-2 text-xs text-muted-foreground">却下理由: {m.rejectedReason}</p>}
          {m.status === "SEND_FAILED" && <p className="mt-2 text-xs text-destructive">送信に失敗しました。返信案を再生成し、再承認してください。</p>}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {["RECEIVED", "DRAFT_READY", "REJECTED", "SEND_FAILED"].includes(m.status) && (
              <Button size="sm" variant="outline" className="bg-card" disabled={busy} onClick={() => act.mutate({ action: "draft" })}>
                {m.status === "RECEIVED" ? <Sparkles className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                {m.status === "RECEIVED" ? "AI 返信案を生成" : "再生成"}
              </Button>
            )}
            {m.status === "DRAFT_READY" && !rejecting && (
              <>
                <Button size="sm" disabled={busy || !edit.trim()} onClick={() => act.mutate({ action: "approve", body: { expectedVersion: m.version, finalText: edit } })}>
                  <Check className="h-4 w-4" /> 承認する
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(true)}>
                  <X className="h-4 w-4" /> 却下
                </Button>
              </>
            )}
            {rejecting && (
              <div className="flex w-full flex-wrap items-center gap-2">
                <Input className="h-8 min-w-0 flex-1 bg-card" placeholder="却下理由 (任意)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => act.mutate({ action: "reject", body: { expectedVersion: m.version, reason: reason || undefined } })}>
                  却下する
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
                  戻る
                </Button>
              </div>
            )}
            {m.status === "APPROVED" &&
              (confirmSend ? (
                <div className="flex w-full flex-wrap items-center gap-2 rounded-lg bg-warning-soft px-3 py-2">
                  <ShieldAlert className="h-4 w-4 text-warning-ink" />
                  <span className="flex-1 text-xs text-warning-ink">承認済みの本文をサプライヤーへ送信します。</span>
                  <Button size="sm" disabled={busy} onClick={() => act.mutate({ action: "send" })}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} 送信する
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmSend(false)}>
                    やめる
                  </Button>
                </div>
              ) : (
                <>
                  <Button size="sm" disabled={busy || blacklisted} onClick={() => setConfirmSend(true)}>
                    <Send className="h-4 w-4" /> 送信
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => act.mutate({ action: "reject", body: { expectedVersion: m.version, reason: "承認取消" } })}>
                    <Undo2 className="h-4 w-4" /> 承認を取り消す
                  </Button>
                  {blacklisted && <span className="text-xs text-destructive">ブラックリスト業者には送信できません</span>}
                </>
              ))}
            {busy && !confirmSend && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
          {act.error && <p className="mt-2 rounded-md bg-destructive-soft px-3 py-2 text-xs text-destructive">{act.error.message}</p>}
        </div>
      )}
    </article>
  );
}

function GoalEditor({ supplierId }: { supplierId: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["goal", supplierId],
    queryFn: () =>
      api<{ targetUnitPrice: string | null; currency: string | null; targetMoq: number | null; wantsOem: boolean; notes: string | null } | null>(`/api/chat/goals?supplierId=${supplierId}`),
  });
  const [g, setG] = useState({ targetUnitPrice: "", currency: "USD", targetMoq: "", wantsOem: false, notes: "" });
  useEffect(() => {
    setG(
      data
        ? { targetUnitPrice: data.targetUnitPrice ?? "", currency: data.currency ?? "USD", targetMoq: data.targetMoq ? String(data.targetMoq) : "", wantsOem: data.wantsOem, notes: data.notes ?? "" }
        : { targetUnitPrice: "", currency: "USD", targetMoq: "", wantsOem: false, notes: "" },
    );
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
      <CardHeader className="pb-3">
        <CardTitle>
          <Target className="h-4 w-4 text-primary" /> 交渉ゴール
        </CardTitle>
        <p className="text-xs text-muted-foreground">AI 返信案の作成に反映されます</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-[1fr_104px] gap-2">
          <div className="space-y-1.5">
            <Label>目標単価</Label>
            <UnitInput value={g.targetUnitPrice} onChange={(e) => setG({ ...g, targetUnitPrice: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>通貨</Label>
            <Select value={g.currency} onChange={(e) => setG({ ...g, currency: e.target.value })}>
              {["USD", "CNY", "JPY", "EUR"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>目標 MOQ</Label>
          <UnitInput unit="個" value={g.targetMoq} onChange={(e) => setG({ ...g, targetMoq: e.target.value })} />
        </div>
        <Checkbox label="OEM (ロゴ・専用パッケージ) を希望" checked={g.wantsOem} onChange={(e) => setG({ ...g, wantsOem: e.target.checked })} />
        <div className="space-y-1.5">
          <Label>補足</Label>
          <Textarea rows={2} value={g.notes} onChange={(e) => setG({ ...g, notes: e.target.value })} />
        </div>
        <Button size="sm" variant="soft" className="w-full" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isSuccess ? <Check className="h-4 w-4" /> : null}
          {save.isSuccess ? "保存しました" : "ゴールを保存"}
        </Button>
      </CardContent>
    </Card>
  );
}

/** 業者チャットからコピーした受信メッセージを取り込む */
function IngestForm({ threadId, supplierId, onDone, compact }: { threadId?: string; supplierId?: string; onDone: (threadId: string) => void; compact?: boolean }) {
  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: () => api<Supplier[]>("/api/suppliers"), enabled: !supplierId });
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
    <div className={cn("space-y-2", !compact && "rounded-xl border bg-card p-4 shadow-card")}>
      {!compact && <p className="text-sm font-semibold">受信メッセージを取り込む</p>}
      {!supplierId && (
        <Select value={sid} onChange={(e) => setSid(e.target.value)} aria-label="業者">
          <option value="">業者を選択</option>
          {suppliers.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      )}
      {!threadId && <Input placeholder="スレッド ID (任意)" value={tid} onChange={(e) => setTid(e.target.value)} />}
      <Textarea placeholder="業者からのメッセージ原文を貼り付け (中国語・英語)" value={text} onChange={(e) => setText(e.target.value)} rows={3} className="bg-card" />
      <Button size="sm" className="w-full" disabled={!sid || !text.trim() || ingest.isPending} onClick={() => ingest.mutate()}>
        {ingest.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
        {ingest.isPending ? "翻訳・返信案を作成中…" : "翻訳して返信案を作成"}
      </Button>
      {ingest.error && <p className="text-xs text-destructive">{ingest.error.message}</p>}
    </div>
  );
}

function ChatInner() {
  const qc = useQueryClient();
  const router = useRouter();
  const sp = useSearchParams();
  const active = sp.get("thread");
  const [q, setQ] = useState("");
  const [showNew, setShowNew] = useState(false);
  const threads = useQuery({ queryKey: ["threads"], queryFn: () => api<Thread[]>("/api/chat/threads"), refetchInterval: 15_000 });
  const messages = useQuery({
    queryKey: ["messages", active],
    queryFn: () => api<Message[]>(`/api/chat/messages?threadId=${encodeURIComponent(active!)}`),
    enabled: !!active,
  });
  const thread = threads.data?.find((t) => t.threadId === active);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (threads.data ?? []).filter((t) => !needle || t.supplier.name.toLowerCase().includes(needle) || t.lastText.toLowerCase().includes(needle));
  }, [threads.data, q]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["threads"] });
    qc.invalidateQueries({ queryKey: ["messages"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const select = (id: string | null) => router.push(id ? `/chat?thread=${encodeURIComponent(id)}` : "/chat");

  return (
    <div className="-my-2 grid grid-cols-1 gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
      {/* スレッド一覧 */}
      <aside className={cn("space-y-3", active && "hidden lg:block")}>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">業者チャット</h1>
          <Button size="sm" variant="soft" onClick={() => setShowNew((s) => !s)}>
            <Plus className="h-4 w-4" /> 取り込み
          </Button>
        </div>
        {showNew && (
          <IngestForm
            onDone={(id) => {
              setShowNew(false);
              refresh();
              select(id);
            }}
          />
        )}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="業者・本文で検索" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ul className="space-y-1">
          {threads.isLoading && <Skeleton className="h-32" />}
          {filtered.length === 0 && !threads.isLoading && <li className="px-3 py-6 text-center text-sm text-muted-foreground">スレッドはありません</li>}
          {filtered.map((t) => (
            <li key={t.threadId}>
              <button
                className={cn("flex w-full gap-3 rounded-xl px-3 py-2.5 text-left transition-colors", t.threadId === active ? "bg-primary-soft" : "hover:bg-accent")}
                onClick={() => select(t.threadId)}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary font-bold">{t.supplier.name.slice(0, 1)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{t.supplier.name}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{relTime(t.lastAt)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <span className="truncate text-xs text-muted-foreground">{t.lastText}</span>
                    {t.pending > 0 && <span className="ml-auto shrink-0 rounded-full bg-warning px-1.5 text-[11px] font-bold text-[#0b0b0b]">{t.pending}</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* 会話 */}
      <section className={cn(!active && "hidden lg:block")}>
        {!active || !thread ? (
          <EmptyState icon={Inbox} title="スレッドを選択してください">
            業者から届いたメッセージを取り込むと、日本語訳と AI 返信案が作成されます。送信は必ず人の承認を経て行われます。
          </EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 space-y-5">
              <div className="flex items-center gap-3 border-b pb-4">
                <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => select(null)} aria-label="一覧に戻る">
                  <ArrowLeft className="h-5 w-5" />
                </Button>
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary font-bold">{thread.supplier.name.slice(0, 1)}</span>
                <div className="min-w-0">
                  <h2 className="truncate font-semibold">{thread.supplier.name}</h2>
                  <p className="text-xs text-muted-foreground">{PLATFORM_LABEL[thread.supplier.platform]}</p>
                </div>
                {thread.supplier.isBlacklisted && (
                  <Badge variant="destructive" className="ml-auto">
                    <Ban className="h-3 w-3" /> ブラックリスト
                  </Badge>
                )}
              </div>
              {messages.isLoading && <Skeleton className="h-48" />}
              {messages.data?.map((m) => <MessageCard key={m.id} m={m} blacklisted={thread.supplier.isBlacklisted} onChanged={refresh} />)}
              <div className="rounded-xl border bg-card p-4 shadow-card xl:hidden">
                <p className="mb-2 text-sm font-semibold">新しい受信メッセージ</p>
                <IngestForm compact threadId={thread.threadId} supplierId={thread.supplier.id} onDone={refresh} />
              </div>
            </div>
            <div className="space-y-4 xl:sticky xl:top-20 xl:self-start">
              <div className="hidden rounded-xl border bg-card p-4 shadow-card xl:block">
                <p className="mb-2 text-sm font-semibold">新しい受信メッセージ</p>
                <IngestForm compact threadId={thread.threadId} supplierId={thread.supplier.id} onDone={refresh} />
              </div>
              <GoalEditor supplierId={thread.supplier.id} />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense>
      <ChatInner />
    </Suspense>
  );
}
