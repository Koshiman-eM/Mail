/**
 * 資産クラスの語彙とクラス別の既定値 (プロファイル)。
 *
 * - 語彙 (`ASSET_CLASSES`) は全アプリ共通: crypto / meme / fx / stock。DB の記録 (取引・仮想トレード・腕のキー・kv) に
 *   この文字列がそのまま入るので、名前は変えない。
 * - アプリはこのうち使うクラス (`enabledAssetClasses`) を選ぶ (暗号資産のボット `trader/` は crypto・meme)。
 *   選ぶのは設定の定義 (`defineAppConfig`) のときに 1 回だけ (1 プロセス = 1 アプリ)。
 * - クラス別の表 (既定コスト・レジームのスプレッド閾値・paper のレバレッジ・情報の擬似資産・空売りの再現・流動性の判定・
 *   リスクのプリセット) はここだけに置く。各モジュールは `enabledProfile` で引く。
 * - 使わないクラス (アプリが選んでいないクラス。例: trader の古い記録に残る fx / stock) はプロファイルを返さない。
 *   呼び出し側は従来どおり既定値 (最初に選んだクラスの値・レバレッジ 1・擬似資産なし) に落とす (例外にしない)。
 */

export const ASSET_CLASSES = ["crypto", "meme", "fx", "stock"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

/** リスクのプリセット (ダッシュボード) ごとの資産クラスのエクスポージャー上限 (評価額比) */
export interface ExposurePresets {
  conservative: number;
  /** 既定値 (= 環境変数 MAX_EXPOSURE_<CLASS> の既定) */
  standard: number;
  aggressive: number;
}

export interface AssetClassProfile {
  /** 表示名 (日本語) */
  label: string;
  /** バックテスト・仮想トレードの既定コスト (スプレッドは全幅 bps、スリッページは片道 bps) */
  defaultCosts: { spreadBps: number; slippageBps: number };
  /** レジーム判定で low_liquidity とみなすスプレッド (bps) */
  regimeMaxSpreadBps: number;
  /** PaperBroker の証拠金計算のレバレッジ (1 = 現物) */
  paperLeverage: number;
  /** 情報バイアスのクラスの擬似資産 (brief.biases のキー) */
  intelPseudoAsset: string;
  /**
   * 情報バイアスの選び方。base: 基準通貨 (無ければ擬似資産)。pair: 基準通貨 − クオート通貨 (FX)。
   * pair では情報源の寄与のクオート通貨側の符号を反転する
   */
  intelBiasMode: "base" | "pair";
  /** paper で空売りを再現してよいクラスか (allowShort=false の銘柄。src/core/short.ts) */
  paperSimulatedShort: boolean;
  /** 新規エントリーに流動性 (USD) の確認を求めるか (RiskManager。MEME_MIN_LIQUIDITY_USD) */
  requiresLiquidityCheck: boolean;
  /** ベースラインの計画のリスク倍率に掛ける係数 (1 = そのまま) */
  planRiskMultiplier: number;
  /** リスクのプリセットのエクスポージャー上限 */
  exposurePresets: ExposurePresets;
}

export const ASSET_CLASS_PROFILES: Readonly<Record<AssetClass, Readonly<AssetClassProfile>>> = {
  crypto: {
    label: "暗号資産",
    defaultCosts: { spreadBps: 2, slippageBps: 1 },
    regimeMaxSpreadBps: 30,
    paperLeverage: 1,
    intelPseudoAsset: "CRYPTO",
    intelBiasMode: "base",
    paperSimulatedShort: true,
    requiresLiquidityCheck: false,
    planRiskMultiplier: 1,
    exposurePresets: { conservative: 0.3, standard: 0.6, aggressive: 0.8 },
  },
  meme: {
    label: "ミーム",
    defaultCosts: { spreadBps: 60, slippageBps: 20 },
    regimeMaxSpreadBps: 150,
    paperLeverage: 1,
    intelPseudoAsset: "MEME",
    intelBiasMode: "base",
    paperSimulatedShort: false,
    requiresLiquidityCheck: true,
    planRiskMultiplier: 0.7,
    exposurePresets: { conservative: 0.02, standard: 0.05, aggressive: 0.1 },
  },
  fx: {
    label: "FX",
    defaultCosts: { spreadBps: 1, slippageBps: 0.5 },
    regimeMaxSpreadBps: 8,
    paperLeverage: 10,
    intelPseudoAsset: "FX",
    intelBiasMode: "pair",
    // FX は売り建てが普通にできる (allowShort=true の銘柄にする)。再現は使わない
    paperSimulatedShort: false,
    requiresLiquidityCheck: false,
    planRiskMultiplier: 1,
    exposurePresets: { conservative: 0.3, standard: 0.6, aggressive: 0.8 },
  },
  stock: {
    label: "株式",
    defaultCosts: { spreadBps: 2, slippageBps: 1 },
    regimeMaxSpreadBps: 30,
    paperLeverage: 2,
    intelPseudoAsset: "STOCKS",
    intelBiasMode: "base",
    // 信用の売りができない銘柄 (allowShort=false) でも paper では再現して学習できる (live では allowShort だけ)
    paperSimulatedShort: true,
    requiresLiquidityCheck: false,
    planRiskMultiplier: 1,
    exposurePresets: { conservative: 0.3, standard: 0.6, aggressive: 0.8 },
  },
};

export const isAssetClass = (x: unknown): x is AssetClass => typeof x === "string" && (ASSET_CLASSES as readonly string[]).includes(x);

let enabled: readonly AssetClass[] = ASSET_CLASSES;
let configured = false;

/**
 * アプリが使う資産クラス (語彙の順)。設定の定義 (`defineAppConfig`) で決める。未設定なら語彙の全部
 * (コアの単体テストなど。アプリは必ず設定を定義する)
 */
export function enabledAssetClasses(): readonly AssetClass[] {
  return enabled;
}

/** アプリが資産クラスを選んだか (未設定なら語彙の全部が有効) */
export function assetClassesConfigured(): boolean {
  return configured;
}

/**
 * アプリが使う資産クラスを決める (設定の定義から 1 回だけ呼ぶ)。同じ組なら何度呼んでもよい。
 * 1 つのプロセスで別の組に変えようとしたら例外 (2 つのアプリの設定を混ぜない)
 */
export function setEnabledAssetClasses(classes: readonly string[]): readonly AssetClass[] {
  if (classes.length === 0) throw new Error("資産クラスを 1 つ以上選んでください");
  for (const c of classes) if (!isAssetClass(c)) throw new Error(`未知の資産クラス: ${c} (${ASSET_CLASSES.join(" / ")})`);
  if (new Set(classes).size !== classes.length) throw new Error(`資産クラスが重複しています: ${classes.join(", ")}`);
  const next = classes as readonly AssetClass[];
  if (configured && (next.length !== enabled.length || next.some((c, i) => c !== enabled[i]))) {
    throw new Error(`資産クラスは既に ${enabled.join(", ")} に決まっています (${next.join(", ")} には変えられません。1 プロセス = 1 アプリ)`);
  }
  enabled = Object.freeze([...next]);
  configured = true;
  return enabled;
}

/** テスト用: 資産クラスの選択を未設定 (語彙の全部) に戻す */
export function resetEnabledAssetClassesForTests(): void {
  enabled = ASSET_CLASSES;
  configured = false;
}

export const isEnabledAssetClass = (x: unknown): x is AssetClass => isAssetClass(x) && enabled.includes(x);

/** 使うクラスのプロファイル。使わないクラス・未知の文字列 (古い記録) は undefined (呼び出し側が既定値に落とす) */
export function enabledProfile(c: unknown): Readonly<AssetClassProfile> | undefined {
  return isEnabledAssetClass(c) ? ASSET_CLASS_PROFILES[c] : undefined;
}

/**
 * 使うクラスのプロファイル。使わないクラス・未知の文字列は最初に選んだクラス (trader は crypto) の値
 * (既定コスト・レジームのスプレッド閾値のように「何かの値が要る」表に使う)
 */
export function profileOrDefault(c: unknown): Readonly<AssetClassProfile> {
  return enabledProfile(c) ?? ASSET_CLASS_PROFILES[enabled[0]];
}

/** 環境変数・リスク設定のキーの接尾辞 (crypto → Crypto / CRYPTO) */
export const classKeySuffix = (c: AssetClass) => c.charAt(0).toUpperCase() + c.slice(1);
