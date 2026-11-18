"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CircleCheck, CirclePause, FileSearch, Loader2, Play, Radar, ShieldCheck, Store, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState, PageHeader, Tabs } from "@/components/ui/misc";
import { PLATFORM_LABEL, api, relTime } from "@/components/api";
import { useMe } from "@/components/hooks";

interface ScraperState {
  platform: string;
  paused: boolean;
  reason: string | null;
  pausedAt: string | null;
}
interface Supplier {
  id: string;
  name: string;
  platform: string;
  rating: string | null;
  isBlacklisted: boolean;
  blacklistNote: string | null;
}
interface User {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "MEMBER";
  disabled: boolean;
  lastLoginAt: string | null;
}

function ScraperTab({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const states = useQuery({ queryKey: ["scraper"], queryFn: () => api<ScraperState[]>("/api/scraper") });
  const resume = useMutation({
    mutationFn: (platform: string) => api("/api/scraper", { method: "POST", json: { platform } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scraper"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>巡回ステータス</CardTitle>
        <CardDescription>
          CAPTCHA やセッション切れを検知すると、自動突破は行わずにそのプラットフォームの巡回だけを停止します。ブラウザで手動ログインしてセッション (storageState)
          を更新してから再開してください。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {states.error && <p className="text-sm text-destructive">{states.error.message}</p>}
        {states.data?.map((s) => (
          <div key={s.platform} className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{PLATFORM_LABEL[s.platform]}</span>
                {s.paused ? (
                  <Badge variant="destructive">
                    <CirclePause className="h-3 w-3" /> 停止中
                  </Badge>
                ) : (
                  <Badge variant="success">
                    <CircleCheck className="h-3 w-3" /> 稼働中
                  </Badge>
                )}
              </div>
              {s.reason && <p className="mt-1 break-all text-xs text-muted-foreground">{s.reason}</p>}
              {s.pausedAt && <p className="text-xs text-muted-foreground">停止 {relTime(s.pausedAt)}</p>}
            </div>
            {s.paused && (
              <Button size="sm" onClick={() => resume.mutate(s.platform)} disabled={resume.isPending || !isAdmin} title={isAdmin ? undefined : "管理者のみ実行できます"}>
                <Play className="h-4 w-4" /> 再認証完了・再開
              </Button>
            )}
          </div>
        ))}
        {resume.error && <p className="text-sm text-destructive">{resume.error.message}</p>}
      </CardContent>
    </Card>
  );
}

function SuppliersTab() {
  const qc = useQueryClient();
  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: () => api<Supplier[]>("/api/suppliers") });
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const update = useMutation({
    mutationFn: ({ id, isBlacklisted, blacklistNote }: { id: string; isBlacklisted: boolean; blacklistNote: string | null }) =>
      api(`/api/suppliers/${id}`, { method: "PATCH", json: { isBlacklisted, blacklistNote } }),
    onSuccess: () => {
      setNoteFor(null);
      setNote("");
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["threads"] });
    },
  });
  if (suppliers.data?.length === 0) return <EmptyState icon={Store} title="業者はまだ登録されていません">商品を登録すると業者も自動で追加されます。</EmptyState>;
  return (
    <Card>
      <CardHeader>
        <CardTitle>業者</CardTitle>
        <CardDescription>ブラックリストに登録した業者へはチャットを送信できません。</CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        {suppliers.data?.map((s) => (
          <div key={s.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-sm font-bold">{s.name.slice(0, 1)}</span>
              <span className="font-medium">{s.name}</span>
              <Badge variant="outline">{PLATFORM_LABEL[s.platform]}</Badge>
              {s.rating && <span className="text-xs text-muted-foreground">評価 {s.rating}</span>}
              {s.isBlacklisted && (
                <Badge variant="destructive">
                  <Ban className="h-3 w-3" /> ブラックリスト
                </Badge>
              )}
              <div className="ml-auto">
                {s.isBlacklisted ? (
                  <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: s.id, isBlacklisted: false, blacklistNote: null })}>
                    解除
                  </Button>
                ) : (
                  noteFor !== s.id && (
                    <Button size="sm" variant="ghost" onClick={() => setNoteFor(s.id)}>
                      ブラックリストに追加
                    </Button>
                  )
                )}
              </div>
            </div>
            {s.blacklistNote && <p className="ml-10 mt-1 text-xs text-muted-foreground">理由: {s.blacklistNote}</p>}
            {noteFor === s.id && (
              <div className="ml-10 mt-2 flex flex-wrap gap-2">
                <Input className="h-8 min-w-0 flex-1" placeholder="理由 (任意)" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
                <Button size="sm" variant="destructive" disabled={update.isPending} onClick={() => update.mutate({ id: s.id, isBlacklisted: true, blacklistNote: note || null })}>
                  登録する
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setNoteFor(null)}>
                  キャンセル
                </Button>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function UsersTab({ meId }: { meId: string }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/api/users") });
  const [f, setF] = useState({ name: "", email: "", password: "", role: "MEMBER" });
  const create = useMutation({
    mutationFn: () => api("/api/users", { method: "POST", json: f }),
    onSuccess: () => {
      setF({ name: "", email: "", password: "", role: "MEMBER" });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; disabled?: boolean; role?: string }) => api(`/api/users/${id}`, { method: "PATCH", json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card>
        <CardHeader>
          <CardTitle>ユーザー</CardTitle>
          <CardDescription>承認・送信の操作は監査ログにユーザー名で記録されます。</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {users.data?.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary font-bold">{u.name.slice(0, 1)}</span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {u.name}
                  {u.id === meId && <Badge variant="outline">あなた</Badge>}
                  {u.disabled && <Badge variant="destructive">無効</Badge>}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {u.email} ・ 最終ログイン {u.lastLoginAt ? relTime(u.lastLoginAt) : "なし"}
                </p>
              </div>
              <Select
                className="h-8 w-28 text-xs"
                value={u.role}
                disabled={u.id === meId || update.isPending}
                onChange={(e) => update.mutate({ id: u.id, role: e.target.value })}
                aria-label={`${u.name} の権限`}
              >
                <option value="ADMIN">管理者</option>
                <option value="MEMBER">メンバー</option>
              </Select>
              <Button size="sm" variant="ghost" disabled={u.id === meId || update.isPending} onClick={() => update.mutate({ id: u.id, disabled: !u.disabled })}>
                {u.disabled ? "有効化" : "無効化"}
              </Button>
            </div>
          ))}
          {update.error && <p className="pt-3 text-sm text-destructive">{update.error.message}</p>}
        </CardContent>
      </Card>
      <Card className="self-start">
        <CardHeader>
          <CardTitle>
            <UserPlus className="h-4 w-4" /> ユーザーを追加
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label>表示名</Label>
              <Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>メールアドレス</Label>
              <Input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>初期パスワード (10文字以上)</Label>
              <Input required type="password" minLength={10} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>権限</Label>
              <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                <option value="MEMBER">メンバー</option>
                <option value="ADMIN">管理者</option>
              </Select>
            </div>
            {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
            <Button type="submit" className="w-full" disabled={create.isPending}>
              追加する
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

interface ParseResult {
  block: string | null;
  parsed: { title: string | null; currency: string | null; priceTiers: { minQty: number; unitPrice: string }[]; moq: number | null; inStock: boolean; stockQty: number | null; source: string[] };
}

function ParserTab() {
  const [platform, setPlatform] = useState("ALIBABA");
  const [html, setHtml] = useState("");
  const run = useMutation({ mutationFn: () => api<ParseResult>("/api/scraper/parse", { method: "POST", json: { platform, html } }) });
  const r = run.data;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>パーサー検証</CardTitle>
          <CardDescription>
            ブラウザで開いた商品ページのソース (HTML) を貼り付けると、巡回時と同じ処理で抽出結果を確認できます。外部へのアクセスは行いません。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="プラットフォーム">
            {Object.entries(PLATFORM_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <Textarea rows={12} className="font-mono text-xs" placeholder="<html>…</html>" value={html} onChange={(e) => setHtml(e.target.value)} />
          <Button onClick={() => run.mutate()} disabled={!html.trim() || run.isPending}>
            {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSearch className="h-4 w-4" />} 抽出する
          </Button>
          {run.error && <p className="text-sm text-destructive">{run.error.message}</p>}
        </CardContent>
      </Card>
      <Card className="self-start">
        <CardHeader>
          <CardTitle>抽出結果</CardTitle>
        </CardHeader>
        <CardContent>
          {!r ? (
            <p className="text-sm text-muted-foreground">まだ実行していません。</p>
          ) : (
            <div className="space-y-3 text-sm">
              {r.block && (
                <p className="rounded-md bg-destructive-soft px-3 py-2 text-destructive">
                  ブロックを検知: {r.block === "captcha" ? "CAPTCHA" : r.block === "login" ? "ログイン要求" : "アクセス制限"}
                </p>
              )}
              {r.parsed.priceTiers.length === 0 ? (
                <p className="rounded-md bg-warning-soft px-3 py-2 text-warning-ink">価格を抽出できませんでした。</p>
              ) : (
                <p className="flex items-center gap-1.5 text-success">
                  <ShieldCheck className="h-4 w-4" /> 価格を抽出できました ({r.parsed.source.join(", ")})
                </p>
              )}
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                <dt className="text-muted-foreground">商品名</dt>
                <dd className="break-words">{r.parsed.title ?? "—"}</dd>
                <dt className="text-muted-foreground">通貨</dt>
                <dd>{r.parsed.currency ?? "—"}</dd>
                <dt className="text-muted-foreground">MOQ</dt>
                <dd>{r.parsed.moq ?? "—"}</dd>
                <dt className="text-muted-foreground">在庫</dt>
                <dd>
                  {r.parsed.inStock ? "あり" : "なし"}
                  {r.parsed.stockQty !== null && ` (${r.parsed.stockQty})`}
                </dd>
                <dt className="text-muted-foreground">段階単価</dt>
                <dd className="tabular">{r.parsed.priceTiers.map((t) => `${t.minQty}〜: ${t.unitPrice}`).join(" / ") || "—"}</dd>
              </dl>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type Tab = "scraper" | "suppliers" | "users" | "parser";

export default function SettingsPage() {
  const { data: me } = useMe();
  const isAdmin = me?.role === "ADMIN";
  const [tab, setTab] = useState<Tab>("scraper");
  return (
    <div>
      <PageHeader title="設定" description="巡回の稼働状態、業者、ユーザーを管理します。" />
      <div className="mb-6 overflow-x-auto">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { value: "scraper", label: <><Radar className="h-4 w-4" /> 巡回</> },
            { value: "suppliers", label: <><Store className="h-4 w-4" /> 業者</> },
            ...(isAdmin ? [{ value: "users" as Tab, label: <><Users className="h-4 w-4" /> ユーザー</> }] : []),
            { value: "parser", label: <><FileSearch className="h-4 w-4" /> パーサー検証</> },
          ]}
        />
      </div>
      {tab === "scraper" && <ScraperTab isAdmin={isAdmin} />}
      {tab === "suppliers" && <SuppliersTab />}
      {tab === "users" && isAdmin && me && <UsersTab meId={me.id} />}
      {tab === "parser" && <ParserTab />}
    </div>
  );
}
