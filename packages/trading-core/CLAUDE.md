# @trading/core

資産クラスに依存しない自動売買の共通コア。`trader/` (暗号資産) と、これから作る `fx-trader/`・`stock-trader/` が `file:` 依存で使う。
ソースのみ (ビルドなし)。`package.json` の `exports` は `{"./*": "./src/*.ts"}` で、アプリは `@trading/core/<path>` (例 `@trading/core/core/decimal`) で読む。tsx (実行) と vitest (試験) がそのまま TypeScript を読む。

アプリ側の手順 (FX・株式のボットの作り方) は `docs/porting-guide.md`。

## 安全不変条件 (厳守)
- **実弾の二重ロックはコアにだけある**: live になるのは `TRADING_MODE=live` と `LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY_RISK` が揃ったときだけ (`src/core/config.ts` の `resolveMode`。テスト `NODE_ENV=test` では常に paper)。実口座アダプターはコンストラクタで `assertLive` (`src/execution/guard.ts`) を呼ぶ。アプリの設定 (`defineAppConfig` の `shape`) はコアの環境変数を再定義できない (例外)。`defaults` でも二重ロックの鍵は変えられない (例外)。
- **新規エントリーは必ず `RiskManager.evaluateEntry` を通す** (`src/engine/engine.ts`)。live の発注先 (`RuntimeAssembly.createLiveBrokers`) が無ければ live は起動しない (`NO_LIVE_BROKERS_MESSAGE`)。`liveBrokerSet` は venue のアダプターが無い銘柄があれば例外。
- 未知の venue / symbol / レート / 上限の無い資産クラスは fail closed (拒否)。
- **テストは完全オフライン** (外部 API・実取引所に接続しない。fetch は注入してモック)。
- 会計値 (残高・数量・手数料・損益) は decimal (`src/core/decimal.ts`)。アプリは `decimal.js` を直接 import しない (`tests/appImports.test.ts` が `trader/src` などを調べる)。
- **学習データの保全**: kv キー、資産クラスの文字列 (`crypto` / `meme` / `fx` / `stock`)、strategy id、腕のキー (`<戦略>|<レジーム>|<資産クラス>[|short]`)、DB のスキーマを変えない。ダッシュボードのリスク上書き (kv `risk:limits:<mode>` の `maxExposure<Class>`) の名前も変えない。
- 予想 (`src/learning/forecast.ts`) の Bonferroni のグループ数は `liveGroups` (既定 `FORECAST_ASSET_CLASS_COUNT` = 4 クラス → 予想時間 3 × 4 = 12 グループ)。trader は 4 に固定する (使うクラスが 2 でも 6 グループに緩めない)。
- コアにアプリ固有の分岐を入れない。必要ならフック (注入点: `RuntimeAssembly`・オプション・登録) を足す。
- コアと全アプリのテストを常に green に保つ。

## コマンド
- `npm install` (このディレクトリで。開発用の依存 vitest・typescript も入れる。アプリの `npm install` の postinstall は `--omit=dev` で実行時の依存だけを入れるので、その後にコアの試験を走らせるときはここで `npm install` し直す)
- `npm test` (vitest。`tests/setup.ts` が資産クラスを crypto・meme に決める) / `npm run typecheck`
- アプリ側も: `cd ../../trader && npx tsc --noEmit && npx vitest run`

