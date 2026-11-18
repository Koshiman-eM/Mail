import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth/session";
import { publicHandler } from "../../_lib/http";

export const POST = publicHandler(async () => {
  await destroySession();
  return NextResponse.json({ ok: true });
});
