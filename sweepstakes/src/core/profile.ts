// profile.json の読み込みと検証
import { readFileSync } from "node:fs";
import type { Profile } from "./types.js";

export const PROFILE_KEYS = [
  "lastName",
  "firstName",
  "lastNameKana",
  "firstNameKana",
  "email",
  "phone",
  "zip",
  "prefecture",
  "city",
  "address1",
  "address2",
  "birthday",
  "gender",
] as const satisfies readonly (keyof Profile)[];

/** address2 (建物名) 以外は必須 */
const OPTIONAL: ReadonlySet<string> = new Set(["address2"]);

export function validateProfile(raw: unknown): Profile {
  if (!raw || typeof raw !== "object") throw new Error("profile.json がオブジェクトではありません");
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  const out: Record<string, string> = {};
  for (const k of PROFILE_KEYS) {
    const v = obj[k];
    if (v === undefined || v === null || v === "") {
      if (!OPTIONAL.has(k)) errors.push(`${k} が未設定です`);
      out[k] = "";
      continue;
    }
    if (typeof v !== "string") {
      errors.push(`${k} は文字列で指定してください`);
      continue;
    }
    out[k] = v.trim();
  }
  if (out.birthday && !/^\d{4}-\d{2}-\d{2}$/.test(out.birthday)) errors.push("birthday は YYYY-MM-DD 形式で指定してください");
  if (out.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) errors.push("email の形式が不正です");
  if (out.zip && out.zip.replace(/\D/g, "").length !== 7) errors.push("zip は 7 桁の郵便番号で指定してください");
  if (errors.length) throw new Error(`profile.json の内容が不正です:\n- ${errors.join("\n- ")}`);
  return out as unknown as Profile;
}

export function loadProfile(path: string): Profile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`profile.json が見つかりません: ${path} (profile.example.json をコピーして作成してください)`);
  }
  return validateProfile(JSON.parse(text));
}
