// Playwright によるフォーム自動入力・送信
// - CAPTCHA は検出したら即中断 (突破・回避は一切しない)
// - 既定は dry-run (送信直前でスクリーンショットを撮って止まる)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { captchaGuard, requiredFieldsGuard, termsGuard } from "./guards.js";
import {
  chooseButton,
  classifyPageState,
  planForm,
  type ButtonDescriptor,
  type FieldDescriptor,
  type PlannedField,
} from "./fieldMapper.js";
import type { Profile } from "./types.js";

export type AttemptOutcome = "submitted" | "needs_manual" | "skipped" | "failed" | "dry_run";

export interface AttemptOptions {
  /** true のときだけ実際に送信ボタンを押す */
  submit: boolean;
  screenshotDir: string;
  /** スクリーンショットのファイル名 (拡張子なし) */
  screenshotName: string;
  timeoutMs?: number;
  /** 指定するとこのホスト以外へのリクエストを遮断する (テスト用の安全装置) */
  allowedHosts?: string[];
  /** ページ外の規約テキスト (Collector が取得した応募規約など) */
  extraTermsText?: string;
}

export interface FilledField {
  label: string;
  key: string;
  value: string;
}

export interface AttemptResult {
  outcome: AttemptOutcome;
  reason: string;
  filled: FilledField[];
  screenshotPath?: string;
  finalUrl?: string;
}

interface Snapshot {
  fields: FieldDescriptor[];
  buttons: ButtonDescriptor[];
  text: string;
  editableFieldCount: number;
}

