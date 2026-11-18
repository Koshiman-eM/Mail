export type BlockKind = "captcha" | "login" | "blocked";

const CAPTCHA_PATTERNS = [
  /nc_1_n1z|nocaptcha|slide to verify|滑动验证|请按住滑块|baxia-dialog|punish\?x5secdata/i,
  /recaptcha|hcaptcha|captcha/i,
];
const LOGIN_PATTERNS = [/login\.(alibaba|1688|aliexpress|taobao)\.com/i, /passport\.(alibaba|1688|aliexpress)\.com/i, /请登录|sign in to continue/i];
const BLOCKED_PATTERNS = [/access denied|访问被拒绝|too many requests/i];

/**
 * 取得したページが CAPTCHA / ログイン要求 / ブロックかどうかを判定する。
 * 判定された場合、ワーカーは自動突破を試みず一時停止して手動再認証を促す。
 */
export function detectBlock(input: { url: string; html: string; status?: number }): BlockKind | null {
  const { url, html, status } = input;
  if (LOGIN_PATTERNS.some((p) => p.test(url))) return "login";
  if (CAPTCHA_PATTERNS.some((p) => p.test(url) || p.test(html))) return "captcha";
  if (LOGIN_PATTERNS.some((p) => p.test(html)) && html.length < 50_000) return "login";
  if (status === 403 || status === 429 || BLOCKED_PATTERNS.some((p) => p.test(html))) return "blocked";
  return null;
}
