import { NextResponse } from "next/server";
import { addDiscoveredItem, dismissDiscoveredItem } from "@/lib/discovery/service";
import { actorOf, handler } from "../../../../_lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/discover/items/:id/add      仕入れ候補に追加 (自動追加と同じ経路。登録済みなら紐付けのみ)
 * POST /api/discover/items/:id/dismiss  除外 (再探索でも復活しない)
 */
export const POST = handler(async (_req: Request, { params }: { params: Promise<{ id: string; action: string }> }, user) => {
  const { id, action } = await params;
  if (action === "add") return NextResponse.json(await addDiscoveredItem(id, actorOf(user)));
  if (action === "dismiss") return NextResponse.json(await dismissDiscoveredItem(id, actorOf(user)));
  return NextResponse.json({ error: "不明な操作です" }, { status: 404 });
});
