"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, MessagesSquare, Package, Settings, Telescope } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/", label: "ホーム", full: "ダッシュボード", icon: LayoutDashboard },
  { href: "/products", label: "仕入れ", full: "仕入れ候補", icon: Package },
  // 利益計算は仕入れ候補画面のボタン・デスクトップのサイドバーから開ける
  { href: "/discover", label: "探索", full: "自動探索", icon: Telescope },
  { href: "/chat", label: "チャット", full: "業者チャット", icon: MessagesSquare, badge: true },
  { href: "/settings", label: "設定", full: "設定", icon: Settings },
];

/** モバイル (lg 未満) 用の画面下部タブバー */
export function BottomNav({ chatCount }: { chatCount: number }) {
  const path = usePathname();
  return (
    <nav
      aria-label="メインメニュー"
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {TABS.map(({ href, label, full, icon: Icon, badge }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          const count = badge ? chatCount : 0;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                aria-label={count > 0 ? `${full} (対応待ち ${count} 件)` : full}
                className={cn(
                  "flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium [-webkit-tap-highlight-color:transparent] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <span className={cn("relative flex h-7 w-14 items-center justify-center rounded-full transition-colors", active && "bg-primary-soft")}>
                  <Icon className="h-5 w-5" aria-hidden="true" />
                  {count > 0 && (
                    <span className="absolute -top-1 right-1.5 min-w-[18px] rounded-full bg-warning px-1 text-center text-[10px] font-bold leading-[18px] text-[#0b0b0b]" aria-hidden="true">
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </span>
                <span className="max-w-full truncate leading-tight">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
