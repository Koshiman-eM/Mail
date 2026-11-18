"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api } from "@/components/api";

interface ScraperState {
  platform: string;
  paused: boolean;
  reason: string | null;
  pausedAt: string | null;
}
interface Supplier {
  id: string;
  name: string;
  platform: string;
  rating: string | null;
  isBlacklisted: boolean;
  blacklistNote: string | null;
}

export default function SettingsPage() {
  const qc = useQueryClient();
  const states = useQuery({ queryKey: ["scraper"], queryFn: () => api<ScraperState[]>("/api/scraper") });
  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: () => api<Supplier[]>("/api/suppliers") });

  const resume = useMutation({
    mutationFn: (platform: string) => api("/api/scraper", { method: "POST", json: { platform } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scraper"] }),
  });
  const toggle = useMutation({
    mutationFn: (s: Supplier) => {
      const note = !s.isBlacklisted ? prompt("ブラックリスト登録の理由 (任意)") : null;
      return api(`/api/suppliers/${s.id}`, { method: "PATCH", json: { isBlacklisted: !s.isBlacklisted, blacklistNote: note } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suppliers"] }),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">設定</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">スクレイピング稼働状態</CardTitle>
          <CardDescription>
            CAPTCHA やセッション切れを検知すると自動突破は行わず、該当プラットフォームの巡回を停止します。ブラウザで手動ログイン/認証を行い、
            セッション (storageState) を更新してから「再開」を押してください。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {states.error && <p className="text-sm text-destructive">{states.error.message}</p>}
          {states.data?.map((s) => (
            <div key={s.platform} className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
              <span className="w-28 font-medium">{s.platform}</span>
              {s.paused ? <Badge variant="destructive">停止中</Badge> : <Badge variant="success">稼働中</Badge>}
              {s.reason && <span className="min-w-0 flex-1 break-words text-xs text-muted-foreground">{s.reason}</span>}
              {s.paused && (
                <Button size="sm" className="ml-auto" onClick={() => resume.mutate(s.platform)} disabled={resume.isPending}>
                  再認証完了・再開
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">業者</CardTitle>
          <CardDescription>ブラックリスト登録した業者へはチャット送信できません。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {suppliers.data?.length === 0 && <p className="text-sm text-muted-foreground">業者はまだ登録されていません。</p>}
          {suppliers.data?.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
              <span className="font-medium">{s.name}</span>
              <Badge variant="outline">{s.platform}</Badge>
              {s.isBlacklisted && <Badge variant="destructive">ブラックリスト</Badge>}
              {s.blacklistNote && <span className="text-xs text-muted-foreground">{s.blacklistNote}</span>}
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => toggle.mutate(s)} disabled={toggle.isPending}>
                {s.isBlacklisted ? "解除" : "ブラックリストに追加"}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
