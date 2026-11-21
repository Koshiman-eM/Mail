// フォーム欄 → プロフィール項目の推定と入力値の生成 (純粋関数)
// ブラウザから抽出した欄の情報 (FieldDescriptor) を受け取り、何を入れるかを決める。
import type { Profile } from "./types.js";

export interface FieldOption {
  value: string;
  label: string;
}

/** ブラウザ側で抽出したフォーム欄の情報 */
export interface FieldDescriptor {
  /** ページ内で欄を特定するためのインデックス (data-sweep-idx) */
  idx: number;
  tag: "input" | "select" | "textarea";
  /** input の type (select/textarea は "select"/"textarea") */
  type: string;
  name: string;
  id: string;
  placeholder: string;
  autocomplete: string;
  /** label[for] / 包含 label / aria-label / aria-labelledby */
  label: string;
  /** 直前のテキスト (例: 「姓」<input>) */
  prevText: string;
  /** 行見出し (th / dt / fieldset legend / 親要素のテキスト) */
  context: string;
  required: boolean;
  maxLength: number | null;
  /** select の選択肢 / radio グループの選択肢 */
  options: FieldOption[];
  /** radio の場合、各選択肢の data-sweep-idx (options と同順) */
  optionIdx?: number[];
  /** checkbox の value */
  value?: string;
}

export type FieldKey =
  | "fullName"
  | "lastName"
  | "firstName"
  | "fullNameKana"
  | "lastNameKana"
  | "firstNameKana"
  | "email"
  | "emailConfirm"
  | "phone"
  | "zip"
  | "prefecture"
  | "city"
  | "address1"
  | "address2"
  | "addressGeneric"
  | "addressFull"
  | "birthday"
  | "birthdayYear"
  | "birthdayMonth"
  | "birthdayDay"
  | "gender"
  | "agree";

export interface FieldMapping {
  key: FieldKey | null;
  confidence: number;
  /** zip1/zip2, tel1/tel2/tel3 のような分割欄の何番目か (1 始まり) */
  part?: number;
  /** 判定根拠 (デバッグ表示用) */
  via: string[];
}

/** これ以上の信頼度で推定できた欄だけを自動入力する */
export const CONFIDENCE_THRESHOLD = 0.8;

const SOURCE_WEIGHT = {
  autocomplete: 0.95,
  label: 0.9,
  prevText: 0.85,
  identifier: 0.85,
  options: 0.9,
  context: 0.8,
  placeholder: 0.75,
} as const;
type Source = keyof typeof SOURCE_WEIGHT;

const AUTOCOMPLETE_MAP: Record<string, FieldKey> = {
  name: "fullName",
  "family-name": "lastName",
  "given-name": "firstName",
  email: "email",
  tel: "phone",
  "tel-national": "phone",
  "postal-code": "zip",
  "address-level1": "prefecture",
  "address-level2": "city",
  "address-line1": "address1",
  "address-line2": "address2",
  "street-address": "addressFull",
  bday: "birthday",
  "bday-year": "birthdayYear",
  "bday-month": "birthdayMonth",
  "bday-day": "birthdayDay",
  sex: "gender",
};

const KANA_HINT = /カナ|かな|フリガナ|ふりがな|ﾌﾘｶﾞﾅ|ｶﾅ|kana|furigana|phonetic|ruby|^セイ|^メイ|^せい$|^めい$/i;

