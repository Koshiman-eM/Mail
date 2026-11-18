"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api, yenFmt } from "@/components/api";
import type { PriceTier, ProfitInput, ProfitResult } from "@/lib/profit/types";

interface ProductLite {
  id: string;
  title: string;
  currency: string;
  moq: number;
  priceTiers: PriceTier[];
  lengthCm: string | null;
  widthCm: string | null;
  heightCm: string | null;
  weightKg: string | null;
  domesticPriceJpy: string | null;
}

const DEFAULTS = {
  quantity: "300",
  moq: "100",
  currency: "USD",
  fxRate: "150",
  fxBuffer: "3",
  localShipping: "10",
  agentPercent: "5",
  agentFixed: "0",
  unitWeight: "0.2",
  len: "20",
  wid: "10",
  hei: "10",
  divisor: "5000" as "5000" | "6000",
  ratePerKg: "800",
  minCharge: "0",
  fuel: "0",
  step: "0.5",
  duty: "5",
  consumptionTax: "10",
  clearance: "3000",
  jpRounding: true,
  sellPrice: "2000",
  feePercent: "10",
  fixedFee: "0",
  domesticShip: "200",
  other: "0",
};
type Form = typeof DEFAULTS;

const BREAKDOWN_LABELS: Record<keyof ProfitResult["breakdown"], string> = {
  goodsJpy: "商品代金",
  localShippingJpy: "現地国内送料",
  agentFeeJpy: "代行手数料",
  internationalShippingJpy: "国際送料",
  customsValueJpy: "(課税価格 CIF)",
  customsDutyJpy: "関税",
  importConsumptionTaxJpy: "輸入消費税",
  customsClearanceFeeJpy: "通関手数料",
  platformFeesJpy: "販売手数料",
  domesticShippingJpy: "国内送料",
  otherCostsJpy: "その他経費",
};

function toInput(f: Form, tiers: PriceTier[]): ProfitInput {
  return {
    quantity: Number(f.quantity),
    moq: Number(f.moq),
    priceTiers: tiers,
    currency: f.currency.toUpperCase(),
    fx: { rate: f.fxRate, bufferPercent: f.fxBuffer },
    localShippingForeign: f.localShipping,
    agentFee: { percent: f.agentPercent, fixedJpy: f.agentFixed },
    package: { unitWeightKg: f.unitWeight, unitDimensionsCm: { length: f.len, width: f.wid, height: f.hei } },
    international: {
      ratePerKgJpy: f.ratePerKg,
      minChargeJpy: f.minCharge,
      volumetricDivisor: Number(f.divisor) as 5000 | 6000,
      weightStepKg: f.step,
      fuelSurchargePercent: f.fuel,
    },
    importCosts: {
      customsDutyPercent: f.duty,
      importConsumptionTaxPercent: f.consumptionTax,
      customsClearanceFeeJpy: f.clearance,
      japanCustomsRounding: f.jpRounding,
    },
    domestic: {
      sellingPriceJpy: f.sellPrice,
      platformFeePercent: f.feePercent,
      platformFixedFeePerUnitJpy: f.fixedFee,
      shippingPerUnitJpy: f.domesticShip,
    },
    otherCostsJpy: f.other,
  };
}

