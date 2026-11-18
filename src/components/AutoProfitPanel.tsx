"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Calculator, Check, Loader2, RefreshCw, Save, Sparkles } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Label, UnitInput } from "./ui/input";
import { Badge } from "./ui/badge";
import { CostBreakdownBar } from "./charts";
import { api, relTime, yenFmt } from "./api";
import { cn } from "@/lib/utils";

export interface AutoSim {
  profitJpy: string;
  roiPercent: string;
  quantity: number;
  createdAt: string;
  auto: boolean;
  trigger: string | null;
  unitProfitJpy: string;
  marginPercent: string;
  totalCostJpy: string;
  revenueJpy: string;
  fxRateApplied: string;
  breakdown: Record<string, string | unknown>;
}

export interface AutoProductFields {
  id: string;
  currency: string;
  moq: number;
  targetQuantity: number | null;
  dutyPercent: string | null;
  domesticPriceJpy: string | null;
  weightKg: string | null;
  lengthCm: string | null;
  widthCm: string | null;
  heightCm: string | null;
  autoCalcStatus: string | null;
  autoCalcNote: string | null;
  autoCalcAt: string | null;
  simulations: AutoSim[];
}

export const TRIGGER_LABEL: Record<string, string> = {
  "product.create": "商品登録",
  "product.update": "商品情報の変更",
  "price.change": "価格の変化",
  "fx.refresh": "定期再計算 (為替)",
  "settings.change": "既定値の変更",
  manual: "手動の再計算",
};

const n = (v: unknown) => Number(v ?? 0);

