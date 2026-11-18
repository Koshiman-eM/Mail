import { NextResponse } from "next/server";
import { autoSimulate } from "@/lib/profit/autoService";
import { handler } from "../../../_lib/http";

export const POST = handler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return NextResponse.json(await autoSimulate(id, "manual"));
});
