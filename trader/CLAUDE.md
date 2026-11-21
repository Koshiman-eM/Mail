# Claude Code Project Guidelines: 自己学習型の仮想通貨自動売買ツール (`trader/`)

このディレクトリは、リポジトリ直下のせどり支援ツールとは独立したパッケージ。ここで作業するときは本ファイルを優先する。

## 1. 概要
仮想通貨 (暗号資産) だけを自律売買する。Solana のトークン・ミームコインを DEX アグリゲーター Jupiter で売買するボット (現物のみ。空売り・レバレッジなし)。既定の取引先は `jupiter` (paper。3.20)。戦略はスキャルピングと短期だけ (中期・長期・ミームの戦略は廃止)。**live の発注先は無い** (GMOコインは廃止。Jupiter の実弾は次の段階。3.13)。相場は Jupiter (既定)・合成データ (`synthetic`)・ccxt (bitbank の足。paper・バックテスト用) (FX・株式・OANDA・Alpaca・DEX は廃止。3.19)。
- インターネットから情報を収集して戦略を立てる (`src/intel/`)。
- 損益の要因を分析し、戦略配分・パラメータ・情報源の信頼度へフィードバックする (`src/learning/`)。

### 共通コア (`packages/trading-core`)
- 資産クラスによらない部分 (型・設定・リスク管理・エンジン・学習・バックテスト・ダッシュボードなど) は共通コア `@trading/core` (`../packages/trading-core/src/`) にある (FX・株式のボットと共有)。地図・不変条件は `packages/trading-core/CLAUDE.md`、FX・株式への移植は `packages/trading-core/docs/porting-guide.md`。
- trader の `src/` の多くのファイル (`src/core/*`・`src/engine/engine.ts` など) は `export * from "@trading/core/<path>"` の 1 行の再輸出 (shim)。**中身を変えるときはコア側のファイルを直す** (コアの試験 `cd ../packages/trading-core && npm install && npm test` と trader の試験の両方を green に)。shim の一覧は `packages/trading-core/CLAUDE.md`。
- trader に残るもの: `src/cli.ts`、設定 `src/appConfig.ts` (`defineAppConfig` で crypto・meme と VENUES / WATCHLIST / CCXT_* / JUPITER_* / GECKO_* / CRYPTOPANIC_TOKEN)、組み立て `src/engine/setup.ts` (`buildRuntime` → コアの `assembleRuntime`)、`src/execution/router.ts` (live は拒否)、`src/simulation.ts` (simulate の部品)、`src/intel/defaultSources.ts` と暗号資産の情報源 (coingecko・cryptopanic・fearGreed)、`src/market/feeds/{ccxt,bitbankCandles,jupiter,geckoHistory}.ts`、`src/market/jupiter/*`、`src/execution/jupiterFill.ts`、`src/engine/{jupiterWatch,fxRate}.ts`。
- 資産クラスは `crypto`・`meme` を選んでいる (`src/appConfig.ts`。語彙は crypto / meme / fx / stock でクラス別の値はコアの `ASSET_CLASS_PROFILES`)。試験は `tests/setup.ts` で先に設定を読み込む。
- 予想の Bonferroni のグループ数は `TRADER_FORECAST_LIVE_GROUPS` = 12 をエンジンに明示して固定している (`src/engine/setup.ts`)。
- アプリのコードは decimal.js を直接 import しない (`@trading/core/core/decimal` 経由。コアの試験が検査する)。zod はコアの `z` (`src/core/config.ts` の再輸出) を使う。Jupiter の API の応答の解析 (`src/market/jupiter/` の parse・tokens・client・quote) だけは trader の zod を使う (コアのスキーマと合成しない)。

## 2. コマンド
- `npm install` / `npm test` / `npm run typecheck`
- `npm run simulate -- --days 1`: 合成データで高速にペーパー運転する (ネット不要)。構造フィルターの理由別の見送り数・エントリー/時・平均保有・テンポ・見送り件数・読みの答え合わせ・転換で決済の成績も表示
- `npm run backtest -- --strategy all [--source synthetic|ccxt|jupiter] [--token <mint|symbol>]` (`--source gmo` は廃止。拒否する)。jupiter は GeckoTerminal の最良のプールの足 (`GeckoHistoryFeed`。期間の全部を専用のバッファにページングで取る。履歴が --days より短ければ例外)、銘柄定義は運用と同じ `jupiterInstrument` (成行だけ・コストは costModel + ネットワーク手数料)
- `npm run trader -- jupiter check [--ultra]`: `runJupiterCheck` (Jupiter・GeckoTerminal の応答の形・既定の銘柄の mint の照合) と frankfurter の USD/JPY を 1 回ずつ (読み取りだけ。キーは有無だけ表示)。設定の行も出す
- `npm run backtest -- --structure-compare [--strategy <id>|all] [--pivot-sweep] [--folds 5] [--days N] [--source ...]`: 相場構造フィルターの比較 (A: ラッパーなし 〜 G: conservative を evaluateParams の区間で比べる)。30 取引未満の区間は「回数不足」。`--pivot-sweep` (N=4/6/10) は頑健性の確認だけで、N を調整し続けない
- `npm start`: 実時間で起動する。既定は paper
- `npm run report`: 成績と学習状態 (現在の mode のもの) を表示。注文種別ごとの成績・maker/taker 手数料の内訳・指値の約定率・探索/通常 (テンポ) の表・読みの答え合わせ (途中/期限で読み外れ・延長・期限前に決着、期限での的中率)・転換で決済 (件数・勝率・純損益・平均R・含み益で決済した件数・勝ちの取引が取れた利確までの距離の割合) も出す
- `npm run trader -- intel`: 情報収集を 1 回実行してブリーフを表示
- `npm run status`: 設定と現在の状態を表示 (VENUES に jupiter があれば Jupiter の設定 `formatJupiterSettings`、いまの VENUES に無い取引先の建玉の警告 `unconfiguredVenuePositionWarnings` (paper reset を勧める。run の起動時も)、指値の設定と約定率、テンポ・最大保有、読みの管理の設定と各建玉の読みの期限、転換で決済の設定 REVERSAL_* も。廃止した取引先・資産クラス・戦略 id・環境変数 (`GMO_*`・`MAX_EXPOSURE_FX/STOCK`) が .env に残っていれば警告、live なら起動しない旨も出す: `configCompatWarnings`)
- `npm run trader -- resume`: キルスイッチ・日次停止を解除 (監査ログに記録。動作中のエンジンにも次のティックで反映)
- `npm run trader -- orders` (`orders list`): 保留中・状態不明の注文を一覧
- `npm run trader -- regime --symbol BTC/JPY --hours 3 [--tf 1m,15m,1h,4h] [--step <分>]`: 各時刻の相場の状態 (レジーム) を運用と同じ detectRegime で表示 (確定足だけ。スプレッドは 0 扱い。ccxt の CCXT_EXCHANGE の足)。目線・押し安値/戻り高値・choppiness も表示
- `npm run trader -- paper reset --equity <円> [--confirm]`: paper の口座 (ペーパーウォレット) を指定の評価額で作り直す。学習データ (取引の履歴・腕・要因分析・パラメータ調整・振り返り・仮想トレード・予想・ニュースの答え合わせ・情報源の信頼度・リスク設定の上書き `risk:limits:paper`・指値の約定率) は残す。`--confirm` なしは確認だけ (dry run、何も書かない)。TRADING_MODE=live では拒否、paper のエンジンが動作中 (kv `engine:lock:paper` の heartbeat が 60 秒以内) なら拒否する (`sudo systemctl stop trader` で止めてから)。実行中は `engine:lock:paper` を取得するので、その間に起動したエンジンは起動しない (`cmdRun` は状態を読み込む前にロックを取る)。保有中の建玉は最後の価格 (無ければ建値) で決済理由 `wallet_reset` (表示「リセットで決済」)・`learningExcluded: true` として記帳上だけ閉じ、腕・要因分析・ParamTuner・振り返り・情報源の信頼度・テンポ・report / ダッシュボードの成績には使わない (`isLearningExcludedTrade`)。書き換えるのは `journal:open:paper` / `positions:exitPlans:paper` / `orders:pending:paper` / `orders:restingTp:paper` / `orders:resolveRequests:paper` / `paper:snapshot` (新しい評価額・建玉なし) / `risk:state:paper` (日初・最高 = 新しい評価額、キルスイッチ・日次停止なし) / `paper:resets` (履歴に追記) だけで、1 トランザクション (SQLite は BEGIN IMMEDIATE) で行う。監査ログ `paper.wallet_reset`。status の当初評価額は最新のリセットの金額。実装は `src/paper/walletReset.ts`
- `npm run report [-- --all]`: paper の評価額・成績は最新の口座リセット以降 (`--all` で全期間)。ダッシュボードの成績も同じ (戦略パネルのボタン / `/api/trades?scope=all` で全期間)
- `npm run trader -- orders resolve <clientId> --none | --filled --qty <数量> --price <価格>`: 状態不明の注文を手動で確定する。escalated 以外は `--force` 必須。`--none` で取消に失敗したら保留のまま

