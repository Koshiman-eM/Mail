/**
 * リスク許容度の上書き (ダッシュボードから変更)。
 *
 * - 保存先: kv `risk:limits:<mode>` = { values (部分可), preset?, updatedAt, source: "dashboard" }。
 *   実効値 = 環境変数 (.env) の値に上書き値を重ねたもの。キーを消せば .env の値に戻る。
 * - 範囲は src/core/config.ts の RISK_SETTING_SPECS (環境変数の検証と同じ定義) を使う。
 * - MAX_ORDERS_PER_MINUTE は誤発注の連鎖を止める安全装置なので、プリセットでは変えず、
 *   個別調整も .env の値以下 (下げる方向) だけ許可する。
 * - live では「リスクを上げる」変更 (割合・保有数・発注数を増やす) に確認語が必要。下げる変更は即時。
 *   最大ドローダウンを現在のドローダウン以下にすると即キルスイッチが作動するので、paper/live とも確認を求める。
 *
 * このモジュールは RiskManager (manager.ts) から読まれるので、manager.ts を import しない (循環を避ける)。
 */
import { z } from "zod";
import { RISK_SETTING_KEYS, RISK_SETTING_SPECS, type RiskSettingKey } from "../core/config";
import { createLogger } from "../core/logger";
import type { RiskLimits, Store, TradingMode } from "../core/types";

const log = createLogger("risk-settings");

export const riskLimitsKey = (mode: TradingMode) => `risk:limits:${mode}`;
/** live でリスクを上げるときの確認語 */
export const RISK_RAISE_CONFIRM = "リスクを上げる";
export const RISK_LIMITS_AUDIT = "risk.limits_changed";

export type RiskValues = Record<RiskSettingKey, number>;
export type RiskPresetId = "conservative" | "standard" | "aggressive";
/** プリセットで変える項目 (発注数の上限は安全装置なので含めない) */
export type RiskPresetKey = Exclude<RiskSettingKey, "maxOrdersPerMinute">;
export const RISK_PRESET_KEYS: readonly RiskPresetKey[] = RISK_SETTING_KEYS.filter((k): k is RiskPresetKey => k !== "maxOrdersPerMinute");
/** .env の値より上げられない (下げる方向だけ許可) 項目 */
export const LOWER_ONLY_KEYS: readonly RiskSettingKey[] = ["maxOrdersPerMinute"];

/**
 * 廃止した項目 (FX・株式の資産クラスの上限)。kv `risk:limits:<mode>` に残っていても読まない (実効値に使わない) が、
 * ダッシュボードから保存し直すときも消さずに引き継ぐ (ユーザーが保存した値を消さない)。変更要求に含まれていても無視する
 */
const RETIRED_RISK_KEYS = ["maxExposureFx", "maxExposureStock"] as const;

/** kv の上書き値のうち廃止した項目 (値はそのまま。読まない) */
function retiredRiskValues(store: Store, mode: TradingMode): Record<string, unknown> {
  const raw = store.kvGet<unknown>(riskLimitsKey(mode));
  const src = raw && typeof raw === "object" ? (raw as { values?: unknown }).values : undefined;
  if (!src || typeof src !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of RETIRED_RISK_KEYS) if ((src as Record<string, unknown>)[k] !== undefined) out[k] = (src as Record<string, unknown>)[k];
  return out;
}

const standardValues = Object.fromEntries(RISK_PRESET_KEYS.map((k) => [k, RISK_SETTING_SPECS[k].def])) as Record<RiskPresetKey, number>;

/** プリセット。標準 = config の既定値 (RISK_SETTING_SPECS.def)。範囲内であることはテストで確認する */
export const RISK_PRESETS: Readonly<Record<RiskPresetId, { label: string; values: Readonly<Record<RiskPresetKey, number>> }>> = {
  conservative: {
    label: "保守的",
    values: {
      riskPerTrade: 0.0025, maxDailyLoss: 0.015, maxDrawdown: 0.08, maxPositionPct: 0.1,
      maxExposureCrypto: 0.3, maxExposureMeme: 0.02, maxOpenPositions: 4,
    },
  },
  standard: { label: "標準", values: standardValues },
  aggressive: {
    label: "積極的",
    values: {
      riskPerTrade: 0.01, maxDailyLoss: 0.05, maxDrawdown: 0.25, maxPositionPct: 0.3,
      maxExposureCrypto: 0.8, maxExposureMeme: 0.1, maxOpenPositions: 12,
    },
  },
};
export const RISK_PRESET_IDS: readonly RiskPresetId[] = ["conservative", "standard", "aggressive"];

