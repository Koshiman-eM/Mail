/** 業者チャット URL の検証エラー */
export class InvalidChatUrlError extends Error {
  constructor(message = "http:// または https:// で始まる URL を入力してください") {
    super(message);
    this.name = "InvalidChatUrlError";
  }
}

/**
 * 業者チャット URL を正規化する。空文字 / null は登録解除 (null)。
 * http / https 以外 (javascript: など) は拒否する。
 */
export function normalizeChatUrl(input: string | null | undefined): string | null {
  const v = (input ?? "").trim();
  if (!v) return null;
  if (v.length > 2000) throw new InvalidChatUrlError("URL が長すぎます (2000 文字まで)");
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new InvalidChatUrlError();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new InvalidChatUrlError();
  if (!url.hostname) throw new InvalidChatUrlError();
  return url.toString();
}