## 3. 安全ガードレール (厳守)
1. **実弾の二重ロック**: live になるのは `TRADING_MODE=live` と `LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY_RISK` が揃ったときだけ (コアの `src/core/config.ts` の `resolveMode`。アプリの設定は再定義できない)。
   - 実口座アダプターはコンストラクタの `assertLive` で、paper / test モードでの生成を拒否する (コアの `src/execution/guard.ts`。いまは実口座アダプターが無いが、Jupiter の実弾のアダプターもこれを呼ぶ。試験はコアの `tests/execution.guard.test.ts`)。
   - このガードを弱める変更をしない。
2. **テストは完全オフライン**: 実在の取引所・ブローカー・ニュース API へ送信しない。
   - fetch / ccxt インスタンスは注入してモックする。
   - フィクスチャ (`tests/fixtures/`) は合成データ。
3. **会計値は decimal.js**: 残高・数量・手数料・損益の計算は `src/core/decimal.ts` を使う。指標・統計は number でよい。
4. **シークレットは環境変数のみ** (`.env.local`)。
5. **先読み禁止**: 戦略に渡すのは確定足だけ。バックテストの約定は次の足の始値で行う。
6. **リスク管理を迂回しない**: 新規エントリーは必ず `RiskManager.evaluateEntry` を通す。
   - 純期待値の規則 (コスト比): コスト控除後の期待値を出すシグナル (`edgeIsNet: true`。scalp_micro・scalp_rebound・scalp_pullback・pullback_5m・pullback_15m) は、テンポの有無によらず「期待値 ≥ max(0, `MIN_EDGE_TO_COST` − 1) × コスト かつ 期待値 > 0」(コストを二重に数えない。NaN は拒否)。それ以外は「期待値 ≥ `MIN_EDGE_TO_COST` × コスト」。バックテストのエントリーの判定 (`minEdgeToCostRatio`) も同じ (`netEdgeMinBps`。edgeIsNet の「期待値 > 0」は比率 0 = フィルターなしでも求める)。
   - 日次損失上限 → 当日停止
   - 最大ドローダウン → kill switch (手動の `resume` まで停止)
7. **学習による変更は検証してから適用**: パラメータ調整は、feed から取った長い履歴 (主時間足 3000 本、scalp は 14 日分) を 5 区間に分けたバックテストで、区間ごとの符号検定 (片側 p < 0.1)・改善幅・取引数の条件をすべて満たすときだけ適用する (`learningHooks.ts` の `createParamValidator`、`tuner.ts`)。hub の短い足では代用しない。
   - 適用後は、判断に使った期間より前の取引と Welch の t 検定で比べ、有意に悪化したら元に戻す。評価待ちは 14 日で期限切れ。
   - LLM の提案も同じ検証経路を通す (`ParamTuner.propose`)。
   - 値動きの予想 (`forecast.ts`) によるエントリーサイズの倍率はパラメータの変更ではない。consensus を除いた基礎モデルで、同じ時刻・同じ資産クラスの予想を 1 観測にまとめ、12 グループ (予想時間 3 × 資産クラス 4。`FORECAST_ASSET_CLASS_COUNT` は fx / stock を廃止しても意図して 4 に固定。使うクラスの数 2 に減らすと 6 グループ = 入る z ≈ 2.39 に緩むため変えない) の多重検定 (Bonferroni) で補正した有意性 (入る z ≥ 2.638、出る z < 2.138、判定済み 100 件以上) を満たしたときだけ 0.7〜1.2 倍で効く。結果は RiskManager の上限 (`MAX_SIZE_MULTIPLIER` = 1.5) の範囲内に収まる。満たさない間は常に 1.0。リスク判定は迂回しない。
8. **学習状態は mode 別キー**: 腕・パラメータ・調整履歴・情報源の信頼度・ニュースの答え合わせ・予想・仮想トレードの kv は `<名前空間>:<mode>:...` (信頼度は `intel:sourceReliability:<mode>`)。paper の学習を live に持ち込まない。旧キー (mode なし) は paper にだけ初回起動時に引き継ぐ (`migration.ts`)。live は初期状態から始める。
9. **仮想トレードの重みと停止中の扱い**: 見送ったシグナルの結果は腕の配分に重み 0.25 (腕を止める判定には使わず、止まった腕の回復判定にだけ使う)。ニュースの答え合わせは 1 記事あたり合計 0.3 (時間 × 資産の数で割る)。取引による信頼度の更新は (情報源, 記事) ごとに 1 回。停止中 (`HALT_SHADOW_REASONS`) に記録した仮想トレードは学習に使わない。戦略がコストで見送ったシグナル (`strategy_filter:*`、`StrategyContext.onFiltered`) は観測専用で、保存だけして腕・情報の効き具合には使わない。
   - 観測専用の戦略 (`OBSERVE_ONLY_STRATEGIES`、既定 `scalp_rebound`、空文字で無効) は新規エントリーを発注せず、仮想トレード (`observe_only`) としてだけ記録する (RiskManager・腕の乱数に触れない。判定は腕・計画の判定より前で、戦略の対象レジームと低流動性の停止は守る)。`observe_only` は通常の見送りと同じく腕の配分に重み 0.25 で入り、腕を止める判定には使わない。観測専用にした戦略の保有中の建玉は従来どおり管理・決済する (持ち主の戦略の決済シグナル・損切り・利確・読みの管理・転換で決済。止めるのは新規だけ)。廃止した戦略・未登録の id は起動時に警告して無視する (`strategyIdListWarnings`。3.19)。