/** 商品詳細: 自動計算の結果と、計算に使う商品ごとの値の編集 */
export function AutoProfitPanel({ p }: { p: AutoProductFields }) {
  const qc = useQueryClient();
  const sim = p.simulations[0];
  const [f, setF] = useState({ targetQuantity: "", dutyPercent: "", domesticPriceJpy: "", weightKg: "", lengthCm: "", widthCm: "", heightCm: "" });
  useEffect(() => {
    setF({
      targetQuantity: p.targetQuantity ? String(p.targetQuantity) : "",
      dutyPercent: p.dutyPercent ?? "",
      domesticPriceJpy: p.domesticPriceJpy ?? "",
      weightKg: p.weightKg ?? "",
      lengthCm: p.lengthCm ?? "",
      widthCm: p.widthCm ?? "",
      heightCm: p.heightCm ?? "",
    });
  }, [p]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["products"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const opt = (v: string) => (v.trim() ? v.trim() : null);
  const save = useMutation({
    mutationFn: () =>
      api(`/api/products/${p.id}`, {
        method: "PATCH",
        json: {
          targetQuantity: f.targetQuantity ? Number(f.targetQuantity) : null,
          dutyPercent: opt(f.dutyPercent),
          domesticPriceJpy: opt(f.domesticPriceJpy),
          weightKg: opt(f.weightKg),
          lengthCm: opt(f.lengthCm),
          widthCm: opt(f.widthCm),
          heightCm: opt(f.heightCm),
        },
      }),
    onSuccess: refresh,
  });
  const recalc = useMutation({ mutationFn: () => api(`/api/products/${p.id}/recalculate`, { method: "POST" }), onSuccess: refresh });

  const b = sim?.breakdown ?? {};
  const segments = [
    { key: "goods", label: "商品代金", value: n(b.goodsJpy) },
    { key: "sourcing", label: "現地送料・代行手数料", value: n(b.localShippingJpy) + n(b.agentFeeJpy) + n(b.otherCostsJpy) },
    { key: "intl", label: "国際送料", value: n(b.internationalShippingJpy) },
    { key: "tax", label: "関税・輸入消費税・通関", value: n(b.customsDutyJpy) + n(b.importConsumptionTaxJpy) + n(b.customsClearanceFeeJpy) },
    { key: "selling", label: "販売手数料・国内送料", value: n(b.platformFeesJpy) + n(b.domesticShippingJpy) },
  ];
  const skipped = p.autoCalcStatus === "SKIPPED" || p.autoCalcStatus === "ERROR";
  const profit = sim ? n(sim.profitJpy) : 0;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>
            <Sparkles className="h-4 w-4 text-primary" /> 自動利益計算
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {p.autoCalcAt ? `最終計算 ${relTime(p.autoCalcAt)}` : "未計算"}
            {sim?.trigger && ` ・ きっかけ: ${TRIGGER_LABEL[sim.trigger] ?? sim.trigger}`}
            {p.autoCalcNote && !skipped && ` ・ ${p.autoCalcNote}`}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => recalc.mutate()} disabled={recalc.isPending}>
          <RefreshCw className={cn("h-4 w-4", recalc.isPending && "animate-spin")} /> 再計算
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {skipped && (
          <p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning-ink">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {p.autoCalcStatus === "ERROR" ? "計算できませんでした" : "自動計算に必要な情報が足りません"}: {p.autoCalcNote}
            </span>
          </p>
        )}

        {sim && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["見込み利益", yenFmt(sim.profitJpy), profit < 0],
                ["ROI", `${sim.roiPercent}%`, profit < 0],
                ["1個あたり", yenFmt(sim.unitProfitJpy), profit < 0],
                ["数量", `${sim.quantity.toLocaleString()} 個`, false],
              ].map(([k, v, neg]) => (
                <div key={k as string} className="rounded-lg bg-muted p-3">
                  <p className="text-[11px] text-muted-foreground">{k}</p>
                  <p className={cn("tabular mt-0.5 font-bold", neg && "text-destructive")}>{v}</p>
                </div>
              ))}
            </div>
            {sim.auto ? (
              <CostBreakdownBar segments={segments} total={n(sim.totalCostJpy)} />
            ) : (
              <p className="text-xs text-muted-foreground">最新の結果は利益計算画面から手動で保存されたものです。</p>
            )}
          </>
        )}

        <form
          className="space-y-3 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <p className="text-sm font-semibold">この商品の計算条件</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>想定発注数量</Label>
              <UnitInput unit="個" placeholder={`MOQ (${p.moq})`} value={f.targetQuantity} onChange={(e) => setF({ ...f, targetQuantity: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>関税率</Label>
              <UnitInput unit="%" placeholder="既定値" value={f.dutyPercent} onChange={(e) => setF({ ...f, dutyPercent: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>国内販売価格 (1個)</Label>
              <UnitInput unit="円" value={f.domesticPriceJpy} onChange={(e) => setF({ ...f, domesticPriceJpy: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>重量 (1個)</Label>
              <UnitInput unit="kg" value={f.weightKg} onChange={(e) => setF({ ...f, weightKg: e.target.value })} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>梱包寸法 (縦 × 横 × 高さ)</Label>
              <div className="grid grid-cols-3 gap-2">
                <UnitInput unit="cm" value={f.lengthCm} onChange={(e) => setF({ ...f, lengthCm: e.target.value })} aria-label="縦" />
                <UnitInput unit="cm" value={f.widthCm} onChange={(e) => setF({ ...f, widthCm: e.target.value })} aria-label="横" />
                <UnitInput unit="cm" value={f.heightCm} onChange={(e) => setF({ ...f, heightCm: e.target.value })} aria-label="高さ" />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={save.isPending}>
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : save.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
              保存して再計算
            </Button>
            <Button type="button" size="sm" variant="ghost" asChild>
              <Link href={`/calculator?productId=${p.id}`}>
                <Calculator className="h-4 w-4" /> 条件を変えて試算
              </Link>
            </Button>
            <Link href="/settings" className="ml-auto text-xs text-primary hover:underline">
              既定値 (送料・手数料など) を変更
            </Link>
          </div>
          {save.error && <p className="text-xs text-destructive">{save.error.message}</p>}
          {recalc.error && <p className="text-xs text-destructive">{recalc.error.message}</p>}
        </form>
      </CardContent>
    </Card>
  );
}

/** 一覧用: 自動計算の状態を短く表示 */
export function AutoRoiCell({ status, sim }: { status: string | null; sim?: AutoSim }) {
  if (sim) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className={cn("tabular font-semibold", n(sim.roiPercent) < 0 && "text-destructive")}>{sim.roiPercent}%</span>
        {sim.auto && <Badge variant="outline">自動</Badge>}
      </span>
    );
  }
  if (status === "SKIPPED") return <Badge variant="warning">情報不足</Badge>;
  if (status === "ERROR") return <Badge variant="destructive">計算エラー</Badge>;
  return <span className="text-muted-foreground">—</span>;
}
