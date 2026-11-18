import { NextResponse } from "next/server";
import { sendPushToUser } from "@/lib/push/send";
import { handler } from "../../_lib/http";

/** 現在のユーザーの端末にだけテスト通知を送る */
export const POST = handler(async (_req, _ctx, user) => {
  const result = await sendPushToUser(user.id, {
    title: "テスト通知",
    body: "越境せどりからの通知はこのように表示されます。",
    url: "/settings",
    tag: "push-test",
    severity: "INFO",
  });
  return NextResponse.json(result);
});
