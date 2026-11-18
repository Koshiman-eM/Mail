import { NextResponse } from "next/server";
import { aiConfigured } from "@/lib/ai/claude";
import { domesticProviderStatus } from "@/lib/discovery/domestic";
import { handler } from "../../_lib/http";

export const dynamic = "force-dynamic";

/** 国内価格の取得元の設定状況 (環境変数から判定。キーの値は返さない) */
export const GET = handler(async () => NextResponse.json({ providers: domesticProviderStatus(), translation: aiConfigured() }));
