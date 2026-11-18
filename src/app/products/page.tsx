"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api, yenFmt } from "@/components/api";
import type { PriceTier } from "@/lib/profit/types";

interface Product {
  id: string;
  platform: string;
  url: string;
  title: string;
  currency: string;
  moq: number;
  priceTiers: PriceTier[];
  inStock: boolean;
  supplier: { name: string; isBlacklisted: boolean };
  simulations: { profitJpy: string; roiPercent: string; quantity: number }[];
}

const EMPTY = {
  platform: "ALIBABA",
  url: "",
  externalId: "",
  title: "",
  currency: "USD",
  moq: "1",
  tiers: "1:3.00, 100:2.50",
  supplierExternalId: "",
  supplierName: "",
  weightKg: "",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  domesticPriceJpy: "",
};

function parseTiers(s: string): PriceTier[] {
  return s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [q, p] = x.split(":").map((y) => y.trim());
      return { minQty: Number(q), unitPrice: p };
    });
}

export default function ProductsPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const [showForm, setShowForm] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: ["products"], queryFn: () => api<Product[]>("/api/products") });

  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  const create = useMutation({
    mutationFn: () =>
      api("/api/products", {
        method: "POST",
        json: {
          platform: form.platform,
          url: form.url,
          externalId: form.externalId || form.url,
          title: form.title,
          currency: form.currency.toUpperCase(),
          moq: Number(form.moq),
          priceTiers: parseTiers(form.tiers),
          supplier: { externalId: form.supplierExternalId || form.supplierName, name: form.supplierName },
          weightKg: opt(form.weightKg),
          lengthCm: opt(form.lengthCm),
          widthCm: opt(form.widthCm),
          heightCm: opt(form.heightCm),
          domesticPriceJpy: opt(form.domesticPriceJpy),
        },
      }),
    onSuccess: () => {
      setForm(EMPTY);
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
  const scrape = useMutation({ mutationFn: (id: string) => api(`/api/products/${id}/scrape`, { method: "POST" }) });

  const F = (k: keyof typeof EMPTY, label: string, placeholder?: string) => (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input value={form[k]} placeholder={placeholder} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">仕入れ候補商品</h1>
        <Button onClick={() => setShowForm((s) => !s)}>{showForm ? "閉じる" : "商品を追加"}</Button>
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">商品を追加</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>プラットフォーム</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
                <option value="ALIBABA">Alibaba.com</option>
                <option value="ALI1688">1688.com</option>
                <option value="ALIEXPRESS">AliExpress</option>
                <option value="OTHER">その他</option>
              </select>
            </div>
            {F("url", "商品URL", "https://www.alibaba.com/product-detail/...")}
            {F("title", "商品名")}
            {F("externalId", "商品ID (任意)")}
            {F("supplierName", "業者名")}
            {F("supplierExternalId", "業者ID (任意)")}
            {F("currency", "通貨")}
            {F("moq", "MOQ")}
            <div className="space-y-1 sm:col-span-2">
              <Label>段階単価 (数量:単価 をカンマ区切り)</Label>
              <Input value={form.tiers} onChange={(e) => setForm({ ...form, tiers: e.target.value })} />
            </div>
            {F("weightKg", "1個あたり重量 (kg)")}
            {F("domesticPriceJpy", "国内販売想定価格 (円)")}
            {F("lengthCm", "縦 (cm)")}
            {F("widthCm", "横 (cm)")}
            {F("heightCm", "高さ (cm)")}
            <div className="flex items-end">
              <Button className="w-full" onClick={() => create.mutate()} disabled={create.isPending}>
                登録
              </Button>
            </div>
            {create.error && <p className="text-sm text-destructive sm:col-span-2">{create.error.message}</p>}
          </CardContent>
        </Card>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {data?.length === 0 && <p className="text-sm text-muted-foreground">まだ商品が登録されていません。</p>}

      <div className="grid gap-3">
        {data?.map((p) => {
          const sim = p.simulations[0];
          return (
            <Card key={p.id}>
              <CardContent className="flex flex-col gap-2 pt-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{p.platform}</Badge>
                    {!p.inStock && <Badge variant="destructive">在庫切れ</Badge>}
                    {p.supplier.isBlacklisted && <Badge variant="destructive">ブラックリスト業者</Badge>}
                  </div>
                  <a href={p.url} target="_blank" rel="noreferrer" className="mt-1 block truncate font-medium hover:underline">
                    {p.title}
                  </a>
                  <p className="text-xs text-muted-foreground">
                    {p.supplier.name} / MOQ {p.moq} / {p.priceTiers.map((t) => `${t.minQty}+: ${t.unitPrice} ${p.currency}`).join("  ")}
                  </p>
                  {sim && (
                    <p className="text-xs">
                      最新試算: {sim.quantity}個で利益 {yenFmt(sim.profitJpy)} (ROI {sim.roiPercent}%)
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/calculator?productId=${p.id}`}>利益計算</Link>
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => scrape.mutate(p.id)} disabled={scrape.isPending || p.platform === "OTHER"}>
                    価格を再取得
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      {scrape.error && <p className="text-sm text-destructive">{scrape.error.message}</p>}
      {scrape.isSuccess && <p className="text-sm text-emerald-700">取得ジョブを登録しました。結果は通知でお知らせします。</p>}
    </div>
  );
}