10. **腕の停止と回復**: 止めるのは実取引だけの統計で、件数 ≥ 30 かつ「縮小推定の平均 + 2.5·SE < 0」のとき。止まった腕も戦略は評価し、仮想トレード (`arm_disabled`) を記録して、回復の推定が 0 を越えたら戻す (`allocator.ts`)。
11. **ダッシュボードの書き込みはリスク設定だけ**: `/api/risk-settings` (kv `risk:limits:<mode>`)。CSRF トークン・Origin 確認・ループバック待ち受け (それ以外は `DASHBOARD_WRITE_TOKEN`) が必須。live でリスクを上げる変更は確認語が必要。範囲は `config.ts` の `RISK_SETTING_SPECS` が唯一の定義。
12. **空売りの再現は paper だけ** (`PAPER_SIMULATE_SHORT`、既定 true。`src/core/short.ts`): `allowShort=false` の銘柄は live では空売りしない (いまの取引先に `allowShort=true` の銘柄は無い)。
   - `allowShort` (取引所の仕様) は書き換えない。paper かつ有効のとき、`allowShort=false` の `crypto` (meme・venue が `jupiter` の銘柄 (SOL・JUP も)・venue が dex の古い銘柄は対象外。`simulatedShortEligible`) に `simulatedShort: true` を付ける (`setup.ts`)。試験 `tests/jupiter.short.test.ts`。
   - 実効の空売り可否は必ず `canShort(inst, mode)` で判定する (戦略 `common.ts` は `ctx.mode`、RiskManager、PaperBroker、planner)。live・バックテスト・mode 不明では `allowShort` だけ。
   - PaperBroker は負の建玉で約定し、建玉代金を余力から拘束、買い戻し時に借入コスト (建玉代金 × `PAPER_SHORT_BORROW_RATE_DAILY` × 日数) を手数料に計上 (decimal)。
   - 取引・仮想トレードは `simulatedShort: true` を付け、腕は `<戦略>|<レジーム>|<資産クラス>|short` で学習する (買いと取引所で可能な売りは従来のキー)。ParamTuner・振り返り・情報源の信頼度・情報の効き具合・予想の applied からは除外。
   - report / simulate / ダッシュボードは「買い」「売り」「空売り (paper 再現)」に分け、live で実際にできる成績 (再現の空売りを除く) を明示する。

13. **live の発注先は無い** (GMOコインは廃止。Jupiter の実弾は次の段階):
   - `TRADING_MODE=live` (二重ロックが揃って resolveMode が live) なら起動しない (fail-closed)。文言は `LIVE_UNSUPPORTED_MESSAGE`「live の発注先は未対応です (Jupiter の実弾は次の段階で実装予定)」(`src/execution/router.ts`)。
   - 止める場所: `cmdRun` (DB・ロック・feed より前)、`buildRuntime` (`assertLiveSupported`。テストで偽の live ブローカー `opts.brokerSet` を渡したときだけ通す)、`createBrokers` の live の分岐 (常に例外)。status (`configCompatWarnings`) も警告する。
   - live の経路 (二重ロック・`assertLive`・偽の live ブローカーでのエンジンの試験 `tests/engine.live.test.ts` など) は残す。Jupiter の実弾のアダプターは `createBrokers` の live の分岐に加え、コンストラクタで `assertLive` を呼ぶ。そのときに `cmdRun` / `buildRuntime` の拒否を外す。
   - USD→JPY の換算 (`src/engine/fx.ts`): VENUES に jupiter があれば frankfurter.app の日次のレート (`src/engine/fxRate.ts` の `UsdJpyRateSource`。キー不要、1 時間ごとに取り直し、kv `fx:usdjpy` にキャッシュ) を "USD/JPY" の気配 (ts = レートの日付の 00:00 UTC。取得時刻ではないので live の `fxApproxReason` は常に古いと判定する) として fx の getQuote に渡す (hub の気配が先)。取れなければ概算表 (1 USD = 150 JPY、source "fallback")。paper はそのまま換算し古さで止めない (paper の新規は `fxApproxReason` を見ない)。live は概算表・古い (5 分超) 気配では新規エントリーしない (日次のレートは live では常に古い扱い。Jupiter の実弾では別のレートの取得元が要る)。

14. **相場構造 (ダウ理論) フィルター** (`src/structure/`、`STRUCTURE_MODE=filter` が既定。`off` なら従来と同一):
   - 戦略の一覧を作る箇所で `withStructure` / `configuredStrategies` がラッパーを掛ける。エンジン・バックテスト・`createParamValidator` は同じ一覧を使い、エンジン本体は変更しない。
   - 確定足だけ (各時間足で直近 300 本)。スイング点は左は厳密・右は `>=` (横ばい対応) で、N 本後に確定する (リペイントしない)。上位足も確定足だけ (MTF: 1m→15m、5m/15m→1h、1h→4h、4h→1d、1d→1w。1w は直近 300 本の 1d から作り、形成中の週は除く)。
   - 弾いたシグナルは観測専用の仮想トレード `strategy_filter:structure_*` (bias / mtf / chop / none / weak / po / stop) だけで、学習には使わない。
   - 構造の損切り (`STRUCTURE_STOP_MODE=structure`) は損切りを押し安値/戻り高値 ± ATR × バッファへ動かすだけ。サイズは RiskManager が決め、期待値は増やさない。新しい損切り幅が元の 0.5 倍未満・3 倍超・0.5 ATR 未満、または利確が不正なら見送る。
   - 既定の対象: scalp_momentum_burst, scalp_micro, short_ema_trend, short_breakout (対象外: scalp_obi, scalp_vwap_revert, short_rsi_revert, scalp_rebound, scalp_pullback, pullback_5m, pullback_15m。押し目買い・戻り売りの 3 戦略は上位足のトレンドを自前で判定する)。未知の id・廃止した戦略の id と、purist での `STRUCTURE_EXIT_ON_WEAKENING` は起動時に警告する。MTF の 4h→1d・1d→1w は一般の規則として残す (いまの既定の対象では使わない。hub は 1d を取得しない)。
   - 設定: `STRUCTURE_MODE` / `_STRATEGIES` / `_PIVOT_N` (3〜20、既定 6) / `_BREAK_MODE` / `_BIAS_METHOD` / `_REVERSAL_MODE` / `_USE_MTF` / `_USE_PERFECT_ORDER` / `_STOP_MODE` / `_STOP_ATR_BUFFER` / `_EXIT_ON_REVERSAL` / `_EXIT_ON_WEAKENING` / `_CHOP_M` / `_CHOP_R` (`config.ts`、既定は README)。
   - `STRUCTURE_EXIT_ON_REVERSAL` (既定 false) はラップした戦略だけの「目線の転換」での決済 (戦略の flat シグナル)。建玉に対する押し安値割れ / 戻り高値超えは 18 (`REVERSAL_EXIT`、全戦略) で、両方 true は重複 (起動時に警告)。
