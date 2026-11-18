import { describe, expect, it } from "vitest";
import * as webpush from "web-push";
import {
  MAX_PUSH_FAILURES,
  PUSH_TTL_SECONDS,
  buildPushPayload,
  decideOnFailure,
  pushRequestOptions,
  safeAppPath,
  shouldPush,
} from "@/lib/push/payload";
import { derivePublicKey } from "@/lib/push/vapid";

describe("shouldPush: どの通知を端末へプッシュするか", () => {
  it("WARNING / CRITICAL は種別に関係なくプッシュする", () => {
    for (const type of ["PRICE_CHANGE", "STOCK_CHANGE", "REAUTH_REQUIRED", "SEND_FAILED", "SYSTEM"]) {
      expect(shouldPush({ type, severity: "WARNING" })).toBe(true);
      expect(shouldPush({ type, severity: "CRITICAL" })).toBe(true);
    }
  });
  it("INFO は業者チャットの受信と返信案準備だけプッシュする", () => {
    expect(shouldPush({ type: "CHAT_RECEIVED", severity: "INFO" })).toBe(true);
    expect(shouldPush({ type: "DRAFT_READY", severity: "INFO" })).toBe(true);
    expect(shouldPush({ type: "PRICE_CHANGE", severity: "INFO" })).toBe(false);
    expect(shouldPush({ type: "SYSTEM", severity: "INFO" })).toBe(false);
  });
});

describe("buildPushPayload", () => {
  const base = { id: "n1", type: "PRICE_CHANGE", severity: "WARNING" as const, title: "価格が上がりました", body: "USB ライト: $1.20 → $1.50", link: "/products?id=p1" };

  it("通知からタイトル・本文・URL・tag・重要度を組み立てる", () => {
    expect(buildPushPayload(base)).toEqual({
      title: "価格が上がりました",
      body: "USB ライト: $1.20 → $1.50",
      url: "/products?id=p1",
      tag: "notif-n1",
      severity: "WARNING",
    });
  });
  it("本文・リンクが無ければ空文字とトップページ", () => {
    const p = buildPushPayload({ ...base, body: null, link: null });
    expect(p.body).toBe("");
    expect(p.url).toBe("/");
  });
  it("長い本文は省略記号付きで切り詰める", () => {
    const p = buildPushPayload({ ...base, body: "あ".repeat(500) });
    expect(p.body.length).toBe(180);
    expect(p.body.endsWith("…")).toBe(true);
  });
  it("空のタイトルはアプリ名で補う", () => {
    expect(buildPushPayload({ ...base, title: "  " }).title).toBe("越境せどり");
  });
});

describe("safeAppPath: 外部 URL へ飛ばさない", () => {
  it.each([
    ["/chat/abc", "/chat/abc"],
    ["https://evil.example/", "/"],
    ["//evil.example/x", "/"],
    ["/\\evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["", "/"],
    [null, "/"],
  ])("%s -> %s", (input, expected) => {
    expect(safeAppPath(input)).toBe(expected);
  });
});

describe("pushRequestOptions", () => {
  it("TTL は 24 時間、CRITICAL のみ urgency high", () => {
    expect(PUSH_TTL_SECONDS).toBe(86_400);
    expect(pushRequestOptions("CRITICAL")).toEqual({ TTL: 86_400, urgency: "high" });
    expect(pushRequestOptions("WARNING").urgency).toBe("normal");
    expect(pushRequestOptions("INFO").urgency).toBe("normal");
  });
});

describe("decideOnFailure: 送信失敗時の購読の扱い", () => {
  it("404 / 410 (購読失効) は即削除", () => {
    expect(decideOnFailure(404, 0)).toEqual({ action: "delete", reason: "gone" });
    expect(decideOnFailure(410, 3)).toEqual({ action: "delete", reason: "gone" });
  });
  it("401 / 403 (VAPID 設定エラー) は購読を消さず、失敗回数にも数えない", () => {
    expect(decideOnFailure(401, 0)).toEqual({ action: "config-error" });
    expect(decideOnFailure(403, MAX_PUSH_FAILURES - 1)).toEqual({ action: "config-error" });
  });
  it("その他のエラーは失敗回数を加算する", () => {
    expect(decideOnFailure(500, 0)).toEqual({ action: "increment", failures: 1 });
    expect(decideOnFailure(429, 2)).toEqual({ action: "increment", failures: 3 });
    expect(decideOnFailure(undefined, 1)).toEqual({ action: "increment", failures: 2 });
  });
  it(`連続 ${MAX_PUSH_FAILURES} 回失敗したら削除する`, () => {
    expect(decideOnFailure(500, MAX_PUSH_FAILURES - 2)).toEqual({ action: "increment", failures: MAX_PUSH_FAILURES - 1 });
    expect(decideOnFailure(500, MAX_PUSH_FAILURES - 1)).toEqual({ action: "delete", reason: "too-many-failures" });
  });
});

describe("VAPID 鍵", () => {
  it("秘密鍵から web-push と同じ公開鍵を導出できる (鍵ペアの不整合を防ぐ)", () => {
    const keys = webpush.generateVAPIDKeys();
    expect(derivePublicKey(keys.privateKey)).toBe(keys.publicKey);
  });
});