/** 自然言語のテキスト (ラベル等) から推定 */
function classifyText(raw: string): FieldKey | null {
  const t = raw.replace(/\s+/g, "").replace(/[（(]?(必須|任意|required|optional)[)）]?|[*＊※]/gi, "");
  if (!t) return null;
  if (/(メール|e-?mail|mail).*(確認|再入力|もう一度|confirm|again)|(確認|confirm).*(メール|e-?mail|mail)/i.test(t)) return "emailConfirm";
  if (/メール|e-?mail|mailaddress|^mail$/i.test(t)) return "email";
  if (/郵便番号|〒|zip|postal|postcode/i.test(t)) return "zip";
  if (/電話|tel|phone|携帯|mobile/i.test(t)) return "phone";
  if (/生年月日|誕生日|birthday|birth|dateofbirth|dob/i.test(t)) return "birthday";
  if (/都道府県|prefecture/i.test(t)) return "prefecture";
  if (/市区町村|市町村|^city$|^市区郡/i.test(t)) return "city";
  if (/建物|マンション|ビル名|部屋番号|号室|building|apartment|address(line)?2/i.test(t)) return "address2";
  if (/番地|丁目|町名|address(line)?1|street/i.test(t)) return "address1";
  if (/住所|ご住所|address/i.test(t)) return "addressGeneric";
  if (/性別|gender|^sex$/i.test(t)) return "gender";
  if (/同意|規約|承諾|プライバシー|個人情報の取り?扱い|agree|consent|accept|privacy|terms/i.test(t)) return "agree";
  const kana = KANA_HINT.test(t);
  const last = /姓|苗字|名字|lastname|familyname|surname|^セイ|^せい$/i.test(t) && !/姓名/.test(t);
  const first = /^名(?!前|称|字)|[（(]名[)）]|firstname|givenname|forename|^メイ|^めい$/i.test(t) && !/姓名/.test(t);
  const full = /氏名|姓名|お?名前|フルネーム|fullname|yourname|^name$/i.test(t);
  if (last && !first) return kana ? "lastNameKana" : "lastName";
  if (first && !last) return kana ? "firstNameKana" : "firstName";
  if (full || (last && first)) return kana ? "fullNameKana" : "fullName";
  if (/^(フリガナ|ふりがな|カナ|かな|kana|furigana)$/i.test(t)) return "fullNameKana";
  return null;
}

/** name / id 属性をトークンに分割 */
export function tokenize(identifier: string): string[] {
  return identifier
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+|(?<=[a-z])(?=\d)/)
    .filter(Boolean);
}

/** name / id 属性 (英語の識別子) から推定 */
function classifyIdentifier(raw: string): { key: FieldKey | null; part?: number } {
  if (!raw) return { key: null };
  const tokens = tokenize(raw);
  if (!tokens.length) return { key: null };
  const has = (...ws: string[]) => ws.some((w) => tokens.includes(w));
  const joined = tokens.join("");
  const lastNum = tokens.length > 1 && /^\d$/.test(tokens.at(-1)!) ? Number(tokens.at(-1)) : undefined;
  const kana = has("kana", "furigana", "kn", "furi", "ruby", "phonetic", "yomi");

  if ((has("email", "mail") && has("confirm", "confirmation", "check", "again", "re", "conf")) || /^(email|mail)(2|_?confirm)/.test(joined))
    return { key: "emailConfirm" };
  if (has("email", "mail", "mailaddress")) return { key: "email" };
  if (has("zip", "zipcode", "postal", "postcode", "yubin", "post", "postalcode", "zip1", "zip2")) return { key: "zip", part: lastNum };
  if (has("tel", "phone", "telephone", "mobile", "tel1", "tel2", "tel3")) return { key: "phone", part: lastNum };
  if (has("birth", "birthday", "bday", "dob", "birthdate", "seinengappi") || /birth/.test(joined)) {
    if (has("year", "yyyy", "y")) return { key: "birthdayYear" };
    if (has("month", "mm", "m")) return { key: "birthdayMonth" };
    if (has("day", "dd", "d")) return { key: "birthdayDay" };
    return { key: "birthday" };
  }
  if (has("pref", "prefecture", "todofuken", "state")) return { key: "prefecture" };
  if (has("city", "shikuchoson", "municipality", "locality")) return { key: "city" };
  if (has("building", "apartment", "bldg", "tatemono", "room") || /^(address|addr)2$/.test(joined) || (has("address", "addr") && lastNum === 2))
    return { key: "address2" };
  if (has("street", "banchi") || /^(address|addr)1$/.test(joined) || (has("address", "addr") && lastNum === 1)) return { key: "address1" };
  if (has("address", "addr", "jusho", "juusho")) return { key: "addressGeneric" };
  if (has("gender", "sex", "seibetsu")) return { key: "gender" };
  if (has("agree", "agreement", "consent", "accept", "privacy", "terms", "doui")) return { key: "agree" };
  const last = has("last", "family", "surname", "sei", "lname", "lastname", "familyname", "sei1");
  const first = has("first", "given", "forename", "mei", "fname", "firstname", "givenname");
  if (last && !first) return { key: kana ? "lastNameKana" : "lastName" };
  if (first && !last) return { key: kana ? "firstNameKana" : "firstName" };
  if (has("name", "fullname", "shimei", "namae", "simei") || (kana && tokens.length <= 2)) {
    // name1 / name2 は姓 / 名として扱う
    if (lastNum === 1) return { key: kana ? "lastNameKana" : "lastName" };
    if (lastNum === 2) return { key: kana ? "firstNameKana" : "firstName" };
    if (has("user", "nick", "nickname", "company", "shop", "account", "login")) return { key: null };
    return { key: kana ? "fullNameKana" : "fullName" };
  }
  return { key: null };
}