15. **指値 (maker)** (`LIMIT_ENTRY` 既定 true、`src/engine/limitOrders.ts`、`orders.ts`):
   - 新規は買いが最良の買い気配、売りが最良の売り気配への指値。優先順位は (成行だけの取引先) > シグナル自身の指値価格 > 戦略の `entryOrder` > 設定。`scalp_micro` は成行。post-only は `capabilities.postOnly` のある取引先だけ (いまは PaperBroker だけ)。
   - 成行だけの取引先 (`BrokerCapabilities.marketOnlyVenues`、いまは `jupiter`。DEX には板に置く指値が無い): 新規は常に成行 (`entryOrderFor`)、利確の指値も置かない (`PositionManager.tpBroker`)、PaperBroker はその venue の指値を拒否する。
   - RiskManager は発注前に、指値価格でサイズを決めて評価する。待機中は kv `orders:pending:<mode>` に保存し、その銘柄の新規を止める。期限・反対シグナル・損切り価格の通過・新規を止める条件 (停止・日次停止・kill switch・状態不明の注文・口座取得不可・気配の古さ) で取り消す。
   - 取消 → 照会で確認する。取消が確定し注文の消滅を確認するまで追跡から外さない (確認できなければ escalate し、新規を止める。取引所側に余分な建玉があれば異常 / kill switch)。一部約定はその数量の建玉にする。最小数量未満の端数は追跡外で、監査ログ `limit.dust_entry`。期限切れは仮想トレード `limit_unfilled` (重み 0.25)。protectiveStop は従来どおり渡す (いまの発注先の paper は付けない)。
   - 待機の利確 (`LIMIT_TAKE_PROFIT`、既定 false、paper のみ。live では無視して起動時に警告): reduceOnly の指値を利確価格に置く。成行で決済する前に、必ず取り消して確認する。
   - PaperBroker は気配が価格を通過したときだけ約定 (触れただけでは約定しない)、maker 手数料。バックテスト (`limitOrders`) は次の足から高値・安値が通過したときだけ約定し、maker 手数料、同じ足では損切り優先。検証・CLI のバックテストも現在の mode と同じ前提にする。約定率は kv `orders:limitStats:<mode>`。
16. **テンポと最大保有** (`src/engine/tempo.ts`、`TARGET_ENTRIES_PER_HOUR` 既定 0 = 無効、`MAX_HOLD_MINUTES` 既定 0 = 無効):
   - tempo (0〜1) = 不足 (1 − 直近 1 時間のエントリー / 目標) × 待ち (最後のエントリーから 60/目標 分まで 0、その 2 倍で 1)。ティックごとに 1 回計算し、新規エントリーの戦略評価 (`StrategyContext.tempo` / `tempoExplore`) と `RiskManager.evaluateEntry` (`EntryParams`) にだけ渡す。決済・バックテスト・パラメータ検証には渡さない。無効なら何も渡さず従来と同一。
   - 緩めるのは戦略の costMult (1.5 へ)、押し目買い・戻り売りの 3 戦略 (scalp_pullback・pullback_5m・pullback_15m。判定は共通の `createPullback`) の閾値、MIN_EDGE_TO_COST (`TEMPO_MIN_EDGE_TO_COST` へ。1 未満にしない) だけ。edgeIsNet のシグナルはコストを二重計上しない (下の「純期待値の規則」。テンポは比率を緩めてから同じ規則を使う)。クールダウン・損切り幅の制限・最大保有・RiskManager のそのほかの判定は緩めない。
   - 探索は paper では常に、live では `TEMPO_ALLOW_LIVE_EXPLORE=true` のときだけ。純期待値の下限を tempo × 往復コストだけ下げ (`tempoNetEdgeFloor`。RiskManager も同じ)、純期待値 ≤ 0 のエントリーはサイズ × `TEMPO_EXPLORE_SIZE` (既定 0.5) で `features.tempoExplore=1`。NaN は常に拒否。
   - 上限: 直近 1 時間のエントリーが ceil(目標 × `TEMPO_CAP_MULTIPLIER` (既定 2)) に達したら新規を止め、仮想トレード `tempo_cap`。エントリーは約定して建玉になった時に 1 回数え、再起動時はこの mode の直近 1 時間の取引と建玉から復元する。
   - `MAX_HOLD_MINUTES` (0 = 無効、5〜1440): 戦略の maxHold (と expectedMs) を丸める。保有中の建玉は変えない。バックテスト・検証も同じ `maxHoldMinutes`。時間軸が mid / long の戦略は新規を発注せず仮想トレード `hold_limit` (observe_only と同じ扱い、重み 0.25、腕の停止には使わない。バックテストでは丸めない) の規則は時間軸による一般の規則として残す (`isHoldLimitedHorizon`。いまの登録戦略に mid / long は無い。古い `hold_limit` の仮想トレードの表示にも使う)。
   - `THESIS_EXIT` が有効 (既定) なら `MAX_HOLD_MINUTES` は読みの期限の上限で、読みが当たっている建玉は 期限 × `THESIS_EXTEND_MULT` まで持ちうる (17)。
17. **読みの管理** (`THESIS_EXIT` 既定 true、`src/engine/thesis.ts` が純粋な判定。false なら従来の時間切れ `time` と同一):
   - 期限 = entryTs + expectedMs (`Signal.expectedMs`、無ければ丸めた maxHoldMs)。plan に maxHoldMs / expectedMs が無い建玉・当初リスク |建値 − 当初ストップ| ≤ 0 は従来どおり。
   - 純 R = (方向 × (決済できる価格 (買い bid / 売り ask) − 建値) − 実際のエントリー手数料/単位 − taker 率 × 決済できる価格) / 当初リスク。建玉の純 R には paper の空売りの借入コストを含めない (仮想トレードの純 R は含む)。そのため空売り (paper 再現) の建玉の「建値」決済はわずかな損失になりうる。
   - 途中で読み外れ `thesis_failed`: 期限の半分以降で 値動きだけの R (grossR = 方向 × (仲値 − 建値) / 当初リスク。バックテストは終値) ≤ −`THESIS_EARLY_CUT_R` (0〜1、既定 0.5。0 で無効)。コスト (手数料・スプレッド) だけでは切らない。期限 `thesis_timeout`: 純 R < `THESIS_MIN_R` (0〜2、既定 0.1)。それ以外は延長。期限 × `THESIS_EXTEND_MULT` (1〜20、既定 4) → `thesis_cap` (延長前に上限に届いた建玉も、利益が出ていれば延長を記録してから決済 = 答え合わせは延長)。
   - 決めた読みの決済は決済計画の `thesis.exit` に保存し、約定するまで同じ理由で再試行する (従来の時間切れと同じく損切り・利確・トレーリングが先、再試行の待ちも同じ)。その間・一部約定の残り (`retryExit`) の間は延長しない。
   - 延長: 決済計画 (kv `positions:exitPlans:<mode>`) の `thesis` (extendedAt・peak・stop) に保存 (再起動後も継続)、監査ログ `thesis.extended`。保護ストップ = 今のストップと max(建値 (往復手数料込み), 延長後の極値 − `THESIS_TRAIL_R` (0.1〜3、既定 0.5) × 当初リスク) のきつい方 (売りは逆)。極値は延長した時点の決済できる価格から始め、延長より前の高値・安値は使わない。延長した判定ではストップを判定しない (延長そのもので決済しない)。保存したストップ (`thesis.stop`) とのきつい方を使い、設定・手数料が変わっても緩めない。`THESIS_EXIT=false` で再起動しても保存したストップで守る。この決済は `trailing` で、決済の注文 (`PendingExit.thesisStop`) に印を付けて約定したときだけ `thesisStopExit: true` (ParamTuner の trail_loosen・exit_sooner の根拠から除く: `isStrategyTrailingExit`)。利確・損切り・シグナルは従来どおり。
   - 判定は PositionManager の毎ティック (時間切れと同じ位置)。決済は通常の成行 (利確の指値の取消確認・reduceOnly・状態不明の扱いはそのまま)。live で読みの管理が有効なまま決済計画つきの建玉を引き継いだら、起動時に警告して監査ログ `thesis.enabled_live` (設定と建玉)。
   - バックテストは足の終値で判定 (期限は終値 ∓ 半スプレッドの純 R、途中は終値の grossR) して次の足の始値で決済、延長後のストップは次の足から、極値は延長した足以降の高値・安値 (∓ 半スプレッド) を前の足まで (先読みなし)。`thesis` を backtest・`createParamValidator`・setup・backtest コマンドへ渡す。
   - 仮想トレードも同じ規則。`thesisExpectedMs` は読みの管理が有効なときだけ記録 (無い古い記録は従来どおり)。極値と延長後の保護ストップの判定は、延長した時刻以降に始まった 1m 足と気配だけ (当初の損切りは従来どおりの範囲)。
   - TradeRecord / ShadowTradeRecord に `thesisExpectedMs` / `thesisDeadlineTs` / `thesisExtendedAt` / `thesisOutcome` (failed_early / timeout / extended / none) / `thesisNetRAtDeadline` / `thesisStopExit` (TradeRecord のみ) (任意。古い記録も読める)。要因分析・ParamTuner は 3 つの理由を time と同じ扱い (`isTimeLikeExit`)。
   - 表示: report / simulate の「読みの答え合わせ」(テンポの表と同じく「うち空売り (paper 再現)」の件数・純損益を注記)、ダッシュボードの保有ポジション (読みの期限・残り分・状態・現在の R)、status の設定と各建玉の期限。ラベルは 読み外れ(途中) / 読み外れ(期限) / 延長の上限。
