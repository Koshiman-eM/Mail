"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, ExternalLink, EyeOff, ImageOff, Loader2, PackagePlus, Pencil, Play, Plus, Settings, Telescope, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox, Input, Label, Select, UnitInput } from "@/components/ui/input";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { EmptyState, PageHeader, Sheet, Skeleton } from "@/components/ui/misc";
import { PLATFORM_LABEL, api, relTime, yenFmt } from "@/components/api";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* 型                                                                  */
/* ------------------------------------------------------------------ */
type SearchPlatform = "ALIBABA" | "ALIEXPRESS" | "ALI1688";
type Status = "AUTO_ADDED" | "ADDED" | "QUALIFIED" | "BELOW_THRESHOLD" | "NO_DOMESTIC_PRICE" | "DUPLICATE" | "DISMISSED" | "ERROR";

interface Watch {
  id: string;
  name: string;
  keywordJa: string;
  foreignKeywords: Partial<Record<SearchPlatform, string>>;
  autoKeywords: Partial<Record<SearchPlatform, { text: string }>> | null;
  platforms: SearchPlatform[];
  enabled: boolean;
  estWeightKg: string;
  estLengthCm: string | null;
  estWidthCm: string | null;
  estHeightCm: string | null;
  targetQuantity: number;
  minRoiPercent: string;
  minProfitJpy: string | null;
  maxMoq: number | null;
  maxUnitPriceJpy: string | null;
  autoAdd: boolean;
  maxAutoAddPerRun: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunNote: string | null;
  running: boolean;
  counts: Partial<Record<Status, number>>;
}

interface Evidence {
  providerLabel: string;
  keyword: string;
  fetchedAt: string;
  cached: boolean;
  sampleCount: number;
  usedCount: number;
  medianJpy: string | null;
  lowerQuartileJpy: string | null;
  adoptedJpy: string | null;
  samples: { title: string; priceJpy: string; url: string; shop?: string }[];
  aiFilter?: { before: number; after: number } | { error: string };
  notes: string[];
}

interface Item {
  id: string;
  watchId: string;
  watch: { name: string };
  platform: SearchPlatform;
  url: string;
  title: string;
  imageUrl: string | null;
  currency: string;
  unitPrice: string;
  moq: number;
  supplierName: string | null;
  domesticPriceJpy: string | null;
  domesticEvidence: Evidence | null;
  estProfitJpy: string | null;
  estRoiPercent: string | null;
  estimate: { quantity: number; unitPriceJpy: string; dimsAssumed: boolean; fxSource: string | null } | null;
  status: Status;
  statusNote: string | null;
  productId: string | null;
  lastSeenAt: string;
}

interface ProviderInfo {
  providers: { id: string; label: string; configured: boolean; note: string }[];
  translation: boolean;
}

const PLATFORMS: SearchPlatform[] = ["ALIBABA", "ALIEXPRESS", "ALI1688"];

const STATUS: Record<Status, { label: string; variant: BadgeVariant }> = {
  AUTO_ADDED: { label: "自動追加", variant: "success" },
  ADDED: { label: "追加済み", variant: "success" },
  QUALIFIED: { label: "条件達成", variant: "info" },
  BELOW_THRESHOLD: { label: "条件未達", variant: "secondary" },
  NO_DOMESTIC_PRICE: { label: "国内価格なし", variant: "warning" },
  DUPLICATE: { label: "登録済み", variant: "outline" },
  DISMISSED: { label: "除外", variant: "outline" },
  ERROR: { label: "エラー", variant: "destructive" },
};

const FILTERS: { key: string; label: string; statuses: Status[] }[] = [
  { key: "good", label: "条件達成", statuses: ["AUTO_ADDED", "ADDED", "QUALIFIED"] },
  { key: "all", label: "すべて", statuses: [] },
  { key: "below", label: "条件未達", statuses: ["BELOW_THRESHOLD"] },
  { key: "nodomestic", label: "国内価格なし", statuses: ["NO_DOMESTIC_PRICE"] },
  { key: "dup", label: "登録済み", statuses: ["DUPLICATE"] },
  { key: "error", label: "エラー", statuses: ["ERROR"] },
  { key: "dismissed", label: "除外", statuses: ["DISMISSED"] },
];

