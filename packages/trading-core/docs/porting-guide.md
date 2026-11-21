# 移植ガイド: FX・株式のボットを @trading/core で作る

このガイドは、共通コア `packages/trading-core` (`@trading/core`) を使って FX のボット (`fx-trader/`) と株式のボット (`stock-trader/`) を作るセッション向けです。
暗号資産のボット `trader/` が最初の利用者で、実装の見本になります (`trader/src/appConfig.ts`・`trader/src/engine/setup.ts`・`trader/src/simulation.ts`・`trader/src/cli.ts`)。
コアの地図・インターフェース・不変条件は `packages/trading-core/CLAUDE.md` を先に読んでください。

## 1. パッケージの作り方

リポジトリ直下に `fx-trader/` (または `stock-trader/`) を作ります。`trader/` と同じ構成にします。

### package.json

```json
{
  "name": "fx-trader",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.13" },
  "scripts": {
    "trader": "tsx --env-file-if-exists=.env.local --env-file-if-exists=.env src/cli.ts",
    "start": "npm run trader -- run",
    "postinstall": "npm --prefix ../packages/trading-core install --omit=dev --no-audit --no-fund",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@trading/core": "file:../packages/trading-core",
    "tsx": "^4.23.15"
  },
  "devDependencies": { "@types/node": "^26.6.6", "typescript": "^5.9.3", "vitest": "^5.1.1" }
}
```

- `file:` 依存はシンボリックリンク (`node_modules/@trading/core` → `packages/trading-core`) です。コアの実行時の依存 (decimal.js・zod・@anthropic-ai/sdk・fast-xml-parser) はコアの `node_modules` に入るので、`postinstall` の行が必須です。
- `postinstall` は `--omit=dev` なので、コアの vitest などは消えます。コアの試験を走らせる前に `cd ../packages/trading-core && npm install` を実行してください。
- decimal.js をアプリの依存に入れないでください (会計値は `@trading/core/core/decimal`。2 つの実体を混ぜない。コアの `tests/appImports.test.ts` が検査します)。
- zod: 設定 (`shape`) はコアの `z` (`import { z } from "@trading/core/core/config"`) で作ります。ブローカーの API の応答の解析にだけ使うなら、アプリの zod を依存に入れてもかまいません (コアのスキーマと合成しない。trader の `src/market/jupiter/` と同じ)。

### tsconfig.json・vitest.config.mts

`trader/tsconfig.json` と同じでかまいません (`moduleResolution: "bundler"`・`noEmit`・`strict`・`types: ["node"]`、`include: ["src/**/*.ts", "tests/**/*.ts", "vitest.config.mts"]`)。

