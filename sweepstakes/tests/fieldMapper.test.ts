import { describe, expect, it } from "vitest";
import {
  chooseButton,
  classifyField,
  classifyPageState,
  CONFIDENCE_THRESHOLD,
  planForm,
  tokenize,
  type FieldDescriptor,
} from "../src/core/fieldMapper.js";
import { TEST_PROFILE } from "./helpers/context.js";

let n = 0;
function fd(p: Partial<FieldDescriptor>): FieldDescriptor {
  return {
    idx: n++,
    tag: "input",
    type: "text",
    name: "",
    id: "",
    placeholder: "",
    autocomplete: "",
    label: "",
    prevText: "",
    context: "",
    required: true,
    maxLength: null,
    options: [],
    ...p,
  };
}

describe("classifyField", () => {
  it.each([
    [{ label: "メールアドレス" }, "email"],
    [{ name: "email_confirm", type: "email" }, "emailConfirm"],
    [{ autocomplete: "family-name" }, "lastName"],
    [{ autocomplete: "given-name" }, "firstName"],
    [{ label: "姓" }, "lastName"],
    [{ label: "名" }, "firstName"],
    [{ label: "セイ" }, "lastNameKana"],
    [{ label: "メイ" }, "firstNameKana"],
    [{ label: "お名前" }, "fullName"],
    [{ label: "氏名（フリガナ）" }, "fullNameKana"],
    [{ name: "name1" }, "lastName"],
    [{ name: "name2" }, "firstName"],
    [{ name: "last_name_kana" }, "lastNameKana"],
    [{ context: "お名前", prevText: "姓", name: "sei" }, "lastName"],
    [{ label: "郵便番号" }, "zip"],
    [{ label: "電話番号" }, "phone"],
    [{ label: "市区町村" }, "city"],
    [{ label: "番地" }, "address1"],
    [{ label: "建物名・部屋番号" }, "address2"],
    [{ label: "ご住所" }, "addressGeneric"],
    [{ label: "生年月日", type: "date" }, "birthday"],
    [{ name: "birthYear" }, "birthdayYear"],
  ] as [Partial<FieldDescriptor>, string][])("%j → %s", (p, key) => {
    const m = classifyField(fd(p));
    expect(m.key).toBe(key);
    expect(m.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
  });

  it("「会社名」「ニックネーム」は氏名と判定しない", () => {
    expect(classifyField(fd({ label: "会社名" })).key).toBeNull();
    expect(classifyField(fd({ name: "nickname" })).key).toBeNull();
  });

  it("都道府県 select は選択肢からも判定", () => {
    const m = classifyField(
      fd({ tag: "select", type: "select", options: ["北海道", "東京都", "大阪府", "沖縄県"].map((v) => ({ value: v, label: v })) }),
    );
    expect(m.key).toBe("prefecture");
  });

  it("性別 radio は選択肢から判定", () => {
    const m = classifyField(fd({ type: "radio", options: [{ value: "1", label: "男性" }, { value: "2", label: "女性" }], optionIdx: [1, 2] }));
    expect(m.key).toBe("gender");
  });

  it("生年月日の分割 select は選択肢の範囲で年/月/日を判定", () => {
    const sel = (max: number) =>
      fd({ tag: "select", type: "select", context: "生年月日", options: Array.from({ length: max }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })) });
    expect(classifyField(sel(12)).key).toBe("birthdayMonth");
    expect(classifyField(sel(31)).key).toBe("birthdayDay");
    const years = fd({ tag: "select", type: "select", context: "生年月日", options: [{ value: "1990", label: "1990" }] });
    expect(classifyField(years).key).toBe("birthdayYear");
  });

  it("根拠が矛盾する欄は信頼度が下がる", () => {
    const m = classifyField(fd({ label: "電話番号", name: "email" }));
    expect(m.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it("同意チェックボックスとメルマガを区別する", () => {
    expect(classifyField(fd({ type: "checkbox", label: "利用規約に同意する" })).key).toBe("agree");
    expect(classifyField(fd({ type: "checkbox", label: "メールマガジンの配信に同意する" })).key).toBeNull();
  });

  it("tokenize", () => {
    expect(tokenize("birthYear")).toEqual(["birth", "year"]);
    expect(tokenize("zip1")).toEqual(["zip", "1"]);
    expect(tokenize("data[Entry][tel_2]")).toEqual(["data", "entry", "tel", "2"]);
  });
});

describe("planForm (入力値の生成)", () => {
  const valueOf = (fields: FieldDescriptor[]) => planForm(fields, TEST_PROFILE).map((p) => p.fill?.value ?? null);

  it("郵便番号・電話番号の分割欄", () => {
    expect(valueOf([fd({ name: "zip1" }), fd({ name: "zip2" })])).toEqual(["100", "0001"]);
    expect(valueOf([fd({ name: "tel1" }), fd({ name: "tel2" }), fd({ name: "tel3" })])).toEqual(["090", "1234", "5678"]);
  });

  it("ハイフンの有無を maxlength / プレースホルダから推定", () => {
    expect(valueOf([fd({ label: "郵便番号", maxLength: 7 })])).toEqual(["1000001"]);
    expect(valueOf([fd({ label: "郵便番号", placeholder: "123-4567" })])).toEqual(["100-0001"]);
    expect(valueOf([fd({ label: "電話番号", placeholder: "09012345678" })])).toEqual(["09012345678"]);
  });

  it("姓名一体欄とカナ (ひらがな指定)", () => {
    expect(valueOf([fd({ label: "氏名" })])).toEqual(["山田 太郎"]);
    expect(valueOf([fd({ label: "氏名", placeholder: "山田太郎" })])).toEqual(["山田太郎"]);
    expect(valueOf([fd({ label: "ふりがな" })])).toEqual(["やまだ たろう"]);
    expect(valueOf([fd({ label: "フリガナ" })])).toEqual(["ヤマダ タロウ"]);
  });

  it("住所欄: 市区町村欄の有無で入れる値が変わる", () => {
    expect(valueOf([fd({ label: "住所" })])).toEqual(["東京都千代田区千代田1-1 サンプルマンション101"]);
    expect(valueOf([fd({ label: "市区町村" }), fd({ label: "住所" }), fd({ label: "建物名", required: false })])).toEqual([
      "千代田区",
      "千代田1-1",
      "サンプルマンション101",
    ]);
  });

  it("選択肢にない都道府県は解決できない (必須なら手動へ)", () => {
    const p = planForm([fd({ tag: "select", type: "select", label: "都道府県", options: [{ value: "1", label: "北海道" }] })], TEST_PROFILE);
    expect(p[0]!.resolved).toBe(false);
  });

  it("不明な欄は解決できない", () => {
    const p = planForm([fd({ tag: "textarea", type: "textarea", label: "応募の理由" })], TEST_PROFILE);
    expect(p[0]!.resolved).toBe(false);
  });
});

describe("ボタン選択・ページ状態", () => {
  it("戻る/リセットを避けて送信系ボタンを選ぶ", () => {
    const b = [
      { idx: 0, text: "戻る", isSubmit: true },
      { idx: 1, text: "リセット", isSubmit: false },
      { idx: 2, text: "確認画面へ", isSubmit: true },
    ];
    expect(chooseButton(b)?.idx).toBe(2);
    expect(chooseButton([{ idx: 0, text: "戻る", isSubmit: true }, { idx: 1, text: "送信する", isSubmit: true }], true)?.idx).toBe(1);
  });

  it("確認画面・完了画面・エラーを判定", () => {
    const send = [{ idx: 0, text: "送信する", isSubmit: true }];
    expect(classifyPageState({ text: "入力内容の確認", editableFieldCount: 0, buttons: send })).toBe("confirm");
    expect(classifyPageState({ text: "ご応募ありがとうございました", editableFieldCount: 0, buttons: [] })).toBe("complete");
    expect(classifyPageState({ text: "メールアドレスを入力してください", editableFieldCount: 5, buttons: send })).toBe("error");
  });
});
