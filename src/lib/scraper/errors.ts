/** 手動での再認証が必要な状態 (自動突破は行わない) */
export class ManualReauthRequiredError extends Error {
  constructor(public readonly kind: "captcha" | "login" | "blocked", public readonly url: string) {
    super(`${kind === "captcha" ? "CAPTCHA" : kind === "login" ? "セッション切れ" : "アクセス制限"}を検知しました: ${url}`);
    this.name = "ManualReauthRequiredError";
  }
}
