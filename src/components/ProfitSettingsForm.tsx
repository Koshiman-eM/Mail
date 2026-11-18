"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Save } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Checkbox, Label, Select, UnitInput } from "./ui/input";
import { api } from "./api";

export interface ProfitSettingsData {
  fxBufferPercent: string;
  fxFallbackRates: Record<string, string>;
  localShippingJpy: string;
  agentFeePercent: string;
  agentFixedJpy: string;
  intlRatePerKgJpy: string;
  intlMinChargeJpy: string;
  volumetricDivisor: number;
  weightStepKg: string;
  fuelSurchargePercent: string;
  defaultDutyPercent: string;
  consumptionTaxPercent: string;
  customsClearanceFeeJpy: string;
  japanCustomsRounding: boolean;
  platformFeePercent: string;
  platformFixedFeePerUnitJpy: string;
  domesticShippingPerUnitJpy: string;
  otherCostsJpy: string;
  roiAlertPercent: string;
  updatedAt: string;
}

export const useProfitSettings = () => useQuery({ queryKey: ["profit-settings"], queryFn: () => api<ProfitSettingsData>("/api/profit/settings") });

type StrKey = { [K in keyof ProfitSettingsData]: ProfitSettingsData[K] extends string ? K : never }[keyof ProfitSettingsData];

const GROUPS: { title: string; fields: [StrKey, string, string][] }[] = [
  {
    title: "為替・現地費用",
    fields: [
      ["fxBufferPercent", "為替バッファ", "%"],
      ["localShippingJpy", "現地国内送料 (1注文)", "円"],
      ["agentFeePercent", "代行手数料", "%"],
      ["agentFixedJpy", "代行固定費 (1注文)", "円"],
    ],
  },
  {
    title: "国際送料",
    fields: [
      ["intlRatePerKgJpy", "kg 単価", "円"],
      ["intlMinChargeJpy", "最低料金", "円"],
      ["weightStepKg", "重量の刻み", "kg"],
      ["fuelSurchargePercent", "燃油サーチャージ", "%"],
    ],
  },
  {
    title: "輸入諸税",
    fields: [
      ["defaultDutyPercent", "関税率 (商品で未設定時)", "%"],
      ["consumptionTaxPercent", "輸入消費税", "%"],
      ["customsClearanceFeeJpy", "通関手数料 (1注文)", "円"],
    ],
  },
  {
    title: "国内販売",
    fields: [
      ["platformFeePercent", "販売手数料率", "%"],
      ["platformFixedFeePerUnitJpy", "固定手数料 (1個)", "円"],
      ["domesticShippingPerUnitJpy", "国内送料 (1個)", "円"],
      ["otherCostsJpy", "その他経費 (1注文)", "円"],
    ],
  },
];

export function ProfitSettingsForm({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data } = useProfitSettings();
  const [f, setF] = useState<ProfitSettingsData | null>(null);
  useEffect(() => {
    if (data) setF({ ...data, fxFallbackRates: { USD: "", CNY: "", EUR: "", ...data.fxFallbackRates } });
  }, [data]);

  const save = useMutation({
    mutationFn: () => {
      const { updatedAt: _u, ...body } = f!;
      return api<{ recalculated: { total: number; OK: number; UNCHANGED: number; SKIPPED: number; ERROR: number } }>("/api/profit/settings", {
        method: "PUT",
        json: { ...body, fxFallbackRates: Object.fromEntries(Object.entries(body.fxFallbackRates).filter(([, v]) => v)) },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profit-settings"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  if (!f) return <div className="h-64 animate-pulse rounded-xl bg-muted" />;
  const set = (k: StrKey) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>自動利益計算の既定値</CardTitle>
          <CardDescription>
            商品の登録・編集時、巡回で価格が変わった時、設定の保存時、そして定期的 (為替の変動) に、この値と各商品の重量・寸法・販売価格で利益を自動計算します。
            発注数量は商品の「想定発注数量」(未設定なら MOQ)、関税率は商品ごとの値 (未設定ならここの値) を使います。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          {GROUPS.map((g) => (
            <fieldset key={g.title} className="space-y-3" disabled={!isAdmin}>
              <legend className="mb-1 text-sm font-semibold">{g.title}</legend>
              <div className="grid grid-cols-2 gap-3">
                {g.fields.map(([k, label, unit]) => (
                  <div key={k} className="space-y-1.5">
                    <Label htmlFor={`ps-${k}`}>{label}</Label>
                    <UnitInput id={`ps-${k}`} unit={unit} value={f[k]} onChange={set(k)} />
                  </div>
                ))}
                {g.title === "国際送料" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="ps-div">容積除数</Label>
                    <Select id="ps-div" value={f.volumetricDivisor} onChange={(e) => setF({ ...f, volumetricDivisor: Number(e.target.value) })}>
                      <option value={5000}>5000</option>
                      <option value={6000}>6000</option>
                    </Select>
                  </div>
                )}
                {g.title === "輸入諸税" && (
                  <div className="flex items-end pb-2">
                    <Checkbox label="税関の端数処理" checked={f.japanCustomsRounding} onChange={(e) => setF({ ...f, japanCustomsRounding: e.target.checked })} />
                  </div>
                )}
              </div>
            </fieldset>
          ))}
          <fieldset className="space-y-3" disabled={!isAdmin}>
            <legend className="mb-1 text-sm font-semibold">予備の為替レート</legend>
            <p className="text-xs text-muted-foreground">最新レートを取得できず、キャッシュも無い場合だけ使います。</p>
            <div className="grid grid-cols-3 gap-3">
              {Object.keys(f.fxFallbackRates).map((cur) => (
                <div key={cur} className="space-y-1.5">
                  <Label htmlFor={`fx-${cur}`}>1 {cur}</Label>
                  <UnitInput id={`fx-${cur}`} unit="円" value={f.fxFallbackRates[cur]} onChange={(e) => setF({ ...f, fxFallbackRates: { ...f.fxFallbackRates, [cur]: e.target.value } })} />
                </div>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-3" disabled={!isAdmin}>
            <legend className="mb-1 text-sm font-semibold">通知</legend>
            <div className="max-w-[200px] space-y-1.5">
              <Label htmlFor="ps-roi">ROI がこれを下回ったら通知</Label>
              <UnitInput id="ps-roi" unit="%" value={f.roiAlertPercent} onChange={set("roiAlertPercent")} />
            </div>
            <p className="text-xs text-muted-foreground">赤字への転落は常に「重要」として通知します。</p>
          </fieldset>
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        {isAdmin ? (
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            保存して全商品を再計算
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">既定値の変更は管理者のみ行えます。</p>
        )}
        {save.data && (
          <p className="flex items-center gap-1.5 text-sm text-success">
            <Check className="h-4 w-4" /> {save.data.recalculated.total} 商品を再計算しました
            {save.data.recalculated.SKIPPED > 0 && <span className="text-warning-ink">(情報不足 {save.data.recalculated.SKIPPED} 件)</span>}
          </p>
        )}
        {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
      </div>
    </form>
  );
}