function classifyPlaceholder(p: string): FieldKey | null {
  const t = p.trim();
  if (!t) return null;
  if (/^[^@\s]+@[^@\s]+\.[a-z]+$/i.test(t.replace(/^(例|ex|e\.g\.)[:：.]?\s*/i, ""))) return "email";
  if (/^(例[:：]?\s*)?\d{3}-?\d{4}$/.test(t)) return "zip";
  if (/^(例[:：]?\s*)?0\d{1,4}-?\d{1,4}-?\d{3,4}$/.test(t)) return "phone";
  if (/^(例[:：]?\s*)?(19|20)\d{2}[\/\-年]?\d{1,2}[\/\-月]?\d{1,2}日?$/.test(t)) return "birthday";
  if (/^(yyyy|年)$/i.test(t)) return "birthdayYear";
  if (/^(mm|月)$/i.test(t)) return "birthdayMonth";
  if (/^(dd|日)$/i.test(t)) return "birthdayDay";
  return classifyText(t.replace(/^例[:：]?\s*/, ""));
}

const PREF_SAMPLE = ["北海道", "東京都", "大阪府", "沖縄県"];

function classifyOptions(f: FieldDescriptor): FieldKey | null {
  if (!f.options.length) return null;
  const texts = f.options.map((o) => `${o.label} ${o.value}`.trim());
  const all = texts.join(" ");
  if (PREF_SAMPLE.filter((p) => all.includes(p)).length >= 3) return "prefecture";
  if (/男/.test(all) && /女/.test(all)) return "gender";
  if (/\bmale\b/i.test(all) && /\bfemale\b/i.test(all)) return "gender";
  return null;
}

/** select の選択肢から 年/月/日 のどれかを判定 */
function datePartFromOptions(f: FieldDescriptor): FieldKey | null {
  const nums = f.options.map((o) => Number(o.value.replace(/\D/g, "") || o.label.replace(/\D/g, ""))).filter((n) => n > 0);
  if (!nums.length) return null;
  const max = Math.max(...nums);
  if (max >= 1900) return "birthdayYear";
  if (max === 12) return "birthdayMonth";
  if (max >= 28 && max <= 31) return "birthdayDay";
  return null;
}

/** 一般的なキー → より具体的なキー (矛盾ではなく詳細化とみなす) */
const SPECIALIZES: Partial<Record<FieldKey, FieldKey[]>> = {
  fullName: ["lastName", "firstName", "fullNameKana", "lastNameKana", "firstNameKana"],
  fullNameKana: ["lastNameKana", "firstNameKana"],
  lastName: ["lastNameKana"],
  firstName: ["firstNameKana"],
  addressGeneric: ["zip", "prefecture", "city", "address1", "address2", "addressFull"],
  birthday: ["birthdayYear", "birthdayMonth", "birthdayDay"],
  email: ["emailConfirm"],
};

function isSpecializationOf(specific: FieldKey, general: FieldKey): boolean {
  return SPECIALIZES[general]?.includes(specific) ?? false;
}

