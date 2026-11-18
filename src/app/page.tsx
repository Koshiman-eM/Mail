import Link from "next/link";
import { Calculator, MessageSquare, Package, Settings } from "lucide-react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const ITEMS = [
  { href: "/calculator", icon: Calculator, title: "利益計算", desc: "為替バッファ・段階単価・容積重量・関税/輸入消費税まで含めた利益と ROI" },
  { href: "/products", icon: Package, title: "商品", desc: "仕入れ候補の登録、価格・在庫の巡回取得、シミュレーション履歴" },
  { href: "/chat", icon: MessageSquare, title: "業者チャット", desc: "原文と日本語訳を並列表示。AI 返信案を確認・編集し承認後に送信" },
  { href: "/settings", icon: Settings, title: "設定", desc: "スクレイピング停止状態の確認と再開、業者のブラックリスト管理" },
];

export default function Home() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">ダッシュボード</h1>
      <div className="grid gap-4 sm:grid-cols-2">
        {ITEMS.map(({ href, icon: Icon, title, desc }) => (
          <Link key={href} href={href}>
            <Card className="h-full transition-colors hover:bg-accent/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Icon className="h-5 w-5" /> {title}
                </CardTitle>
                <CardDescription>{desc}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