## モジュールの地図 (`src/`)
- `core/`: 型 (`types.ts`)、資産クラスの語彙とプロファイル (`assetClasses.ts`)、設定 (`config.ts`: `defineAppConfig`・`CoreEnv`・`AppConfig<E>`・`envHelpers`・`z`・`resolveMode`・リスク項目の定義)、decimal、往復コスト (`costs.ts`)、手数料率 (`fees.ts`)、保有コスト (`holdingCost.ts`)、取引時間 (`calendar.ts`)、空売りの再現 (`short.ts`)、HTTP・ロガー・Claude 呼び出し (`ai.ts`)
- `indicators/`, `regime/`, `structure/` (ダウ理論のフィルター): 指標 (`series.ts` の `macd` は mid_trend_follow 用に戻した)・相場環境・相場構造
- `strategies/`: 13 戦略 (scalp 6 / short 5 / mid 2: `trend.ts` の `trend_4h` と、廃止 (299e971) から同じ id で戻した `mid.ts` の `mid_trend_follow`) と登録 (`registry.ts`: `ALL_STRATEGIES`・`configuredStrategies`・`withAssetClasses`・`selectStrategies`・`managesOwnExit`)、廃止した戦略の互換 (`retired.ts`)
- `market/`: `MarketHub`、足 (`candles.ts`・`fileCandles.ts`)、合成フィード (`feeds/synthetic.ts`)
- `execution/`: `PaperBroker` (`paper.ts`)、`BrokerSet` (`brokerSet.ts`: `createPaperBrokerSet`・`liveBrokerSet`)、`assertLive` (`guard.ts`)
- `risk/`: `RiskManager` (`manager.ts`)、ダッシュボードの上書き (`settings.ts`)、再開要求
- `intel/`: 情報収集の汎用部分 (RSS・経済指標・分析・資産別バイアス・計画)。暗号資産の情報源 (CoinGecko・CryptoPanic・Fear&Greed) は trader 側
- `learning/`: 要因分析・腕の配分・情報源の信頼度・ParamTuner・振り返り・仮想トレード・ニュースの答え合わせ・予想・移行
- `backtest/`: イベント駆動バックテスト・区間検証・合成データ
- `engine/`: `TradingEngine` (`engine.ts`)、建玉・注文・指値・テンポ・読みの管理・建値ストップ (`breakeven.ts`: `BREAKEVEN_TRIGGER_R`。純粋な判定。PositionManager・backtest・仮想トレードが同じ規則を使う)・転換で決済、組み立て (`runtime.ts`: `assembleRuntime`)、simulate (`simulate.ts`: `runSimulation` は `SimulationRuntimeFactory` を受け取る)、backtest コマンド (`backtestCommand.ts`: 取得元の登録 `registerBacktestSource`)、レポート
- `dashboard/`: 閲覧 + リスク設定の書き込み (`server.ts`・`page.ts` の `DASHBOARD_HTML`)
- `paper/walletReset.ts`: paper の口座の作り直し
- `storage/`: Store (node:sqlite / memory)
- `testing/`: 試験の部品 (`runtime.ts` の `buildTestRuntime`・`testConfig`・`coreConfig`、`fakeLiveBroker.ts`、`reversalScenario.ts`、`structureBars.ts`、`validation.ts`)。vitest を import しない (アプリの型検査で読まれるため)

