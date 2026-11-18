"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calculator, ExternalLink, Loader2, Package, PencilLine, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select, UnitInput } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState, PageHeader, Sheet, Skeleton } from "@/components/ui/misc";
import { PriceHistoryChart, Sparkline } from "@/components/charts";
import { PLATFORM_LABEL, api, relTime, yenFmt } from "@/components/api";
import type { PriceTier } from "@/lib/profit/types";
import { AutoProfitPanel, AutoRoiCell, type AutoSim } from "@/components/AutoProfitPanel";
import { cn } from "@/lib/utils";
import { FetchStatusBadge, FetchStatusPanel, UrlImportCard, fieldsLabel, needsBasics, type ImportResponse } from "@/components/import/ProductImport";

interface Product {
  id: string;
  platform: string;
  url: string;
  title: string;
  titleJa: string | null;
  currency: string;
  moq: number;
  priceTiers: PriceTier[];
  inStock: boolean;
  updatedAt: string;
  weightKg: string | null;
  lengthCm: string | null;
  widthCm: string | null;
  heightCm: string | null;
  domesticPriceJpy: string | null;
  hsCode: string | null;
  targetQuantity: number | null;
  dutyPercent: string | null;
  autoCalcStatus: string | null;
  autoCalcNote: string | null;
  autoCalcAt: string | null;
  fetchStatus: string | null;
  fetchNote: string | null;
  lastFetchedAt: string | null;
  supplier: { id: string; name: string; externalId: string; isBlacklisted: boolean };
  simulations: AutoSim[];
  snapshots: { priceTiers: PriceTier[]; capturedAt: string; inStock: boolean }[];
}

const minPrice = (tiers: PriceTier[]) => (tiers.length ? Math.min(...tiers.map((t) => Number(t.unitPrice))) : NaN);
/** 表示用: 最安段階の単価を元の文字列 (桁数) のまま返す */
const minPriceLabel = (tiers: PriceTier[]) =>
  tiers.length ? tiers.reduce((a, b) => (Number(b.unitPrice) < Number(a.unitPrice) ? b : a)).unitPrice : "—";

