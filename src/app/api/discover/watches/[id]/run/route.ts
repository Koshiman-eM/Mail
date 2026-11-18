import { NextResponse } from "next/server";
import { startManualRun } from "@/lib/discovery/service";
import { createHttpFetcher } from "@/lib/scraper/httpFetcher";
import { actorOf, handler } from "../../../../_lib/http";

export const dynamic = "force-dynamic";

/**
 * 「今すぐ探索」: 同じ条件は 10 分に 1 回まで (超過は 429)。探索はバックグラウンドで行い、すぐ 202 を返す。
 * 画面は GET /api/discover/watches の running / lastRunStatus をポーリングして完了を待つ。
 * Web プロセスにはブラウザが無いため HTTP 取得を使う (CAPTCHA 等で取れない場合は定期ジョブの Playwright に任せる)。
 */
export const POST = handler(async (_req: Request, { params }: { params: Promise<{ id: string }> }, user) => {
  const { id } = await params;
  await startManualRun(id, { actor: actorOf(user), getFetcher: async () => createHttpFetcher() });
  return NextResponse.json({ started: true }, { status: 202 });
});
