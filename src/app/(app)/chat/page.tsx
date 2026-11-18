"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, Check, ExternalLink, Inbox, Languages, Link2, Loader2, PenLine, Pencil, Plus, RotateCcw, Search, Send, Sparkles, Target, X } from "lucide-react";
import { ReplyComposer, type ReplyLang } from "@/components/chat/ReplyComposer";
import { HandoffActions, HandoffText, type HandoffSupplier } from "@/components/chat/HandoffPanel";
import { ChatUrlEditor } from "@/components/chat/ChatUrlEditor";
import { useAutoGrow, useSendMode, type SendMode } from "@/components/chat/hooks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox, Input, Label, Select, Textarea, UnitInput } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Skeleton, Tabs } from "@/components/ui/misc";
import { PLATFORM_LABEL, api, relTime } from "@/components/api";
import { CHAT_STATUS, FLOW_STEPS, type ChatStatusKey } from "@/components/chatStatus";
import { cn } from "@/lib/utils";

interface Thread {
  threadId: string;
  supplier: { id: string; name: string; platform: string; isBlacklisted: boolean; chatUrl: string | null };
  lastText: string;
  lastAt: string;
  pending: number;
}
interface Message {
  id: string;
  supplierId: string;
  threadId: string;
  direction: "INBOUND" | "OUTBOUND";
  draftSource: "AI" | "MANUAL" | null;
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
  externalMsgId: string | null;
  version: number;
  createdAt: string;
}
interface Supplier {
  id: string;
  name: string;
}

const LANG: Record<string, string> = { zh: "中国語", en: "英語", ja: "日本語" };

const OUTBOUND_STEPS: typeof FLOW_STEPS = [
  { key: "draft", label: "作成", match: ["DRAFT_READY", "REJECTED", "SEND_FAILED", "RECEIVED"] },
  { key: "approved", label: "承認", match: ["APPROVED", "SENDING"] },
  { key: "sent", label: "送信", match: ["SENT"] },
];

function FlowStepper({ status, outbound }: { status: ChatStatusKey; outbound?: boolean }) {
  const steps = outbound ? OUTBOUND_STEPS : FLOW_STEPS;
  const idx = steps.findIndex((s) => s.match.includes(status));
  const failed = status === "SEND_FAILED" || status === "REJECTED";
  return (
    <ol className="flex items-center gap-1 text-[11px]" aria-label="承認フロー">
      {steps.map((s, i) => {
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
            {i < steps.length - 1 && <span className="h-px w-3 bg-border" />}
          </li>
        );
      })}
    </ol>
  );
}

function SourceBadge({ source }: { source: Message["draftSource"] }) {
  if (!source) return null;
  return source === "MANUAL" ? (
    <Badge variant="outline">
      <PenLine className="h-3 w-3" /> 手動
    </Badge>
  ) : (
    <Badge variant="outline">
      <Sparkles className="h-3 w-3" /> AI 案
    </Badge>
  );
}

