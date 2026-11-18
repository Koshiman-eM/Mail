import type { Platform } from "@prisma/client";
import { prisma } from "../db/prisma";
import { notify } from "../notifications/service";
import type { BlockKind } from "../scraper/detect";
import { ManualReauthRequiredError } from "../scraper/errors";
import { PLATFORM_NAME } from "./common";

/** DB (ScraperState) 上の停止状態。Redis の有無に関わらずこれが正 */
export async function isPlatformPaused(platform: Platform): Promise<boolean> {
  const s = await prisma.scraperState.findUnique({ where: { platform } });
  return !!s?.paused;
}

export async function pausedPlatforms(): Promise<Set<Platform>> {
  const states = await prisma.scraperState.findMany({ where: { paused: true } });
  return new Set(states.map((s) => s.platform));
}

/**
 * CAPTCHA / セッション切れ検知時: 自動突破はせず、プラットフォームの巡回を停止して手動再認証を促す CRITICAL 通知を出す。
 * 既に停止中なら通知は重複させない。BullMQ キューの停止は呼び出し側 (ワーカー) が行う。
 */
export async function pausePlatformForReauth(platform: Platform, kind: BlockKind, url: string): Promise<{ alreadyPaused: boolean; message: string }> {
  const err = new ManualReauthRequiredError(kind, url);
  const before = await prisma.scraperState.findUnique({ where: { platform } });
  await prisma.scraperState.upsert({
    where: { platform },
    create: { platform, paused: true, reason: err.message, pausedAt: new Date() },
    update: { paused: true, reason: err.message, ...(before?.paused ? {} : { pausedAt: new Date() }) },
  });
  if (!before?.paused) {
    await notify({
      type: "REAUTH_REQUIRED",
      severity: "CRITICAL",
      title: `${PLATFORM_NAME[platform]}: 手動での再認証が必要です`,
      body: `${err.message}\nブラウザでログイン/認証を完了し、セッションを更新してから設定画面の「再開」を押してください。自動での突破は行いません。`,
      link: "/settings",
      meta: { platform, kind },
    });
  }
  return { alreadyPaused: !!before?.paused, message: err.message };
}
