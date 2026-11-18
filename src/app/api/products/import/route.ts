import { NextResponse } from "next/server";
import { z } from "zod";
import { UnsupportedUrlError, importProduct } from "@/lib/jobs/importProduct";
import { createHttpFetcher } from "@/lib/scraper/httpFetcher";
import { readLimitedJson } from "../../_lib/body";
import { actorOf, handler } from "../../_lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z
  .object({
    url: z.string().max(4000).optional(),
    text: z.string().max(10_000).optional(),
    html: z.string().max(5_000_000).optional(),
  })
  .refine((v) => (v.url && v.url.trim()) || (v.text && v.text.trim()), { message: "url または text を指定してください" });

/**
 * 商品 URL (または共有テキスト) から仕入れ候補を登録する。
 * 同じ商品が登録済みなら `{ product, existed: true }`、新規なら `{ product, existed: false, fetch }` (201)。
 * 対応外の URL は 422。ページの取得は Web プロセスでも動く HTTP 取得で 1 回だけ行う。
 */
export const POST = handler(async (req: Request, _ctx, user) => {
  // 貼り付けソース (最大 5MB) を含みうるため、約 6MB を超える本文は読む前/読みながら拒否する (413)
  const raw = await readLimitedJson(req);
  if (!raw.ok) return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  const body = schema.parse(raw.json);
  const fetcher = createHttpFetcher();
  try {
    const r = await importProduct(body, { fetcher, actor: actorOf(user) });
    return NextResponse.json(r, { status: r.existed ? 200 : 201 });
  } catch (e) {
    if (e instanceof UnsupportedUrlError) return NextResponse.json({ error: e.message, code: e.name }, { status: 422 });
    throw e;
  } finally {
    await fetcher.close();
  }
});
