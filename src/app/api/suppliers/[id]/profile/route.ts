import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { NotFoundError } from "@/lib/chat/service";
import { InvalidChatUrlError, normalizeChatUrl } from "@/lib/suppliers/chatUrl";
import { actorOf, handler } from "../../../_lib/http";

export const dynamic = "force-dynamic";

const urlOrNull = z.string().max(2000, "URL が長すぎます (2000 文字まで)").nullable().optional();
const schema = z.object({
  name: z.string().trim().min(1, "業者名を入力してください").max(200).optional(),
  externalId: z.string().trim().min(1).max(128).optional(),
  shopUrl: urlOrNull,
  chatUrl: urlOrNull,
});

class DuplicateExternalIdError extends Error {}

/** http / https の URL だけを受け付ける (javascript: 等は拒否)。空文字・null は登録解除 */
function normalizeUrlField(label: string, v: string | null | undefined): string | null {
  try {
    return normalizeChatUrl(v);
  } catch (e) {
    if (e instanceof InvalidChatUrlError) throw new InvalidChatUrlError(`${label}: ${e.message}`);
    throw e;
  }
}

/** 業者の基本情報 (名前・ID・ショップ URL・チャット URL) を更新する */
export const PATCH = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }, user) => {
  const { id } = await params;
  const body = schema.parse(await req.json());
  const data: Prisma.SupplierUpdateInput = {};
  try {
    if (body.name !== undefined) data.name = body.name;
    if (body.shopUrl !== undefined) data.shopUrl = normalizeUrlField("ショップ URL", body.shopUrl);
    if (body.chatUrl !== undefined) data.chatUrl = normalizeUrlField("チャット URL", body.chatUrl);
  } catch (e) {
    if (e instanceof InvalidChatUrlError) return NextResponse.json({ error: e.message, code: e.name }, { status: 400 });
    throw e;
  }
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const before = await tx.supplier.findUnique({ where: { id } });
      if (!before) throw new NotFoundError(`Supplier(${id})`);
      if (body.externalId !== undefined && body.externalId !== before.externalId) {
        const dup = await tx.supplier.findUnique({ where: { platform_externalId: { platform: before.platform, externalId: body.externalId } } });
        if (dup) throw new DuplicateExternalIdError();
        data.externalId = body.externalId;
      }
      const s = await tx.supplier.update({ where: { id }, data });
      await tx.auditLog.create({
        data: {
          actor: actorOf(user),
          action: "supplier.profile_update",
          entityType: "Supplier",
          entityId: id,
          before: { name: before.name, externalId: before.externalId, shopUrl: before.shopUrl, chatUrl: before.chatUrl },
          after: data as Prisma.InputJsonValue,
        },
      });
      return s;
    });
    return NextResponse.json(updated);
  } catch (e) {
    // 同時更新で一意制約 (platform, externalId) に違反した場合も 409
    if (e instanceof DuplicateExternalIdError || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) {
      return NextResponse.json({ error: "同じ業者 ID の業者が既に登録されています" }, { status: 409 });
    }
    throw e;
  }
});