export interface RiskLimitsOverride {
  values: Partial<RiskValues>;
  preset?: RiskPresetId;
  updatedAt: number;
  source: "dashboard";
}

/** 割合の表記ゆれ (0.1 + 0.2 など) で比較が狂わないよう、12 桁に丸める */
const norm = (v: number) => Number(v.toPrecision(12));
const EPS = 1e-12;

/** RiskLimits → 項目ごとの値 */
export function riskValuesOf(l: RiskLimits): RiskValues {
  return {
    riskPerTrade: l.riskPerTrade,
    maxDailyLoss: l.maxDailyLoss,
    maxDrawdown: l.maxDrawdown,
    maxPositionPct: l.maxPositionPct,
    maxExposureCrypto: l.maxExposureByClass.crypto,
    maxExposureMeme: l.maxExposureByClass.meme,
    maxOpenPositions: l.maxOpenPositions,
    maxOrdersPerMinute: l.maxOrdersPerMinute,
  };
}

/** base に項目ごとの値を重ねた RiskLimits (base は変更しない) */
export function applyRiskValues(base: RiskLimits, v: Partial<RiskValues>): RiskLimits {
  const pick = (k: RiskSettingKey, cur: number) => (v[k] !== undefined ? (v[k] as number) : cur);
  return {
    ...base,
    riskPerTrade: pick("riskPerTrade", base.riskPerTrade),
    maxDailyLoss: pick("maxDailyLoss", base.maxDailyLoss),
    maxDrawdown: pick("maxDrawdown", base.maxDrawdown),
    maxPositionPct: pick("maxPositionPct", base.maxPositionPct),
    maxOpenPositions: pick("maxOpenPositions", base.maxOpenPositions),
    maxOrdersPerMinute: pick("maxOrdersPerMinute", base.maxOrdersPerMinute),
    maxExposureByClass: {
      crypto: pick("maxExposureCrypto", base.maxExposureByClass.crypto),
      meme: pick("maxExposureMeme", base.maxExposureByClass.meme),
    },
  };
}

const pctText = (r: number) => `${Number((r * 100).toPrecision(6))}%`;

