import { NextResponse } from "next/server";
import { getVapidKeys } from "@/lib/push/vapid";
import { handler } from "../../_lib/http";

export const dynamic = "force-dynamic";

/** ブラウザの pushManager.subscribe に渡す VAPID 公開鍵 */
export const GET = handler(async () => {
  const { publicKey } = await getVapidKeys();
  return NextResponse.json({ publicKey }, { headers: { "cache-control": "no-store" } });
});
