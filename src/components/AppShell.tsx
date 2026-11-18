"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Calculator, ChevronDown, LayoutDashboard, LogOut, MessagesSquare, Package, Settings, Telescope } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { BottomNav } from "./BottomNav";
import { InstallButton } from "./InstallPrompt";
import { NotificationBell } from "./NotificationBell";
import { PwaSuggestions } from "./PwaSuggestions";
import { ThemeToggle } from "./theme";
import { useDashboard, useMe } from "./hooks";
import { api } from "./api";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "ダッシュボード", icon: LayoutDashboard },
  { href: "/products", label: "仕入れ候補", icon: Package },
  { href: "/discover", label: "自動探索", icon: Telescope },
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
        <span className="block text-[11px] text-muted-foreground max-[379px]:hidden">仕入れ・交渉管理</span>
      </span>
    </Link>
  );
}

/** 業者チャットの対応待ち件数 (承認待ち + 送信待ち + 送信失敗) */
function useChatCount() {
  const { data } = useDashboard();
  return (data?.awaitingApproval ?? 0) + (data?.awaitingSend ?? 0) + (data?.sendFailed ?? 0);
}

function Nav({ chatCount }: { chatCount: number }) {
  const path = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(({ href, label, icon: Icon, badge }) => {
        const active = href === "/" ? path === "/" : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
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
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-10 items-center gap-2 rounded-lg p-1 hover:bg-accent sm:pr-2"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`ユーザーメニュー (${me.name})`}
      >
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
  const chatCount = useChatCount();
  const path = usePathname();

  return (
    <div className="min-h-screen">
      {/* デスクトップ: 固定サイドバー */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col gap-6 border-r bg-sidebar px-3 py-5 lg:flex">
        <Logo />
        <Nav chatCount={chatCount} />
        <p className="mt-auto px-3 text-[11px] leading-relaxed text-muted-foreground">送信は必ず承認を経て行われます。</p>
      </aside>

      <div className="lg:pl-60">
        {/* スタンドアロン表示ではステータスバー (ノッチ) 分の余白を確保する */}
        <header className="sticky top-0 z-20 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur">
          <div className="flex h-14 items-center gap-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:px-6">
            <div className="min-w-0 lg:hidden">
              <Logo />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
              <InstallButton />
              <ThemeToggle />
              <NotificationBell />
              <div className="mx-1 hidden h-6 w-px bg-border sm:block" />
              <UserMenu />
            </div>
          </div>
        </header>
        {/* モバイルでは下部タブバーに隠れないよう下余白を確保する */}
        <main className="mx-auto max-w-7xl px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 lg:py-8">
          {path === "/" && <PwaSuggestions />}
          {children}
        </main>
      </div>

      {/* モバイル: 下部タブバー (ドロワーの代わり) */}
      <BottomNav chatCount={chatCount} />
    </div>
  );
}