## 主な注入点 (インターフェース)
- **資産クラス** (`core/assetClasses.ts`): `ASSET_CLASSES = ["crypto","meme","fx","stock"]`、`ASSET_CLASS_PROFILES` (defaultCosts・regimeMaxSpreadBps・paperLeverage・intelPseudoAsset・intelBiasMode (`base` / `pair`)・paperSimulatedShort・requiresLiquidityCheck・planRiskMultiplier・exposurePresets・label)。アプリは `defineAppConfig({assetClasses})` で使うクラスを選ぶ (1 プロセス 1 組。`enabledAssetClasses()`)。選んでいないクラスの古い記録は既定値に落ちる (`enabledProfile` は undefined、`profileOrDefault` は最初に選んだクラス)。
- **設定** (`core/config.ts`): `defineAppConfig({assetClasses, shape, defaults})` → `{loadConfig, defaultRisk, riskSettingKeys, unusedClassEnvKeys, assetClasses}`。上限の環境変数 `MAX_EXPOSURE_<CLASS>` とリスクの項目 `maxExposure<Class>` は使うクラスの分だけ作る。コアのモジュールは `CoreEnv` だけを読む。
- **往復コスト** (`core/costs.ts`): `roundTripCostBps(feeRate, spreadBps, slippageBps)`・`quoteCostBps(inst, quote)`。手数料率は `costFeeRate` (taker + 固定手数料 / refNotional)。
- **取引先ごとのレバレッジ上限**: `new RiskManager(limits, store, {mode, venueLeverageCaps, calendar})`。
- **保有コスト** (`core/holdingCost.ts`): `HoldingCostModel { accrue({inst, qty, avgPrice, from, to, mode}) → Decimal; appliesTo(inst, qty) }`。既定 `simulatedShortBorrowModel(rate)`。PaperBroker (`holdingCost`) と仮想トレード (`shadow.holdingCost`) が使う。
- **取引時間** (`core/calendar.ts`): `MarketCalendar { isOpen, nextOpen, nextClose, tradingDayKey, nextTradingDayStart }`、`ALWAYS_OPEN`、`weeklySessionCalendar({tz, sessions, weekdays, holidays?, dayRollover?})`、`openDurationMs`。エンジンは閉まっている間は新規エントリーしない (`market_closed`)、テンポは取引時間だけで測る、RiskManager の日の区切りは取引日。決済は閉まっていても従来どおり出す (閉まっている間の決済の待ち合わせは未実装。下の「残っている課題」)。
- **組み立て** (`engine/runtime.ts`): `assembleRuntime(config, assembly, opts)`。`RuntimeAssembly` = markets (feed + 銘柄)・createLiveBrokers?・paperBroker?・intelSources?・strategies? / strategyBase?・calendar?・holdingCost?・venueLeverageCaps?・periodic?・marketExtras?・extraTimeframeClasses?・onTimeframes?・fallbackQuote?・validationFeed?・onClose?。
- **発注前の見積もりのコスト** (`MarketExtras.entryQuoteCost`、`engine/engine.ts`): venue の銘柄だけ、evaluateEntry の承認後・発注前に承認された数量・向きで呼ぶ。`{costBps}` なら `RiskManager.recheckEdge` (同じ `edgeCheck`) で確かめ直し (追加の判定)、通れば entryContext.costBps に記録。`{unavailable}`・例外は見送り (risk.reject)、undefined は従来どおり。フックの無い venue は従来と同一。
- **観測専用** (`strategies/observeOnly.ts`): `OBSERVE_ONLY_STRATEGIES` の `<id>` (全資産クラス) / `<id>:<資産クラス>`。`parseObserveOnly`・`isObserveOnly`・`observeOnlyWarnings`。既定 `scalp_rebound,short_ema_trend:meme`。
- **simulate** (`engine/simulate.ts`): `runSimulation({factory, ...})`。`SimulationRuntimeFactory` = loadConfig・simulationEnv・guardedDbPaths・buildRuntime。
- **backtest の取得元** (`engine/backtestCommand.ts`): `synthetic` / `feed` + `registerBacktestSource({name, label, open, marketOnly})`。
- **予想の多重検定**: `ForecastOptions.liveGroups` (グループ数。既定 3 × 4 = 12)。
- **決済を自分で管理する戦略** (`Strategy.managesOwnExit?: true`。いまは `trend_4h`・`mid_trend_follow`): その戦略が持ち主の建玉・仮想トレードには建値ストップ・転換で決済・読みの管理 (代わりに maxHold の時間切れ)・`MAX_HOLD_MINUTES` の上限 (と hold_limit の観測専用。`tempo.ts` の `isHoldLimitedStrategy`) を掛けない。当初の損切り・シグナルの利確と標準のトレーリング (`trailingStopPct`。PositionManager・バックテストは ownExit でも従来どおり。仮想トレードはもともとトレーリングを追わない)・戦略の決済シグナル・maxHoldBars・RiskManager と新規エントリーの判定は従来どおり。相場構造のラッパー (`withStructure`) は `...inner` で managesOwnExit を引き継ぐ。PositionManager は deps の `managesOwnExit(strategyId)`、仮想トレードは `ShadowOptions.managesOwnExit`、バックテストは `strategy.managesOwnExit` (検証・コマンドも同じ経路)、engine は `managesOwnExit(id, this.strategies)` (registry。未知・廃止した id は false = 従来どおり)。試験 `tests/strategies.trend4h.test.ts`・`tests/strategies.midTrendFollow.test.ts`。
- **mid_trend_follow** (`strategies/mid.ts`): 判定・パラメータは廃止前と同一 (試験が廃止前の evaluate を写した参照の実装と比べる)。crypto だけ・managesOwnExit。`DEFAULT_STRUCTURE_STRATEGIES` に入る (廃止前と同じ。4h→1d の MTF のため hub は 1d を取る)。`RETIRED_STRATEGIES` から外した (long_momentum・meme_momentum は廃止のまま)。同じ銘柄の建玉は 1 つ (trend_4h と同時に持たない)。