/** 1 つの欄が何の項目かを推定する */
export function classifyField(f: FieldDescriptor): FieldMapping {
  const votes: { key: FieldKey; source: Source; weight: number }[] = [];
  const add = (key: FieldKey | null, source: Source) => {
    if (key) votes.push({ key, source, weight: SOURCE_WEIGHT[source] });
  };
  let part: number | undefined;

  if (f.type === "checkbox") {
    // チェックボックスは同意欄かどうかだけを判定する
    const t = [f.label, f.prevText, f.context, f.name, f.id].join(" ");
    const isAgree = /同意|規約|承諾|プライバシー|個人情報|agree|consent|accept|privacy|terms/i.test(t);
    const isNewsletter = /メルマガ|メールマガジン|ニュースレター|newsletter|お知らせを受け取|配信を希望/i.test(t);
    return isAgree && !isNewsletter
      ? { key: "agree", confidence: 0.95, via: ["checkbox:agree"] }
      : { key: null, confidence: 0, via: [] };
  }
  if (["password", "file", "hidden", "submit", "button", "image", "reset", "search", "url", "color", "range"].includes(f.type)) {
    return { key: null, confidence: 0, via: [] };
  }

  const ac = f.autocomplete.toLowerCase().split(/\s+/).filter((w) => !/^(section-|shipping|billing|home|work|mobile)/.test(w)).pop() ?? "";
  add(AUTOCOMPLETE_MAP[ac] ?? null, "autocomplete");
  add(classifyText(f.label), "label");
  add(classifyText(f.prevText), "prevText");
  for (const ident of [f.name, f.id]) {
    const r = classifyIdentifier(ident);
    add(r.key, "identifier");
    if (r.part !== undefined) part ??= r.part;
  }
  add(classifyPlaceholder(f.placeholder), "placeholder");
  add(classifyText(f.context), "context");
  add(classifyOptions(f), "options");
  if (f.type === "email") add("email", "autocomplete");
  if (f.type === "tel") votes.push({ key: "phone", source: "identifier", weight: 0.8 });
  if (f.type === "date") votes.push({ key: "birthday", source: "identifier", weight: 0.8 });

  if (!votes.length) return { key: null, confidence: 0, via: [] };

  // 詳細化 (お名前 → 姓 など) は具体的な方に寄せる
  const keys = [...new Set(votes.map((v) => v.key))];
  const specific = keys.filter((k) => !keys.some((o) => o !== k && isSpecializationOf(o, k)));
  let candidates = votes.filter((v) => specific.includes(v.key));

  // カナの手掛かりがあれば氏名系はカナに寄せる
  const kanaHint =
    KANA_HINT.test(f.label) || KANA_HINT.test(f.prevText) || KANA_HINT.test(f.context) || /^[゠-ヿ\s　]+$/.test(f.placeholder.replace(/^例[:：]?\s*/, ""));
  if (kanaHint) {
    const toKana: Partial<Record<FieldKey, FieldKey>> = { fullName: "fullNameKana", lastName: "lastNameKana", firstName: "firstNameKana" };
    candidates = candidates.map((v) => ({ ...v, key: toKana[v.key] ?? v.key }));
  }

  // 生年月日を年月日に分割した select の判定
  if (candidates.some((v) => v.key === "birthday") && f.tag === "select") {
    const p = datePartFromOptions(f);
    if (p) candidates = [{ key: p, source: "options", weight: 0.9 }];
  }

  const byKey = new Map<FieldKey, { weight: number; sources: Source[] }>();
  for (const v of candidates) {
    const cur = byKey.get(v.key) ?? { weight: 0, sources: [] };
    cur.weight = Math.max(cur.weight, v.weight);
    if (!cur.sources.includes(v.source)) cur.sources.push(v.source);
    byKey.set(v.key, cur);
  }
  const ranked = [...byKey.entries()].sort((a, b) => b[1].weight - a[1].weight || b[1].sources.length - a[1].sources.length);
  const [bestKey, best] = ranked[0]!;
  let confidence = best.weight + (best.sources.length >= 2 ? 0.05 : 0);
  // 別の項目を示す有力な根拠と矛盾する場合は信頼度を下げる
  const rival = ranked.find(([k, v]) => k !== bestKey && v.weight >= 0.8);
  if (rival) confidence -= 0.3;
  confidence = Math.min(0.99, Math.max(0, confidence));

  let key: FieldKey = bestKey;
  // name1 / name2 形式の分割氏名
  if (key === "fullName" && part === 1) key = "lastName";
  else if (key === "fullName" && part === 2) key = "firstName";
  else if (key === "fullNameKana" && part === 1) key = "lastNameKana";
  else if (key === "fullNameKana" && part === 2) key = "firstNameKana";
  const usePart = key === "zip" || key === "phone" ? part : undefined;
  return { key, confidence, part: usePart, via: best.sources.map((s) => `${s}:${bestKey}`) };
}

