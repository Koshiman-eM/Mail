"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Calculator, ChevronDown, LayoutDashboard, LogOut, Menu, MessagesSquare, Package, Settings, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { NotificationBell } from "./NotificationBell";
import { ThemeToggle } from "./theme";
import { useDashboard, useMe } from "./hooks";
import { api } from "./api";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "ダッシュボード", icon: LayoutDashboard },
  { href: "/products", label: "仕入れ候補", icon: Package },
  { href: "/calculator", label: "利益計算", icon: Calculator },
  { href: "/chat", label: "業者チャット", icon: MessagesSquare, badge: "chat" as const },
  { href: "/settings", label: "設定", icon: Settings },
];

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-[13px] font-black text-primary-foreground">越</span>
      <span className="leading-tight">
        <span className="block text-sm font-bold">越境せどり</span>
        <span className="block text-[11px] text-muted-foreground">仕入れ・交渉管理</span>
      </span>
    </Link>
  );
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const { data } = useDashboard();
  const chatCount = (data?.awaitingApproval ?? 0) + (data?.awaitingSend ?? 0) + (data?.sendFailed ?? 0);
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(({ href, label, icon: Icon, badge }) => {
        const active = href === "/" ? path === "/" : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={cn(
              "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="h-[18px] w-[18px]" />
            <span className="flex-1">{label}</span>
            {badge === "chat" && chatCount > 0 && (
              <span className="rounded-full bg-warning px-1.5 py-px text-[11px] font-bold text-[#0b0b0b]" aria-label={`対応待ち ${chatCount} 件`}>
                {chatCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function UserMenu() {
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const qc = useQueryClient();
  useEffect(() => {
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    qc.clear();
    router.replace("/login");
  };
  if (!me) return <div className="h-9 w-9 animate-pulse rounded-full bg-muted" />;
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-lg p-1 pr-2 hover:bg-accent" aria-haspopup="menu" aria-expanded={open}>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-xs font-bold">{me.name.slice(0, 1)}</span>
        <span className="hidden text-sm font-medium sm:inline">{me.name}</span>
        <ChevronDown className="hidden h-4 w-4 text-muted-foreground sm:inline" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-lg border bg-card shadow-lg">
          <div className="border-b px-3 py-2.5">
            <p className="text-sm font-medium">{me.name}</p>
            <p className="truncate text-xs text-muted-foreground">{me.email}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{me.role === "ADMIN" ? "管理者" : "メンバー"}</p>
          </div>
          <button role="menuitem" onClick={logout} className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent">
            <LogOut className="h-4 w-4" /> ログアウト
          </button>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setMobileOpen(false), [path]);

  return (
    <div className="min-h-screen">
      {/* デスクトップ: 固定サイドバー */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col gap-6 border-r bg-sidebar px-3 py-5 lg:flex">
        <Logo />
        <Nav />
        <p className="mt-auto px-3 text-[11px] leading-relaxed text-muted-foreground">送信は必ず承認を経て行われます。</p>
      </aside>

      {/* モバイル: ドロワー */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col gap-6 bg-sidebar px-3 py-5 shadow-xl">
            <div className="flex items-center justify-between">
              <Logo />
              <button onClick={() => setMobileOpen(false)} className="rounded-md p-1.5 hover:bg-accent" aria-label="メニューを閉じる">
                <X className="h-5 w-5" />
              </button>
            </div>
            <Nav onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur sm:px-6">
          <button className="-ml-1 rounded-md p-2 hover:bg-accent lg:hidden" onClick={() => setMobileOpen(true)} aria-label="メニューを開く">
            <Menu className="h-5 w-5" />
          </button>
          <div className="lg:hidden">
            <Logo />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <NotificationBell />
            <div className="mx-1 h-6 w-px bg-border" />
            <UserMenu />
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
