// MCP から profile.json を読み書きする (部分更新・形式検証・アトミック書き込み)
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { PROFILE_KEYS, validateProfile } from "../core/profile.js";
import type { Profile } from "../core/types.js";

export type ProfileKey = (typeof PROFILE_KEYS)[number];
export type ProfilePatch = Partial<Record<ProfileKey, string>>;

export class ProfileValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`プロフィールの値が不正です:\n- ${errors.join("\n- ")}`);
    this.name = "ProfileValidationError";
  }
}

export interface ProfileStore {
  /** 未作成なら null */
  read(): Partial<Profile> | null;
  write(p: Partial<Profile>): void;
}

const RETRYABLE_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * 一時ファイルを本来のパスへ置き換える。
 * Windows でも rename は既存ファイルを上書きできる (MoveFileEx + REPLACE_EXISTING) が、
 * ウイルス対策ソフト・エディタ・インデクサが対象を一瞬開いていると EPERM / EACCES / EBUSY で失敗するため、
 * 少し待って再試行する。最終的に失敗したら一時ファイルを消して例外を投げる。
 */
export function replaceFileSync(tmp: string, dest: string, opts: { retries?: number; delayMs?: number; rename?: typeof renameSync } = {}): void {
  const retries = opts.retries ?? (process.platform === "win32" ? 10 : 0);
  const delayMs = opts.delayMs ?? 50;
  const rename = opts.rename ?? renameSync;
  for (let i = 0; ; i++) {
    try {
      rename(tmp, dest);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (i >= retries || !RETRYABLE_RENAME.has(code)) {
        rmSync(tmp, { force: true });
        throw e;
      }
      // 同期 API なので Atomics.wait で短く待つ
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs * (i + 1));
    }
  }
}

/**
 * ファイルベースの ProfileStore (書き込みは一時ファイル → rename、権限 0600)。
 * Windows では mode / chmod は読み取り専用属性にしか効かない (0600 は書き込み可なので実害なし)。
 * アクセス制御はユーザープロファイル配下に置くことで NTFS の ACL に任せる。
 */
export function fileProfileStore(path: string): ProfileStore {
  return {
    read() {
      if (!existsSync(path)) return null;
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!raw || typeof raw !== "object") throw new Error("profile.json がオブジェクトではありません");
      return raw as Partial<Profile>;
    },
    write(p) {
      const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      chmodSync(tmp, 0o600);
      replaceFileSync(tmp, path);
    },
  };
}

/** メモリ内の ProfileStore (テスト用) */
export function memoryProfileStore(initial: Partial<Profile> | null = null): ProfileStore & { data: Partial<Profile> | null } {
  const s = {
    data: initial ? { ...initial } : null,
    read: () => (s.data ? { ...s.data } : null),
    write: (p: Partial<Profile>) => {
      s.data = { ...p };
    },
  };
  return s;
}

const KATAKANA = /^[゠-ヿ぀-ゟー\s　]+$/;

function isValidDate(s: string, now: Date): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return false;
  return y >= 1900 && dt.getTime() <= now.getTime();
}

/** 指定された項目だけ形式を検証する。空文字は address2 のみ許可 */
export function validateProfilePatch(patch: ProfilePatch, now: Date = new Date()): string[] {
  const errors: string[] = [];
  for (const [k, raw] of Object.entries(patch) as [ProfileKey, string][]) {
    if (!PROFILE_KEYS.includes(k)) {
      errors.push(`${k} は profile の項目ではありません`);
      continue;
    }
    const v = raw.trim();
    if (!v) {
      if (k !== "address2") errors.push(`${k} を空にはできません`);
      continue;
    }
    if (v.length > 200) errors.push(`${k} が長すぎます (200 文字以内)`);
    switch (k) {
      case "zip":
        if (!/^\d{3}-?\d{4}$/.test(v)) errors.push("zip は 7 桁の郵便番号 (例: 100-0001) で指定してください");
        break;
      case "phone": {
        const digits = v.replace(/-/g, "");
        if (!/^[\d-]+$/.test(v) || !/^0\d{9,10}$/.test(digits)) errors.push("phone は 0 から始まる 10〜11 桁の電話番号 (例: 090-1234-5678) で指定してください");
        break;
      }
      case "email":
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) errors.push("email の形式が不正です");
        break;
      case "birthday":
        if (!isValidDate(v, now)) errors.push("birthday は実在する過去の日付を YYYY-MM-DD 形式で指定してください");
        break;
      case "gender":
        if (!["male", "female", "other", "男性", "女性"].includes(v)) errors.push("gender は male / female / other (男性 / 女性 も可) で指定してください");
        break;
      case "lastNameKana":
      case "firstNameKana":
        if (!KATAKANA.test(v)) errors.push(`${k} はカタカナ (またはひらがな) で指定してください`);
        break;
    }
  }
  return errors;
}

export interface ProfileUpdateResult {
  profile: Partial<Profile>;
  changed: ProfileKey[];
  /** 未設定の必須項目 (書き込みは行う) */
  missing: string[];
}

/** 部分更新して保存する。形式エラーなら ProfileValidationError (書き込まない) */
export function updateProfile(store: ProfileStore, patch: ProfilePatch, now: Date = new Date()): ProfileUpdateResult {
  const keys = Object.keys(patch) as ProfileKey[];
  if (!keys.length) throw new ProfileValidationError(["変更する項目を 1 つ以上指定してください"]);
  const errors = validateProfilePatch(patch, now);
  if (errors.length) throw new ProfileValidationError(errors);
  const cur = store.read() ?? {};
  const next: Record<string, string> = {};
  for (const k of PROFILE_KEYS) {
    const v = k in patch ? patch[k]!.trim() : (cur as Record<string, unknown>)[k];
    next[k] = typeof v === "string" ? v : "";
  }
  const changed = keys.filter((k) => (cur as Record<string, unknown>)[k] !== next[k]);
  let missing: string[] = [];
  try {
    validateProfile(next);
  } catch (e) {
    missing = (e as Error).message
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2));
  }
  store.write(next as unknown as Partial<Profile>);
  return { profile: next as unknown as Partial<Profile>, changed, missing };
}
