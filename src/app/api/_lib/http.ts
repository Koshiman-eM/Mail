import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ApprovalGuardError, BlacklistedSupplierError, ConcurrentModificationError, NotFoundError } from "@/lib/chat/service";
import { InvalidTransitionError } from "@/lib/chat/stateMachine";
import { InvalidProfitInputError, MoqNotMetError } from "@/lib/profit";

/** ドメイン例外を HTTP ステータスへ変換する */
export function toErrorResponse(e: unknown) {
  if (e instanceof ZodError) return NextResponse.json({ error: "入力が不正です", issues: e.issues }, { status: 400 });
  if (e instanceof MoqNotMetError || e instanceof InvalidProfitInputError)
    return NextResponse.json({ error: e.message }, { status: 422 });
  if (e instanceof NotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
  if (e instanceof ApprovalGuardError || e instanceof InvalidTransitionError || e instanceof BlacklistedSupplierError)
    return NextResponse.json({ error: e.message, code: e.name }, { status: 409 });
  if (e instanceof ConcurrentModificationError) return NextResponse.json({ error: e.message, code: e.name }, { status: 409 });
  console.error(e);
  return NextResponse.json({ error: e instanceof Error ? e.message : "Internal Server Error" }, { status: 500 });
}

export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      return toErrorResponse(e);
    }
  };
}

/** 監査ログ用の操作者名 (認証導入までは環境変数で設定) */
export { env } from "@/lib/env";