vitest は誤発注防止の環境変数を必ず入れます:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"], // import "../src/appConfig"; (資産クラスを先に決める)
    env: { NODE_ENV: "test", TRADING_MODE: "paper", LIVE_TRADING_CONFIRM: "", ANTHROPIC_API_KEY: "" },
  },
});
```

### リポジトリ直下

直下の `tsconfig.json` (せどりのアプリ) は `trader`・`packages`・`fx-trader`・`stock-trader` を除外済みです。別の名前にするときは `exclude` に足してください。直下の CLAUDE.md はせどりのアプリ用なので、ボットの説明は各パッケージの CLAUDE.md に書きます。

### サーバー

- trader とは別の systemd のユニット (`/etc/systemd/system/fx-trader.service`。`WorkingDirectory=<fx-trader の絶対パス>`、`ExecStart=/usr/bin/npm start`) にします。trader と同じ書き方です (`trader/README.md` の「systemd の例」)。
- **`DB_PATH` と `DASHBOARD_PORT` を trader と分けます** (例 `DB_PATH=/var/lib/fx-trader/fx.db`、`DASHBOARD_PORT=8788`)。同じ DB を共有するとロック (`engine:lock:<mode>`)・学習データ・建玉が混ざります。アプリの既定値は `defineAppConfig` の `defaults` で変えられます (`{ DB_PATH: "./data/fx.db", DASHBOARD_PORT: "8788" }`)。
- 更新は `git pull && npm install && sudo systemctl restart fx-trader`。コアを変えたら trader も再起動します。

## 2. 実装するもの

### 2.1 設定 (`src/appConfig.ts`)

```ts
import { defineAppConfig, envHelpers, type AppConfig as CoreAppConfig, type CoreEnv } from "@trading/core/core/config";
const { str, bool, ranged } = envHelpers;
const SHAPE = {
  OANDA_ACCOUNT_ID: str(),
  OANDA_API_TOKEN: str(),
  OANDA_ENV: str("practice"),
  WATCHLIST: str("USD/JPY,EUR/USD"),
};
const definition = defineAppConfig({ assetClasses: ["fx"], shape: SHAPE, defaults: { DB_PATH: "./data/fx.db", DASHBOARD_PORT: "8788" } });
export const loadConfig = (src = process.env) => definition.loadConfig(src);
```

- `assetClasses` はアプリが使う資産クラス (FX は `["fx"]`、株式は `["stock"]`)。1 プロセスで 1 組です (`enabledAssetClasses()`)。資産クラスの上限の環境変数 (`MAX_EXPOSURE_FX` など) とダッシュボードのリスク項目 (`maxExposureFx`) は自動で作られます。
- 実弾の二重ロック (`TRADING_MODE`・`LIVE_TRADING_CONFIRM`)・リスク上限などコアのキーは再定義できません (例外)。アプリのキー (ブローカーの ID・トークン・銘柄) だけを足します。シークレットは `.env.local` だけに書きます。

### 2.2 相場 (feed) とブローカー

参考になる旧実装 (trader から削除済み。git の履歴で読めます):

- OANDA (FX):
  - `git show 299e971^:trader/src/market/feeds/oanda.ts` (相場)
  - `git show 299e971^:trader/src/execution/oandaBroker.ts` (発注)
  - `git show 299e971^:trader/tests/execution.adapters.test.ts` (モックの試験)
  - `git show 299e971^:trader/tests/fixtures/market/oanda.json` (合成のフィクスチャ)
- Alpaca (株式): 同じコミットの `trader/src/market/feeds/alpaca.ts`・`trader/src/execution/alpacaBroker.ts`
- 頑丈なブローカーの書き方 (照会・取消の確認・状態不明の注文・レート制限・時刻のずれ): `git show 299e971:trader/src/execution/gmoBroker.ts`

決まりごと:

- feed は `MarketDataFeed` (`@trading/core/core/types`)。確定足だけを返し、先読み・リペイントをしない。気配の時刻は取得時刻ではなく取引所の時刻。
- live のブローカーは `Broker` を実装し、**コンストラクタで `assertLive(mode)` を呼ぶ** (`@trading/core/execution/guard`)。fetch は注入できるようにして、試験ではモックにする。
- `RuntimeAssembly.createLiveBrokers` で `liveBrokerSet({ oanda: broker }, instruments)` を返す。venue のアダプターが無い銘柄があれば例外になります。live の発注先を渡さなければ live は起動しません。
- 新しいアダプターは最初は paper (PaperBroker) と practice / paper 口座で十分に確かめてから live にする。

### 2.3 銘柄 (Instrument)

- `tickSize` (価格の刻み)・`lotSize` (数量の刻み)・`minQty`・`minNotional`・`contractSize` を取引所の仕様どおりに入れる。
  - FX: pip (USD/JPY は 0.01、EUR/USD は 0.0001) と価格の刻み (OANDA は pip の 1/10)、数量は通貨単位 (OANDA は 1 単位から)。`quoteCurrency` は JPY / USD など (口座通貨への換算は `createFxConverter`。USD/JPY の気配が hub にあればそれを使う)。`allowShort: true`。
  - 株式: 刻みは 0.01 USD (米国株)・呼値の単位 (日本株)、数量は 1 株 (端株の可否はブローカー次第)、日本株は 100 株単位。空売りできない銘柄は `allowShort: false` (paper では再現され、腕は `|short` で分かれる)。
- `assetClass` は `"fx"` / `"stock"` (文字列を変えない)。
- **取引時間** (`MarketCalendar`): `RuntimeAssembly.calendar` に渡す。閉まっている間は新規エントリーしません (見送り `market_closed`)。テンポは取引時間だけで測り、日次損失の日の区切りは取引日です。
  ```ts
  import { weeklySessionCalendar } from "@trading/core/core/calendar";
  // FX: NY 17:00 で日を区切る。日曜 17:00 〜 金曜 17:00
  const fx = weeklySessionCalendar({ tz: "America/New_York", sessions: [{ open: "17:00", close: "17:00" }], weekdays: [1, 2, 3, 4, 5], dayRollover: "17:00" });
  // 米国株: 9:30〜16:00 ET、休場日を入れる
  const nyse = weeklySessionCalendar({ tz: "America/New_York", sessions: [{ open: "09:30", close: "16:00" }], weekdays: [1, 2, 3, 4, 5], holidays: ["2026-11-26", "2026-12-25"] });
  // 東証: 昼休みあり
  const tse = weeklySessionCalendar({ tz: "Asia/Tokyo", sessions: [{ open: "09:00", close: "11:30" }, { open: "12:30", close: "15:30" }], weekdays: [1, 2, 3, 4, 5] });
  ```
  閉まっている間の決済は、いまは従来どおり注文を出します (開くまで待たせる処理は未実装。必要ならコアにフックを足す)。
- **保有コスト** (`HoldingCostModel`、`RuntimeAssembly.holdingCost`): PaperBroker と仮想トレードが使います。
  - FX のスワップポイント: 買い・売りで符号が違う (受け取りは負のコスト)。`appliesTo: () => true`、`accrue` で NY 17:00 をまたいだ回数 × 1 単位あたりのスワップ (水曜の 3 倍などはブローカーの仕様で)。旧実装の考え方は `git show 299e971:trader/src/core/holdingFee.ts` (日本時間 6:00 の締めをまたいだ回数)。
  - 株式の信用の金利・貸株料: 建玉代金 × 年率 / 365 × 日数。
  - 金額はクオート通貨建ての decimal。
- **取引先ごとのレバレッジの上限** (`RuntimeAssembly.venueLeverageCaps`、例 `{ oanda: 5 }`): 取引先の建玉の合計が 評価額 × 上限 を超えないように RiskManager が縮める・拒否します (資産クラスの上限・1 銘柄の上限に追加で効く)。PaperBroker の証拠金はプロファイルの `paperLeverage` (fx 10・stock 2)。国内の FX は法定の 25 倍より低くしておく。

### 2.4 情報源

- 経済指標 (`@trading/core/intel/sources/econCalendar`) と RSS (`createRssSources({ env, defaults })`。`defaults` にアプリの既定の一覧) はコアにあります。
- FX は通貨ごとのバイアス (USD・JPY・EUR…) が base − quote で効きます (プロファイルの `intelBiasMode: "pair"`。擬似資産は `FX`)。株式は個別のティッカーと擬似資産 `STOCKS`。
- 記事の銘柄の付与 (`intel/assetTagger.ts`) の辞書は暗号資産寄りです。`TagOptions` で辞書を足してください。辞書・リスクオン指数を差し替えるフックが要るならコアに足します (アプリの分岐をコアに書かない)。
- 暗号資産の情報源 (CoinGecko・CryptoPanic・Fear&Greed) は trader 側にあります。使わないでください。

### 2.5 戦略

- 登録戦略の資産クラスは crypto / meme です。`selectStrategies(ids, ["fx"])` (または `withAssetClasses`) で自分のクラスの一覧を作り、`RuntimeAssembly.strategyBase` に渡します (構造フィルター STRUCTURE_MODE はこの一覧に掛かる)。id は変わらず、腕のキーは `<戦略>|<レジーム>|fx` で分かれます。
- 最初の戦略:
  - FX: `short_ema_trend`・`short_rsi_revert`・`short_breakout`
  - 株式: `short_breakout`・`short_ema_trend`・`pullback_15m`
- 出来高が要る戦略 (`scalp_momentum_burst`・`scalp_micro` の detectBurst) と板が要る `scalp_obi` は、実際の出来高・板が取れない限り使わない (OANDA の出来高は tick 数で、実際の出来高ではない)。
- **新しく使う戦略は観測専用から始める** (`OBSERVE_ONLY_STRATEGIES` に入れて仮想トレードだけを記録し、十分な件数で成績を確かめてから外す)。

### 2.6 組み立て

`trader/src/engine/setup.ts` の `buildRuntime` と同じ形にします:

```ts
import { assembleRuntime } from "@trading/core/engine/runtime";
const runtime = await assembleRuntime(config, {
  markets: [{ feed, instruments }],
  createLiveBrokers: ({ instruments }) => liveBrokerSet({ oanda: new OandaBroker({ mode: config.mode, ... }) }, instruments),
  intelSources, strategyBase, calendar: fx, holdingCost: swapModel, venueLeverageCaps: { oanda: 5 },
}, { store });
```

simulate は `runSimulation({ factory })` (`SimulationRuntimeFactory`: loadConfig・simulationEnv・guardedDbPaths・buildRuntime。trader の `src/simulation.ts` が見本)。backtest の取得元は `registerBacktestSource({ name: "oanda", label, open })` で登録します (trader の `src/cli.ts` の ccxt・jupiter が見本)。

## 3. 安全の不変条件 (守ること)

1. 実弾の二重ロック (`TRADING_MODE=live` + `LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY_RISK`) はコアの `resolveMode` だけ。アプリで同じキーを読まない・再定義しない。
2. 実口座アダプターはコンストラクタで `assertLive` を呼ぶ。live の発注先が無い・venue のアダプターが無い銘柄があれば起動しない。
3. 新規エントリーは必ず `RiskManager.evaluateEntry` を通す (エンジンの外で発注しない)。
4. 試験は完全オフライン。実在のブローカー・ニュース API に送らない。fetch を注入してモックにし、フィクスチャは合成データ。
5. 会計値は decimal (`@trading/core/core/decimal`)。
6. 学習データの保全: kv キー、資産クラスの文字列、strategy id、腕のキー、DB のスキーマを変えない。
7. シークレットは環境変数 (`.env.local`) だけ。ログ・status に値を出さない。

## 4. 試験の部品

- `@trading/core/testing/runtime`: `buildTestRuntime({ specs, env, config, assembly, opts })` (合成フィード + paper + MemoryStore + 仮想時計。`clock.t` を進めて `runtime.engine.tick(t)`)、`testConfig(env)`・`coreConfig(src)`。
- `@trading/core/testing/fakeLiveBroker` (`FakeLiveBroker`: 受付だけ・約定・拒否・例外・遅延を再現する偽の live ブローカー。live の経路の試験に)、`reversalScenario`・`structureBars`・`validation`。
- 合成フィード: `SyntheticFeed({ specs })` (`@trading/core/market/feeds/synthetic`)。FX・株式の銘柄の `specs` を自分で作れます。
- 取引時間・保有コスト・レバレッジ上限の試験の例: コアの `tests/calendar.test.ts`・`tests/holdingCost.test.ts`・`tests/risk.venueLeverage.test.ts`。

## 5. コアを変えるときの決まり

- アプリの事情はフック (オプション・`RuntimeAssembly`・登録) で入れる。コアに `if (venue === "oanda")` のようなアプリの分岐を書かない。
- 既定の動き (オプションを渡さないとき) は変えない。trader の動きを変えないことを確かめる:
  - `cd trader && npx tsc --noEmit && npx vitest run`
  - `cd packages/trading-core && npm install && npm run typecheck && npm test`
  - 他のアプリ (fx-trader・stock-trader) の試験も全部
  - trader の simulate の再現 (`npm run trader -- simulate --days 3 --seed 1 --db memory`) の取引・損益が変わらないこと
- 資産クラスごとの値はプロファイル (`ASSET_CLASS_PROFILES`) に足す。新しい資産クラスの文字列は作らない (DB の記録・腕のキーに入るため)。
- コアの `src/testing/` は vitest を import しない (アプリの型検査で読まれる)。