function MessageCard({
  m,
  supplier,
  sendMode,
  defaultLang,
  stickyOnMobile,
  onChanged,
}: {
  m: Message;
  supplier: HandoffSupplier;
  sendMode: SendMode;
  defaultLang: ReplyLang;
  /** モバイルでは操作ボタンを画面下部の固定バーに出す */
  stickyOnMobile: boolean;
  onChanged: () => void;
}) {
  const blacklisted = supplier.isBlacklisted;
  const [writing, setWriting] = useState(false);
  const [edit, setEdit] = useState(m.finalText ?? m.draftText ?? "");
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  useEffect(() => setEdit(m.finalText ?? m.draftText ?? ""), [m.finalText, m.draftText, m.version]);
  const editRef = useAutoGrow(edit, 360);

  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: unknown }) => api(`/api/chat/messages/${m.id}/${action}`, { method: "POST", json: body ?? {} }),
    onSettled: () => {
      setRejecting(false);
      onChanged();
    },
  });
  const busy = act.isPending;
  const edited = m.draftText !== null && edit.trim() !== m.draftText.trim();
  const st = CHAT_STATUS[m.status];
  const handoffSent = m.externalMsgId?.startsWith("handoff:") ?? false;
  const big = "h-11 lg:h-8";

  return (
    <article id={`msg-${m.id}`} className="scroll-mt-20 space-y-3">
      {/* 受信メッセージ */}
      {m.direction === "INBOUND" && (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border bg-card p-3 shadow-card sm:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <FlowStepper status={m.status} />
              <span className="text-[11px] text-muted-foreground">{new Date(m.createdAt).toLocaleString("ja-JP")}</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">原文 ({LANG[m.originalLang ?? ""] ?? m.originalLang ?? "不明"})</p>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{m.originalText}</p>
              </div>
              <div className="min-w-0 border-t pt-3 md:border-l md:border-t-0 md:pl-3 md:pt-0">
                <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                  <Languages className="h-3 w-3" /> 日本語訳
                </p>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{m.translatedText ?? "—"}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 返信 (送信済み) */}
      {m.status === "SENT" && m.finalText && (
        <div className="ml-auto max-w-[90%] rounded-2xl rounded-tr-sm bg-primary p-3 text-primary-foreground shadow-card sm:p-4 md:max-w-[75%]">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{m.finalText}</p>
          {m.draftTextJa && <p className="mt-2 whitespace-pre-wrap break-words border-t border-white/20 pt-2 text-xs opacity-85">{m.draftTextJa}</p>}
          <p className="mt-2 text-[11px] opacity-70">
            {handoffSent ? (
              <>
                業者アプリで送信 ・ 記録 {m.sentAt && new Date(m.sentAt).toLocaleString("ja-JP")} ・ 承認 {m.approvedBy}
              </>
            ) : (
              <>
                {m.draftSource === "MANUAL" ? "手動作成" : "AI 案"} ・ 送信 {m.sentAt && new Date(m.sentAt).toLocaleString("ja-JP")} ・ 承認 {m.approvedBy}
              </>
            )}
          </p>
        </div>
      )}

      {/* 返信案 (承認フロー) */}
      {m.status !== "SENT" && (
        <div
          className={cn(
            "ml-auto min-w-0 rounded-2xl rounded-tr-sm border border-dashed p-3 sm:p-4 md:ml-10",
            m.status === "APPROVED" ? "border-primary/60 bg-primary-soft/50" : "border-primary/40 bg-primary-soft/30",
          )}
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
              {m.direction === "OUTBOUND" ? <PenLine className="h-4 w-4 shrink-0 text-primary" /> : <Sparkles className="h-4 w-4 shrink-0 text-primary" />}
              {m.direction === "OUTBOUND" ? "送信メッセージ" : "返信"}
              <SourceBadge source={m.draftSource} />
            </p>
            <span className="flex flex-wrap items-center gap-2">
              {m.direction === "OUTBOUND" && <FlowStepper status={m.status} outbound />}
              <Badge variant={st.variant}>{st.label}</Badge>
            </span>
          </div>

          {m.status === "APPROVED" ? (
            <>
              <HandoffText m={m} supplier={supplier} />
              <HandoffActions m={m} supplier={supplier} sendMode={sendMode} onChanged={onChanged} className={cn("mt-3", stickyOnMobile && "hidden lg:block")} />
              {stickyOnMobile && <p className="mt-2 text-xs text-primary lg:hidden">画面下のボタンからコピー/共有して送信してください。</p>}
            </>
          ) : writing ? (
            <ReplyComposer
              target={{ kind: "inbound", messageId: m.id }}
              defaultLang={defaultLang}
              initialText={m.draftSource === "MANUAL" ? (m.draftText ?? "") : ""}
              initialTextJa={m.draftSource === "MANUAL" ? (m.draftTextJa ?? "") : ""}
              blacklisted={blacklisted}
              onCancel={() => setWriting(false)}
              onDone={() => {
                setWriting(false);
                onChanged();
              }}
            />
          ) : m.draftText === null ? (
            <p className="text-sm text-muted-foreground">まだ返信案がありません。</p>
          ) : (
            <>
              <Textarea
                ref={editRef}
                value={edit}
                onChange={(e) => setEdit(e.target.value)}
                disabled={m.status !== "DRAFT_READY" || busy}
                rows={3}
                aria-label="送信される本文"
                className="resize-none bg-card text-base lg:text-sm"
              />
              {m.draftTextJa && <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-card/70 px-3 py-2 text-xs leading-relaxed text-muted-foreground">訳: {m.draftTextJa}</p>}
              {edited && m.status === "DRAFT_READY" && <p className="mt-1.5 text-xs text-warning-ink">本文を編集しました。この内容で承認されます (日本語訳は元の案のものです)。</p>}
            </>
          )}

          {m.status === "REJECTED" && m.rejectedReason && <p className="mt-2 text-xs text-muted-foreground">却下理由: {m.rejectedReason}</p>}
          {m.status === "SEND_FAILED" && <p className="mt-2 text-xs text-destructive">送信の記録に失敗しました。返信案を再生成または書き直し、再承認してください。</p>}

          {!writing && m.status !== "APPROVED" && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {["RECEIVED", "DRAFT_READY", "REJECTED", "SEND_FAILED"].includes(m.status) && !rejecting && (
                <>
                  {m.direction === "INBOUND" && (
                    <Button size="sm" variant="outline" className={cn(big, "bg-card")} disabled={busy} onClick={() => act.mutate({ action: "draft" })}>
                      {m.status === "RECEIVED" || m.draftSource === "MANUAL" ? <Sparkles className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                      {m.status === "RECEIVED" || m.draftSource === "MANUAL" ? "AI 返信案を生成" : "AI 案を再生成"}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className={cn(big, "bg-card")} disabled={busy} onClick={() => setWriting(true)}>
                    <PenLine className="h-4 w-4" /> {m.draftText ? "書き直す" : "自分で書く"}
                  </Button>
                </>
              )}
              {m.status === "DRAFT_READY" && !rejecting && (
                <>
                  <Button
                    size="sm"
                    className={cn(big, "min-w-0 flex-1 sm:flex-none")}
                    disabled={busy || !edit.trim() || blacklisted}
                    onClick={() => act.mutate({ action: "approve-send", body: { expectedVersion: m.version, finalText: edit } })}
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} 承認する
                  </Button>
                  <Button size="sm" variant="ghost" className={big} disabled={busy} onClick={() => setRejecting(true)}>
                    <X className="h-4 w-4" /> 却下
                  </Button>
                  {blacklisted && <span className="w-full text-xs text-destructive">ブラックリスト業者には送信できません</span>}
                </>
              )}
              {rejecting && (
                <div className="flex w-full flex-wrap items-center gap-2">
                  <Input className="h-11 min-w-0 flex-1 basis-40 bg-card lg:h-8" placeholder="却下理由 (任意)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                  <Button size="sm" variant="destructive" className={big} disabled={busy} onClick={() => act.mutate({ action: "reject", body: { expectedVersion: m.version, reason: reason || undefined } })}>
                    却下する
                  </Button>
                  <Button size="sm" variant="ghost" className={big} onClick={() => setRejecting(false)}>
                    戻る
                  </Button>
                </div>
              )}
              {busy && m.status !== "DRAFT_READY" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
          )}
          {act.error && <p className="mt-2 rounded-md bg-destructive-soft px-3 py-2 text-xs text-destructive">{act.error.message}</p>}
        </div>
      )}
    </article>
  );
}

/**
 * モバイル (< lg) 用: 会話中の「いま操作すべき」メッセージの操作を画面下部 (ボトムナビの上) に固定表示する。
 * APPROVED → 手渡し操作 (コピー/共有/チャット/送信しました)、DRAFT_READY → 該当カードへ移動。
 */
function PendingActionBar({ m, supplier, sendMode, onChanged }: { m: Message; supplier: HandoffSupplier; sendMode: SendMode; onChanged: () => void }) {
  const jump = () => document.getElementById(`msg-${m.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <div className="sticky bottom-[calc(64px+env(safe-area-inset-bottom))] z-20 -mx-1 rounded-xl border bg-card p-3 shadow-lg lg:hidden">
      {m.status === "APPROVED" ? (
        <>
          <button type="button" onClick={jump} className="mb-2 flex w-full min-w-0 items-center gap-1.5 text-left text-xs font-semibold">
            <Send className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="shrink-0">承認済み・未送信</span>
            <span className="truncate font-normal text-muted-foreground">{m.finalText}</span>
          </button>
          <HandoffActions m={m} supplier={supplier} sendMode={sendMode} onChanged={onChanged} compact />
        </>
      ) : (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-xs">
            <span className="font-semibold">承認待ちの返信があります</span>
            <span className="block truncate text-muted-foreground">{m.draftTextJa ?? m.draftText}</span>
          </p>
          <Button className="h-11 shrink-0" onClick={jump}>
            <Check className="h-4 w-4" /> 確認する
          </Button>
        </div>
      )}
    </div>
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
  const [newMode, setNewMode] = useState<"ingest" | "compose">("ingest");
  const [composeSupplier, setComposeSupplier] = useState("");
  const [editingUrl, setEditingUrl] = useState(false);
  useEffect(() => setEditingUrl(false), [active]);
  const sendMode = useSendMode();
  /** モバイルで画面下部に固定表示するメッセージ: 最新の承認済み (未送信) → なければ最新の承認待ち */
  const stickyMsg = useMemo(() => {
    const list = [...(messages.data ?? [])].reverse();
    return list.find((m) => m.status === "APPROVED") ?? list.find((m) => m.status === "DRAFT_READY" && m.draftText !== null) ?? null;
  }, [messages.data]);
  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: () => api<(Supplier & { platform: string; isBlacklisted: boolean })[]>("/api/suppliers"), enabled: showNew });
  const composeTarget = suppliers.data?.find((s) => s.id === composeSupplier);
  /** 返信言語の既定: スレッド内の最新の受信メッセージの言語 → 1688 は中国語 → それ以外は英語 */
  const defaultLang: ReplyLang = useMemo(() => {
    const lastInbound = [...(messages.data ?? [])].reverse().find((m) => m.direction === "INBOUND" && m.originalLang);
    if (lastInbound) return lastInbound.originalLang === "zh" ? "zh" : "en";
    return thread?.supplier.platform === "ALI1688" ? "zh" : "en";
  }, [messages.data, thread]);

  return (
    <div className="-my-2 grid grid-cols-1 gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
      {/* スレッド一覧 */}
      <aside className={cn("space-y-3", active && "hidden lg:block")}>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">業者チャット</h1>
          <Button size="sm" variant="soft" onClick={() => setShowNew((s) => !s)}>
            <Plus className="h-4 w-4" /> 新規
          </Button>
        </div>
        {showNew && (
          <div className="space-y-3 rounded-xl border bg-card p-4 shadow-card">
            <Tabs<"ingest" | "compose">
              value={newMode}
              onChange={setNewMode}
              items={[
                { value: "ingest", label: "受信を取り込む" },
                { value: "compose", label: "こちらから送る" },
              ]}
            />
            {newMode === "ingest" ? (
              <IngestForm
                compact
                onDone={(id) => {
                  setShowNew(false);
                  refresh();
                  select(id);
                }}
              />
            ) : (
              <div className="space-y-3">
                <Select value={composeSupplier} onChange={(e) => setComposeSupplier(e.target.value)} aria-label="送信先の業者">
                  <option value="">業者を選択</option>
                  {suppliers.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                {composeTarget && (
                  <ReplyComposer
                    key={composeTarget.id}
                    target={{ kind: "outbound", supplierId: composeTarget.id }}
                    defaultLang={composeTarget.platform === "ALI1688" ? "zh" : "en"}
                    blacklisted={composeTarget.isBlacklisted}
                    onDone={({ threadId }) => {
                      setShowNew(false);
                      setComposeSupplier("");
                      refresh();
                      if (threadId) select(threadId);
                    }}
                  />
                )}
              </div>
            )}
          </div>
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
            業者から届いたメッセージを取り込むと日本語訳と AI 返信案が作成されます。「新規」からこちらのメッセージを書くこともできます。承認した本文はコピー/共有して業者アプリから送り、「送信しました」で記録します。
          </EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-6 pb-24 lg:pb-0 xl:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 space-y-5">
              <div className="space-y-2 border-b pb-3">
                <div className="flex items-center gap-2 sm:gap-3">
                  <Button variant="ghost" size="icon" className="-ml-2 h-11 w-11 shrink-0 lg:hidden" onClick={() => select(null)} aria-label="一覧に戻る">
                    <ArrowLeft className="h-5 w-5" />
                  </Button>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary font-bold">{thread.supplier.name.slice(0, 1)}</span>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-semibold">{thread.supplier.name}</h2>
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      {PLATFORM_LABEL[thread.supplier.platform]}
                      {thread.supplier.isBlacklisted && (
                        <Badge variant="destructive">
                          <Ban className="h-3 w-3" /> ブラックリスト
                        </Badge>
                      )}
                    </p>
                  </div>
                  {thread.supplier.chatUrl && (
                    <Button asChild size="sm" variant="outline" className="h-10 shrink-0 px-2.5 lg:h-8">
                      <a href={thread.supplier.chatUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4" />
                        <span className="hidden min-[400px]:inline">チャットを開く</span>
                        <span className="min-[400px]:hidden">開く</span>
                      </a>
                    </Button>
                  )}
                  {thread.supplier.chatUrl && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-10 w-10 shrink-0 lg:h-8 lg:w-8"
                      aria-label="業者チャットの URL を編集"
                      onClick={() => setEditingUrl((v) => !v)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                {!thread.supplier.chatUrl && !editingUrl && (
                  <button type="button" className="inline-flex min-h-8 items-center gap-1 text-xs text-primary underline-offset-4 hover:underline" onClick={() => setEditingUrl(true)}>
                    <Link2 className="h-3.5 w-3.5" /> 業者チャットの URL を登録
                  </button>
                )}
                {editingUrl && <ChatUrlEditor key={thread.supplier.id} supplierId={thread.supplier.id} chatUrl={thread.supplier.chatUrl} onClose={() => setEditingUrl(false)} />}
              </div>
              {messages.isLoading && <Skeleton className="h-48" />}
              {messages.data?.map((m) => (
                <MessageCard
                  key={m.id}
                  m={m}
                  supplier={thread.supplier}
                  sendMode={sendMode}
                  defaultLang={defaultLang}
                  stickyOnMobile={stickyMsg?.id === m.id}
                  onChanged={refresh}
                />
              ))}
              {stickyMsg && <PendingActionBar key={`${stickyMsg.id}-${stickyMsg.version}`} m={stickyMsg} supplier={thread.supplier} sendMode={sendMode} onChanged={refresh} />}
              <div className="rounded-xl border bg-card p-3 shadow-card sm:p-4">
                <p className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
                  <PenLine className="h-4 w-4 text-primary" /> メッセージを作成
                </p>
                <ReplyComposer
                  key={`${thread.threadId}-${messages.data?.length ?? 0}`}
                  target={{ kind: "outbound", supplierId: thread.supplier.id, threadId: thread.threadId }}
                  defaultLang={defaultLang}
                  blacklisted={thread.supplier.isBlacklisted}
                  onDone={refresh}
                />
              </div>
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
