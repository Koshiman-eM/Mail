"use client";

import Link from "next/link";
import { AlertOctagon, ArrowRight, CircleCheck, CirclePause, Inbox, MessageSquareReply, Package, TrendingUp } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader, Skeleton, StatCard } from "@/components/ui/misc";
import { RoiBars } from "@/components/charts";
import { SeverityBadge } from "@/components/severity";
import { PLATFORM_LABEL, relTime } from "@/components/api";
import { useDashboard, useMe } from "@/components/hooks";
import { CHAT_STATUS } from "@/components/chatStatus";

function greeting() {
  const h = new Date().getHours();
  return h < 11 ? "おはようございます" : h < 18 ? "こんにちは" : "おつかれさまです";
}

export default function Dashboard() {
  const { data, isLoading } = useDashboard();
  const { data: me } = useMe();

  return (
    <div className="space-y-6">
      <PageHeader
        title={me ? `${greeting()}、${me.name}さん` : "ダッシュボード"}
        description="仕入れ候補の収益性と、対応が必要な項目をまとめています。"
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/products">候補を追加</Link>
            </Button>
            <Button asChild>
              <Link href="/calculator">利益を計算</Link>
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {isLoading || !data ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[110px] rounded-xl" />)
        ) : (
          <>
            <StatCard
              label="承認待ちの返信"
              value={data.awaitingApproval}
              icon={MessageSquareReply}
              tone={data.awaitingApproval > 0 ? "warning" : "default"}
              hint={`送信待ち ${data.awaitingSend} 件${data.sendFailed ? ` ・ 送信失敗 ${data.sendFailed} 件` : ""}`}
            />
            <StatCard
              label="平均 ROI (最新試算)"
              value={data.avgRoi === null ? "—" : `${data.avgRoi.toFixed(1)}%`}
              icon={TrendingUp}
              tone="success"
              hint={data.simulatedCount ? `${data.simulatedCount} 商品中 ${data.profitableCount} 商品が黒字` : "試算を保存すると集計されます"}
            />
            <StatCard
              label="仕入れ候補"
              value={data.productCount}
              icon={Package}
              hint={`取引可能な業者 ${data.supplierCount} 社${data.outOfStock ? ` ・ 在庫切れ ${data.outOfStock} 件` : ""}`}
            />
            <StatCard
              label="未読の重要通知"
              value={data.unreadCritical}
              icon={AlertOctagon}
              tone={data.unreadCritical > 0 ? "destructive" : "default"}
              hint={`未読通知 合計 ${data.unreadTotal} 件`}
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <CardTitle>承認キュー</CardTitle>
              <CardDescription>AI 返信案の承認・送信を待っているメッセージ</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/chat">
                すべて見る <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {!data ? (
              <Skeleton className="h-40" />
            ) : data.queue.length === 0 ? (
              <EmptyState icon={Inbox} title="対応待ちはありません">
                業者からの新着メッセージを取り込むと、AI が返信案を作成してここに表示します。
              </EmptyState>
            ) : (
              <ul className="divide-y">
                {data.queue.map((m) => {
                  const st = CHAT_STATUS[m.status as keyof typeof CHAT_STATUS];
                  return (
                    <li key={m.id}>
                      <Link href={`/chat?thread=${encodeURIComponent(m.threadId)}`} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-3 hover:bg-accent">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-bold">{m.supplier.slice(0, 1)}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{m.supplier}</span>
                            <Badge variant={st.variant}>{st.label}</Badge>
                          </span>
                          <span className="block truncate text-[13px] text-muted-foreground">{m.text}</span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{relTime(m.updatedAt)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>ROI 上位の商品</CardTitle>
            <CardDescription>各商品の最新シミュレーション結果</CardDescription>
          </CardHeader>
          <CardContent>{!data ? <Skeleton className="h-40" /> : <RoiBars items={data.topRoi.map((t) => ({ id: t.id, label: t.label, roi: t.roi }))} />}</CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>最近の通知</CardTitle>
            <CardDescription>価格・在庫の変動、再認証の要求など</CardDescription>
          </CardHeader>
          <CardContent>
            {!data ? (
              <Skeleton className="h-40" />
            ) : data.recentAlerts.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">通知はまだありません</p>
            ) : (
              <ul className="space-y-1">
                {data.recentAlerts.map((n) => {
                  const inner = (
                    <>
                      <SeverityBadge severity={n.severity} />
                      <span className="min-w-0 flex-1 truncate text-sm">{n.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{relTime(n.createdAt)}</span>
                    </>
                  );
                  return (
                    <li key={n.id}>
                      {n.link ? (
                        <Link href={n.link} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent">
                          {inner}
                        </Link>
                      ) : (
                        <div className="-mx-2 flex items-center gap-3 px-2 py-2">{inner}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <CardTitle>巡回ステータス</CardTitle>
              <CardDescription>CAPTCHA 検知時は自動で停止します</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/settings">管理</Link>
            </Button>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {data?.scrapers.map((s) => (
                <li key={s.platform} className="flex items-center justify-between rounded-lg border px-3 py-2.5">
                  <span className="text-sm font-medium">{PLATFORM_LABEL[s.platform]}</span>
                  {s.paused ? (
                    <Badge variant="destructive">
                      <CirclePause className="h-3 w-3" /> 停止中・要再認証
                    </Badge>
                  ) : (
                    <Badge variant="success">
                      <CircleCheck className="h-3 w-3" /> 稼働中
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