18. **転換で決済** (`REVERSAL_EXIT` 既定 true、`src/engine/reversalExit.ts` が純粋な判定。false なら従来と同一):
   - 時間足 (`REVERSAL_EXIT_TF`): `lower` (既定) = 持ち主の戦略の主時間足の 1 つ下 (1m→1m、5m→1m、15m→5m、1h→15m、4h→1h、1d→4h。`reversalTimeframeFor`)、`same` = 主時間足 (従来)。hub は対象の戦略のその時間足も取得する (`hubTimeframesFor` に reversal を渡す。全銘柄で同じ時間足なので建玉のある銘柄でも必ずある)。hub にその足が無ければ主時間足で判定する。
   - 建玉に対するダウ理論: その時間足で、エントリーした足以降に確定したスイングロー (買い) / スイングハイ (売り) のうち最も新しいものを水準にする。確定足の終値がそれを `REVERSAL_EXIT_BUFFER_ATR` (0〜1、既定 0) × ATR(14) より大きく割ったら (越えたら) 成行で決済 (理由 `reversal`。含み益でも含み損でも)。
   - スイングは `detectPivots` / `confirmedPivots` (N = `REVERSAL_EXIT_PIVOT_N`、2〜10、既定 3。`STRUCTURE_PIVOT_N` とは別)。N 本後に確定してから使う (リペイントしない)。エントリー前のスイングは使わない (エントリーした足は使う)。エントリー後に確定したスイングが無ければ何もしない (損切りが守る)。`REVERSAL_EXIT_FALLBACK=true` (既定 false) のときだけ、エントリーした足 (確定済み) の安値 (買い) / 高値 (売り) を水準にする (監査ログに `fallback: true`。エントリーした足が形成中なら判定しない)。既定で無効なのは早く発火しすぎるため (simulate でほとんどの取引をエントリー付近で閉じ、転換で決済の勝率は 5% 前後だった)。エンジン・バックテスト・仮想トレードとも同じ設定 (`ReversalSettings.fallback`)。ヒゲでは決済しない。ATR は最後の 100 本から (バッファ 0 なら ATR は使わない)。
   - 対象: `REVERSAL_EXIT_STRATEGIES` (空 = 全戦略。未登録・廃止した戦略の id は起動時に警告。廃止した戦略の id は一覧から外さない (外すと空 = 全戦略に変わりうる) ので、更新前に建てたその戦略の建玉にだけ効く)。読みの管理の建玉・延長中の建玉も対象 (答え合わせは延長前なら「期限前に決着」、延長後なら延長)。
   - エンジン: 保有中の建玉を、判定の時間足の新しい確定足ごとに 1 回 (`processSymbol` の持ち主の戦略の評価の後)。損切り・利確・トレーリング・読みの管理 (ティックごと) が先。同じ確定足で戦略の決済シグナルも出たら `signal` を優先 (`signal` の件数は無効のときと同じ)。決済の手続き中 (保留中・状態不明の注文、読みの決済の再試行、一部約定の残り、利確の指値の取消中、拒否後の建玉確認) は重ねない (`PositionManager.exitInProgress`)。決済は signal と同じ通常の `close()`。監査ログ `position.reversal_exit` (判定の時間足 `timeframe`・主時間足 `primaryTimeframe`・水準・`fallback`・終値・スイングの足・ATR・状態)。足がエントリーより新しい建玉は判定せず `position.reversal_no_history` を 1 回 (hub は各時間足を最大 2000 本保持)。新たに保存するものは無い (水準は足から毎回求める)。
   - バックテスト: 判定の時間足が確定したバーの終値で判定し、次のバーの始値で決済 (signal と同じ)。主時間足が確定していないバーでは戦略を評価せず転換で決済だけを判定する。基準足が粗くて 1 つ下の時間足を作れなければ same (主時間足) で判定する (`reversalBacktestTimeframe`。例: pullback_5m は基準足 5m なので 5m)。`reversal` を backtest・`createParamValidator`・setup・backtest コマンドへ渡す (検証も運用と同じ規則)。
   - 仮想トレード: 同じ規則。記録時に実際の建玉と同じ判定の時間足 (`REVERSAL_EXIT_TF`) を `reversalTf` に保存し (有効で対象のときだけ。決済の記録には残さない)、engine が渡す hub のその時間足の確定足で判定 (リサンプルしない。足が無ければ判定しない)。損切り・利確・読みの管理が先。古い記録は従来どおり。
   - 要因分析・ParamTuner は `signal` と同じ扱い (`isSignalLikeExit`。決済後に伸びたら early_exit → tp_raise)。表示名は「転換で決済」(ダッシュボードの取引は 押し安値割れ / 戻り高値超え を添える)。report / simulate の「転換で決済」の表、status の設定。

