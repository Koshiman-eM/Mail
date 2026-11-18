"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, CheckCheck } from "lucide-react";
import { Button } from "./ui/button";
import { Tabs } from "./ui/misc";
import { api, relTime } from "./api";
import { SEVERITY, SeverityBadge, type Severity } from "./severity";
import { cn } from "@/lib/utils";

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

type Filter = Severity | "ALL";

export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ["notifications", filter, unreadOnly],
    queryFn: () =>
      api<NotificationList>(`/api/notifications?${new URLSearchParams({ ...(filter !== "ALL" && { severity: filter }), ...(unreadOnly && { unread: "1" }) })}`),
  });

  // SSE でリアルタイム更新 (切断時はブラウザが自動再接続)
  useEffect(() => {
    const es = new EventSource("/api/notifications/stream");
    es.addEventListener("notification", () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    });
    return () => es.close();
  }, [qc]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const markRead = async (body: { ids?: string[]; all?: boolean }) => {
    await api("/api/notifications/read", { method: "POST", json: body });
    qc.invalidateQueries({ queryKey: ["notifications"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const total = data?.unreadTotal ?? 0;
  const hasCritical = (data?.unread.CRITICAL ?? 0) > 0;

  return (
    <div className="relative" ref={ref}>
      <Button variant="ghost" size="icon" className="relative" aria-label={`通知 (未読 ${total} 件)`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Bell className="h-[18px] w-[18px]" />
        {total > 0 && (
          <span
            className={cn(
              "absolute right-0.5 top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold ring-2 ring-background",
              hasCritical ? "bg-destructive text-white" : "bg-warning text-[#0b0b0b]",
            )}
          >
            {total > 99 ? "99+" : total}
          </span>
        )}
      </Button>
      {open && (
        <div className="fixed inset-x-2 top-14 z-50 overflow-hidden rounded-xl border bg-card shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-[420px]">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <p className="font-semibold">通知</p>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" className="accent-[rgb(var(--primary))]" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
              未読のみ
            </label>
          </div>
          <div className="border-b px-3 py-2">
            <Tabs<Filter>
              value={filter}
              onChange={setFilter}
              items={[
                { value: "ALL", label: "すべて" },
                ...(["CRITICAL", "WARNING", "INFO"] as const).map((s) => ({
                  value: s,
                  label: (
                    <>
                      {SEVERITY[s].label}
                      {data?.unread[s] ? <span className="tabular text-[11px] text-muted-foreground">{data.unread[s]}</span> : null}
                    </>
                  ),
                })),
              ]}
            />
          </div>
          <ul className="scrollbar-thin max-h-[60vh] overflow-y-auto">
            {data?.items.length === 0 && (
              <li className="flex flex-col items-center gap-2 px-4 py-10 text-sm text-muted-foreground">
                <BellOff className="h-6 w-6" />
                通知はありません
              </li>
            )}
            {data?.items.map((n) => (
              <li key={n.id} className={cn("group relative border-b px-4 py-3 last:border-0", !n.readAt && "bg-primary-soft/40")}>
                {!n.readAt && <span className="absolute left-1.5 top-4 h-1.5 w-1.5 rounded-full bg-primary" aria-label="未読" />}
                <div className="flex items-start gap-3">
                  <SeverityBadge severity={n.severity} />
                  <div className="min-w-0 flex-1">
                    {n.link ? (
                      <Link
                        href={n.link}
                        className="text-sm font-medium leading-snug hover:underline"
                        onClick={() => {
                          setOpen(false);
                          if (!n.readAt) markRead({ ids: [n.id] });
                        }}
                      >
                        {n.title}
                      </Link>
                    ) : (
                      <p className="text-sm font-medium leading-snug">{n.title}</p>
                    )}
                    {n.body && <p className="mt-0.5 line-clamp-3 whitespace-pre-line break-words text-xs text-muted-foreground">{n.body}</p>}
                    <p className="mt-1 text-[11px] text-muted-foreground">{relTime(n.createdAt)}</p>
                  </div>
                  {!n.readAt && (
                    <button className="shrink-0 text-xs text-muted-foreground opacity-70 hover:text-foreground hover:opacity-100" onClick={() => markRead({ ids: [n.id] })}>
                      既読
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="flex justify-end border-t px-3 py-2">
            <Button size="sm" variant="ghost" onClick={() => markRead({ all: true })} disabled={total === 0}>
              <CheckCheck className="h-4 w-4" /> すべて既読にする
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
