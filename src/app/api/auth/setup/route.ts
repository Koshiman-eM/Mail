import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { PASSWORD_MIN_LENGTH, hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { publicHandler } from "../../_lib/http";

const schema = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(100),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(200),
});

/** ユーザーが1人もいない場合に限り、最初の管理者を作成する */
export const POST = publicHandler(async (req: Request) => {
  const body = schema.parse(await req.json());
  const passwordHash = await hashPassword(body.password);
  const user = await prisma.$transaction(async (tx) => {
    if ((await tx.user.count()) > 0) return null;
    const u = await tx.user.create({
      data: { email: body.email.trim().toLowerCase(), name: body.name.trim(), passwordHash, role: "ADMIN" },
    });
    await tx.auditLog.create({ data: { actor: `${u.name} <${u.email}>`, action: "auth.setup", entityType: "User", entityId: u.id } });
    return u;
  }, { isolationLevel: "Serializable" });
  if (!user) return NextResponse.json({ error: "初期設定は完了しています" }, { status: 409 });
  await createSession(user.id, req.headers.get("user-agent"));
  return NextResponse.json({ ok: true }, { status: 201 });
});