19. **廃止した機能の互換** (GMOコイン・OANDA・Alpaca・DEX の取引先、資産クラス fx / stock、ccxt の実弾の発注、meme_momentum・DexScreener・AUTO_MEME_WATCH、mid_trend_follow・long_momentum):
   - **学習データを消さない・書き換えない**。廃止した戦略の腕・仮想トレード・取引の記録、kv `engine:autoMemeWatch` などは DB に残し、読まないだけ。持続状態を読むコードは、廃止した戦略 id・venue の記録があっても例外にしない・消さない。
   - 廃止した戦略の情報は `src/strategies/retired.ts` (`RETIRED_STRATEGIES`: 主時間足・時間軸) だけ。復元した建玉は損切り・利確・トレーリング・読みの管理・転換で決済で管理を続ける (転換で決済の時間足は `RETIRED_STRATEGIES` の主時間足から。engine の `primaryTimeframeOf`)。出なくなるのは持ち主の戦略の決済シグナルだけ。試験 `tests/engine.retiredStrategy.test.ts`。
   - 環境変数の戦略 id (`OBSERVE_ONLY_STRATEGIES` / `STRUCTURE_STRATEGIES` / `REVERSAL_EXIT_STRATEGIES`) に廃止した id があれば起動時に警告して無視する (`strategyIdListWarnings`。起動は止めない)。
   - `VENUES` / `WATCHLIST` の `gmo` / `oanda` / `alpaca` / `dex` は起動時に警告して無視する (`parseVenues` の warn。ほかの未知の値は従来どおりエラー)。VENUES が廃止した取引先だけ (例 `VENUES=gmo`) なら警告して `ccxt` (CCXT_EXCHANGE、既定 bitbank) にする (`effectiveVenues`。古い .env で paper が落ちないように)。`OANDA_*` / `ALPACA_*` / `CCXT_API_KEY` / `CCXT_SECRET` / `CCXT_PASSWORD` / `AUTO_MEME_WATCH` は読まない。`GMO_*` / `MAX_EXPOSURE_FX` / `MAX_EXPOSURE_STOCK` も読まず (値が不正でも起動を止めない)、run の起動時と status で警告する (`removedEnvWarnings`)。`gmo` コマンド・`--source gmo` は廃止した旨のエラー。
   - 資産クラス fx / stock (合成の USD/JPY・AAPL、経済指標の FX・株式向けのブラックアウト `blackoutsFromEvents`、FX の base − quote のバイアス、擬似資産 FX、株のティッカーの付与、`MAX_EXPOSURE_FX/STOCK`、振り返りの scope) は廃止した。`AssetClass` は `"crypto" | "meme"`。WATCHLIST の `|fx` / `|stock` は警告して無視する (`parseWatchlist` の warn)。
     - 古い記録の `assetClass: "fx" / "stock"` (取引・仮想トレード・腕・パラメータ・情報の効き具合・振り返り・予想の集計・paper のスナップショットの銘柄定義) は消さず、読んでも例外にしない。クラス別の表は既定値に落とす (`defaultCosts`・`regimeOptionsFor` は crypto の値、PaperBroker のレバレッジは 1、`classExposure` は別のキーに積む、上限の無いクラスの新規は RiskManager が拒否、擬似資産なし)。計画には fx / stock の古い教訓を渡さない (`isPlannerScope`)。
     - kv `risk:limits:<mode>` の `maxExposureFx` / `maxExposureStock` は読まず、ダッシュボードから保存し直しても消さずに引き継ぐ (`RETIRED_RISK_KEYS`)。古い画面から送られても拒否せず無視する。
     - 経済指標は情報源として残す (USD の指標は CRYPTO / MEME の eventRisk、クオート通貨 (JPY など) の指標は銘柄の `IntelBias.blackoutUntil`)。株式市場全体のニュースの擬似資産 STOCKS はリスクオン指数の材料として残す (株式は取引しない)。
   - GMOコインの廃止: GmoBroker・GmoFeed・`src/market/gmo/`・RiskManager の実効レバレッジの上限・持ち越し手数料 (`holdingFee.ts`) は削除した。古い paper のスナップショットの GMO の建玉は、同じ銘柄を ccxt で監視していればその相場で管理を続ける。持ち越し手数料で付いた買いの建玉の `borrowAccrued` は決済時に払い、以後は積まない (保有コストを積むのは負の建玉 = 再現した空売りだけ)。古い仮想トレードの `holdingFeeDaily` は計上しない (記録は書き換えない)。
   - paper の ccxt (bitbank の足、`CcxtFeed`・`bitbankCandles`・`backtest --source ccxt`) は従来どおり (相場の既定の実データ源)。
   - 資産クラス `meme` は Jupiter のミームコイン (3.20) と、WATCHLIST で `|meme` と明示した銘柄。ccxt の銘柄は自動では分類しない (ccxt の DOGE・PEPE なども crypto。合成データの PEPE/USDT も crypto)。meme は `MAX_EXPOSURE_MEME` と `MEME_MIN_LIQUIDITY_USD` (Jupiter はトークン情報の liquidity、ほかは 24 時間の出来高からの推定) の RiskManager の判定を受け、assetClasses に meme のある戦略 (scalp_momentum_burst・scalp_pullback・pullback_5m・pullback_15m・short_ema_trend・short_rsi_revert) が取引する。腕のキーに資産クラスが入るので学習は crypto と分かれる。
   - 時間軸の型 `Horizon` の mid / long も残す (古い記録・`isHoldLimitedHorizon`)。