function Field({ label, value, onChange, suffix, type = "text" }: { label: string; value: string; onChange: (v: string) => void; suffix?: string; type?: string }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="flex items-center gap-1">
        <Input inputMode="decimal" type={type} value={value} onChange={(e) => onChange(e.target.value)} />
        {suffix && <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}

function Calculator() {
  const sp = useSearchParams();
  const [f, setF] = useState<Form>(DEFAULTS);
  const [tiers, setTiers] = useState<PriceTier[]>([
    { minQty: 100, unitPrice: "2.50" },
    { minQty: 500, unitPrice: "2.00" },
  ]);
  const [productId, setProductId] = useState<string>(sp.get("productId") ?? "");
  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  const products = useQuery({ queryKey: ["products"], queryFn: () => api<ProductLite[]>("/api/products") });

  useEffect(() => {
    const p = products.data?.find((x) => x.id === productId);
    if (!p) return;
    setTiers(p.priceTiers);
    setF((prev) => ({
      ...prev,
      currency: p.currency,
      moq: String(p.moq),
      quantity: String(Math.max(p.moq, Number(prev.quantity) || p.moq)),
      ...(p.weightKg && { unitWeight: p.weightKg }),
      ...(p.lengthCm && { len: p.lengthCm }),
      ...(p.widthCm && { wid: p.widthCm }),
      ...(p.heightCm && { hei: p.heightCm }),
      ...(p.domesticPriceJpy && { sellPrice: p.domesticPriceJpy }),
    }));
  }, [productId, products.data]);

  const fx = useMutation({
    mutationFn: () => api<{ rate: string; defaultBufferPercent: number; stale: boolean }>(`/api/fx?base=${f.currency}`),
    onSuccess: (r) => setF((p) => ({ ...p, fxRate: r.rate })),
  });
  const calc = useMutation({ mutationFn: () => api<ProfitResult>("/api/profit/calculate", { method: "POST", json: toInput(f, tiers) }) });
  const save = useMutation({
    mutationFn: () => api(`/api/products/${productId}/simulations`, { method: "POST", json: toInput(f, tiers) }),
  });

  const r = calc.data;
  const profitPositive = r && Number(r.profitJpy) >= 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">越境せどり利益計算</h1>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">商品・数量</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label>登録商品から読み込み (任意)</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">— 手入力 —</option>
                {products.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="発注数量" value={f.quantity} onChange={set("quantity")} suffix="個" />
              <Field label="MOQ" value={f.moq} onChange={set("moq")} suffix="個" />
              <Field label="通貨" value={f.currency} onChange={set("currency")} />
            </div>
            <div className="space-y-2">
              <Label>段階単価 (数量別)</Label>
              {tiers.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input className="w-28" inputMode="numeric" value={String(t.minQty)} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, minQty: Number(e.target.value) || 0 } : x)))} />
                  <span className="text-xs text-muted-foreground">個以上</span>
                  <Input className="w-28" inputMode="decimal" value={t.unitPrice} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} />
                  <span className="text-xs text-muted-foreground">{f.currency}</span>
                  <Button variant="ghost" size="icon" aria-label="削除" onClick={() => setTiers(tiers.filter((_, j) => j !== i))} disabled={tiers.length === 1}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setTiers([...tiers, { minQty: (tiers.at(-1)?.minQty ?? 0) * 2 || 1, unitPrice: tiers.at(-1)?.unitPrice ?? "1" }])}>
                <Plus className="h-4 w-4" /> 段階を追加
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">為替・現地費用</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="col-span-2 space-y-1">
              <Label>為替レート (1 {f.currency} = ? 円)</Label>
              <div className="flex gap-1">
                <Input value={f.fxRate} onChange={(e) => set("fxRate")(e.target.value)} inputMode="decimal" />
                <Button variant="outline" size="icon" aria-label="最新レートを取得" onClick={() => fx.mutate()} disabled={fx.isPending}>
                  <RefreshCw className={fx.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                </Button>
              </div>
              {fx.data?.stale && <p className="text-xs text-amber-600">取得失敗のためキャッシュ値です</p>}
              {fx.error && <p className="text-xs text-destructive">{fx.error.message}</p>}
            </div>
            <Field label="為替バッファ" value={f.fxBuffer} onChange={set("fxBuffer")} suffix="%" />
            <Field label="現地国内送料" value={f.localShipping} onChange={set("localShipping")} suffix={f.currency} />
            <Field label="代行手数料" value={f.agentPercent} onChange={set("agentPercent")} suffix="%" />
            <Field label="代行固定費" value={f.agentFixed} onChange={set("agentFixed")} suffix="円" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">国際送料 (実重量 vs 容積重量)</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="1個あたり重量" value={f.unitWeight} onChange={set("unitWeight")} suffix="kg" />
            <Field label="縦" value={f.len} onChange={set("len")} suffix="cm" />
            <Field label="横" value={f.wid} onChange={set("wid")} suffix="cm" />
            <Field label="高さ" value={f.hei} onChange={set("hei")} suffix="cm" />
            <div className="space-y-1">
              <Label>容積除数</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={f.divisor} onChange={(e) => set("divisor")(e.target.value as "5000" | "6000")}>
                <option value="5000">5000 (エクスプレス)</option>
                <option value="6000">6000</option>
              </select>
            </div>
            <Field label="kg単価" value={f.ratePerKg} onChange={set("ratePerKg")} suffix="円" />
            <Field label="最低料金" value={f.minCharge} onChange={set("minCharge")} suffix="円" />
            <Field label="燃油サーチャージ" value={f.fuel} onChange={set("fuel")} suffix="%" />
            <Field label="重量刻み" value={f.step} onChange={set("step")} suffix="kg" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">輸入諸税・国内販売</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="関税率 (品目別)" value={f.duty} onChange={set("duty")} suffix="%" />
            <Field label="輸入消費税" value={f.consumptionTax} onChange={set("consumptionTax")} suffix="%" />
            <Field label="通関手数料" value={f.clearance} onChange={set("clearance")} suffix="円" />
            <label className="flex items-end gap-2 pb-2 text-xs">
              <input type="checkbox" checked={f.jpRounding} onChange={(e) => set("jpRounding")(e.target.checked)} />
              税関端数処理
            </label>
            <Field label="販売価格 (1個)" value={f.sellPrice} onChange={set("sellPrice")} suffix="円" />
            <Field label="販売手数料率" value={f.feePercent} onChange={set("feePercent")} suffix="%" />
            <Field label="固定手数料 (1個)" value={f.fixedFee} onChange={set("fixedFee")} suffix="円" />
            <Field label="国内送料 (1個)" value={f.domesticShip} onChange={set("domesticShip")} suffix="円" />
            <Field label="その他経費" value={f.other} onChange={set("other")} suffix="円" />
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3 lg:sticky lg:top-20 lg:self-start">
        <Button className="w-full" size="lg" onClick={() => calc.mutate()} disabled={calc.isPending}>
          計算する
        </Button>
        {calc.error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{calc.error.message}</p>}
        {r && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                結果
                <Badge variant={profitPositive ? "success" : "destructive"}>ROI {r.roiPercent}%</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md bg-muted p-2">
                  <p className="text-xs text-muted-foreground">利益</p>
                  <p className={`text-lg font-bold ${profitPositive ? "text-emerald-700" : "text-destructive"}`}>{yenFmt(r.profitJpy)}</p>
                </div>
                <div className="rounded-md bg-muted p-2">
                  <p className="text-xs text-muted-foreground">1個あたり利益</p>
                  <p className="text-lg font-bold">{yenFmt(r.unitProfitJpy)}</p>
                </div>
                <div className="rounded-md bg-muted p-2">
                  <p className="text-xs text-muted-foreground">利益率</p>
                  <p className="font-semibold">{r.marginPercent}%</p>
                </div>
                <div className="rounded-md bg-muted p-2">
                  <p className="text-xs text-muted-foreground">損益分岐 販売単価</p>
                  <p className="font-semibold">{r.breakEvenUnitPriceJpy === "N/A" ? "N/A" : yenFmt(r.breakEvenUnitPriceJpy)}</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                適用単価 {r.unitPriceForeign} ({r.appliedTier.minQty}個以上) / 適用レート {Number(r.fxRateApplied).toFixed(3)}円 / 課金重量{" "}
                {r.weight.chargeableKg}kg ({r.weight.basis === "volumetric" ? "容積" : "実"}重量: 実 {r.weight.actualKg} / 容積 {r.weight.volumetricKg})
              </p>
              <table className="w-full">
                <tbody>
                  {Object.entries(r.breakdown).map(([k, v]) => (
                    <tr key={k} className={k === "customsValueJpy" ? "text-muted-foreground" : ""}>
                      <td className="py-0.5">{BREAKDOWN_LABELS[k as keyof ProfitResult["breakdown"]]}</td>
                      <td className="py-0.5 text-right tabular-nums">{yenFmt(v)}</td>
                    </tr>
                  ))}
                  <tr className="border-t font-semibold">
                    <td className="pt-1">仕入原価 (1個 {yenFmt(r.landedUnitCostJpy)})</td>
                    <td className="pt-1 text-right tabular-nums">{yenFmt(r.landedCostJpy)}</td>
                  </tr>
                  <tr className="font-semibold">
                    <td>総コスト</td>
                    <td className="text-right tabular-nums">{yenFmt(r.totalCostJpy)}</td>
                  </tr>
                  <tr className="font-semibold">
                    <td>売上</td>
                    <td className="text-right tabular-nums">{yenFmt(r.revenueJpy)}</td>
                  </tr>
                </tbody>
              </table>
              {productId && (
                <Button variant="outline" className="w-full" onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isSuccess ? "保存しました" : "シミュレーションを保存"}
                </Button>
              )}
              {save.error && <p className="text-xs text-destructive">{save.error.message}</p>}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

export default function CalculatorPage() {
  return (
    <Suspense>
      <Calculator />
    </Suspense>
  );
}
