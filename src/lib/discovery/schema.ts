import { z } from "zod";

/** 10 進数の入力 (文字列・数値どちらも可。保存は文字列で decimal.js / Prisma Decimal に渡す) */
const decimal = (label: string, opts: { positive?: boolean } = {}) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(
      z
        .string()
        .regex(/^\d{1,10}(\.\d{1,3})?$/, `${label}は 0 以上の数値で入力してください`)
        .refine((v) => !opts.positive || Number(v) > 0, `${label}は 0 より大きい値を入力してください`),
    );

/** 空文字・null は「未設定」 */
const optionalDecimal = (label: string) =>
  z
    .union([z.literal(""), z.null(), decimal(label, { positive: true })])
    .optional()
    .transform((v) => (v === "" ? null : v));

const optionalInt = (label: string, max: number) =>
  z
    .union([z.literal(""), z.null(), z.number().int(`${label}は整数で入力してください`).min(1, `${label}は 1 以上で入力してください`).max(max, `${label}は ${max} 以下で入力してください`)])
    .optional()
    .transform((v) => (v === "" ? null : v));

const keyword = z.string().trim().max(100, "キーワードは 100 文字以内で入力してください");

/** 探索条件の入力 (作成時)。更新時は partial で受け付ける */
export const watchBaseSchema = z.object({
  name: z.string().trim().min(1, "名前を入力してください").max(60, "名前は 60 文字以内で入力してください"),
  keywordJa: z.string().trim().min(1, "国内検索キーワードを入力してください").max(100, "キーワードは 100 文字以内で入力してください"),
  foreignKeywords: z.object({ ALIBABA: keyword.optional(), ALIEXPRESS: keyword.optional(), ALI1688: keyword.optional() }).strict(),
  platforms: z.array(z.enum(["ALIBABA", "ALIEXPRESS", "ALI1688"])).min(1, "検索するサイトを 1 つ以上選んでください").max(3),
  enabled: z.boolean(),
  estWeightKg: decimal("想定重量", { positive: true }),
  estLengthCm: optionalDecimal("縦"),
  estWidthCm: optionalDecimal("横"),
  estHeightCm: optionalDecimal("高さ"),
  targetQuantity: z.number().int("想定数量は整数で入力してください").min(1, "想定数量は 1 以上で入力してください").max(1_000_000, "想定数量が大きすぎます"),
  minRoiPercent: decimal("最低 ROI"),
  minProfitJpy: optionalDecimal("最低利益"),
  maxMoq: optionalInt("MOQ 上限", 1_000_000),
  maxUnitPriceJpy: optionalDecimal("仕入単価の上限"),
  autoAdd: z.boolean(),
  maxAutoAddPerRun: z.number().int("自動追加の上限は整数で入力してください").min(0, "自動追加の上限は 0 以上で入力してください").max(30, "自動追加の上限は 30 件以下にしてください"),
});

export const watchCreateSchema = watchBaseSchema
  .partial({ foreignKeywords: true, enabled: true, targetQuantity: true, autoAdd: true, maxAutoAddPerRun: true, estLengthCm: true, estWidthCm: true, estHeightCm: true, minProfitJpy: true, maxMoq: true, maxUnitPriceJpy: true })
  .superRefine(dimsAllOrNone);

export const watchUpdateSchema = watchBaseSchema.partial().superRefine(dimsAllOrNone);

function dimsAllOrNone(v: { estLengthCm?: string | null; estWidthCm?: string | null; estHeightCm?: string | null }, ctx: z.RefinementCtx) {
  const given = [v.estLengthCm, v.estWidthCm, v.estHeightCm].filter((d) => d !== null && d !== undefined);
  if (given.length > 0 && given.length < 3) ctx.addIssue({ code: "custom", path: ["estLengthCm"], message: "寸法は縦・横・高さをすべて入力するか、すべて空欄にしてください" });
}

export type WatchCreateInput = z.infer<typeof watchCreateSchema>;
export type WatchUpdateInput = z.infer<typeof watchUpdateSchema>;
