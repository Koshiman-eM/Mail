"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ClipboardPaste, FileCode2, Link2, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Textarea, UnitInput } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api, relTime } from "@/components/api";
import type { PriceTier } from "@/lib/profit/types";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* 型 (API レスポンス)                                                  */
/* ------------------------------------------------------------------ */
export interface FetchInfo {
  status: "OK" | "FAILED";
  note: string | null;
  parsedFields: string[];
}
export interface ImportResponse {
  product: { id: string; title: string };
  existed: boolean;
  fetch?: FetchInfo;
}
type ScrapeResult =
  | { status: "ok"; events: number; auto: string; parsedFields: string[]; note: string | null }
  | { status: "blocked"; kind: string; note: string; paused: boolean }
  | { status: "failed"; note: string; retryable: boolean; parsedFields: string[] };
type ScrapeResponse = { mode: "queued"; jobId: string } | { mode: "inline" | "pasted"; result: ScrapeResult };

export interface FetchableProduct {
  id: string;
  platform: string;
  url: string;
  title: string;
  currency: string;
  moq: number;
  priceTiers: PriceTier[];
  fetchStatus: string | null;
  fetchNote: string | null;
  lastFetchedAt: string | null;
  supplier: { id: string; name: string; externalId: string };
}

const FIELD_LABEL: Record<string, string> = {
  title: "商品名",
  priceTiers: "価格",
  moq: "MOQ",
  currency: "通貨",
  stock: "在庫",
  supplierName: "業者名",
  supplierId: "業者 ID",
  supplierUrl: "ショップ URL",
};
export const fieldsLabel = (fields: string[]) => fields.map((f) => FIELD_LABEL[f] ?? f).join("・");

/** 取り込み直後で商品名が URL のままか */
export const titleIsPlaceholder = (p: { title: string; url: string }) => !p.title.trim() || p.title === p.url || /^https?:\/\//i.test(p.title);
const supplierIsPlaceholder = (s: { name: string; externalId: string }) => s.externalId.startsWith("unknown:") || s.name === "業者未設定";

/** 足りない基本情報 (商品名・価格・業者) があるか */
export const needsBasics = (p: FetchableProduct) => titleIsPlaceholder(p) || p.priceTiers.length === 0 || supplierIsPlaceholder(p.supplier);

/* ------------------------------------------------------------------ */
export function FetchStatusBadge({ status, pending }: { status: string | null; pending?: boolean }) {
  if (pending || status === "PENDING")
    return (
      <Badge variant="info">
        <Loader2 className="h-3 w-3 animate-spin" /> 取得中
      </Badge>
    );
  if (status === "FAILED") return <Badge variant="warning">取得失敗</Badge>;
  return null;
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["products"] });
  qc.invalidateQueries({ queryKey: ["dashboard"] });
}

export function useImportProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { url?: string; text?: string; html?: string }) => api<ImportResponse>("/api/products/import", { method: "POST", json: body }),
    onSuccess: () => invalidate(qc),
  });
}

/** クリップボードから読み取り (非対応・拒否時は null) */
export async function readClipboard(): Promise<string | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) return null;
    const t = await navigator.clipboard.readText();
    return t.trim() ? t : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* URL から追加                                                         */
