"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Calculator, Loader2, MessagesSquare, ShieldCheck, TrendingDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { api } from "@/components/api";
import { ThemeToggle } from "@/components/theme";

const FEATURES = [
  { icon: Calculator, title: "諸経費込みの利益計算", desc: "為替バッファ・容積重量・関税/消費税まで一括計上" },
  { icon: TrendingDown, title: "価格・在庫の変動監視", desc: "変動や CAPTCHA 検知をリアルタイムに通知" },
  { icon: MessagesSquare, title: "承認制の業者チャット", desc: "AI 返信案を確認・編集してから送信" },
];

function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const next = sp.get("next");
  const status = useQuery({ queryKey: ["auth-status"], queryFn: () => api<{ needsSetup: boolean }>("/api/auth/status") });
  const setup = status.data?.needsSetup ?? false;
  const [form, setForm] = useState({ email: "", password: "", name: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(setup ? "/api/auth/setup" : "/api/auth/login", { method: "POST", json: setup ? form : { email: form.email, password: form.password } });
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-[#0f2a4d] p-12 text-white lg:flex">
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-[#2a78d6]/40 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 left-10 h-80 w-80 rounded-full bg-[#1baf7a]/20 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-lg font-black text-[#0f2a4d]">越</span>
          <span className="text-lg font-bold">越境せどり</span>
        </div>
        <div className="relative space-y-8">
          <h1 className="text-3xl font-bold leading-snug">
            海外仕入れの利益判断から
            <br />
            業者交渉まで、ひとつの画面で。
          </h1>
          <ul className="space-y-5">
            {FEATURES.map(({ icon: Icon, title, desc }) => (
              <li key={title} className="flex gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10">
                  <Icon className="h-5 w-5" />
                </span>
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="block text-sm text-white/70">{desc}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/50">Alibaba.com / 1688.com / AliExpress 対応</p>
      </section>

      <section className="flex flex-col">
        <div className="flex justify-end p-4">
          <ThemeToggle />
        </div>
        <div className="flex flex-1 items-center justify-center px-6 pb-16">
          <form onSubmit={submit} className="w-full max-w-sm space-y-5">
            <div className="space-y-1.5">
              <div className="mb-6 flex items-center gap-2 lg:hidden">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary font-black text-primary-foreground">越</span>
                <span className="font-bold">越境せどり</span>
              </div>
              <h2 className="text-2xl font-bold tracking-tight">{setup ? "初期管理者を作成" : "ログイン"}</h2>
              <p className="text-sm text-muted-foreground">
                {setup ? "最初のユーザーは管理者になります。以降のユーザーは設定画面から追加できます。" : "アカウント情報を入力してください。"}
              </p>
            </div>
            {setup && (
              <div className="space-y-1.5">
                <Label htmlFor="name">表示名</Label>
                <Input id="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">メールアドレス</Label>
              <Input id="email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">パスワード{setup && " (10文字以上)"}</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={setup ? 10 : undefined}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                autoComplete={setup ? "new-password" : "current-password"}
              />
            </div>
            {error && <p className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{error}</p>}
            <Button type="submit" size="lg" className="w-full" disabled={busy || status.isLoading}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {setup ? "作成してはじめる" : "ログイン"}
            </Button>
            <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" /> 業者への送信はすべて承認後にのみ行われます
            </p>
          </form>
        </div>
      </section>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
