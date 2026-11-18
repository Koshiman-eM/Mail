import { NextResponse } from "next/server";
import { handler } from "../../_lib/http";

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: Request, _ctx, user) => NextResponse.json(user));
