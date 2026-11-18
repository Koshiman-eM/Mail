import type { Store } from "../core/types";

/** 別プロセスの CLI からエンジンへ再開を依頼する kv キー */
export const RESUME_REQUEST_KEY = "risk:resumeRequested";

export interface ResumeRequest {
  at: number;
  by: string;
}

/** 再開要求を書く (エンジンが次のティックで risk.resume() を実行する) */
export function requestResume(store: Store, req: ResumeRequest): void {
  store.kvSet<ResumeRequest>(RESUME_REQUEST_KEY, req);
}

/** 再開要求を読む (消さない) */
export function peekResumeRequest(store: Store): ResumeRequest | undefined {
  const v = store.kvGet<ResumeRequest>(RESUME_REQUEST_KEY);
  return v && typeof v === "object" && typeof v.at === "number" ? v : undefined;
}

/** 再開要求を消す */
export function clearResumeRequest(store: Store): void {
  store.kvSet<ResumeRequest | undefined>(RESUME_REQUEST_KEY, undefined);
}