// ---------------------------------------------------------------------------
// 入力値の生成
// ---------------------------------------------------------------------------

export function katakanaToHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
export function hiraganaToKatakana(s: string): string {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

function wantsHiragana(f: FieldDescriptor): boolean {
  const t = `${f.label} ${f.prevText} ${f.context}`;
  if (/ひらがな|ふりがな/.test(t) && !/カタカナ|フリガナ|カナ/.test(t)) return true;
  return /^[ぁ-ゖー\s　]+$/.test(f.placeholder.replace(/^例[:：]?\s*/, "")) && f.placeholder.trim() !== "";
}

function kana(f: FieldDescriptor, s: string): string {
  return wantsHiragana(f) ? katakanaToHiragana(s) : hiraganaToKatakana(s);
}

/** プレースホルダや maxlength からハイフンの有無を推定 */
function wantsNoHyphen(f: FieldDescriptor, digitsLen: number): boolean {
  if (f.maxLength !== null && f.maxLength > 0 && f.maxLength <= digitsLen) return true;
  if (/ハイフン(なし|不要|無し)|ハイフンを?(入れ|含め)ず|半角数字のみ|no\s*hyphen/i.test(`${f.label} ${f.placeholder} ${f.context}`)) return true;
  const ph = f.placeholder.replace(/^例[:：]?\s*/, "");
  return /^\d{7,}$/.test(ph);
}

function splitPhone(phone: string): string[] {
  if (/[-‐ー－]/.test(phone)) return phone.split(/[-‐ー－]/).map((s) => s.replace(/\D/g, ""));
  const d = phone.replace(/\D/g, "");
  if (/^0[5789]0/.test(d) && d.length === 11) return [d.slice(0, 3), d.slice(3, 7), d.slice(7)];
  if (/^0[36]/.test(d) && d.length === 10) return [d.slice(0, 2), d.slice(2, 6), d.slice(6)];
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6)];
}

function normalizeGender(g: string): "male" | "female" | "other" {
  if (/^(male|m|男|男性)$/i.test(g.trim())) return "male";
  if (/^(female|f|女|女性)$/i.test(g.trim())) return "female";
  return "other";
}

const GENDER_RE = {
  male: /^(男|男性|male|m|man|1)$/i,
  female: /^(女|女性|female|f|woman|2)$/i,
  other: /^(その他|回答しない|答えない|other|none|no ?answer|prefer not)/i,
};

function pickOption(options: FieldOption[], match: (o: FieldOption) => boolean): FieldOption | undefined {
  return options.find(match);
}

function prefCore(s: string): string {
  return s.trim().replace(/(都|道|府|県)$/, "");
}

export interface FillValue {
  /** text 入力 / select の value / radio の選択肢 value */
  value: string;
  /** radio の場合、チェックする選択肢の data-sweep-idx */
  optionIdx?: number;
  /** checkbox を ON にする */
  check?: boolean;
}

/**
 * 欄とその推定結果から入力値を作る。決められなければ null。
 * hasCityField: フォーム内に市区町村欄が別にあるか (汎用「住所」欄に何を入れるかに使う)
 */
