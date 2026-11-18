"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { api } from "./api";
import { cn } from "@/lib/utils";

type Severity = "INFO" | "WARNING" | "CRITICAL";
interface Notification {
  id: string;
  type: string;
  severity: Severity;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}
interface NotificationList {
  items: Notification[];
  unread: Record<Severity, number>;
  unreadTotal: number;
}

const SEV_LABEL: Record<Severity, string> = { CRITICAL: "重要", WARNING: "注意", INFO: "情報" };
const SEV_VARIANT = { CRITICAL: "destructive", WARNING: "warning", INFO: "secondary" } as const;

export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Severity | "ALL">("ALL");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const key = ["notifications", filter, unreadOnly];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () =>
      api<NotificationList>(`/api/notifications?${new URLSearchParams({ ...(filter !== "ALL" && { severity: filter }), ...(unreadOnly && { unread: "1" }) })}`),
  });

  // SSE でリアルタイム更新
  useEffect(() => {
    const es = new EventSource("/api/notifications/stream");
    es.addEventListener("notification", () => qc.invalidateQueries({ queryKey: ["notifications"] }));
    return () => es.close();
  }, [qc]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const markRead = async (body: { ids?: string[]; all?: boolean }) => {
    await api("/api/notifications/read", { method: "POST", json: body });
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };

  const total = data?.unreadTotal ?? 0;
  const hasCritical = (data?.unread.CRITICAL ?? 0) > 0;

  return (
    <div className="relative" ref={ref}>
      <Button variant="ghost" size="icon" aria-label={`通知 (未読 ${total} 件)`} onClick={() => setOpen((o) => !o)}>
        <Bell className="h-5 w-5" />
        {total > 0 && (
          <span
            className={cn(
              "absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white",
              hasCritical ? "bg-red-600" : "bg-amber-500",
            )}
          >
            {total > 99 ? "99+" : total}
          </span>
        )}
      </Button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[min(92vw,420px)] rounded-lg border bg-background shadow-lg">
          <div className="flex flex-wrap items-center gap-1 border-b p-2">
            {(["ALL", "CRITICAL", "WARNING", "INFO"] as const).map((s) => (
              <Button key={s} size="sm" variant={filter === s ? "default" : "outline"} onClick={() => setFilter(s)}>
                {s === "ALL" ? "すべて" : SEV_LABEL[s]}
                {s !== "ALL" && data?.unread[s] ? ` (${data.unread[s]})` : ""}
              </Button>
            ))}
            <label className="ml-auto flex items-center gap-1 text-xs">
              <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
              未読のみ
            </label>
          </div>
          <ul className="max-h-[60vh] overflow-y-auto">
            {data?.items.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">通知はありません</li>}
            {data?.items.map((n) => (
              <li key={n.id} className={cn("border-b p-3 text-sm last:border-0", !n.readAt && "bg-accent/50")}>
                <div className="flex items-start gap-2">
                  <Badge variant={SEV_VARIANT[n.severity]}>{SEV_LABEL[n.severity]}</Badge>
                  <div className="min-w-0 flex-1">
                    {n.link ? (
                      <Link href={n.link} className="font-medium hover:underline" onClick={() => markRead({ ids: [n.id] })}>
                        {n.title}
                      </Link>
                    ) : (
                      <p className="font-medium">{n.title}</p>
                    )}
                    {n.body && <p className="mt-0.5 whitespace-pre-line break-words text-xs text-muted-foreground">{n.body}</p>}
                    <p className="mt-1 text-[11px] text-muted-foreground">{new Date(n.createdAt).toLocaleString("ja-JP")}</p>
                  </div>
                  {!n.readAt && (
                    <button className="text-xs text-muted-foreground hover:underline" onClick={() => markRead({ ids: [n.id] })}>
                      既読
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="border-t p-2 text-right">
            <Button size="sm" variant="ghost" onClick={() => markRead({ all: true })} disabled={total === 0}>
              すべて既読にする
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
