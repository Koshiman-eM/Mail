import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { publicHandler } from "../../_lib/http";

export const dynamic = "force-dynamic";

/** ログイン画面用: 初期管理者の作成が必要かどうか */
export const GET = publicHandler(async () => {
  const count = await prisma.user.count();
  return NextResponse.json({ needsSetup: count === 0 });
});
