import { NextResponse } from "next/server";
import { getJpyRate } from "@/lib/fx";
import { env } from "@/lib/env";
import { handler } from "../_lib/http";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const base = new URL(req.url).searchParams.get("base") ?? "USD";
  const r = await getJpyRate(base);
  return NextResponse.json({
    base: base.toUpperCase(),
    quote: "JPY",
    rate: r.rate.toString(),
    fetchedAt: r.fetchedAt,
    source: r.source,
    stale: r.stale,
    defaultBufferPercent: env.fxDefaultBufferPercent,
  });
});