export function valueFor(
  f: FieldDescriptor,
  m: FieldMapping,
  p: Profile,
  ctx: { hasCityField: boolean; hasAddress2Field: boolean; hasPrefectureField: boolean },
): FillValue | null {
  if (!m.key) return null;
  const [by, bm, bd] = p.birthday.split("-");
  const text = (s: string | undefined): FillValue | null => (s ? { value: s } : null);
  const sep = /\s/.test(f.placeholder.replace(/^例[:：]?\s*/, "")) || !f.placeholder ? " " : "";

  let v: FillValue | null;
  switch (m.key) {
    case "lastName":
      v = text(p.lastName);
      break;
    case "firstName":
      v = text(p.firstName);
      break;
    case "fullName":
      v = text(p.lastName && p.firstName ? `${p.lastName}${sep}${p.firstName}` : "");
      break;
    case "lastNameKana":
      v = text(kana(f, p.lastNameKana));
      break;
    case "firstNameKana":
      v = text(kana(f, p.firstNameKana));
      break;
    case "fullNameKana":
      v = text(p.lastNameKana && p.firstNameKana ? kana(f, `${p.lastNameKana}${sep}${p.firstNameKana}`) : "");
      break;
    case "email":
    case "emailConfirm":
      v = text(p.email);
      break;
    case "zip": {
      const d = p.zip.replace(/\D/g, "");
      if (m.part === 1) v = text(d.slice(0, 3));
      else if (m.part === 2) v = text(d.slice(3));
      else v = text(wantsNoHyphen(f, 7) ? d : `${d.slice(0, 3)}-${d.slice(3)}`);
      break;
    }
    case "phone": {
      const parts = splitPhone(p.phone);
      if (m.part && m.part >= 1 && m.part <= 3) v = text(parts[m.part - 1]);
      else {
        const d = p.phone.replace(/\D/g, "");
        v = text(wantsNoHyphen(f, d.length) ? d : parts.join("-"));
      }
      break;
    }
    case "prefecture":
      if (f.tag === "select") {
        const o = pickOption(f.options, (o) => prefCore(o.label) === prefCore(p.prefecture) || prefCore(o.value) === prefCore(p.prefecture));
        v = o ? { value: o.value } : null;
      } else v = text(p.prefecture);
      break;
    case "city":
      v = text(p.city);
      break;
    case "address1":
      v = text(p.address1);
      break;
    case "address2":
      v = text(p.address2);
      break;
    case "addressGeneric":
    case "addressFull": {
      // 市区町村欄が別にあれば番地以降、なければ市区町村から (都道府県欄がなければ都道府県から)
      const pieces = ctx.hasCityField ? [p.address1] : [ctx.hasPrefectureField ? "" : p.prefecture, p.city, p.address1];
      if (!ctx.hasAddress2Field && p.address2) pieces.push(" " + p.address2);
      v = text(pieces.join("").trim());
      break;
    }
    case "birthday":
      if (f.type === "date") v = text(p.birthday);
      else if (/^\d{8}$/.test(f.placeholder.replace(/^例[:：]?\s*/, "")) || (f.maxLength !== null && f.maxLength === 8)) v = text(`${by}${bm}${bd}`);
      else if (/-/.test(f.placeholder)) v = text(p.birthday);
      else v = text(`${by}/${bm}/${bd}`);
      break;
    case "birthdayYear":
    case "birthdayMonth":
    case "birthdayDay": {
      const raw = m.key === "birthdayYear" ? by! : m.key === "birthdayMonth" ? bm! : bd!;
      const n = String(Number(raw));
      if (f.tag === "select") {
        const o = pickOption(f.options, (o) => Number(o.value.replace(/\D/g, "")) === Number(raw) && o.value.trim() !== "")
          ?? pickOption(f.options, (o) => Number(o.label.replace(/\D/g, "")) === Number(raw) && /\d/.test(o.label));
        v = o ? { value: o.value } : null;
      } else v = text(m.key === "birthdayYear" ? raw : f.maxLength === 2 ? raw : n);
      break;
    }
    case "gender": {
      const g = normalizeGender(p.gender);
      const o = pickOption(f.options, (o) => GENDER_RE[g].test(o.label.trim()) || GENDER_RE[g].test(o.value.trim()));
      if (f.type === "radio") {
        const i = o ? f.options.indexOf(o) : -1;
        v = o && f.optionIdx ? { value: o.value, optionIdx: f.optionIdx[i] } : null;
      } else if (f.tag === "select") v = o ? { value: o.value } : null;
      else v = text(g === "male" ? "男性" : g === "female" ? "女性" : "その他");
      break;
    }
    case "agree":
      v = f.type === "checkbox" ? { value: f.value ?? "on", check: true } : null;
      break;
    default:
      v = null;
  }
  if (v && !v.check && v.optionIdx === undefined && f.maxLength !== null && f.maxLength > 0 && v.value.length > f.maxLength) return null;
  return v;
}

