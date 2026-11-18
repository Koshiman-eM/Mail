import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ApprovalGuardError, BlacklistedSupplierError, ConcurrentModificationError, NotFoundError } from "@/lib/chat/service";
import { InvalidTransitionError } from "@/lib/chat/stateMachine";
import { InvalidProfitInputError, MoqNotMetError } from "@/lib/profit";
import { AiRefusalError } from "@/lib/ai/claude";
import { ForbiddenError, UnauthorizedError, requireUser, type SessionUser } from "@/lib/auth/session";
import { DiscoveryActionError, DiscoveryCooldownError, DiscoveryNotFoundError } from "@/lib/discovery/errors";
import { PayloadTooLargeError } from "./body";

/** ドメイン例外を HTTP ステータスへ変換する */
export function toErrorResponse(e: unknown) {
  if (e instanceof UnauthorizedError) return NextResponse.json({ error: e.message }, { status: 401 });
  if (e instanceof ForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
  if (e instanceof PayloadTooLargeError) return NextResponse.json({ error: e.message, code: e.name }, { status: 413 });
  if (e instanceof ZodError) {
    const first = e.issues[0];
    const detail = first ? `${first.path.length ? `${first.path.join(".")}: ` : ""}${first.message}` : "";
    return NextResponse.json({ error: detail ? `入力が不正です (${detail})` : "入力が不正です", issues: e.issues }, { status: 400 });
  }
  if (e instanceof MoqNotMetError || e instanceof InvalidProfitInputError)
    return NextResponse.json({ error: e.message }, { status: 422 });
  if (e instanceof NotFoundError || e instanceof DiscoveryNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
  if (e instanceof DiscoveryCooldownError)
    return NextResponse.json({ error: e.message, code: e.name }, { status: 429, headers: { "Retry-After": String(Math.max(1, e.retryAfterSec)) } });
  if (e instanceof DiscoveryActionError) return NextResponse.json({ error: e.message, code: e.name }, { status: 422 });
  if (
    e instanceof ApprovalGuardError ||
    e instanceof InvalidTransitionError ||
    e instanceof BlacklistedSupplierError ||
    e instanceof ConcurrentModificationError
  )
    return NextResponse.json({ error: e.message, code: e.name }, { status: 409 });
  if (e instanceof AiRefusalError) return NextResponse.json({ error: e.message, code: e.name }, { status: 422 });
  console.error(e);
  return NextResponse.json({ error: e instanceof Error ? e.message : "Internal Server Error" }, { status: 500 });
}

/**
 * Route Handler ラッパー。既定でログイン必須 (DB でセッションを検証) とし、
 * 例外を HTTP レスポンスへ変換する。ハンドラーには検証済みユーザーが渡される。
 */
export function handler<C = unknown>(
  fn: (req: Request, ctx: C, user: SessionUser) => Promise<Response>,
  opts: { role?: "ADMIN" } = {},
) {
  return async (req: Request, ctx: C) => {
    try {
      const user = await requireUser();
      if (opts.role && user.role !== opts.role) throw new ForbiddenError();
      return await fn(req, ctx, user);
    } catch (e) {
      return toErrorResponse(e);
    }
  };
}

/** ログイン不要のハンドラー (ログイン・初期設定のみ) */
export function publicHandler<C = unknown>(fn: (req: Request, ctx: C) => Promise<Response>) {
  return async (req: Request, ctx: C) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      return toErrorResponse(e);
    }
  };
}

/** 監査ログ等に記録する操作者表記 */
export const actorOf = (u: SessionUser) => `${u.name} <${u.email}>`;
