"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Globe, Landmark, Loader2, Package, Plus, RefreshCw, Save, Store, Trash2, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox, Label, Select, UnitInput } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/misc";
import { CostBreakdownBar } from "@/components/charts";
import { api, yenFmt } from "@/components/api";
import { useProfitSettings, type ProfitSettingsData } from "@/components/ProfitSettingsForm";
import type { PriceTier, ProfitInput, ProfitResult } from "@/lib/profit/types";
import { cn } from "@/lib/utils";

interface ProductLite {
  targetQuantity: number | null;
  dutyPercent: string | null;
  id: string;
  title: string;
  titleJa: string | null;
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
  localShippingJpy: "0",
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

/** 「設定 > 利益計算」の既定値をフォームへ反映 */
function fromSettings(s: ProfitSettingsData): Partial<Form> {
  return {
    fxBuffer: s.fxBufferPercent,
    localShipping: "0",
    localShippingJpy: s.localShippingJpy,
    agentPercent: s.agentFeePercent,
    agentFixed: s.agentFixedJpy,
    divisor: String(s.volumetricDivisor) as "5000" | "6000",
    ratePerKg: s.intlRatePerKgJpy,
    minCharge: s.intlMinChargeJpy,
    fuel: s.fuelSurchargePercent,
    step: s.weightStepKg,
    duty: s.defaultDutyPercent,
    consumptionTax: s.consumptionTaxPercent,
    clearance: s.customsClearanceFeeJpy,
    jpRounding: s.japanCustomsRounding,
    feePercent: s.platformFeePercent,
    fixedFee: s.platformFixedFeePerUnitJpy,
    domesticShip: s.domesticShippingPerUnitJpy,
    other: s.otherCostsJpy,
  };
}

function toInput(f: Form, tiers: PriceTier[]): ProfitInput {
  return {
    quantity: Number(f.quantity),
    moq: Number(f.moq),
    priceTiers: tiers,
    currency: f.currency.toUpperCase(),
    fx: { rate: f.fxRate, bufferPercent: f.fxBuffer },
    localShippingForeign: f.localShipping,
    localShippingJpy: f.localShippingJpy,
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

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-soft text-primary">
            <Icon className="h-4 w-4" />
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const n = (s: string) => Number(s);

function Results({ r }: { r: ProfitResult }) {
  const b = r.breakdown;
  const profit = n(r.profitJpy);
  const positive = profit >= 0;
  const segments = [
    { key: "goods", label: "商品代金", value: n(b.goodsJpy) },
    { key: "sourcing", label: "現地送料・代行手数料", value: n(b.localShippingJpy) + n(b.agentFeeJpy) + n(b.otherCostsJpy) },
    { key: "intl", label: "国際送料", value: n(b.internationalShippingJpy) },
    { key: "tax", label: "関税・輸入消費税・通関", value: n(b.customsDutyJpy) + n(b.importConsumptionTaxJpy) + n(b.customsClearanceFeeJpy) },
    { key: "selling", label: "販売手数料・国内送料", value: n(b.platformFeesJpy) + n(b.domesticShippingJpy) },
  ];
  const rows: [string, string][] = [
    ["商品代金", b.goodsJpy],
    ["現地国内送料", b.localShippingJpy],
    ["代行手数料", b.agentFeeJpy],
    ["国際送料", b.internationalShippingJpy],
    ["関税", b.customsDutyJpy],
    ["輸入消費税", b.importConsumptionTaxJpy],
    ["通関手数料", b.customsClearanceFeeJpy],
    ["その他経費", b.otherCostsJpy],
    ["販売手数料", b.platformFeesJpy],
    ["国内送料", b.domesticShippingJpy],
  ];

  return (
    <div className="space-y-4">
      <div className={cn("rounded-xl border p-5", positive ? "border-success/30 bg-success-soft" : "border-destructive/30 bg-destructive-soft")}>
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-medium text-muted-foreground">見込み利益 ({r.quantity.toLocaleString()} 個)</p>
          <Badge variant={positive ? "success" : "destructive"}>{positive ? "黒字" : "赤字"}</Badge>
        </div>
        <p className={cn("mt-1 text-4xl font-bold tracking-tight", positive ? "text-success" : "text-destructive")}>{yenFmt(r.profitJpy)}</p>
        <p className="mt-1 text-sm text-muted-foreground">1個あたり {yenFmt(r.unitProfitJpy)}</p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          ["ROI", `${r.roiPercent}%`],
          ["利益率", `${r.marginPercent}%`],
          ["損益分岐単価", r.breakEvenUnitPriceJpy === "N/A" ? "N/A" : yenFmt(r.breakEvenUnitPriceJpy)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border bg-card p-3">
            <p className="text-[11px] text-muted-foreground">{k}</p>
            <p className="tabular mt-0.5 font-bold">{v}</p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>総コストの内訳</CardTitle>
          <p className="tabular text-2xl font-bold">{yenFmt(r.totalCostJpy)}</p>
        </CardHeader>
        <CardContent>
          <CostBreakdownBar segments={segments} total={n(r.totalCostJpy)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>計算の前提</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-[13px]">
          <p className="flex justify-between">
            <span className="text-muted-foreground">適用単価</span>
            <span className="tabular">
              {r.unitPriceForeign} ({r.appliedTier.minQty.toLocaleString()} 個〜)
            </span>
          </p>
          <p className="flex justify-between">
            <span className="text-muted-foreground">適用レート (バッファ込)</span>
            <span className="tabular">{Number(r.fxRateApplied).toFixed(3)} 円</span>
          </p>
          <p className="flex justify-between">
            <span className="text-muted-foreground">課金重量</span>
            <span className="tabular">
              {Number(r.weight.chargeableKg)} kg
              <Badge variant="outline" className="ml-1.5">
                {r.weight.basis === "volumetric" ? "容積重量" : "実重量"}
              </Badge>
            </span>
          </p>
          <p className="flex justify-between text-xs text-muted-foreground">
            <span>実重量 {Number(r.weight.actualKg)} kg / 容積重量 {Number(r.weight.volumetricKg)} kg</span>
          </p>
          <p className="flex justify-between">
            <span className="text-muted-foreground">課税価格 (CIF)</span>
            <span className="tabular">{yenFmt(b.customsValueJpy)}</span>
          </p>
          <p className="flex justify-between">
            <span className="text-muted-foreground">仕入原価 (1個)</span>
            <span className="tabular">{yenFmt(r.landedUnitCostJpy)}</span>
          </p>
          <details className="pt-2">
            <summary className="cursor-pointer text-xs font-medium text-primary">費目別の明細を表示</summary>
            <table className="mt-2 w-full">
              <tbody className="tabular">
                {rows.map(([k, v]) => (
                  <tr key={k} className="border-t">
                    <td className="py-1 text-muted-foreground">{k}</td>
                    <td className="py-1 text-right">{yenFmt(v)}</td>
                  </tr>
                ))}
                <tr className="border-t font-semibold">
                  <td className="py-1">売上</td>
                  <td className="py-1 text-right">{yenFmt(r.revenueJpy)}</td>
                </tr>
              </tbody>
            </table>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}

function CalculatorInner() {
  const sp = useSearchParams();
  const [f, setF] = useState<Form>(DEFAULTS);
  const [tiers, setTiers] = useState<PriceTier[]>([
    { minQty: 100, unitPrice: "2.50" },
    { minQty: 500, unitPrice: "2.00" },
  ]);
  const [productId, setProductId] = useState<string>(sp.get("productId") ?? "");
  const set = <K extends keyof Form>(k: K) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((p) => ({ ...p, [k]: (e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value) as Form[K] }));

  const products = useQuery({ queryKey: ["products"], queryFn: () => api<ProductLite[]>("/api/products") });
  const settings = useProfitSettings();
  const [settingsApplied, setSettingsApplied] = useState(false);
  useEffect(() => {
    if (settings.data && !settingsApplied) {
      setF((prev) => ({ ...prev, ...fromSettings(settings.data) }));
      setSettingsApplied(true);
    }
  }, [settings.data, settingsApplied]);

  useEffect(() => {
    const p = products.data?.find((x) => x.id === productId);
    if (!p) return;
    // 価格未取得 (URL 取り込みで取得失敗) の商品は空の段階を1行用意する
    setTiers(p.priceTiers.length ? p.priceTiers : [{ minQty: p.moq, unitPrice: "" }]);
    setF((prev) => ({
      ...prev,
      currency: p.currency,
      moq: String(p.moq),
      quantity: String(Math.max(p.moq, p.targetQuantity ?? p.moq)),
      ...(p.dutyPercent && { duty: p.dutyPercent }),
      ...(p.weightKg && { unitWeight: p.weightKg }),
      ...(p.lengthCm && { len: p.lengthCm }),
      ...(p.widthCm && { wid: p.widthCm }),
      ...(p.heightCm && { hei: p.heightCm }),
      ...(p.domesticPriceJpy && { sellPrice: p.domesticPriceJpy }),
    }));
  }, [productId, products.data]);

  const fx = useMutation({
    mutationFn: () => api<{ rate: string; stale: boolean; fetchedAt: string }>(`/api/fx?base=${f.currency}`),
    onSuccess: (r) => setF((p) => ({ ...p, fxRate: r.rate })),
  });
  const calc = useMutation({ mutationFn: () => api<ProfitResult>("/api/profit/calculate", { method: "POST", json: toInput(f, tiers) }) });
  const save = useMutation({ mutationFn: () => api(`/api/products/${productId}/simulations`, { method: "POST", json: toInput(f, tiers) }) });

  return (
    <div>
      <PageHeader
        title="利益計算"
        description="条件を変えて試算します。入力欄は「設定 > 利益計算」の既定値から始まります。登録商品の利益は自動で計算され、商品一覧に表示されます。"
        actions={
          settings.data && (
            <Button variant="outline" onClick={() => setF((prev) => ({ ...prev, ...fromSettings(settings.data!) }))}>
              <RefreshCw className="h-4 w-4" /> 既定値に戻す
            </Button>
          )
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            calc.mutate();
          }}
        >
          <Section icon={Package} title="商品・数量">
            <div className="space-y-4">
              <Field label="登録商品から読み込み (任意)">
                <Select value={productId} onChange={(e) => setProductId(e.target.value)}>
                  <option value="">手入力</option>
                  {products.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.titleJa ?? p.title}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="発注数量">
                  <UnitInput unit="個" value={f.quantity} onChange={set("quantity")} />
                </Field>
                <Field label="MOQ">
                  <UnitInput unit="個" value={f.moq} onChange={set("moq")} />
                </Field>
                <Field label="通貨">
                  <Select value={f.currency} onChange={set("currency")}>
                    {["USD", "CNY", "JPY", "EUR"].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="space-y-2">
                <Label>段階単価</Label>
                <div className="space-y-2">
                  {tiers.map((t, i) => {
                    const active = Number(f.quantity) >= t.minQty && !tiers.some((o) => o.minQty > t.minQty && Number(f.quantity) >= o.minQty);
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <UnitInput className="w-32" unit="個〜" value={String(t.minQty)} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, minQty: Number(e.target.value) || 0 } : x)))} />
                        <UnitInput className="flex-1" unit={f.currency} value={t.unitPrice} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} />
                        <span className="w-14 text-center">{active && <Badge variant="info">適用</Badge>}</span>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label="段階を削除" onClick={() => setTiers(tiers.filter((_, j) => j !== i))} disabled={tiers.length === 1}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setTiers([...tiers, { minQty: (tiers.at(-1)?.minQty ?? 0) * 2 || 1, unitPrice: tiers.at(-1)?.unitPrice ?? "1" }])}>
                  <Plus className="h-4 w-4" /> 段階を追加
                </Button>
              </div>
            </div>
          </Section>

          <Section icon={Globe} title="為替・現地費用">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label={`為替レート (1 ${f.currency})`} className="col-span-2 sm:col-span-1">
                <div className="flex gap-1.5">
                  <UnitInput className="flex-1" unit="円" value={f.fxRate} onChange={set("fxRate")} />
                  <Button type="button" variant="outline" size="icon" aria-label="最新レートを取得" title="最新レートを取得" onClick={() => fx.mutate()} disabled={fx.isPending || f.currency === "JPY"}>
                    <RefreshCw className={cn("h-4 w-4", fx.isPending && "animate-spin")} />
                  </Button>
                </div>
                {fx.data && <p className={cn("text-[11px]", fx.data.stale ? "text-warning-ink" : "text-muted-foreground")}>{fx.data.stale ? "取得失敗のためキャッシュ値" : `取得 ${new Date(fx.data.fetchedAt).toLocaleString("ja-JP")}`}</p>}
                {fx.error && <p className="text-[11px] text-destructive">{fx.error.message}</p>}
              </Field>
              <Field label="為替バッファ">
                <UnitInput unit="%" value={f.fxBuffer} onChange={set("fxBuffer")} />
              </Field>
              <Field label="現地国内送料">
                <UnitInput unit={f.currency} value={f.localShipping} onChange={set("localShipping")} />
              </Field>
              <Field label="現地国内送料 (円建て)">
                <UnitInput unit="円" value={f.localShippingJpy} onChange={set("localShippingJpy")} />
              </Field>
              <Field label="代行手数料">
                <UnitInput unit="%" value={f.agentPercent} onChange={set("agentPercent")} />
              </Field>
              <Field label="代行固定費">
                <UnitInput unit="円" value={f.agentFixed} onChange={set("agentFixed")} />
              </Field>
              <Field label="その他経費">
                <UnitInput unit="円" value={f.other} onChange={set("other")} />
              </Field>
            </div>
          </Section>

          <Section icon={Truck} title="国際送料 (実重量と容積重量の大きい方)">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="1個の重量">
                <UnitInput unit="kg" value={f.unitWeight} onChange={set("unitWeight")} />
              </Field>
              <Field label="縦">
                <UnitInput unit="cm" value={f.len} onChange={set("len")} />
              </Field>
              <Field label="横">
                <UnitInput unit="cm" value={f.wid} onChange={set("wid")} />
              </Field>
              <Field label="高さ">
                <UnitInput unit="cm" value={f.hei} onChange={set("hei")} />
              </Field>
              <Field label="容積除数">
                <Select value={f.divisor} onChange={set("divisor")}>
                  <option value="5000">5000</option>
                  <option value="6000">6000</option>
                </Select>
              </Field>
              <Field label="kg 単価">
                <UnitInput unit="円" value={f.ratePerKg} onChange={set("ratePerKg")} />
              </Field>
              <Field label="最低料金">
                <UnitInput unit="円" value={f.minCharge} onChange={set("minCharge")} />
              </Field>
              <Field label="燃油サーチャージ">
                <UnitInput unit="%" value={f.fuel} onChange={set("fuel")} />
              </Field>
              <Field label="重量の刻み">
                <UnitInput unit="kg" value={f.step} onChange={set("step")} />
              </Field>
            </div>
          </Section>

          <Section icon={Landmark} title="輸入諸税">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="関税率 (品目別)">
                <UnitInput unit="%" value={f.duty} onChange={set("duty")} />
              </Field>
              <Field label="輸入消費税">
                <UnitInput unit="%" value={f.consumptionTax} onChange={set("consumptionTax")} />
              </Field>
              <Field label="通関手数料">
                <UnitInput unit="円" value={f.clearance} onChange={set("clearance")} />
              </Field>
              <div className="flex items-end pb-2">
                <Checkbox label="税関の端数処理" checked={f.jpRounding} onChange={set("jpRounding")} />
              </div>
            </div>
          </Section>

          <Section icon={Store} title="国内販売">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="販売価格 (1個)">
                <UnitInput unit="円" value={f.sellPrice} onChange={set("sellPrice")} />
              </Field>
              <Field label="販売手数料率">
                <UnitInput unit="%" value={f.feePercent} onChange={set("feePercent")} />
              </Field>
              <Field label="固定手数料 (1個)">
                <UnitInput unit="円" value={f.fixedFee} onChange={set("fixedFee")} />
              </Field>
              <Field label="国内送料 (1個)">
                <UnitInput unit="円" value={f.domesticShip} onChange={set("domesticShip")} />
              </Field>
            </div>
          </Section>

          <div className="sticky bottom-0 -mx-4 border-t bg-background/90 px-4 py-3 backdrop-blur lg:hidden">
            <Button type="submit" size="lg" className="w-full" disabled={calc.isPending}>
              計算する
            </Button>
          </div>
        </form>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Button size="lg" className="hidden w-full lg:flex" onClick={() => calc.mutate()} disabled={calc.isPending}>
            {calc.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            計算する
          </Button>
          {calc.error && <p className="rounded-lg bg-destructive-soft px-4 py-3 text-sm text-destructive">{calc.error.message}</p>}
          {calc.data ? (
            <>
              <Results r={calc.data} />
              {productId && (
                <Button variant="outline" className="w-full" onClick={() => save.mutate()} disabled={save.isPending || save.isSuccess}>
                  {save.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                  {save.isSuccess ? "保存しました" : "この試算を商品に保存"}
                </Button>
              )}
              {save.error && <p className="text-xs text-destructive">{save.error.message}</p>}
            </>
          ) : (
            !calc.error && (
              <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                条件を入力して「計算する」を押すと、利益・ROI・コスト内訳がここに表示されます。
              </div>
            )
          )}
        </aside>
      </div>
    </div>
  );
}

export default function CalculatorPage() {
  return (
    <Suspense>
      <CalculatorInner />
    </Suspense>
  );
}