20. **Jupiter (Solana。`VENUES=jupiter` が既定)** (`src/market/jupiter/` が API の部品、配線は `src/market/feeds/jupiter.ts`・`src/engine/jupiterWatch.ts`・`src/execution/jupiterFill.ts`・`setup.ts` の `setupJupiter`):
   - paper だけ。クライアントは読み取り専用 (swap・execute は呼ばない)。live は従来どおり拒否 (3.13)。実弾のアダプターは次の段階で `assertLive` を呼ぶ。
   - 銘柄 (`jupiterInstrument`): シンボル `<SYMBOL>/USDC` (重なれば `<SYMBOL>-<mint 先頭 4 文字>/USDC`。使ったシンボルは kv `jupiter:watch:<mode>` の `instSymbol` に保存し、再起動では保有中の銘柄を最初に同じシンボルで加える (paper のスナップショットの銘柄定義の symbol も使う。`addToken` の強制シンボル)。保有中の建玉のシンボル → mint の対応は再起動で変わらない)、クオート USDC (= USD。口座通貨は JPY のまま)、venue `jupiter`、`allowShort=false`、SOL・JUP は crypto、それ以外は meme。lotSize = minQty = 10^-decimals、tickSize = 10^-(6 + decimals)、minNotional = `JUPITER_MIN_NOTIONAL_USD` (既定 5)、taker / maker 手数料率 0 (経路の手数料は見積もりの価格に含まれる)、`fixedFeePerOrder` = `JUPITER_NETWORK_FEE_USD` (既定 0.02)、`costModel` = { refNotional: `JUPITER_QUOTE_SIZE_USD` (既定 50), spreadBps: 2 × 代わりのモデルの片道 bps, slippageBps: 0 }、meta { mint, decimals, source }。
   - コスト: 約定ごとの固定手数料はコストの見積もりでは `costFeeRate` (= taker 率 + 固定手数料 / refNotional。`src/core/fees.ts`) で率にする。戦略の段階 (サイズが分からない) は refNotional = `JUPITER_QUOTE_SIZE_USD`。RiskManager はサイズを決めた後、実際の代金でのコスト (`EntryParams.costBpsAt` = `JupiterFeed.costBpsAt`: 2 × (その代金と流動性での代わりのモデルの片道 bps + 手数料 / 代金)) で同じ規則 (`edgeCheck`) をもう一度確かめ、満たさなければ拒否する (サイズは縮めない。記録の costBps もその値。`costBpsAt` の無い銘柄は従来と同一)。RiskManager の `costBps`・戦略の `roundTripCostBps` (netEdge)・読みの管理の純 R・仮想トレード (手数料と、約定ずれは `costModel.slippageBps`)・バックテスト (`instrumentCosts` と固定手数料を約定ごとに decimal で計上) が同じ前提。固定手数料の無い銘柄は従来と同一。
   - feed (`JupiterFeed`): Price V3 を `JUPITER_POLL_MS` (既定 5 秒) ごとに全 mint を 1 回 (50 件ずつ) で取る (fetchQuote ごとに API を呼ばない)。気配は 仲値 = 価格、買い・売り = `estimateFillFallback` を `JUPITER_QUOTE_SIZE_USD` と流動性で評価した価格 (主要銘柄 (crypto) は固定 5bps、meme は既定 30bps。見積もり API は使わない)。全部の取得に失敗したら fetchQuote は例外 (hub の lastError → 新規停止)、一部の mint が応答に無いときは例外にせず前の気配 (古い時刻 → stale_quote で新規停止) を返し status・警告で知らせる。regime の maxSpreadBps は meme 150 / crypto 30 のまま。
   - 足: `candlesAreLocal` の feed は hub が毎回全体を取り直して置き換える (空でも集約・気配からの組み立てに切り替えない。`MarketHub`)。1m は PolledCandleStore (出来高不明 `Candle.volumeKnown: false`)、上位足は `resamplePolled`。GeckoTerminal の backfill は裏の取得 (起動を待たせない): プール → 1m (全銘柄で先に) → 1m の 1 ページの集約で hub の 300 本に足りない時間足 (15m・1h・4h・5m) を直接。1m の履歴はポーリングの最初の足より前だけ。プールの検索 (見つからない・失敗) と履歴の失敗は 5 分 → 15 分 → 60 分 (以後 60 分ごと) の後に取り直し、時間足は成功してから取得済みにする (`GECKO_RETRY_BACKOFF_MS`)。監視から外した銘柄の GeckoTerminal のキャッシュは捨て (`forgetToken`)、キャッシュの件数にも上限 (足 200・プール 500)。
   - 先読み・リペイントをしない: 一度返した確定足は時間足ごとに凍結し、OHLC を変えない。変えてよいのは出来高の「不明 → 分かった」だけ。履歴は凍結した最初の足より前にだけ足す (途中の空白には差し込まない)。GeckoTerminal の出来高は銘柄を順に (最短 1 分おき、`GECKO_CALLS_PER_MIN` の枠の中で) 取り、確定から 3 分以上たった 1m 足にだけ入れる (取引の無い分は 0)。GeckoTerminal の高値・安値は使わない。
   - 出来高が不明な足: 出来高を条件に使う戦略 (scalp_momentum_burst・scalp_micro の detectBurst・short_breakout) は判定の窓に `volumeKnown === false` の足があれば条件を満たさない (`volumeUnknown`。fail-closed)。scalp_pullback 系は出来高を確信度の加点だけに使い、不明なら 0。volumeKnown を持たない足 (ccxt・合成) は従来と同一。直近の足の出来高は常に不明なので、Jupiter の銘柄ではこの 3 戦略は入らない。
   - 約定 (paper): PaperBroker の `marketPricer` (`createJupiterFillPricer`): `swap/v1/quote` の見積もり → `estimateFill` の実効価格 (数量は発注の decimal のまま)。(mint, 向き, 金額の帯 = round(log2(USD))) ごとに 15 秒キャッシュ (参照価格が取得時から 0.3% を超えて動いたら使わない。使うときは古い絶対価格ではなく、取得時の参照価格に対する影響 (bps) を今の参照価格に掛ける)。枠の待ち (`TokenBucket.waitMs` は待ちの列を含む) が 4 秒を超えそう・4 秒で返らない (AbortController で中止し、共有の枠を使い続けない)・失敗なら `estimateFillFallback`。見積もりの再試行は 1 回まで。気配がエンジンの maxQuoteAgeMs (30 秒) より古ければ代わりのモデルで値付けせず注文を拒否する (決済は次のティックで再試行)。手数料は固定手数料だけ (PaperBroker が約定ごとに計上。余力の確認にも含める)。
   - 空売りなし (3.12)・指値なし (3.15 の marketOnlyVenues)。
   - ミームの流動性: `EngineDeps.marketExtras` (venues ["jupiter"]) の `liquidityUsd` = トークン情報の liquidity (`tokens/v2/search` を 1 時間ごと、100 件ずつ。定期の処理 `jupiter.tokens`)。値が無い・3 時間 (`LIQUIDITY_MAX_AGE_MS`) より古ければ undefined (RiskManager が拒否。気配の仮のスプレッドも流動性不明の bps)。出来高からの推定は使わない。
   - 監視銘柄: `JUPITER_TOKENS` (mint か symbol。symbol は MAJOR_TOKENS・DEFAULT_MEME_TOKENS → tokens/v2/search。decimals が取れなければ既定の銘柄だけ既知の値) と自動探索 (`JUPITER_DISCOVERY`、既定 true、`JUPITER_DISCOVERY_MINUTES` ごと。定期の処理 `jupiter.discovery`): toptrending/1h と toporganicscore/1h → `screenTokens` (JUPITER_DISCOVERY_* の設定、空はモジュールの既定値) → `mergeWatchlist` (期限 `JUPITER_DISCOVERY_TTL_HOURS`、keepMints = 保有中・保留中の注文の銘柄)。kv `jupiter:watch:<mode>` (decimals つき)。監査ログ `jupiter.watch_add` / `jupiter.watch_remove` (外した理由と選別の不合格の理由) / `jupiter.discovery` (不合格の理由の集計) / `jupiter.discovery_error`。実行中の追加・削除は `TradingEngine.watchInstrument` (hub.watch + PaperBroker.addInstrument) / `unwatchInstrument` (建玉・保留中の注文・利確の指値のある銘柄は外さない。`MarketHub.unwatch`) と feed の addToken / removeToken。監視中の自動追加の銘柄が後で選別に落ちたら (監査の変化・流動性の低下など) 新規エントリーだけ止める (`screen_failed`。止めた理由は kv の `screenBlock` に保存して再起動後も止める。トークン情報が無いときは前回の判定のまま止める (fail-closed)。監査ログ `jupiter.watch_screen_failed` は理由の種類 (code) の組が変わったときだけ、解除は `_ok`)。起動時は kv の一覧から期限内 (と保有中) の銘柄、paper のスナップショットの Jupiter の建玉の銘柄定義 (meta.mint・decimals) から戻す。
   - パラメータ検証 (3.7): Jupiter の銘柄は長い履歴が無いので `feedFor` が undefined (検証しない = 学習による変更は適用しない)。
   - 定期の処理 (`EngineDeps.periodic`: USD/JPY・トークン情報・自動探索) は start でタイマー、`advance` (simulate・試験) で期限が来たら実行。失敗しても取引は止めない。
   - レートの目安 (1 分あたり): Jupiter は価格 12 回 + 約定ごとの見積もり + 探索 2 回 / 20 分 + トークン情報 1 回 / 時間 (キーなしの上限 30 回/分)。GeckoTerminal は起動時に 1 銘柄 6 回、その後は残りの枠で出来高。
   - 既定の VENUES の変更 (synthetic → jupiter): VENUES を設定していないのに DB_PATH の隣に `<ベース名>-synthetic.db` があれば、run の起動時と status で「いまは DB_PATH を使う、以前は -synthetic.db、VENUES=synthetic で戻せる」と警告する (`syntheticDbSwitchWarning`。自動では移さない)。
   - `JUPITER_POLL_MS` は 1000〜15000 (気配の古さの上限 30 秒の半分以下。config で検証)。
   - 取引先の切り替え: いまの VENUES に無い取引先の建玉 (例 bitbank の BTC/JPY) は起動を止めず (従来の孤児・監視外の扱い)、起動時にログと監査ログ `engine.unwatched_positions`、status と run で `paper reset` を勧める警告。
   - 要確認 (`jupiter check`): API の仕様は公式資料の記述だけで実際の応答とは未照合 (`JUPITER_UNVERIFIED_ITEMS`)。主要銘柄の固定 5bps、既定の銘柄の decimals (`KNOWN_DECIMALS`) も要確認。
   - 試験: `tests/jupiter.feed.test.ts` (ポーリング・backfill・出来高の取り込みで OHLC が変わらないこと・実行中の追加と削除)、`jupiter.fill.test.ts`、`jupiter.short.test.ts`、`jupiter.watch.test.ts`、`jupiter.backtest.test.ts` (7 日分の 1m・履歴が短いときの例外)、`jupiter.review.test.ts` (シンボルの保存 (TRUMP の重なり)・停止の保存・流動性の古さ・GeckoTerminal の再試行とキャッシュ・実際の代金のコスト・見積もりのキャッシュと中止・古い気配・USD/JPY の時刻・設定)、`fxRate.test.ts`、`strategies.volumeUnknown.test.ts`、`engine.jupiter.test.ts` (既定の VENUES・数時間の統合・ミームの流動性・互換の警告)。モックは `tests/helpers/jupiterMock.ts`。