/** 1 項目の検証。問題があれば日本語のメッセージ、無ければ undefined */
export function checkRiskValue(key: RiskSettingKey, v: unknown, envValue?: number): string | undefined {
  const s = RISK_SETTING_SPECS[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return `${s.label} は数値で指定してください`;
  if (s.kind === "ratio") {
    if (!(v > s.min && v <= s.max)) return `${s.label} は 0% より大きく ${pctText(s.max)} 以下で指定してください`;
  } else if (!Number.isInteger(v) || v < s.min || v > s.max) {
    return `${s.label} は ${s.min} 以上 ${s.max} 以下の整数で指定してください`;
  }
  if (LOWER_ONLY_KEYS.includes(key) && envValue !== undefined && v > envValue) {
    return `${s.label} は安全装置のため .env の値 (${envValue}) より上げられません`;
  }
  return undefined;
}

/**
 * kv の上書き値を読む。範囲外・型違いの項目は捨てる (壊れた kv で上限を緩めない)。
 * 廃止した項目 (maxExposureFx / maxExposureStock) が kv に残っていても読まない (kv は書き換えない)。
 * 下げる方向だけの項目は .env の値で頭打ちにする (.env を下げた後に古い上書きで上がらないように)。
 */
export function readRiskOverride(store: Store, mode: TradingMode, envLimits: RiskLimits): RiskLimitsOverride | undefined {
  const raw = store.kvGet<unknown>(riskLimitsKey(mode));
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<RiskLimitsOverride>;
  const env = riskValuesOf(envLimits);
  const values: Partial<RiskValues> = {};
  const src = r.values && typeof r.values === "object" ? (r.values as Record<string, unknown>) : {};
  for (const k of RISK_SETTING_KEYS) {
    const v = src[k];
    if (v === undefined) continue;
    if (LOWER_ONLY_KEYS.includes(k) && typeof v === "number" && checkRiskValue(k, v) === undefined) {
      values[k] = Math.min(v, env[k]);
      continue;
    }
    const err = checkRiskValue(k, v, env[k]);
    if (err) {
      log.warn("リスク上限の上書き値が不正なため無視します", { key: k, value: String(v), mode });
      continue;
    }
    values[k] = norm(v as number);
  }
  return {
    values,
    ...(typeof r.preset === "string" && (RISK_PRESET_IDS as readonly string[]).includes(r.preset) ? { preset: r.preset as RiskPresetId } : {}),
    updatedAt: typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
    source: "dashboard",
  };
}

/** 実効値 (.env の値 + 上書き値) */
export function effectiveRiskLimits(envLimits: RiskLimits, store: Store | undefined, mode: TradingMode): { limits: RiskLimits; override?: RiskLimitsOverride } {
  const override = store ? readRiskOverride(store, mode, envLimits) : undefined;
  return { limits: override ? applyRiskValues(envLimits, override.values) : envLimits, ...(override ? { override } : {}) };
}

/** 値が「リスクを上げる」変更か (全項目とも大きいほどリスクが高い) */
const isRaise = (from: number, to: number) => to > from + EPS;

export interface RiskChange {
  key: RiskSettingKey;
  from: number;
  to: number;
  raised: boolean;
}

export function diffRiskValues(before: RiskValues, after: RiskValues): RiskChange[] {
  const out: RiskChange[] = [];
  for (const k of RISK_SETTING_KEYS) {
    if (Math.abs(before[k] - after[k]) <= EPS) continue;
    out.push({ key: k, from: before[k], to: after[k], raised: isRaise(before[k], after[k]) });
  }
  return out;
}

/** values (プリセット対象の項目) がプリセットと一致するもの */
export function matchingPreset(v: RiskValues): RiskPresetId | undefined {
  return RISK_PRESET_IDS.find((id) => RISK_PRESET_KEYS.every((k) => Math.abs(RISK_PRESETS[id].values[k] - v[k]) <= EPS));
}

// ───────── 変更要求 (ダッシュボードの POST) ─────────

// 廃止した項目 (RETIRED_RISK_KEYS) は古い画面から送られても拒否せず無視する (それ以外の未知の項目は書き間違いとして拒否)
const valuesSchema = z.strictObject({
  ...(Object.fromEntries(RISK_SETTING_KEYS.map((k) => [k, z.number().optional()])) as Record<RiskSettingKey, z.ZodOptional<z.ZodNumber>>),
  ...(Object.fromEntries(RETIRED_RISK_KEYS.map((k) => [k, z.unknown().optional()])) as Record<(typeof RETIRED_RISK_KEYS)[number], z.ZodOptional<z.ZodUnknown>>),
});

export const RiskSettingsRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("set"),
    values: valuesSchema,
    preset: z.enum(["conservative", "standard", "aggressive"]).optional(),
    confirm: z.string().max(100).optional(),
    acknowledgeDrawdown: z.boolean().optional(),
  }),
  z.strictObject({
    action: z.literal("reset"),
    confirm: z.string().max(100).optional(),
    acknowledgeDrawdown: z.boolean().optional(),
  }),
]);
export type RiskSettingsRequest = z.infer<typeof RiskSettingsRequestSchema>;

/** 現在のリスク状態 (判定用)。不明な値は undefined */
export interface RiskMetrics {
  drawdownPct?: number;
  dailyLossPct?: number;
  killSwitch?: boolean;
}

export type RiskSettingsResult =
  | { ok: true; changed: boolean; limits: RiskLimits; override?: RiskLimitsOverride; changes: RiskChange[]; raised: boolean; warnings: string[] }
  | { ok: false; status: 400; error: string; fieldErrors?: Partial<Record<RiskSettingKey, string>> }
  | {
      ok: false;
      status: 409;
      error: string;
      /** 必要な確認: raise = live でリスクを上げる (確認語)、drawdown = 即キルスイッチ作動 */
      needs: ("raise" | "drawdown")[];
      raisedKeys: RiskSettingKey[];
      confirmPhrase?: string;
      drawdownPct?: number;
      changes: RiskChange[];
    };

/**
 * 変更要求を検証して保存し、監査ログに残す (確認が必要・不正なら何も書かない)。
 * 同期処理なので、同じプロセス内の同時要求が混ざることはない。
 */
