import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { NotFoundError } from "@/lib/chat/service";
import { handler } from "../../_lib/http";

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      supplier: true,
      snapshots: { orderBy: { capturedAt: "desc" }, take: 50 },
      simulations: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!product) throw new NotFoundError(`Product(${id})`);
  return NextResponse.json(product);
});
