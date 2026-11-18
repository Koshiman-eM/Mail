import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { PASSWORD_MIN_LENGTH, hashPassword } from "@/lib/auth/password";
import { actorOf, handler } from "../../_lib/http";

const schema = z.object({
  role: z.enum(["ADMIN", "MEMBER"]).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(200).optional(),
});

export const PATCH = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }, actor) => {
  const { id } = await params;
  const body = schema.parse(await req.json());
  if (id === actor.id && (body.disabled || body.role === "MEMBER")) {
    return NextResponse.json({ error: "自分自身の無効化・権限変更はできません" }, { status: 400 });
  }
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id },
      data: {
        role: body.role,
        disabled: body.disabled,
        ...(body.password && { passwordHash: await hashPassword(body.password) }),
      },
      select: { id: true, email: true, name: true, role: true, disabled: true },
    });
    // 無効化・パスワード変更時は既存セッションを失効させる
    if (body.disabled || body.password) await tx.session.deleteMany({ where: { userId: id } });
    await tx.auditLog.create({
      data: {
        actor: actorOf(actor),
        action: "user.update",
        entityType: "User",
        entityId: id,
        after: { role: body.role, disabled: body.disabled, passwordChanged: Boolean(body.password) },
      },
    });
    return u;
  });
  return NextResponse.json(updated);
}, { role: "ADMIN" });