/** ブラウザ内で実行: フォーム欄とボタンを抽出し data-sweep-* 属性で印を付ける */
function extractInPage(): Snapshot {
  const CONTROL_SEL = "input, select, textarea";
  const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const isVisible = (el: Element): boolean => {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    return el.getClientRects().length > 0;
  };
  const textWithoutControls = (el: Element): string => {
    const c = el.cloneNode(true) as Element;
    c.querySelectorAll("select, option, script, style, textarea").forEach((n) => n.remove());
    return norm(c.textContent);
  };
  const isFillable = (el: Element): boolean => {
    const t = (el.getAttribute("type") ?? "text").toLowerCase();
    if (el.tagName === "INPUT" && ["hidden", "submit", "button", "image", "reset"].includes(t)) return false;
    if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) return false;
    if (t === "radio" || t === "checkbox") {
      // 見た目をカスタムした radio/checkbox はラベルが見えていれば対象
      const lbl = (el as HTMLInputElement).labels?.[0];
      return isVisible(el) || (lbl ? isVisible(lbl) : false);
    }
    return isVisible(el); // CSS で隠された欄 (ハニーポット) には触れない
  };

  // 入力欄が最も多いフォームを対象にする (なければ body 全体)
  const forms = Array.from(document.querySelectorAll("form"));
  let root: Element = document.body;
  let best = 0;
  for (const f of forms) {
    const n = Array.from(f.querySelectorAll(CONTROL_SEL)).filter(isFillable).length;
    if (n > best) {
      best = n;
      root = f;
    }
  }
  const controls = Array.from(root.querySelectorAll(CONTROL_SEL)).filter(isFillable);
  const controlKey = (el: Element) => {
    const t = (el.getAttribute("type") ?? "").toLowerCase();
    return t === "radio" ? `radio:${el.getAttribute("name")}` : el;
  };
  const countControls = (container: Element) =>
    new Set(Array.from(container.querySelectorAll(CONTROL_SEL)).filter(isFillable).map(controlKey)).size;

  const labelOf = (el: Element): string => {
    const parts: string[] = [];
    const labels = (el as HTMLInputElement).labels;
    if (labels) for (const l of Array.from(labels)) parts.push(textWithoutControls(l));
    const aria = el.getAttribute("aria-label");
    if (aria) parts.push(aria);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) for (const id of lb.split(/\s+/)) parts.push(norm(document.getElementById(id)?.textContent));
    return norm(parts.join(" "));
  };
  const prevTextOf = (el: Element): string => {
    let out = "";
    let n: Node | null = el.previousSibling;
    for (let i = 0; n && i < 4; i++, n = n.previousSibling) {
      if (n.nodeType === Node.TEXT_NODE) out = (n.textContent ?? "") + out;
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const e = n as Element;
        if (e.tagName === "BR" || e.matches(CONTROL_SEL) || e.querySelector(CONTROL_SEL) || e.tagName === "LABEL") break;
        out = (e.textContent ?? "") + out;
      }
      if (norm(out).length > 30) break;
    }
    return norm(out).slice(-30);
  };
  const contextOf = (el: Element): string => {
    const tr = el.closest("tr");
    if (tr && root.contains(tr)) {
      const th = tr.querySelector("th");
      if (th) return textWithoutControls(th);
    }
    const dd = el.closest("dd");
    if (dd && dd.previousElementSibling?.tagName === "DT") return textWithoutControls(dd.previousElementSibling);
    const fs = el.closest("fieldset");
    const legend = fs?.querySelector("legend");
    if (legend && countControls(fs!) <= 3) return textWithoutControls(legend);
    // 親要素をたどり、この欄だけを含む範囲のテキストを使う
    let cur: Element | null = el.parentElement;
    let ctx = "";
    for (let i = 0; cur && cur !== root && i < 3; i++, cur = cur.parentElement) {
      if (countControls(cur) > 1) break;
      const t = textWithoutControls(cur);
      if (t && t.length <= 60) ctx = t;
    }
    return ctx;
  };

  const fields: FieldDescriptor[] = [];
  const radioGroups = new Map<string, FieldDescriptor>();
  let idx = 0;
  for (const el of controls) {
    const tag = el.tagName.toLowerCase() as "input" | "select" | "textarea";
    const type = tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : tag;
    const myIdx = idx++;
    el.setAttribute("data-sweep-idx", String(myIdx));
    const labelText = labelOf(el);
    const required =
      (el as HTMLInputElement).required ||
      el.getAttribute("aria-required") === "true" ||
      /必須|required|[*＊]/i.test(labelText);
    if (type === "radio") {
      const name = el.getAttribute("name") ?? `__radio${myIdx}`;
      let g = radioGroups.get(name);
      if (!g) {
        const ctx = contextOf(el);
        g = {
          idx: myIdx,
          tag: "input",
          type: "radio",
          name,
          id: "",
          placeholder: "",
          autocomplete: el.getAttribute("autocomplete") ?? "",
          label: norm(el.closest("[role=radiogroup]")?.getAttribute("aria-label")),
          prevText: "",
          context: ctx,
          required: required || /必須|[*＊]/.test(ctx),
          maxLength: null,
          options: [],
          optionIdx: [],
        };
        radioGroups.set(name, g);
        fields.push(g);
      }
      g.required ||= (el as HTMLInputElement).required;
      g.options.push({ value: (el as HTMLInputElement).value, label: labelText || prevTextOf(el) });
      g.optionIdx!.push(myIdx);
      continue;
    }
    const ctx = contextOf(el);
    const prev = prevTextOf(el);
    const ml = (el as HTMLInputElement).maxLength;
    fields.push({
      idx: myIdx,
      tag,
      type,
      name: el.getAttribute("name") ?? "",
      id: el.id ?? "",
      placeholder: el.getAttribute("placeholder") ?? "",
      autocomplete: el.getAttribute("autocomplete") ?? "",
      label: labelText,
      prevText: prev,
      context: ctx,
      required: required || /必須|[*＊]/.test(`${prev} ${ctx}`),
      maxLength: typeof ml === "number" && ml > 0 ? ml : null,
      options:
        tag === "select"
          ? Array.from((el as HTMLSelectElement).options).map((o) => ({ value: o.value, label: norm(o.textContent) }))
          : [],
      value: type === "checkbox" ? (el as HTMLInputElement).value : undefined,
    });
  }

  const buttons: ButtonDescriptor[] = [];
  const btnEls = Array.from(
    root.querySelectorAll("button, input[type=submit], input[type=image], input[type=button], a[role=button]"),
  ).filter(isVisible);
  btnEls.forEach((b, i) => {
    b.setAttribute("data-sweep-btn", String(i));
    const type = (b.getAttribute("type") ?? (b.tagName === "BUTTON" ? "submit" : "")).toLowerCase();
    const text = norm(
      b.tagName === "INPUT" ? (b as HTMLInputElement).value || b.getAttribute("alt") : b.textContent || b.getAttribute("aria-label"),
    );
    buttons.push({ idx: i, text, isSubmit: (b.tagName === "BUTTON" && type === "submit") || type === "submit" || type === "image" });
  });

  const editableFieldCount = controls.filter((el) => {
    const t = (el.getAttribute("type") ?? "text").toLowerCase();
    return el.tagName !== "INPUT" || !["radio", "checkbox"].includes(t);
  }).length;
  return { fields, buttons, text: norm(document.body?.innerText).slice(0, 20000), editableFieldCount };
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(extractInPage);
}

async function pageCaptchaGuard(page: Page) {
  const html = await page.content();
  const frameUrls = page.frames().map((f) => f.url());
  return captchaGuard({ html, frameUrls });
}

