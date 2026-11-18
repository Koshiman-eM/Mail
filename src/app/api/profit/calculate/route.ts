import { NextResponse } from "next/server";
import { calculateProfit, profitInputSchema } from "@/lib/profit";
import { handler } from "../../_lib/http";

export const POST = handler(async (req: Request) => {
  const input = profitInputSchema.parse(await req.json());
  return NextResponse.json(calculateProfit(input));
});
