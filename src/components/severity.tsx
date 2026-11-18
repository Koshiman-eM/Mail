import { AlertOctagon, AlertTriangle, Info } from "lucide-react";
import { Badge } from "./ui/badge";

export type Severity = "INFO" | "WARNING" | "CRITICAL";

export const SEVERITY: Record<Severity, { label: string; variant: "destructive" | "warning" | "info"; icon: typeof Info }> = {
  CRITICAL: { label: "重要", variant: "destructive", icon: AlertOctagon },
  WARNING: { label: "注意", variant: "warning", icon: AlertTriangle },
  INFO: { label: "情報", variant: "info", icon: Info },
};

/** 重要度は色だけでなくアイコン + ラベルで示す */
export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY[severity];
  const Icon = s.icon;
  return (
    <Badge variant={s.variant}>
      <Icon className="h-3 w-3" />
      {s.label}
    </Badge>
  );
}
