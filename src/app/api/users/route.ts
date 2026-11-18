import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { PASSWORD_MIN_LENGTH, hashPassword } from "@/lib/auth/password";
import { actorOf, handler } from "../_lib/http";

export const dynamic = "force-dynamic";

const publicFields = { id: true, email: true, name: true, role: true, disabled: true, lastLoginAt: true, createdAt: true } as const;

export const GET = handler(async () => {
  return NextResponse.json(await prisma.user.findMany({ select: publicFields, orderBy: { createdAt: "asc" } }));
}, { role: "ADMIN" });

const createSchema = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(100),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(200),
  role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
});

export const POST = handler(async (req: Request, _ctx, actor) => {
  const body = createSchema.parse(await req.json());
  const email = body.email.trim().toLowerCase();
  if (await prisma.user.findUnique({ where: { email } })) {
    return NextResponse.json({ error: "このメールアドレスは登録済みです" }, { status: 409 });
  }
  const user = await prisma.user.create({
    data: { email, name: body.name.trim(), role: body.role, passwordHash: await hashPassword(body.password) },
    select: publicFields,
  });
  await prisma.auditLog.create({
    data: { actor: actorOf(actor), action: "user.create", entityType: "User", entityId: user.id, after: { email, role: body.role } },
  });
  return NextResponse.json(user, { status: 201 });
}, { role: "ADMIN" });