const RUN_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  RUNNING: { label: "探索中", variant: "info" },
  OK: { label: "完了", variant: "success" },
  PARTIAL: { label: "一部失敗", variant: "warning" },
  FAILED: { label: "失敗", variant: "destructive" },
  SKIPPED: { label: "未実行", variant: "outline" },
};

/* ------------------------------------------------------------------ */
/* 取得元の状態                                                        */
/* ------------------------------------------------------------------ */
function ProviderBanner() {
  const { data } = useQuery({ queryKey: ["discover-providers"], queryFn: () => api<ProviderInfo>("/api/discover/providers"), staleTime: 5 * 60_000 });
  if (!data) return null;
  const rakuten = data.providers.find((p) => p.id === "rakuten");
  const amazon = data.providers.find((p) => p.id === "amazon");
  return (
    <div className={cn("mb-5 rounded-xl border px-4 py-3 text-sm", rakuten?.configured ? "bg-card" : "border-warning/40 bg-warning-soft")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-medium">国内価格</span>
        <span className="inline-flex items-center gap-1.5">
          楽天市場 {rakuten?.configured ? <Badge variant="success">設定済み</Badge> : <Badge variant="warning">未設定</Badge>}
        </span>
        <span className="inline-flex items-center gap-1.5" title={amazon?.note}>
          Amazon <Badge variant="outline">未対応</Badge>
        </span>
        <span className="inline-flex items-center gap-1.5">
          翻訳 {data.translation ? <Badge variant="success">Claude</Badge> : <Badge variant="outline">未設定</Badge>}
        </span>
        <Link href="/settings?tab=scraper" className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline">
          <Settings className="h-3.5 w-3.5" /> 設定を確認
        </Link>
      </div>
      {!rakuten?.configured && (
        <p className="mt-1.5 text-xs leading-relaxed text-warning-ink">
          楽天 API が未設定のため国内価格を調べられません (探索結果は「国内価格なし」になります)。{rakuten?.note}
        </p>
      )}
      {!data.translation && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">Claude API が未設定のため、海外サイト用のキーワードを空欄にすると日本語のまま検索します。各サイトのキーワードを入力してください。</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 探索条件フォーム                                                    */
/* ------------------------------------------------------------------ */
type FormState = {
  name: string;
  keywordJa: string;
  kwALIBABA: string;
  kwALIEXPRESS: string;
  kwALI1688: string;
  platforms: SearchPlatform[];
  enabled: boolean;
  estWeightKg: string;
  estLengthCm: string;
  estWidthCm: string;
  estHeightCm: string;
  targetQuantity: string;
  minRoiPercent: string;
  minProfitJpy: string;
  maxMoq: string;
  maxUnitPriceJpy: string;
  autoAdd: boolean;
  maxAutoAddPerRun: string;
};

const toForm = (w?: Watch): FormState => ({
  name: w?.name ?? "",
  keywordJa: w?.keywordJa ?? "",
  kwALIBABA: w?.foreignKeywords.ALIBABA ?? "",
  kwALIEXPRESS: w?.foreignKeywords.ALIEXPRESS ?? "",
  kwALI1688: w?.foreignKeywords.ALI1688 ?? "",
  platforms: w?.platforms ?? [...PLATFORMS],
  enabled: w?.enabled ?? true,
  estWeightKg: w?.estWeightKg ?? "",
  estLengthCm: w?.estLengthCm ?? "",
  estWidthCm: w?.estWidthCm ?? "",
  estHeightCm: w?.estHeightCm ?? "",
  targetQuantity: String(w?.targetQuantity ?? 50),
  minRoiPercent: w?.minRoiPercent ?? "30",
  minProfitJpy: w?.minProfitJpy ?? "",
  maxMoq: w?.maxMoq ? String(w.maxMoq) : "",
  maxUnitPriceJpy: w?.maxUnitPriceJpy ?? "",
  autoAdd: w?.autoAdd ?? true,
  maxAutoAddPerRun: String(w?.maxAutoAddPerRun ?? 5),
});

const intOrEmpty = (v: string) => (v.trim() === "" ? "" : Number(v));

function WatchForm({ watch, onDone }: { watch?: Watch; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<FormState>(() => toForm(watch));
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name,
        keywordJa: f.keywordJa,
        foreignKeywords: { ALIBABA: f.kwALIBABA, ALIEXPRESS: f.kwALIEXPRESS, ALI1688: f.kwALI1688 },
        platforms: f.platforms,
        enabled: f.enabled,
        estWeightKg: f.estWeightKg,
        estLengthCm: f.estLengthCm,
        estWidthCm: f.estWidthCm,
        estHeightCm: f.estHeightCm,
        targetQuantity: Number(f.targetQuantity || 1),
        minRoiPercent: f.minRoiPercent,
        minProfitJpy: f.minProfitJpy,
        maxMoq: intOrEmpty(f.maxMoq),
        maxUnitPriceJpy: f.maxUnitPriceJpy,
        autoAdd: f.autoAdd,
        maxAutoAddPerRun: Number(f.maxAutoAddPerRun || 0),
      };
      return watch ? api(`/api/discover/watches/${watch.id}`, { method: "PATCH", json: body }) : api("/api/discover/watches", { method: "POST", json: body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["discover-watches"] });
      onDone();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/discover/watches/${watch!.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["discover-watches"] });
      qc.invalidateQueries({ queryKey: ["discover-items"] });
      onDone();
    },
  });
  const togglePlatform = (p: SearchPlatform) => setF({ ...f, platforms: f.platforms.includes(p) ? f.platforms.filter((x) => x !== p) : [...f.platforms, p] });

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">検索条件</h3>
        <div className="space-y-1.5">
          <Label htmlFor="w-name">名前</Label>
          <Input id="w-name" required maxLength={60} value={f.name} onChange={set("name")} placeholder="例: シリコンヘラ" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="w-kw">国内検索キーワード (日本語)</Label>
          <Input id="w-kw" required maxLength={100} value={f.keywordJa} onChange={set("keywordJa")} placeholder="例: シリコン ヘラ 耐熱" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">楽天市場の相場を調べるキーワードです。海外サイト用が空欄ならこれを翻訳して検索します。</p>
        </div>
        <div className="space-y-2">
          <Label>検索するサイト</Label>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {PLATFORMS.map((p) => (
              <Checkbox key={p} label={PLATFORM_LABEL[p]} checked={f.platforms.includes(p)} onChange={() => togglePlatform(p)} />
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {PLATFORMS.map((p) => (
            <div key={p} className="min-w-0 space-y-1.5">
              <Label htmlFor={`w-kw-${p}`}>{PLATFORM_LABEL[p]} 用 ({p === "ALI1688" ? "中国語" : "英語"})</Label>
              <Input
                id={`w-kw-${p}`}
                maxLength={100}
                value={f[`kw${p}` as keyof FormState] as string}
                onChange={set(`kw${p}` as keyof FormState)}
                placeholder={watch?.autoKeywords?.[p]?.text ?? "空欄なら自動翻訳"}
                disabled={!f.platforms.includes(p)}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">試算の前提 (1 個あたり)</h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="w-wt">重量 (必須)</Label>
            <UnitInput id="w-wt" unit="kg" required value={f.estWeightKg} onChange={set("estWeightKg")} placeholder="0.2" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="w-qty">想定発注数量</Label>
            <UnitInput id="w-qty" unit="個" inputMode="numeric" value={f.targetQuantity} onChange={set("targetQuantity")} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {(["estLengthCm", "estWidthCm", "estHeightCm"] as const).map((k, i) => (
            <div key={k} className="min-w-0 space-y-1.5">
              <Label htmlFor={`w-${k}`}>{["縦", "横", "高さ"][i]}</Label>
              <UnitInput id={`w-${k}`} unit="cm" value={f[k]} onChange={set(k)} />
            </div>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          寸法を空欄にすると実重量のみで送料を試算します (追加された仕入れ候補では寸法を入力するまで利益の自動計算が「情報不足」になります)。数量は「想定発注数量」と MOQ の大きい方で、その数量の段階単価を使います。送料・手数料などは設定画面の利益計算の既定値を使います。
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">自動追加の条件</h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="w-roi">最低 ROI</Label>
            <UnitInput id="w-roi" unit="%" required value={f.minRoiPercent} onChange={set("minRoiPercent")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="w-profit">最低利益 (任意)</Label>
            <UnitInput id="w-profit" unit="円" value={f.minProfitJpy} onChange={set("minProfitJpy")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="w-moq">MOQ 上限 (任意)</Label>
            <UnitInput id="w-moq" unit="個" inputMode="numeric" value={f.maxMoq} onChange={set("maxMoq")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="w-unit">仕入単価の上限 (任意)</Label>
            <UnitInput id="w-unit" unit="円" value={f.maxUnitPriceJpy} onChange={set("maxUnitPriceJpy")} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <Checkbox label="条件を満たす商品を自動で仕入れ候補に追加" checked={f.autoAdd} onChange={(e) => setF({ ...f, autoAdd: e.target.checked })} />
          <div className="flex items-center gap-2">
            <Label htmlFor="w-max" className="whitespace-nowrap">
              1 回の上限
            </Label>
            <UnitInput id="w-max" unit="件" inputMode="numeric" className="w-24" value={f.maxAutoAddPerRun} onChange={set("maxAutoAddPerRun")} disabled={!f.autoAdd} />
          </div>
        </div>
        <Checkbox label="定期実行 (4 時間ごと) に含める" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
      </section>

      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
      {remove.error && <p className="text-sm text-destructive">{remove.error.message}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {watch ? "保存する" : "追加する"}
        </Button>
        {watch && (
          <Button
            type="button"
            variant="ghost"
            className="ml-auto text-destructive"
            disabled={remove.isPending}
            onClick={() => confirm(`「${watch.name}」と探索結果を削除しますか? (追加済みの仕入れ候補は残ります)`) && remove.mutate()}
          >
            <Trash2 className="h-4 w-4" /> 削除
          </Button>
        )}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* 探索条件カード                                                      */
/* ------------------------------------------------------------------ */
function thresholdsLabel(w: Watch): string {
  const parts = [`ROI ≥ ${Number(w.minRoiPercent)}%`];
  if (w.minProfitJpy) parts.push(`利益 ≥ ${yenFmt(w.minProfitJpy)}`);
  if (w.maxMoq) parts.push(`MOQ ≤ ${w.maxMoq.toLocaleString()}`);
  if (w.maxUnitPriceJpy) parts.push(`単価 ≤ ${yenFmt(w.maxUnitPriceJpy)}`);
  return parts.join(" ・ ");
}

function WatchCard({ w, onEdit }: { w: Watch; onEdit: () => void }) {
  const qc = useQueryClient();
  const [showNote, setShowNote] = useState(false);
  const run = useMutation({
    mutationFn: () => api(`/api/discover/watches/${w.id}/run`, { method: "POST" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["discover-watches"] }),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api(`/api/discover/watches/${w.id}`, { method: "PATCH", json: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["discover-watches"] }),
  });
  const rs = w.running ? RUN_STATUS.RUNNING : w.lastRunStatus ? RUN_STATUS[w.lastRunStatus] : null;
  const good = (w.counts.AUTO_ADDED ?? 0) + (w.counts.ADDED ?? 0) + (w.counts.QUALIFIED ?? 0);
  return (
    <Card className={cn("flex min-w-0 flex-col", !w.enabled && "opacity-80")}>
      <CardHeader className="pb-2">
        <div className="flex items-start gap-2">
          <CardTitle className="min-w-0 flex-1">
            <span className="break-all">{w.name}</span>
          </CardTitle>
          <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`${w.name} を編集`}>
            <Pencil className="h-4 w-4" />
          </Button>
        </div>
        <p className="break-all text-xs text-muted-foreground">「{w.keywordJa}」</p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 text-sm">
        <div className="flex flex-wrap gap-1.5">
          {w.platforms.map((p) => (
            <Badge key={p} variant="outline">
              {PLATFORM_LABEL[p]}
            </Badge>
          ))}
          {w.autoAdd ? <Badge variant="info">自動追加 {w.maxAutoAddPerRun} 件まで</Badge> : <Badge variant="secondary">自動追加オフ</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">{thresholdsLabel(w)}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <span className="text-success">条件達成 {good}</span>
          <span className="text-muted-foreground">未達 {w.counts.BELOW_THRESHOLD ?? 0}</span>
          <span className="text-muted-foreground">国内価格なし {w.counts.NO_DOMESTIC_PRICE ?? 0}</span>
          {(w.counts.ERROR ?? 0) > 0 && <span className="text-destructive">エラー {w.counts.ERROR}</span>}
        </div>
        <div className="text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <span>最終実行 {w.lastRunAt ? relTime(w.lastRunAt) : "なし"}</span>
            {rs && <Badge variant={rs.variant}>{w.running && <Loader2 className="h-3 w-3 animate-spin" />}{rs.label}</Badge>}
            {w.lastRunNote && !w.running && (
              <button type="button" className="text-primary hover:underline" onClick={() => setShowNote((s) => !s)} aria-expanded={showNote}>
                {showNote ? "詳細を閉じる" : "詳細"}
              </button>
            )}
          </div>
          {showNote && w.lastRunNote && <p className="mt-1.5 whitespace-pre-line break-all rounded-md bg-muted px-2.5 py-2 leading-relaxed">{w.lastRunNote}</p>}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending || w.running}>
            {run.isPending || w.running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} 今すぐ探索
          </Button>
          <Checkbox className="ml-auto text-xs" label="定期実行" checked={w.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
        </div>
        {run.error && <p className="text-xs text-destructive">{run.error.message}</p>}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 探索結果                                                            */
/* ------------------------------------------------------------------ */
function Thumb({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken)
    return (
      <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <ImageOff className="h-5 w-5" />
      </span>
    );
  // 外部 (海外サイトの CDN) の画像。リファラーは送らない
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="h-16 w-16 shrink-0 rounded-lg border bg-muted object-cover" />;
}

function EvidenceDetails({ e }: { e: Evidence }) {
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-primary">根拠 ({e.providerLabel} {e.sampleCount} 件中 {e.usedCount} 件)</summary>
      <div className="mt-1.5 space-y-1.5 rounded-md bg-muted px-2.5 py-2 leading-relaxed text-muted-foreground">
        <p>
          キーワード「{e.keyword}」・{e.cached ? "キャッシュ " : ""}
          {relTime(e.fetchedAt)}取得
        </p>
        {e.adoptedJpy && (
          <p>
            採用 {yenFmt(e.adoptedJpy)} (下位 25% 点) ・ 中央値 {e.medianJpy ? yenFmt(e.medianJpy) : "—"}
          </p>
        )}
        {e.aiFilter && "after" in e.aiFilter && <p>AI で無関係な販売例を除外: {e.aiFilter.before} → {e.aiFilter.after} 件</p>}
        <ul className="space-y-1">
          {e.samples.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="tabular shrink-0 text-foreground">{yenFmt(s.priceJpy)}</span>
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="min-w-0 break-all hover:underline">
                {s.title.slice(0, 80)}
                {s.shop && <span className="text-muted-foreground"> ({s.shop})</span>}
              </a>
            </li>
          ))}
        </ul>
        {e.notes.map((n, i) => (
          <p key={i} className="text-warning-ink">
            {n}
          </p>
        ))}
      </div>
    </details>
  );
}

function ItemRow({ it }: { it: Item }) {
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (action: "add" | "dismiss") => api(`/api/discover/items/${it.id}/${action}`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["discover-items"] });
      qc.invalidateQueries({ queryKey: ["discover-watches"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const st = STATUS[it.status];
  const roi = it.estRoiPercent !== null ? Number(it.estRoiPercent) : null;
  const added = it.status === "ADDED" || it.status === "AUTO_ADDED";
  const hasPrice = Number(it.unitPrice) > 0;
  return (
    <li className="flex gap-3 px-4 py-3.5">
      <Thumb src={it.imageUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={st.variant}>{st.label}</Badge>
          {roi !== null && <Badge variant={roi < 0 ? "destructive" : roi >= 30 ? "success" : "secondary"}>ROI {it.estRoiPercent}%</Badge>}
          {it.estProfitJpy !== null && <span className="tabular text-xs font-medium">利益 {yenFmt(it.estProfitJpy)}</span>}
        </div>
        <p className="mt-1 line-clamp-2 break-all text-sm font-medium">{it.title}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>{PLATFORM_LABEL[it.platform]}</span>
          {it.supplierName && <span className="break-all">{it.supplierName}</span>}
          <span>{it.watch.name}</span>
        </p>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-muted-foreground">海外</dt>
          <dd className="tabular min-w-0">
            {hasPrice ? (
              <>
                {it.unitPrice} {it.currency}〜{it.estimate && <> → {yenFmt(it.estimate.unitPriceJpy)}</>} ・ MOQ {it.moq.toLocaleString()}
                {it.estimate && <span className="text-muted-foreground"> ・ 試算 {it.estimate.quantity.toLocaleString()} 個</span>}
              </>
            ) : (
              "—"
            )}
          </dd>
          <dt className="text-muted-foreground">国内</dt>
          <dd className="tabular min-w-0">{it.domesticPriceJpy ? yenFmt(it.domesticPriceJpy) : "—"}</dd>
        </dl>
        {it.domesticEvidence && it.domesticEvidence.sampleCount > 0 && <EvidenceDetails e={it.domesticEvidence} />}
        {it.statusNote && <p className="mt-1 break-all text-xs leading-relaxed text-muted-foreground">{it.statusNote}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!added && it.status !== "DISMISSED" && hasPrice && (
            <Button size="sm" onClick={() => act.mutate("add")} disabled={act.isPending}>
              {act.isPending && act.variables === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />} 追加
            </Button>
          )}
          {!added && it.status !== "DISMISSED" && (
            <Button size="sm" variant="outline" onClick={() => act.mutate("dismiss")} disabled={act.isPending}>
              <EyeOff className="h-4 w-4" /> 除外
            </Button>
          )}
          {it.productId && (
            <Button size="sm" variant="soft" asChild>
              <Link href={`/products?id=${it.productId}`}>仕入れ候補を見る</Link>
            </Button>
          )}
          <Button size="sm" variant="ghost" asChild>
            <a href={it.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" /> 開く
            </a>
          </Button>
        </div>
        {act.error && <p className="mt-1 text-xs text-destructive">{act.error.message}</p>}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
export default function DiscoverPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Watch | "new" | null>(null);
  const [filter, setFilter] = useState("good");
  const [watchFilter, setWatchFilter] = useState("ALL");

  const watches = useQuery({
    queryKey: ["discover-watches"],
    queryFn: () => api<Watch[]>("/api/discover/watches"),
    refetchInterval: (q) => (q.state.data?.some((w) => w.running) ? 4000 : false),
  });
  const anyRunning = !!watches.data?.some((w) => w.running);

  // 探索が終わったら結果を読み直す
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !anyRunning) qc.invalidateQueries({ queryKey: ["discover-items"] });
    wasRunning.current = anyRunning;
  }, [anyRunning, qc]);

  const statuses = FILTERS.find((x) => x.key === filter)!.statuses;
  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (filter === "all") sp.set("status", FILTERS.flatMap((x) => x.statuses).filter((s) => s !== "DISMISSED").join(","));
    else sp.set("status", statuses.join(","));
    if (watchFilter !== "ALL") sp.set("watchId", watchFilter);
    return sp.toString();
  }, [filter, statuses, watchFilter]);
  const items = useQuery({
    queryKey: ["discover-items", params],
    queryFn: () => api<Item[]>(`/api/discover/items?${params}`),
    refetchInterval: anyRunning ? 8000 : false,
  });

  return (
    <div>
      <PageHeader
        title="自動探索"
        description="検索条件を登録すると、海外サイトの検索結果と国内の相場から利益を試算し、条件を満たす商品を仕入れ候補に自動で追加します (4 時間ごと)。"
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> 条件を追加
          </Button>
        }
      />

      <ProviderBanner />

      {watches.error && <p className="mb-3 text-sm text-destructive">{watches.error.message}</p>}
      {watches.isLoading ? (
        <Skeleton className="mb-8 h-48 rounded-xl" />
      ) : !watches.data?.length ? (
        <div className="mb-8">
          <EmptyState
            icon={Telescope}
            title="探索条件がまだありません"
            action={
              <Button variant="outline" onClick={() => setEditing("new")}>
                <Plus className="h-4 w-4" /> 条件を追加
              </Button>
            }
          >
            ジャンルや商品名のキーワード、想定重量、自動追加する ROI などを登録してください。
          </EmptyState>
        </div>
      ) : (
        <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {watches.data.map((w) => (
            <WatchCard key={w.id} w={w} onEdit={() => setEditing(w)} />
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="gap-3">
          <CardTitle>探索結果</CardTitle>
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="ステータスで絞り込み">
            {FILTERS.map((x) => (
              <button
                key={x.key}
                role="tab"
                aria-selected={filter === x.key}
                onClick={() => setFilter(x.key)}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  filter === x.key ? "border-primary bg-primary-soft text-primary" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {x.label}
              </button>
            ))}
          </div>
          {(watches.data?.length ?? 0) > 1 && (
            <Select className="sm:w-64" value={watchFilter} onChange={(e) => setWatchFilter(e.target.value)} aria-label="探索条件で絞り込み">
              <option value="ALL">すべての探索条件</option>
              {watches.data!.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
        </CardHeader>
        <div className="border-t">
          {items.error && <p className="px-4 py-3 text-sm text-destructive">{items.error.message}</p>}
          {items.isLoading ? (
            <Skeleton className="m-4 h-32" />
          ) : !items.data?.length ? (
            <p className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
              <CircleAlert className="h-4 w-4 shrink-0" /> 該当する探索結果はありません。
            </p>
          ) : (
            <ul className="divide-y">
              {items.data.map((it) => (
                <ItemRow key={it.id} it={it} />
              ))}
            </ul>
          )}
        </div>
      </Card>

      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
        海外サイトの検索結果は CAPTCHA やページ構造の変更で取得できないことがあります (自動突破はしません。検知すると巡回を停止し通知します)。試算は検索結果の価格と登録した前提値によるもので、商品ページの段階単価は追加後の巡回で取得します。
      </p>

      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "探索条件を追加" : "探索条件を編集"}>
        {editing !== null && <WatchForm key={editing === "new" ? "new" : editing.id} watch={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} />}
      </Sheet>
    </div>
  );
}
