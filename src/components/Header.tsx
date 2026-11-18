"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NotificationBell } from "./NotificationBell";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "ダッシュボード" },
  { href: "/calculator", label: "利益計算" },
  { href: "/products", label: "商品" },
  { href: "/chat", label: "業者チャット" },
  { href: "/settings", label: "設定" },
];

export function Header() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <Link href="/" className="shrink-0 font-bold">
          越境せどり
        </Link>
        <nav className="flex min-w-0 flex-1 gap-1 overflow-x-auto text-sm">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                "whitespace-nowrap rounded-md px-3 py-1.5 hover:bg-accent",
                (n.href === "/" ? path === "/" : path.startsWith(n.href)) && "bg-accent font-medium",
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <NotificationBell />
      </div>
    </header>
  );
}
