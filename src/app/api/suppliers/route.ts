import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handler } from "../_lib/http";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  return NextResponse.json(await prisma.supplier.findMany({ orderBy: { name: "asc" } }));
});
