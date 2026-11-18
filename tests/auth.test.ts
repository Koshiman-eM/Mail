import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { clearFailures, isLocked, recordFailure } from "@/lib/auth/rateLimit";

describe("パスワードハッシュ", () => {
  it("正しいパスワードのみ一致し、毎回異なるソルトを使う", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("wrong password!!", a)).toBe(false);
  });
  it("不正な形式は false", async () => {
    expect(await verifyPassword("x", "plain-text")).toBe(false);
  });
});

describe("ログイン試行制限", () => {
  it("10回失敗でロック、成功でリセット", () => {
    const keys = ["email:test@example.com"];
    const now = 1_000_000;
    for (let i = 0; i < 9; i++) recordFailure(keys, now);
    expect(isLocked(keys, now)).toBe(false);
    recordFailure(keys, now);
    expect(isLocked(keys, now)).toBe(true);
    expect(isLocked(keys, now + 16 * 60 * 1000)).toBe(false);
    clearFailures(keys);
    expect(isLocked(keys, now)).toBe(false);
  });
});