## 資産クラスと trader の互換で残っているもの (暗号資産寄りの部分)
- `core/short.ts` の `NO_SHORT_VENUES = ["jupiter"]` と `dex*`: DEX の銘柄は paper でも空売りを再現しない。古い paper のスナップショットの銘柄定義に印が無いので venue 名で判定している (FX・株式の venue には影響しない)。
- `intel/assetTagger.ts` の辞書 (BTC・ETH・SOL…・`CRYPTO_BASES`)、`intel/aggregate.ts` の `USD_SPILLOVER = ["CRYPTO","MEME"]`、`intel/analyzer.ts` のリスクオン指数 (CRYPTO・STOCKS・MEME)、`intel/prompts.ts` の文言: 情報の分析が暗号資産向け。FX・株式は `TagOptions` (追加の辞書) と自前の情報源で補う。辞書・指数の差し替えのフックは今後の課題。
- 戦略の既定の資産クラス (crypto / meme)。アプリは `selectStrategies` / `withAssetClasses` で選ぶ。
- 合成データ (`market/feeds/synthetic.ts`) の既定の銘柄 (BTC/USDT・ETH/USDT・PEPE/USDT)、backtest の feed の既定の銘柄 `BTC/USDT` (アプリは symbol を渡す)。
- `engine/fx.ts` の概算の為替表 (USD 基準) と USD の別名 (USDT・USDC)。

## 残っている課題 (フォローアップ)
- **trader の再輸出の shim の削除** (codemod): 次の trader のファイルは `export * from "@trading/core/<path>"` の 1 行だけ。trader の import を `@trading/core/...` に書き換えてから消す。
  - `src/core/`: ai, assetClasses, calendar, config, costs, decimal, fees, holdingCost, http, logger, short, sweep, types, util
  - `src/indicators/`: microstructure, resample, series / `src/regime/detect` / `src/storage/`: index, memory, readonly, sqlite
  - `src/structure/`: machine, mtf, perfectOrder, pivots, settings, types, wrap
  - `src/strategies/`: common, labels, netEdge, registry, retired, scalp, scalpMicro, scalpPullback, scalpRebound, short
  - `src/market/`: candles, fileCandles, hub, feeds/synthetic
  - `src/backtest/`: engine, evaluate, metrics, synthetic, types
  - `src/engine/`: backtestCommand, context, deadline, engine, feedCache, fx, learningHooks, limitOrders, lock, orders, positions, regimeReport, report, reversalExit, runtime, simulate, structureCompare, tempo, thesis
  - `src/execution/`: brokerSet, guard, paper / `src/paper/walletReset` / `src/risk/`: manager, resumeRequest, settings
  - `src/intel/`: aggregate, analyzer, assetTagger, planner, prompts, sentiment, service, sources/common, sources/econCalendar, sources/rss
  - `src/learning/`: allocator, attribution, forecast, influence, journal, migration, newsCheck, prompts, reflection, reliability, service, shadow, stats, tuner
  - `src/dashboard/`: page, server / `src/testing/runtime`
  - `tests/helpers/`: fakeLiveBroker, reversalScenario, structureBars, validation
- 取引時間外の決済: 閉まっている間は発注せず、開いたときに出す (いまは閉まっていても決済の注文を出す)。
- 情報の分析の辞書・リスクオン指数のフック (上記)。
