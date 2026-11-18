import { NextResponse } from "next/server";
import { recalcAll } from "@/lib/profit/autoService";
import { handler } from "../../_lib/http";

/** 全商品の利益を再計算 */
export const POST = handler(async () => NextResponse.json(await recalcAll("manual")));