/* ------------------------------------------------------------------ */
function NewProductForm({ onDone, initialUrl = "" }: { onDone: () => void; initialUrl?: string }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    platform: /1688\.com/.test(initialUrl) ? "ALI1688" : /aliexpress\./.test(initialUrl) ? "ALIEXPRESS" : /alibaba\.com/.test(initialUrl) || !initialUrl ? "ALIBABA" : "OTHER",
    url: initialUrl,
    title: "",
    externalId: "",
    supplierName: "",
    supplierExternalId: "",
    currency: "USD",
    moq: "1",
    weightKg: "",
    lengthCm: "",
    widthCm: "",
    heightCm: "",
    domesticPriceJpy: "",
    targetQuantity: "",
    dutyPercent: "",
  });
  const [tiers, setTiers] = useState<PriceTier[]>([{ minQty: 1, unitPrice: "" }]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);

  const create = useMutation({
    mutationFn: () =>
      api("/api/products", {
        method: "POST",
        json: {
          platform: f.platform,
          url: f.url,
          externalId: f.externalId || f.url,
          title: f.title,
          currency: f.currency.toUpperCase(),
          moq: Number(f.moq),
          priceTiers: tiers.filter((t) => t.unitPrice),
          supplier: { externalId: f.supplierExternalId || f.supplierName, name: f.supplierName },
          weightKg: opt(f.weightKg),
          lengthCm: opt(f.lengthCm),
          widthCm: opt(f.widthCm),
          heightCm: opt(f.heightCm),
          domesticPriceJpy: opt(f.domesticPriceJpy),
          targetQuantity: f.targetQuantity ? Number(f.targetQuantity) : undefined,
          dutyPercent: opt(f.dutyPercent),
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      onDone();
    },
  });

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">基本情報</h3>
        <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
          <div className="space-y-1.5">
            <Label>プラットフォーム</Label>
            <Select value={f.platform} onChange={set("platform")}>
              {Object.entries(PLATFORM_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>商品 URL</Label>
            <Input required type="url" value={f.url} onChange={set("url")} placeholder="https://www.alibaba.com/product-detail/..." />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>商品名</Label>
          <Input required value={f.title} onChange={set("title")} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>業者名</Label>
            <Input required value={f.supplierName} onChange={set("supplierName")} />
          </div>
          <div className="space-y-1.5">
            <Label>業者 ID (任意)</Label>
            <Input value={f.supplierExternalId} onChange={set("supplierExternalId")} />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">価格</h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>通貨</Label>
            <Select value={f.currency} onChange={set("currency")}>
              {["USD", "CNY", "JPY", "EUR"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>MOQ</Label>
            <UnitInput unit="個" value={f.moq} onChange={set("moq")} required />
          </div>
        </div>
        <div className="space-y-2">
          <Label>段階単価</Label>
          {tiers.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <UnitInput className="w-32" unit="個〜" value={String(t.minQty)} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, minQty: Number(e.target.value) || 0 } : x)))} />
              <UnitInput className="flex-1" unit={f.currency} placeholder="単価" value={t.unitPrice} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} />
              <Button type="button" variant="ghost" size="icon-sm" aria-label="段階を削除" disabled={tiers.length === 1} onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setTiers([...tiers, { minQty: (tiers.at(-1)?.minQty ?? 1) * 10, unitPrice: "" }])}>
            <Plus className="h-4 w-4" /> 段階を追加
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">梱包・販売 (利益の自動計算に使用)</h3>
        <p className="text-xs text-muted-foreground">重量・寸法・国内販売価格を入れると、登録と同時に利益を自動計算します。送料や手数料は「設定 &gt; 利益計算」の既定値を使います。</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label>重量</Label>
            <UnitInput unit="kg" value={f.weightKg} onChange={set("weightKg")} />
          </div>
          <div className="space-y-1.5">
            <Label>縦</Label>
            <UnitInput unit="cm" value={f.lengthCm} onChange={set("lengthCm")} />
          </div>
          <div className="space-y-1.5">
            <Label>横</Label>
            <UnitInput unit="cm" value={f.widthCm} onChange={set("widthCm")} />
          </div>
          <div className="space-y-1.5">
            <Label>高さ</Label>
            <UnitInput unit="cm" value={f.heightCm} onChange={set("heightCm")} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>国内販売想定価格</Label>
            <UnitInput unit="円" value={f.domesticPriceJpy} onChange={set("domesticPriceJpy")} />
          </div>
          <div className="space-y-1.5">
            <Label>想定発注数量 (任意)</Label>
            <UnitInput unit="個" placeholder="MOQ" value={f.targetQuantity} onChange={set("targetQuantity")} />
          </div>
          <div className="space-y-1.5">
            <Label>関税率 (任意)</Label>
            <UnitInput unit="%" placeholder="既定値" value={f.dutyPercent} onChange={set("dutyPercent")} />
          </div>
        </div>
      </section>

      {create.error && <p className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{create.error.message}</p>}
      <div className="flex justify-end gap-2 border-t pt-4">
        <Button type="button" variant="outline" onClick={onDone}>
          キャンセル
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          登録する
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
function ProductDetail({ p, notice }: { p: Product; notice?: string | null }) {
  const history = p.snapshots.map((s) => ({ at: s.capturedAt, value: minPrice(s.priceTiers) })).filter((h) => Number.isFinite(h.value));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{PLATFORM_LABEL[p.platform]}</Badge>
        {p.inStock ? <Badge variant="success">在庫あり</Badge> : <Badge variant="destructive">在庫切れ</Badge>}
        {p.supplier.isBlacklisted && <Badge variant="destructive">ブラックリスト業者</Badge>}
        <FetchStatusBadge status={p.fetchStatus} />
        <span className="text-xs text-muted-foreground">更新 {relTime(p.updatedAt)}</span>
      </div>
      {notice && <p className="rounded-md bg-primary-soft px-3 py-2 text-sm text-primary">{notice}</p>}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <Button asChild className="h-11 sm:h-9">
          <Link href={`/calculator?productId=${p.id}`}>
            <Calculator className="h-4 w-4" /> 利益計算
          </Link>
        </Button>
        <Button variant="outline" asChild className="h-11 sm:h-9">
          <a href={p.url} target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4" /> 商品ページ
          </a>
        </Button>
      </div>

      <FetchStatusPanel p={p} />

      <Card>
        <CardHeader>
          <CardTitle>最安段階単価の推移 ({p.currency})</CardTitle>
        </CardHeader>
        <CardContent>
          <PriceHistoryChart points={history} currency={p.currency} />
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>段階単価</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-medium">数量</th>
                  <th className="pb-2 text-right font-medium">単価</th>
                </tr>
              </thead>
              <tbody className="tabular">
                {p.priceTiers.length === 0 && (
                  <tr className="border-t">
                    <td colSpan={2} className="py-3 text-center text-muted-foreground">
                      価格未取得 (「基本情報を入力」から登録できます)
                    </td>
                  </tr>
                )}
                {p.priceTiers.map((t) => (
                  <tr key={t.minQty} className="border-t">
                    <td className="py-1.5">{t.minQty.toLocaleString()} 個〜</td>
                    <td className="py-1.5 text-right font-medium">
                      {t.unitPrice} {p.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-muted-foreground">MOQ {p.moq.toLocaleString()} 個</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>商品データ</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">業者</dt>
              <dd className="break-all">{p.supplier.name}</dd>
              <dt className="text-muted-foreground">重量</dt>
              <dd className="tabular">{p.weightKg ? `${p.weightKg} kg` : "—"}</dd>
              <dt className="text-muted-foreground">寸法</dt>
              <dd className="tabular">{p.lengthCm ? `${p.lengthCm}×${p.widthCm}×${p.heightCm} cm` : "—"}</dd>
              <dt className="text-muted-foreground">国内価格</dt>
              <dd className="tabular">{p.domesticPriceJpy ? yenFmt(p.domesticPriceJpy) : "—"}</dd>
              <dt className="text-muted-foreground">HS コード</dt>
              <dd>{p.hsCode ?? "—"}</dd>
            </dl>
          </CardContent>
        </Card>
      </div>

      <AutoProfitPanel p={p} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
export default function ProductsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["products"], queryFn: () => api<Product[]>("/api/products") });
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState("ALL");
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter(
      (p) =>
        (platform === "ALL" || p.platform === platform) &&
        (!needle || [p.title, p.titleJa ?? "", p.supplier.name].some((s) => s.toLowerCase().includes(needle))),
    );
  }, [data, q, platform]);
  const current = data?.find((p) => p.id === selected);
  // 通知のリンク (/products?id=...) から開いた場合は詳細を表示
  // 共有画面から「手入力で追加」(/products?add=manual&url=...) で来た場合はフォームを開く
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get("id");
    if (id) setSelected(id);
    if (sp.get("add") === "manual") {
      setManualUrl(sp.get("url") ?? "");
      setAdding(true);
    }
  }, []);
  const onImported = (r: ImportResponse) => {
    setNotice(
      r.existed
        ? "この商品は登録済みです。"
        : r.fetch?.status === "OK"
          ? `登録しました${r.fetch.parsedFields.length ? ` (取得: ${fieldsLabel(r.fetch.parsedFields)})` : ""}`
          : "URL で登録しました。ページの情報は取得できなかったため、下から再取得・ソース貼り付け・手入力をしてください。",
    );
    setSelected(r.product.id);
  };
  const closeDetail = () => {
    setSelected(null);
    setNotice(null);
  };
  const qc = useQueryClient();
  const recalcAll = useMutation({
    mutationFn: () => api<{ total: number; SKIPPED: number }>("/api/profit/recalculate", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  return (
    <div>
      <PageHeader
        title="仕入れ候補"
        description="登録した商品の価格推移と最新の利益試算を一覧できます。"
        actions={
          <>
            <Button variant="outline" onClick={() => recalcAll.mutate()} disabled={recalcAll.isPending || !data?.length}>
              <RefreshCw className={cn("h-4 w-4", recalcAll.isPending && "animate-spin")} /> 全商品を再計算
            </Button>
            <Button variant="outline" onClick={() => setAdding(true)}>
              <PencilLine className="h-4 w-4" /> 手入力で追加
            </Button>
            {/* モバイルの下部タブには利益計算が無いため、ここから開けるようにする */}
            <Button variant="outline" asChild>
              <Link href="/calculator">
                <Calculator className="h-4 w-4" /> 利益計算
              </Link>
            </Button>
          </>
        }
      />

      <UrlImportCard onImported={onImported} />

      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="商品名・業者名で検索" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select className="sm:w-60" value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="プラットフォームで絞り込み">
          <option value="ALL">すべてのプラットフォーム</option>
          {Object.entries(PLATFORM_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {recalcAll.data && (
        <p className="mb-3 text-sm text-success">
          {recalcAll.data.total} 商品を再計算しました{recalcAll.data.SKIPPED > 0 && `(情報不足 ${recalcAll.data.SKIPPED} 件)`}
        </p>
      )}
      {recalcAll.error && <p className="mb-3 text-sm text-destructive">{recalcAll.error.message}</p>}
      {isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Package}
          title={data?.length ? "条件に一致する商品がありません" : "まだ商品が登録されていません"}
          action={
            !data?.length && (
              <Button variant="outline" onClick={() => setAdding(true)}>
                <PencilLine className="h-4 w-4" /> 手入力で追加
              </Button>
            )
          }
        >
          {!data?.length && "上の「URL から追加」に Alibaba.com・1688.com・AliExpress の商品 URL を貼り付けると、価格・業者を読み取って登録します。アプリの「共有」からも追加できます。"}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-card">
          <table className="w-full text-sm">
            <thead className="hidden border-b bg-muted/50 text-left text-xs text-muted-foreground md:table-header-group">
              <tr>
                <th className="px-4 py-2.5 font-medium">商品</th>
                <th className="px-4 py-2.5 text-right font-medium">最安単価</th>
                <th className="px-4 py-2.5 font-medium">推移</th>
                <th className="px-4 py-2.5 text-right font-medium">MOQ</th>
                <th className="px-4 py-2.5 text-right font-medium">ROI</th>
                <th className="px-4 py-2.5 font-medium">在庫</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((p) => {
                const sim = p.simulations[0];
                const spark = [...p.snapshots].reverse().map((s) => minPrice(s.priceTiers)).filter(Number.isFinite);
                return (
                  <tr key={p.id} className="cursor-pointer transition-colors hover:bg-accent/60" onClick={() => { setNotice(null); setSelected(p.id); }}>
                    <td className="px-4 py-3.5">
                      <p className="line-clamp-2 break-all font-medium md:line-clamp-1">{p.titleJa ?? p.title}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span>{PLATFORM_LABEL[p.platform]}</span>
                        <span aria-hidden>・</span>
                        <span>{p.supplier.name}</span>
                        {p.supplier.isBlacklisted && <Badge variant="destructive">ブラックリスト</Badge>}
                        <FetchStatusBadge status={p.fetchStatus} />
                        {p.fetchStatus !== "FAILED" && needsBasics(p) && <Badge variant="outline">要入力</Badge>}
                      </p>
                      <p className="mt-1 flex gap-3 text-xs md:hidden">
                        <span className="tabular">
                          {minPriceLabel(p.priceTiers)} {p.currency}〜
                        </span>
                        {sim ? <span className="tabular">ROI {sim.roiPercent}%</span> : p.autoCalcStatus === "SKIPPED" && <span className="text-warning-ink">利益: 情報不足</span>}
                        {!p.inStock && <span className="text-destructive">在庫切れ</span>}
                      </p>
                    </td>
                    <td className="tabular hidden px-4 py-3 text-right md:table-cell">
                      {minPriceLabel(p.priceTiers)} <span className="text-xs text-muted-foreground">{p.currency}</span>
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <Sparkline values={spark} />
                    </td>
                    <td className="tabular hidden px-4 py-3 text-right md:table-cell">{p.moq.toLocaleString()}</td>
                    <td className="tabular hidden px-4 py-3 text-right md:table-cell">
                      <AutoRoiCell status={p.autoCalcStatus} sim={sim} />
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      {p.inStock ? <Badge variant="success">あり</Badge> : <Badge variant="destructive">切れ</Badge>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Sheet open={!!current} onClose={closeDetail} title={<span className="line-clamp-1">{current?.titleJa ?? current?.title}</span>}>
        {current && <ProductDetail p={current} notice={notice} />}
      </Sheet>
      <Sheet open={adding} onClose={() => setAdding(false)} title="手入力で商品を追加">
        <NewProductForm key={manualUrl} initialUrl={manualUrl} onDone={() => setAdding(false)} />
      </Sheet>
    </div>
  );
}
