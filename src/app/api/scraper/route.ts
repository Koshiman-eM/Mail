import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { PLATFORMS } from "@/lib/scraper/policy";
import { scrapeQueue } from "@/lib/scraper/queue";
import { handler } from "../_lib/http";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const states = await prisma.scraperState.findMany();
  const map = new Map(states.map((s) => [s.platform, s]));
  return NextResponse.json(
    PLATFORMS.map((p) => ({ platform: p, paused: map.get(p)?.paused ?? false, reason: map.get(p)?.reason ?? null, pausedAt: map.get(p)?.pausedAt ?? null })),
  );
});

const resumeSchema = z.object({ platform: z.enum(["ALIBABA", "ALI1688", "ALIEXPRESS"]) });

/** 手動再認証完了後にスクレイピングを再開 */
export const POST = handler(async (req: Request) => {
  const { platform } = resumeSchema.parse(await req.json());
  await prisma.$transaction([
    prisma.scraperState.upsert({
      where: { platform },
      create: { platform, paused: false },
      update: { paused: false, reason: null, pausedAt: null },
    }),
    prisma.auditLog.create({
      data: { actor: env.operatorName, action: "scraper.resume", entityType: "ScraperState", entityId: platform },
    }),
  ]);
  if (env.redisUrl) await scrapeQueue(platform).resume();
  return NextResponse.json({ platform, paused: false });
});
