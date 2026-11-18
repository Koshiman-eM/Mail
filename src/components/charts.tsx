"use client";

import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/*
 * チャートは dataviz 参照パレット (globals.css の --chart-*) を使用。
 * - カテゴリ色は固定順 (slot 1→5) で割り当て、件数で塗り替えない
 * - 細いマーク、2px のサーフェス間隔、凡例は常に表示 (2系列以上)、ホバーでツールチップ
 * - ライトモードで 3:1 未満のスロットがあるため、凡例に値と割合を併記 (色だけに頼らない)
 */

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;

/* ------------------------------------------------------------------ */
/* コスト内訳: 横向き 100% 積み上げバー + 値付き凡例                     */
/* ------------------------------------------------------------------ */
export interface CostSegment {
  key: string;
  label: string;
  value: number;
}

export function CostBreakdownBar({ segments, total }: { segments: CostSegment[]; total: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const visible = segments.filter((s) => s.value > 0);
  return (
    <figure className="space-y-3" aria-label="コスト内訳">
      <div className="relative flex h-3.5 w-full gap-[2px] overflow-hidden rounded" role="img" aria-label={visible.map((s) => `${s.label} ${yen(s.value)}`).join("、")}>
        {visible.map((s, i) => (
          <div
            key={s.key}
            className={cn("h-full transition-opacity first:rounded-l last:rounded-r", hover && hover !== s.key && "opacity-40")}
            style={{ width: `${(s.value / total) * 100}%`, background: `var(--chart-${(segments.indexOf(s) % 5) + 1})`, minWidth: 2 }}
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
            title={`${s.label}: ${yen(s.value)} (${((s.value / total) * 100).toFixed(1)}%)`}
            data-index={i}
          />
        ))}
      </div>
      <ul className="grid gap-1 text-[13px]">
        {segments.map((s, i) => (
          <li
            key={s.key}
            className={cn("flex items-center gap-2 rounded px-1 py-0.5", hover === s.key && "bg-muted")}
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: `var(--chart-${(i % 5) + 1})` }} />
            <span className="flex-1 text-muted-foreground">{s.label}</span>
            <span className="tabular font-medium">{yen(s.value)}</span>
            <span className="tabular w-12 text-right text-xs text-muted-foreground">{total > 0 ? `${((s.value / total) * 100).toFixed(1)}%` : "—"}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* 価格推移: ステップライン + クロスヘア/ツールチップ                    */
/* ------------------------------------------------------------------ */
export interface PricePoint {
  at: string; // ISO
  value: number;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag * 10;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toFixed(6)));
  return ticks;
}

export function PriceHistoryChart({ points, currency, height = 200 }: { points: PricePoint[]; currency: string; height?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hi, setHi] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const pad = { l: 48, r: 12, t: 12, b: 26 };

  const data = useMemo(() => [...points].sort((a, b) => a.at.localeCompare(b.at)), [points]);
  if (data.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">価格履歴はまだありません</p>;

  const t0 = new Date(data[0].at).getTime();
  const t1 = Math.max(new Date(data[data.length - 1].at).getTime(), t0 + 1);
  const ticks = niceTicks(Math.min(...data.map((d) => d.value)), Math.max(...data.map((d) => d.value)));
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const x = (iso: string) => pad.l + ((new Date(iso).getTime() - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);

  let d = "";
  data.forEach((p, i) => {
    const px = x(p.at);
    const py = y(p.value);
    d += i === 0 ? `M${px},${py}` : `H${px}V${py}`;
  });
  if (data.length === 1) d += `H${W - pad.r}`;

  const onMove = (e: React.PointerEvent) => {
    const svg = ref.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    data.forEach((p, i) => {
      if (Math.abs(x(p.at) - mx) < Math.abs(x(data[best].at) - mx)) best = i;
    });
    setHi(best);
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
  const active = hi !== null ? data[hi] : null;

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none select-none"
        role="img"
        aria-label={`価格推移 (${currency})`}
        onPointerMove={onMove}
        onPointerLeave={() => setHi(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth={1} />
            <text x={pad.l - 8} y={y(t)} dy="0.35em" textAnchor="end" fontSize={11} fill="var(--chart-muted)" className="tabular">
              {t}
            </text>
          </g>
        ))}
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--chart-axis)" />
        {[data[0], data[data.length - 1]].map((p, i) => (
          <text key={i} x={x(p.at)} y={H - 8} fontSize={11} fill="var(--chart-muted)" textAnchor={i === 0 ? "start" : "end"}>
            {fmtDate(p.at)}
          </text>
        ))}
        <path d={d} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeLinejoin="round" />
        {active && (
          <>
            <line x1={x(active.at)} x2={x(active.at)} y1={pad.t} y2={H - pad.b} stroke="var(--chart-axis)" strokeDasharray="3 3" />
            <circle cx={x(active.at)} cy={y(active.value)} r={5} fill="var(--chart-1)" stroke="var(--chart-surface)" strokeWidth={2} />
          </>
        )}
      </svg>
      {active && (
        <div
          className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-md border bg-card px-2.5 py-1.5 text-xs shadow-lg"
          style={{ left: `${(x(active.at) / W) * 100}%` }}
        >
          <p className="text-muted-foreground">{new Date(active.at).toLocaleString("ja-JP")}</p>
          <p className="tabular font-semibold">
            {active.value} {currency}
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* スパークライン (一覧用の小さな推移)                                  */
/* ------------------------------------------------------------------ */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return <span className={cn("text-xs text-muted-foreground", className)}>—</span>;
  const W = 80;
  const H = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (W - 4) + 2},${H - 3 - ((v - min) / (max - min || 1)) * (H - 6)}`).join(" ");
  const first = values[0];
  const last = values[values.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cn("h-6 w-20", className)} role="img" aria-label={`価格推移 ${first} → ${last}`}>
      <title>{`価格推移 ${first} → ${last}`}</title>
      <polyline points={pts} fill="none" stroke="var(--chart-1)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* ROI 横棒 (正: 青 / 負: 赤 — 発散ペア)                               */
/* ------------------------------------------------------------------ */
export function RoiBars({ items }: { items: { id: string; label: string; roi: number; href?: string }[] }) {
  const [hover, setHover] = useState<string | null>(null);
  if (items.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">利益試算を保存すると ROI が表示されます</p>;
  const maxAbs = Math.max(...items.map((i) => Math.abs(i.roi)), 1);
  const hasNeg = items.some((i) => i.roi < 0);
  return (
    <ul className="space-y-2.5" aria-label="商品別 ROI">
      {items.map((it) => {
        const w = (Math.abs(it.roi) / maxAbs) * (hasNeg ? 50 : 100);
        const neg = it.roi < 0;
        return (
          <li key={it.id} onMouseEnter={() => setHover(it.id)} onMouseLeave={() => setHover(null)} className={cn("rounded-md px-1 py-0.5", hover === it.id && "bg-muted")}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
              <span className="truncate">{it.label}</span>
              <span className={cn("tabular shrink-0 font-semibold", neg ? "text-destructive" : "text-foreground")}>{it.roi.toFixed(1)}%</span>
            </div>
            <div className="relative h-2 w-full rounded-sm bg-muted">
              {hasNeg && <span className="absolute inset-y-[-2px] left-1/2 w-px bg-[var(--chart-axis)]" />}
              <span
                className="absolute inset-y-0 rounded-sm"
                style={{
                  width: `${w}%`,
                  left: hasNeg ? (neg ? `${50 - w}%` : "50%") : 0,
                  background: neg ? "#e34948" : "var(--chart-1)",
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