export function applyRiskSettingsChange(opts: {
  store: Store;
  mode: TradingMode;
  envLimits: RiskLimits;
  request: unknown;
  metrics: RiskMetrics;
  now: number;
  source?: "dashboard";
}): RiskSettingsResult {
  const { store, mode, envLimits, now } = opts;
  const parsed = RiskSettingsRequestSchema.safeParse(opts.request);
  if (!parsed.success) {
    return { ok: false, status: 400, error: `要求の形式が不正です: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(本文)"} ${i.message}`).join(" / ").slice(0, 300)}` };
  }
  const req = parsed.data;
  const env = riskValuesOf(envLimits);
  const cur = effectiveRiskLimits(envLimits, store, mode);
  const before = riskValuesOf(cur.limits);

  let newValues: Partial<RiskValues> = {};
  if (req.action === "set") {
    const fieldErrors: Partial<Record<RiskSettingKey, string>> = {};
    for (const k of RISK_SETTING_KEYS) {
      const v = req.values[k];
      if (v === undefined) continue;
      const err = checkRiskValue(k, v, env[k]);
      if (err) fieldErrors[k] = err;
      else newValues[k] = norm(v);
    }
    if (Object.keys(fieldErrors).length) {
      return { ok: false, status: 400, error: `範囲外の値があります: ${Object.values(fieldErrors).join(" / ")}`, fieldErrors };
    }
  } else newValues = {};
  const after = riskValuesOf(applyRiskValues(envLimits, newValues));
  const changes = diffRiskValues(before, after);
  const raisedKeys = changes.filter((c) => c.raised).map((c) => c.key);
  const raised = raisedKeys.length > 0;

  const needs: ("raise" | "drawdown")[] = [];
  if (mode === "live" && raised && req.confirm !== RISK_RAISE_CONFIRM) needs.push("raise");
  // 最大ドローダウンを現在のドローダウン以下にすると、次の評価で即キルスイッチが作動する (既に作動中なら新たな影響は無い)
  const dd = opts.metrics.drawdownPct;
  const ddTrips = dd !== undefined && Number.isFinite(dd) && !opts.metrics.killSwitch && after.maxDrawdown <= dd && changes.some((c) => c.key === "maxDrawdown");
  if (ddTrips && req.acknowledgeDrawdown !== true) needs.push("drawdown");
  if (needs.length) {
    const msgs: string[] = [];
    if (needs.includes("raise")) msgs.push(`live でリスクを上げる変更です (${raisedKeys.map((k) => RISK_SETTING_SPECS[k].label).join("、")})。確認語「${RISK_RAISE_CONFIRM}」を入力してください`);
    if (needs.includes("drawdown")) msgs.push(`最大ドローダウン ${pctText(after.maxDrawdown)} は現在のドローダウン ${pctText(dd as number)} 以下です。保存すると即キルスイッチが作動します`);
    return {
      ok: false, status: 409, error: msgs.join(" / "), needs, raisedKeys,
      ...(needs.includes("raise") ? { confirmPhrase: RISK_RAISE_CONFIRM } : {}),
      ...(dd !== undefined ? { drawdownPct: dd } : {}),
      changes,
    };
  }

  const warnings: string[] = [];
  if (ddTrips) warnings.push("最大ドローダウンが現在のドローダウン以下のため、次の評価でキルスイッチが作動します");
  const dl = opts.metrics.dailyLossPct;
  if (dl !== undefined && Number.isFinite(dl) && after.maxDailyLoss < dl) warnings.push("日次損失の上限が当日の損失を下回るため、次の評価で当日の新規エントリーが止まります");

  const hasOverride = cur.override !== undefined && Object.keys(cur.override.values).length > 0;
  if (changes.length === 0 && (req.action === "set" ? sameOverride(cur.override?.values ?? {}, newValues) : !hasOverride)) {
    return { ok: true, changed: false, limits: cur.limits, ...(cur.override ? { override: cur.override } : {}), changes, raised: false, warnings };
  }

  // プリセット名は値が実際にそのプリセットと一致するときだけ残す (調整後に名前だけ残らないように)
  const preset = req.action === "set" && req.preset && matchingPreset(after) === req.preset ? req.preset : undefined;
  let override: RiskLimitsOverride | undefined;
  // 廃止した項目の保存済みの値は消さずに引き継ぐ (読まないので実効値には影響しない)
  const retired = retiredRiskValues(store, mode);
  if (Object.keys(newValues).length === 0 && Object.keys(retired).length === 0) store.kvSet(riskLimitsKey(mode), undefined);
  else {
    if (Object.keys(newValues).length > 0) override = { values: newValues, ...(preset ? { preset } : {}), updatedAt: now, source: opts.source ?? "dashboard" };
    store.kvSet(riskLimitsKey(mode), { values: { ...retired, ...newValues }, ...(override?.preset ? { preset: override.preset } : {}), updatedAt: now, source: opts.source ?? "dashboard" });
  }
  store.audit({
    ts: now,
    type: RISK_LIMITS_AUDIT,
    data: {
      mode, action: req.action, before, after, preset: preset ?? null, source: opts.source ?? "dashboard", raised,
      changes: changes.map((c) => ({ key: c.key, from: c.from, to: c.to, raised: c.raised })),
      ...(ddTrips ? { acknowledgedDrawdown: true } : {}),
    },
  });
  log.warn("リスク上限を変更しました", { mode, action: req.action, raised, changes: changes.map((c) => `${c.key} ${c.from}→${c.to}`).join(", ") });
  return { ok: true, changed: true, limits: applyRiskValues(envLimits, newValues), ...(override ? { override } : {}), changes, raised, warnings };
}

function sameOverride(a: Partial<RiskValues>, b: Partial<RiskValues>): boolean {
  return RISK_SETTING_KEYS.every((k) => (a[k] === undefined) === (b[k] === undefined) && (a[k] === undefined || Math.abs((a[k] as number) - (b[k] as number)) <= EPS));
}

/** GET /api/risk-settings 用の表示データ (秘密情報は含めない) */
export function riskSettingsView(opts: { store: Store; mode: TradingMode; envLimits: RiskLimits; metrics: RiskMetrics }) {
  const { limits, override } = effectiveRiskLimits(opts.envLimits, opts.store, opts.mode);
  const effective = riskValuesOf(limits);
  const env = riskValuesOf(opts.envLimits);
  return {
    mode: opts.mode,
    effective,
    env,
    override: override ? { values: override.values, preset: override.preset ?? null, updatedAt: override.updatedAt, source: override.source } : null,
    sources: Object.fromEntries(RISK_SETTING_KEYS.map((k) => [k, override?.values[k] !== undefined ? "dashboard" : "env"])) as Record<RiskSettingKey, "env" | "dashboard">,
    presets: RISK_PRESET_IDS.map((id) => ({ id, label: RISK_PRESETS[id].label, values: RISK_PRESETS[id].values })),
    fields: RISK_SETTING_KEYS.map((k) => {
      const s = RISK_SETTING_SPECS[k];
      return { key: k, label: s.label, env: s.env, kind: s.kind, min: s.min, max: s.max, inPreset: (RISK_PRESET_KEYS as readonly string[]).includes(k), lowerOnly: LOWER_ONLY_KEYS.includes(k) };
    }),
    current: opts.metrics,
    confirmPhrase: RISK_RAISE_CONFIRM,
  };
}

/** CLI 用: 実効値と上書きの有無 */
export function riskOverrideLines(store: Store, mode: TradingMode, envLimits: RiskLimits, fmtTime: (ts: number) => string): string[] {
  const { limits, override } = effectiveRiskLimits(envLimits, store, mode);
  if (!override || Object.keys(override.values).length === 0) return [`リスク上限の上書き (${mode}): なし (.env の値を使用)`];
  const eff = riskValuesOf(limits);
  const env = riskValuesOf(envLimits);
  const fmt = (k: RiskSettingKey, v: number) => (RISK_SETTING_SPECS[k].kind === "ratio" ? pctText(v) : String(v));
  const lines = [
    `リスク上限の上書き (${mode}): あり (ダッシュボードで ${fmtTime(override.updatedAt)} に変更${override.preset ? `、プリセット ${RISK_PRESETS[override.preset].label}` : ""})`,
  ];
  for (const k of RISK_SETTING_KEYS) {
    if (override.values[k] === undefined) continue;
    lines.push(`  ${RISK_SETTING_SPECS[k].label}: 実効 ${fmt(k, eff[k])} (.env ${fmt(k, env[k])})`);
  }
  return lines;
}
