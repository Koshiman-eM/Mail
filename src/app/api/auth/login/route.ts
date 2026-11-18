import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { clearFailures, isLocked, recordFailure } from "@/lib/auth/rateLimit";
import { publicHandler } from "../../_lib/http";

const schema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export const POST = publicHandler(async (req: Request) => {
  const { email, password } = schema.parse(await req.json());
  const normalized = email.trim().toLowerCase();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  const keys = [`email:${normalized}`, `ip:${ip}`];
  if (isLocked(keys)) {
    return NextResponse.json({ error: "ログイン試行回数が多すぎます。しばらく待ってから再試行してください" }, { status: 429 });
  }

  const user = await prisma.user.findUnique({ where: { email: normalized } });
  // ユーザー有無で応答時間が変わらないよう、存在しない場合もダミー検証を行う
  const ok = await verifyPassword(password, user?.passwordHash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
  if (!user || !ok || user.disabled) {
    recordFailure(keys);
    return NextResponse.json({ error: "メールアドレスまたはパスワードが正しくありません" }, { status: 401 });
  }
  clearFailures(keys);
  await createSession(user.id, req.headers.get("user-agent"));
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    prisma.auditLog.create({ data: { actor: `${user.name} <${user.email}>`, action: "auth.login", entityType: "User", entityId: user.id } }),
  ]);
  return NextResponse.json({ ok: true });
});
