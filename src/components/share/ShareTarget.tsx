"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, MessageSquareText, PackagePlus, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/misc";
import { PLATFORM_LABEL, api } from "@/components/api";
import { useImportProduct } from "@/components/import/ProductImport";
import { analyzeProductUrl, extractUrls, findProductUrl } from "@/lib/scraper/url";

interface Supplier {
  id: string;
  name: string;
  platform: string;
  isBlacklisted: boolean;
}
interface Thread {
  threadId: string;
  supplier: { id: string; name: string };
  lastText: string;
  lastAt: string;
}

/** 共有された内容 (title / text / url) を 1 つの本文にまとめる。重複は除く */
function combine(title: string, text: string, url: string): string {
  const parts: string[] = [];
  for (const p of [title, text, url].map((s) => s.trim()).filter(Boolean)) {
    if (!parts.some((x) => x.includes(p))) parts.push(p);
  }
  return parts.join("\n");
}

/* ------------------------------------------------------------------ */
function ProductCard({ url, title }: { url: string; title?: string }) {
  const router = useRouter();
  const imp = useImportProduct();
  const a = analyzeProductUrl(url);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PackagePlus className="h-5 w-5 text-primary" /> 仕入れ候補に追加
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {a && <Badge variant="outline">{PLATFORM_LABEL[a.platform]}</Badge>}
        {title && <p className="line-clamp-3 text-sm font-medium">{title}</p>}
        <p className="break-all text-xs text-muted-foreground">{url}</p>
        <Button
          className="h-12 w-full text-base"
          disabled={imp.isPending}
          onClick={() => imp.mutate({ url }, { onSuccess: (r) => router.push(`/products?id=${encodeURIComponent(r.product.id)}`) })}
        >
          {imp.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <PackagePlus className="h-5 w-5" />}
          {imp.isPending ? "商品ページを読み込み中…" : "仕入れ候補に追加"}
        </Button>
        {imp.error && (
          <div className="space-y-2 rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">
            <p>{imp.error.message}</p>
            <Link className="inline-flex min-h-[44px] items-center gap-1 font-medium underline" href={`/products?add=manual&url=${encodeURIComponent(url)}`}>
              <PencilLine className="h-4 w-4" /> 手入力で追加する
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
function MessageCard({ initialText }: { initialText: string }) {
  const router = useRouter();
  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: () => api<Supplier[]>("/api/suppliers") });
  const threads = useQuery({ queryKey: ["threads"], queryFn: () => api<Thread[]>("/api/chat/threads") });
  const [supplierId, setSupplierId] = useState("");
  const [threadId, setThreadId] = useState("__new__");
  const [text, setText] = useState(initialText);
  useEffect(() => setText(initialText), [initialText]);

  const supplierThreads = useMemo(() => (threads.data ?? []).filter((t) => t.supplier.id === supplierId), [threads.data, supplierId]);
  // 業者を選んだら最新のスレッドを既定にする
  useEffect(() => setThreadId(supplierThreads[0]?.threadId ?? "__new__"), [supplierThreads]);
  const selectable = (suppliers.data ?? []).filter((s) => !s.isBlacklisted);

  const ingest = useMutation({
    mutationFn: () => {
      const tid = threadId !== "__new__" ? threadId : supplierThreads.length ? `thread-${supplierId}-${Date.now().toString(36)}` : `thread-${supplierId}`;
      return api<{ threadId: string }>("/api/chat/messages", { method: "POST", json: { supplierId, threadId: tid, text: text.trim() } }).then(() => tid);
    },
    onSuccess: (tid) => router.push(`/chat?thread=${encodeURIComponent(tid)}`),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquareText className="h-5 w-5 text-primary" /> 業者メッセージとして取り込む
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            ingest.mutate();
          }}
        >
          <p className="text-xs text-muted-foreground">取り込むと日本語に翻訳し、返信案を作成します (送信はしません。送信は承認後のみ)。</p>
          <div className="space-y-1.5">
            <Label htmlFor="share-supplier">業者</Label>
            <Select id="share-supplier" className="h-11" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
              <option value="">{suppliers.isLoading ? "読み込み中…" : "業者を選択"}</option>
              {selectable.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({PLATFORM_LABEL[s.platform] ?? s.platform})
                </option>
              ))}
            </Select>
            {suppliers.data && selectable.length === 0 && <p className="text-xs text-warning-ink">業者が登録されていません。先に商品を URL から追加してください。</p>}
          </div>
          {supplierId && (
            <div className="space-y-1.5">
              <Label htmlFor="share-thread">スレッド</Label>
              <Select id="share-thread" className="h-11" value={threadId} onChange={(e) => setThreadId(e.target.value)}>
                {supplierThreads.map((t) => (
                  <option key={t.threadId} value={t.threadId}>
                    {t.lastText.slice(0, 30) || t.threadId} ({new Date(t.lastAt).toLocaleDateString("ja-JP")})
                  </option>
                ))}
                <option value="__new__">新しいスレッド</option>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="share-text">メッセージ本文</Label>
            <Textarea id="share-text" className="min-h-[140px] text-base sm:text-sm" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          {ingest.error && <p className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{ingest.error.message}</p>}
          <Button type="submit" className="h-12 w-full text-base" disabled={!supplierId || !text.trim() || ingest.isPending}>
            {ingest.isPending && <Loader2 className="h-5 w-5 animate-spin" />} 業者メッセージとして取り込む
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
export function ShareTarget({ title, text, url }: { title: string; text: string; url: string }) {
  const productUrl = findProductUrl(url, text, title);
  const otherUrl = productUrl ? null : (extractUrls([url, text, title].join(" "))[0] ?? null);
  const body = combine(title, text, url);
  const [forceProduct, setForceProduct] = useState(false);

  if (!body) {
    return (
      <div>
        <PageHeader title="共有から追加" description="他のアプリの「共有」からこのアプリを選ぶと、商品 URL やメッセージを取り込めます。" />
        <p className="text-sm text-muted-foreground">共有された内容がありません。</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader title="共有から追加" />
      {productUrl ? (
        <>
          <ProductCard url={productUrl} title={title && !title.includes("http") ? title : undefined} />
          <details className="rounded-xl border bg-card p-4 text-sm">
            <summary className="min-h-[44px] cursor-pointer py-2 font-medium">商品ではなく業者メッセージとして取り込む</summary>
            <div className="pt-3">
              <MessageCard initialText={body} />
            </div>
          </details>
        </>
      ) : (
        <>
          <MessageCard initialText={body} />
          {otherUrl && (
            <div className="space-y-2">
              {!forceProduct ? (
                <Button variant="outline" className="h-11 w-full" onClick={() => setForceProduct(true)}>
                  <PackagePlus className="h-4 w-4" /> 商品 URL として追加
                </Button>
              ) : (
                <ProductCard url={otherUrl} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