async function applyPlan(page: Page, plan: PlannedField[]): Promise<FilledField[]> {
  const filled: FilledField[] = [];
  for (const p of plan) {
    if (!p.fill || !p.mapping.key) continue;
    const f = p.field;
    if (f.type === "radio") {
      if (p.fill.optionIdx === undefined) continue;
      await page.locator(`[data-sweep-idx="${p.fill.optionIdx}"]`).check({ force: true });
    } else if (f.type === "checkbox") {
      if (p.fill.check) await page.locator(`[data-sweep-idx="${f.idx}"]`).check({ force: true });
    } else if (f.tag === "select") {
      await page.locator(`[data-sweep-idx="${f.idx}"]`).selectOption({ value: p.fill.value });
    } else {
      await page.locator(`[data-sweep-idx="${f.idx}"]`).fill(p.fill.value);
    }
    filled.push({ label: p.displayLabel, key: p.mapping.key, value: p.fill.check ? "(チェック)" : p.fill.value });
  }
  return filled;
}

async function clickAndWait(page: Page, btnIdx: number, timeoutMs: number): Promise<void> {
  const nav = page
    .waitForEvent("framenavigated", { predicate: (fr) => fr === page.mainFrame(), timeout: Math.min(timeoutMs, 10_000) })
    .catch(() => null);
  await page.locator(`[data-sweep-btn="${btnIdx}"]`).click();
  await nav;
  await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForTimeout(300);
}

async function shot(page: Page, dir: string, name: string): Promise<string | undefined> {
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    return path;
  } catch {
    return undefined;
  }
}

/** 1 件のフォームに対して入力〜(必要なら)送信を行う */
export async function attemptEntry(browser: Browser, url: string, profile: Profile, opts: AttemptOptions): Promise<AttemptResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const context = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  // tsx/esbuild の keepNames が埋め込む __name() をページ内でも解決できるようにする
  await context.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  if (opts.allowedHosts) {
    const allowed = new Set(opts.allowedHosts);
    await page.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (u.protocol === "data:" || u.protocol === "about:" || allowed.has(u.hostname)) return route.continue();
      return route.abort("blockedbyclient");
    });
  }
  // 送信モードでのみ「送信しますか？」系のダイアログを承認する
  page.on("dialog", (d) => void (opts.submit ? d.accept() : d.dismiss()).catch(() => undefined));

  let filled: FilledField[] = [];
  const done = async (outcome: AttemptOutcome, reason: string, takeShot = true): Promise<AttemptResult> => {
    const screenshotPath = takeShot ? await shot(page, opts.screenshotDir, `${opts.screenshotName}-${outcome}`) : undefined;
    const finalUrl = page.url();
    await context.close();
    return { outcome, reason, filled, screenshotPath, finalUrl };
  };

  try {
    const res = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    if (res && res.status() >= 400) return await done("failed", `ページ取得に失敗しました (HTTP ${res.status()})`);

    // 1) CAPTCHA
    const cap = await pageCaptchaGuard(page);
    if (!cap.ok) return await done("needs_manual", cap.reason!);

    // 2) 規約の自動応募禁止
    let snap = await snapshot(page);
    const terms = termsGuard([snap.text, opts.extraTermsText]);
    if (!terms.ok) return await done("skipped", terms.reason!);

    // 3) 入力計画と必須欄チェック
    if (snap.fields.length === 0) return await done("needs_manual", "応募フォームが見つかりませんでした");
    const plan = planForm(snap.fields, profile);
    const req = requiredFieldsGuard(plan.map((p) => ({ label: p.displayLabel, required: p.field.required, resolved: p.resolved })));
    if (!req.ok) return await done("needs_manual", req.reason!);
    const firstBtn = chooseButton(snap.buttons, false);
    if (!firstBtn) return await done("needs_manual", "送信ボタンを特定できませんでした");

    filled = await applyPlan(page, plan);

    // 4) dry-run はここで停止
    if (!opts.submit) return await done("dry_run", `dry-run: 送信直前で停止しました (${filled.length} 欄を入力)`);

    // 5) 送信 (確認画面があれば最終送信まで、最大 3 段)
    await clickAndWait(page, firstBtn.idx, timeoutMs);
    for (let step = 0; step < 3; step++) {
      const cap2 = await pageCaptchaGuard(page);
      if (!cap2.ok) return await done("needs_manual", `確認画面で${cap2.reason}`);
      snap = await snapshot(page);
      const state = classifyPageState(snap);
      if (state === "complete") return await done("submitted", "送信しました (完了画面を確認)");
      if (state === "confirm") {
        const fin = chooseButton(snap.buttons, true);
        if (!fin) return await done("needs_manual", "確認画面の送信ボタンを特定できませんでした");
        await clickAndWait(page, fin.idx, timeoutMs);
        continue;
      }
      if (state === "error" || state === "form") {
        return await done("failed", `送信後もフォームが表示されています (入力エラーの可能性): ${snap.text.slice(0, 120)}`);
      }
      return await done("submitted", "送信しました (完了表示は確認できませんでした。重複送信を避けるため送信済みとして記録)");
    }
    return await done("submitted", "送信しました (確認画面が続いたため完了表示は未確認)");
  } catch (e) {
    return await done("failed", `エラー: ${(e as Error).message.split("\n")[0]}`);
  }
}