export interface PlannedField {
  field: FieldDescriptor;
  mapping: FieldMapping;
  fill: FillValue | null;
  /** 信頼度が閾値以上で値も決まった */
  resolved: boolean;
  /** 表示用ラベル */
  displayLabel: string;
}

export function displayLabel(f: FieldDescriptor): string {
  return (f.label || f.prevText || f.context || f.placeholder || f.name || f.id || `#${f.idx}`).replace(/\s+/g, " ").trim().slice(0, 40);
}

/** フォーム全体の入力計画を作る */
export function planForm(fields: FieldDescriptor[], profile: Profile): PlannedField[] {
  const mapped = fields.map((f) => ({ f, m: classifyField(f) }));
  const strong = (k: FieldKey) => mapped.some(({ m }) => m.key === k && m.confidence >= CONFIDENCE_THRESHOLD);
  const ctx = { hasCityField: strong("city"), hasAddress2Field: strong("address2"), hasPrefectureField: strong("prefecture") };
  return mapped.map(({ f, m }) => {
    const fill = m.confidence >= CONFIDENCE_THRESHOLD ? valueFor(f, m, profile, ctx) : null;
    return { field: f, mapping: m, fill, resolved: fill !== null, displayLabel: displayLabel(f) };
  });
}

// ---------------------------------------------------------------------------
// ボタン・ページ状態の判定
// ---------------------------------------------------------------------------

export interface ButtonDescriptor {
  idx: number;
  text: string;
  /** button[type=submit] / input[type=submit|image] なら true */
  isSubmit: boolean;
}

const BACK_RE = /戻る|修正|訂正|リセット|クリア|キャンセル|やり直|back|reset|clear|cancel|edit|prev/i;
const PROCEED_RE = /確認|次へ|進む|送信|応募|申し込|申込|登録|エントリー|確定|完了|submit|send|confirm|next|apply|enter|entry|register|continue|done/i;
const FINAL_RE = /送信|応募する|応募を?確定|申し込む|申込む|登録する|確定|完了|この内容で|submit|send|apply|complete|finish|register/i;

/** 押すべきボタンを選ぶ。final=true なら確認画面の最終送信ボタンを優先 */
export function chooseButton(buttons: ButtonDescriptor[], final = false): ButtonDescriptor | null {
  const cands = buttons.filter((b) => !BACK_RE.test(b.text));
  const pref = final ? FINAL_RE : PROCEED_RE;
  return (
    cands.find((b) => pref.test(b.text) && b.isSubmit) ??
    cands.find((b) => pref.test(b.text)) ??
    (final ? null : cands.find((b) => b.isSubmit)) ??
    null
  );
}

export type PageState = "confirm" | "complete" | "error" | "form" | "unknown";

const COMPLETE_RE = /ありがとうございま|応募(?:が|を)?(?:完了|受け付け|受付)|送信(?:が|を)?完了|受け付けました|受付(?:いた)?しました|完了しました|thank\s*you|thanks\s+for|has\s+been\s+(?:received|submitted)|successfully/i;
const CONFIRM_RE = /確認|ご確認|以下の内容|内容をご確認|confirm|review/i;
const ERROR_RE = /エラー|入力してください|選択してください|正しく入力|不正|必須項目|error|invalid|is\s+required|please\s+(?:enter|fill)/i;

/** 送信ボタンを押した後のページ状態を推定する */
export function classifyPageState(s: { text: string; editableFieldCount: number; buttons: ButtonDescriptor[] }): PageState {
  const finalBtn = chooseButton(s.buttons, true);
  if (s.editableFieldCount === 0 && finalBtn && CONFIRM_RE.test(s.text)) return "confirm";
  if (COMPLETE_RE.test(s.text) && !(s.editableFieldCount === 0 && finalBtn)) return "complete";
  if (s.editableFieldCount > 0 && ERROR_RE.test(s.text)) return "error";
  if (s.editableFieldCount > 0) return "form";
  if (s.editableFieldCount === 0 && finalBtn) return "confirm";
  return "unknown";
}
