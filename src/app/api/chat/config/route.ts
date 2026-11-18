import { NextResponse } from "next/server";
import { getSupplierAdapter, sendModeOf } from "@/lib/suppliers";
import { handler } from "../../_lib/http";

export const dynamic = "force-dynamic";

/** チャット送信方式 (UI の表示切替用)。handoff: 業者アプリで本人が送る / mock: 開発用 / external: アプリから送信 */
export const GET = handler(async () => NextResponse.json({ sendMode: sendModeOf(getSupplierAdapter()) }));