## 4. 構成
(ここに挙げるパスのうち、上の「共通コア」に挙げた trader に残るもの以外は、実体が `packages/trading-core/src/` の同じパスにある)
- `src/core/`: 型の契約 (`types.ts`)、設定、decimal、HTTP リトライ、Claude 呼び出し (`ai.ts`。構造化出力、拒否時はサーバー側フォールバック、キー未設定時はルールベース)
- `src/strategies/labels.ts`: 戦略・時間軸・腕のキーの日本語の表示名 (表示専用。id・kv キー・env の値・腕のキーは変えない。long / short は長期 / 短期の意味で売買の向きではない)。画面・レポートはここを通す
- `src/indicators/`, `src/regime/`: 指標・リサンプル・相場環境の判定
- `src/strategies/`: 11 戦略 (scalp 6 / short 5)。資産クラスは scalp_momentum_burst・scalp_pullback・pullback_5m・pullback_15m・short_ema_trend・short_rsi_revert が crypto・meme、scalp_obi (板が必要)・scalp_vwap_revert・scalp_micro・scalp_rebound・short_breakout は crypto だけ。廃止した戦略の互換の情報は `retired.ts` (3.19)。scalp_rebound は 15m の下降トレンド中の 1m の反発を買う (買いのみ・crypto。既定で観測専用)。scalp_pullback は 15m EMA20 の傾きで方向を決め、上昇中の 1m の押しを買い・下降中の戻りを売る (crypto。売りは canShort。損切り = 押しの極値 ± stopAtr (0.3) ATR を 0.8〜3.5 ATR に収める (超えたら見送り)、利確 = tpR (2) × 損切り幅、保有 10〜30 分、純期待値 (edgeIsNet)、コスト条件と 5 本のクールダウンあり。構造ラッパーなし・観測専用でない)。pullback_5m (5m / 上位足 1h、保有 6〜24 本 = 30 分〜2 時間) と pullback_15m (15m / 上位足 4h、保有 4〜16 本 = 1〜4 時間) は scalp_pullback と同じ判定 (`createPullback`) の短期版 (horizon short、純期待値、構造ラッパーなし・観測専用でない。warmup は上位足 28 本ぶん)。パラメータの標準名は stopAtr, tpAtr, trailAtr, entryThreshold, maxHoldBars
- `src/structure/`: 相場構造 (pivots・machine・perfectOrder・mtf・wrap・settings)。`src/engine/structureCompare.ts` は `--structure-compare`
- `src/engine/tempo.ts`: テンポ・上限・探索。`thesis.ts`: 読みの管理の純粋な判定 (期限・純 R・延長後の保護ストップ・決済理由)。`reversalExit.ts`: 転換で決済の純粋な判定 (エントリー後の押し安値・戻り高値と終値の比較、設定)。`limitOrders.ts`: 指値エントリー / 待機の利確の管理。`orders.ts`: 保留中・状態不明の注文の管理 (指値の取消確認・約定率の統計を含む)
- `src/backtest/`: イベント駆動バックテスト、`evaluateParams`、`walkForward`、合成データ
- `src/market/`: feed (jupiter / ccxt / synthetic) と MarketHub。`feeds/jupiter.ts` は Jupiter の feed (3.20)、`feeds/geckoHistory.ts` はバックテスト用の GeckoTerminal の足。ccxt は相場の取得だけ (bitbank は `bitbankCandles.ts`)。synthetic は BTC/USDT・ETH/USDT・PEPE/USDT (すべて crypto)。`src/market/jupiter/` は Jupiter の API の部品 (client・price・tokens・candles・gecko・quote・discovery・check)
- `src/execution/`: PaperBroker (`marketPricer`・固定手数料・`marketOnlyVenues`)、`jupiterFill.ts` (Jupiter の成行の約定価格)、`guard.ts` (`assertLive`)、router (live は常に拒否。実口座アダプターは無い)
- `src/engine/jupiterWatch.ts`: Jupiter の設定 (env)・固定の銘柄の解決・自動探索。`fxRate.ts`: USD/JPY の日次のレート
- `src/risk/`: RiskManager (実効の上限 = .env + ダッシュボードの上書き。`settings.ts`)
- `src/intel/`: 情報源 (RSS・Fear&Greed・CryptoPanic・CoinGecko・経済指標) → 分析 (Claude) → 資産別バイアス → 戦略計画
- `src/learning/`: 次の部品で構成する
  - TradeJournal
  - attributeTrade (損益の要因分析)
  - StrategyAllocator (戦略×レジーム×資産クラスのベイズ配分)
  - SourceReliabilityTracker (情報源の信頼度。kv `intel:sourceReliability:<mode>` 経由で intel が読む。ニュースの答え合わせもこの mode 別キーを更新する)
  - ParamTuner (区間検証・Welch の差し戻し・双方向ルール。統計関数は `stats.ts`)
  - reflect (定期的な振り返り)
  - `shadow.ts`: 見送ったシグナルを仮想トレードとして追跡し、決済結果を腕の更新 (重み 0.25) に渡す。未決済は kv `shadow:open:<mode>`
  - `newsCheck.ts`: ニュースの向きと 15m / 1h / 4h 後の値動きの答え合わせ。情報源の信頼度に重み 0.3 で反映。状態は kv `newsCheck:<mode>:*`
  - `forecast.ts`: 銘柄ごとの値動きの予想 (15m / 1h / 4h)・答え合わせ・オンライン学習。有意なときだけエントリーサイズの倍率を返す。kv `forecast:*:<mode>`
  - `migration.ts`: 学習状態の mode 分離の移行 (旧キー → `<mode>` 付きキー。paper はコピー、live は初期状態。フラグ kv `migration:learningModeSplit:<mode>`)
- `src/storage/`: Store (node:sqlite / memory)
- `src/engine/`, `src/cli.ts`, `src/dashboard/`: 統合・CLI・ダッシュボード (閲覧 + リスク設定)。`regimeReport.ts` は regime コマンド

## 5. 既定モデル
Claude API は `claude-opus-5-5` (`ANTHROPIC_MODEL` で変更可)。