/* ------------------------------------------------------------------ */
export function UrlImportCard({ onImported, onManual }: { onImported: (r: ImportResponse) => void; onManual?: () => void }) {
  const [value, setValue] = useState("");
  const [clipMsg, setClipMsg] = useState<string | null>(null);
  const imp = useImportProduct();
  const [canPaste, setCanPaste] = useState(false);
  useEffect(() => setCanPaste(typeof navigator !== "undefined" && !!navigator.clipboard?.readText), []);

  const submit = (text: string) => {
    if (!text.trim()) return;
    imp.mutate(/^https?:\/\/\S+$/.test(text.trim()) ? { url: text.trim() } : { text }, {
      onSuccess: (r) => {
        setValue("");
        onImported(r);
      },
    });
  };

  return (
    <Card className="mb-4">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">URL から追加</h2>
        </div>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            submit(value);
          }}
        >
          <Input
            className="h-12 text-base sm:h-10 sm:text-sm"
            inputMode="url"
            placeholder="Alibaba・1688・AliExpress の商品 URL を貼り付け"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="商品 URL"
          />
          <div className="flex gap-2">
            {canPaste && (
              <Button
                type="button"
                variant="outline"
                className="h-12 flex-1 sm:h-10 sm:flex-none"
                disabled={imp.isPending}
                onClick={async () => {
                  setClipMsg(null);
                  const t = await readClipboard();
                  if (!t) return setClipMsg("クリップボードを読み取れませんでした。入力欄に長押しで貼り付けてください");
                  setValue(t);
                  submit(t);
                }}
              >
                <ClipboardPaste className="h-4 w-4" /> 貼り付けて追加
              </Button>
            )}
            <Button type="submit" className="h-12 flex-1 sm:h-10 sm:flex-none" disabled={imp.isPending || !value.trim()}>
              {imp.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} 追加
            </Button>
          </div>
        </form>
        {imp.isPending && <p className="text-xs text-muted-foreground">商品ページを読み込んでいます (最大 20 秒ほど)…</p>}
        {clipMsg && <p className="text-xs text-warning-ink">{clipMsg}</p>}
        {imp.error && <p className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{imp.error.message}</p>}
        {onManual && (
          <button type="button" className="min-h-[44px] text-sm text-primary underline-offset-4 hover:underline" onClick={onManual}>
            URL が無い・取り込めない場合は手入力で追加
          </button>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 取得状態と手動対応 (再取得・ソース貼り付け・基本情報の入力)            */
/* ------------------------------------------------------------------ */
export function FetchStatusPanel({ p }: { p: FetchableProduct }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"none" | "html" | "basics">("none");
  const [html, setHtml] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const report = (r: ScrapeResponse) => {
    if (r.mode === "queued") return setMsg({ ok: true, text: "取得ジョブを登録しました。結果は通知でお知らせします。" });
    const res = r.result;
    if (res.status === "ok") setMsg({ ok: true, text: `取得しました${res.parsedFields.length ? ` (${fieldsLabel(res.parsedFields)})` : ""}` });
    else setMsg({ ok: false, text: res.note });
  };
  const scrape = useMutation({
    mutationFn: (body?: { html: string }) => api<ScrapeResponse>(`/api/products/${p.id}/scrape`, { method: "POST", json: body ?? {} }),
    onSuccess: (r, body) => {
      report(r);
      invalidate(qc);
      if (body?.html && r.mode !== "queued" && r.result.status === "ok") {
        setHtml("");
        setMode("none");
      }
    },
    onError: (e) => setMsg({ ok: false, text: e.message }),
  });

  const failed = p.fetchStatus === "FAILED";
  const missing = needsBasics(p);
  const canFetch = p.platform !== "OTHER";

  return (
    <div className={cn("space-y-3 rounded-xl border p-4", failed ? "border-warning/40 bg-warning-soft/40" : "bg-card")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">商品ページからの取得</span>
        <FetchStatusBadge status={p.fetchStatus} pending={scrape.isPending} />
        {p.fetchStatus === "OK" && !scrape.isPending && <Badge variant="success">取得済み</Badge>}
        {p.lastFetchedAt && <span className="text-xs text-muted-foreground">最終取得 {relTime(p.lastFetchedAt)}</span>}
      </div>
      {failed && p.fetchNote && (
        <p className="flex gap-2 text-sm text-warning-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{p.fetchNote}</span>
        </p>
      )}
      {!failed && missing && <p className="text-sm text-muted-foreground">商品名・価格・業者名のうち未入力の項目があります。下のボタンから入力できます。</p>}

      <div className="grid gap-2 sm:grid-cols-3">
        {canFetch && (
          <Button variant="outline" className="h-11" onClick={() => scrape.mutate(undefined)} disabled={scrape.isPending}>
            <RefreshCw className={cn("h-4 w-4", scrape.isPending && "animate-spin")} /> 再取得
          </Button>
        )}
        <Button variant={mode === "html" ? "soft" : "outline"} className="h-11" onClick={() => setMode(mode === "html" ? "none" : "html")}>
          <FileCode2 className="h-4 w-4" /> ソースを貼り付け
        </Button>
        <Button variant={mode === "basics" ? "soft" : missing ? "default" : "outline"} className="h-11" onClick={() => setMode(mode === "basics" ? "none" : "basics")}>
          <Pencil className="h-4 w-4" /> 基本情報を入力
        </Button>
      </div>
      {msg && <p className={cn("text-sm", msg.ok ? "text-success" : "text-destructive")}>{msg.text}</p>}

      {mode === "html" && (
        <div className="space-y-2">
          <Label htmlFor={`html-${p.id}`}>ページのソースを貼り付けて読み込む</Label>
          <p className="text-xs text-muted-foreground">
            PC のブラウザで商品ページを開き (CAPTCHA が出たら自分で認証)、「ページのソースを表示」の内容をすべてコピーして貼り付けてください。サイトへの再アクセスはしません。
          </p>
          <Textarea id={`html-${p.id}`} className="min-h-[140px] font-mono text-xs" value={html} onChange={(e) => setHtml(e.target.value)} placeholder="<html>…" />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={async () => {
                const t = await readClipboard();
                if (t) setHtml(t);
                else setMsg({ ok: false, text: "クリップボードを読み取れませんでした。入力欄に貼り付けてください" });
              }}
            >
              <ClipboardPaste className="h-4 w-4" /> 貼り付け
            </Button>
            <Button className="h-11 flex-1" disabled={!html.trim() || scrape.isPending} onClick={() => scrape.mutate({ html })}>
              {scrape.isPending && <Loader2 className="h-4 w-4 animate-spin" />} 読み込む
            </Button>
          </div>
        </div>
      )}
      {mode === "basics" && <BasicsForm p={p} onDone={() => setMode("none")} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
function BasicsForm({ p, onDone }: { p: FetchableProduct; onDone: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(titleIsPlaceholder(p) ? "" : p.title);
  const [moq, setMoq] = useState(String(p.moq));
  const [supplierName, setSupplierName] = useState(supplierIsPlaceholder(p.supplier) && p.supplier.name === "業者未設定" ? "" : p.supplier.name);
  const [tiers, setTiers] = useState<PriceTier[]>(p.priceTiers.length ? p.priceTiers : [{ minQty: p.moq || 1, unitPrice: "" }]);

  const save = useMutation({
    mutationFn: async () => {
      const validTiers = tiers.filter((t) => t.unitPrice.trim() && t.minQty > 0).map((t) => ({ minQty: t.minQty, unitPrice: t.unitPrice.trim() }));
      if (validTiers.some((t) => !/^\d+(\.\d+)?$/.test(t.unitPrice))) throw new Error("単価は数値で入力してください");
      const body: Record<string, unknown> = {};
      if (title.trim() && title.trim() !== p.title) body.title = title.trim();
      const m = Number(moq);
      if (!Number.isInteger(m) || m <= 0) throw new Error("MOQ は 1 以上の整数で入力してください");
      if (m !== p.moq) body.moq = m;
      if (validTiers.length) body.priceTiers = validTiers;
      if (Object.keys(body).length) await api(`/api/products/${p.id}`, { method: "PATCH", json: body });
      if (supplierName.trim() && supplierName.trim() !== p.supplier.name) {
        await api(`/api/suppliers/${p.supplier.id}/profile`, { method: "PATCH", json: { name: supplierName.trim() } });
      }
    },
    onSuccess: () => {
      invalidate(qc);
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      onDone();
    },
  });

  return (
    <form
      className="space-y-3 border-t pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="space-y-1.5">
        <Label>商品名</Label>
        <Input className="h-11" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: シリコンヘラ 5本セット" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>業者名</Label>
          <Input className="h-11" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} placeholder="ショップ名" />
        </div>
        <div className="space-y-1.5">
          <Label>MOQ</Label>
          <UnitInput unit="個" inputMode="numeric" value={moq} onChange={(e) => setMoq(e.target.value)} />
        </div>
      </div>
      <div className="space-y-2">
        <Label>段階単価 ({p.currency})</Label>
        {tiers.map((t, i) => (
          <div key={i} className="flex items-center gap-2">
            <UnitInput className="w-28" unit="個〜" inputMode="numeric" value={String(t.minQty)} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, minQty: Number(e.target.value) || 0 } : x)))} />
            <UnitInput className="flex-1" unit={p.currency} placeholder="単価" value={t.unitPrice} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} />
            <Button type="button" variant="ghost" size="icon" aria-label="段階を削除" disabled={tiers.length === 1} onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => setTiers([...tiers, { minQty: (tiers.at(-1)?.minQty || 1) * 10, unitPrice: "" }])}>
          <Plus className="h-4 w-4" /> 段階を追加
        </Button>
      </div>
      {save.error && <p className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{save.error.message}</p>}
      <div className="flex gap-2">
        <Button type="button" variant="outline" className="h-11 flex-1" onClick={onDone}>
          キャンセル
        </Button>
        <Button type="submit" className="h-11 flex-1" disabled={save.isPending}>
          {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />} 保存
        </Button>
      </div>
    </form>
  );
}
