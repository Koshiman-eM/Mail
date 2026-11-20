# Claude Code Project Guidelines: 自己学習型マルチアセット自動売買ツール (`trader/`)

このディレクトリは、リポジトリ直下のせどり支援ツールとは独立したパッケージ。ここで作業するときは本ファイルを優先する。

## 1. 概要
仮想通貨 (ミームコイン含む)・FX・株式を自律売買する。メインはスキャルピングと短期で、中期・長期にも対応する。
- インターネットから情報を収集して戦略を立てる (`src/intel/`)。
- 損益の要因を分析し、戦略配分・パラメータ・情報源の信頼度へフィードバックする (`src/learning/`)。

## 2. コマンド
- `npm install` / `npm test` / `npm run typecheck`
- `npm run simulate -- --days 1`: 合成データで高速にペーパー運転する (ネット不要)。構造フィルターの理由別の見送り数・エントリー/時・平均保有・テンポ・見送り件数・読みの答え合わせも表示
- `npm run backtest -- --strategy all [--source synthetic|ccxt|gmo]`
- `npm run backtest -- --structure-compare [--strategy <id>|all] [--pivot-sweep] [--folds 5] [--days N] [--source ...]`: 相場構造フィルターの比較 (A: ラッパーなし 〜 G: conservative を evaluateParams の区間で比べる)。30 取引未満の区間は「回数不足」。`--pivot-sweep` (N=4/6/10) は頑健性の確認だけで、N を調整し続けない
- `npm start`: 実時間で起動する。既定は paper
- `npm run report`: 成績と学習状態 (現在の mode のもの) を表示。注文種別ごとの成績・maker/taker 手数料の内訳・指値の約定率・探索/通常 (テンポ) の表・読みの答え合わせ (途中/期限で読み外れ・延長・期限前に決着、期限での的中率) も出す
- `npm run trader -- intel`: 情報収集を 1 回実行してブリーフを表示
- `npm run status`: 設定と現在の状態を表示 (指値の設定と約定率、テンポ・最大保有、読みの管理の設定と各建玉の読みの期限も)
- `npm run trader -- resume`: キルスイッチ・日次停止を解除 (監査ログに記録。動作中のエンジンにも次のティックで反映)
- `npm run trader -- orders` (`orders list`): 保留中・状態不明の注文を一覧
- `npm run trader -- regime --symbol BTC/JPY --hours 3 [--tf 1m,15m,1h,4h] [--step <分>]`: 各時刻の相場の状態 (レジーム) を運用と同じ detectRegime で表示 (確定足だけ。スプレッドは 0 扱い。VENUES に gmo があれば GMOコインの足)。目線・押し安値/戻り高値・choppiness も表示
- `npm run trader -- gmo check`: GMOコインの API の応答の形を確かめる (公開 API と、`GMO_API_KEY` があれば読み取り専用の非公開 API。**注文・取消は呼ばない**。キーは表示しない)。live に切り替える前に必ず実行する
- `npm run trader -- orders resolve <clientId> --none | --filled --qty <数量> --price <価格>`: 状態不明の注文を手動で確定する。escalated 以外は `--force` 必須。`--none` で取消に失敗したら保留のまま

## 3. 安全ガードレール (厳守)
1. **実弾の二重ロック**: live になるのは `TRADING_MODE=live` と `LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY_RISK` が揃ったときだけ (`src/core/config.ts` の `resolveMode`)。
   - 実口座アダプターはコンストラクタの `assertLive` で、paper / test モードでの生成を拒否する (`src/execution/guard.ts`)。
   - このガードを弱める変更をしない。
2. **テストは完全オフライン**: 実在の取引所・ブローカー・ニュース API へ送信しない。
   - fetch / ccxt インスタンスは注入してモックする。
   - フィクスチャ (`tests/fixtures/`) は合成データ。
3. **会計値は decimal.js**: 残高・数量・手数料・損益の計算は `src/core/decimal.ts` を使う。指標・統計は number でよい。
4. **シークレットは環境変数のみ** (`.env.local`)。
5. **先読み禁止**: 戦略に渡すのは確定足だけ。バックテストの約定は次の足の始値で行う。
6. **リスク管理を迂回しない**: 新規エントリーは必ず `RiskManager.evaluateEntry` を通す。
   - 日次損失上限 → 当日停止
   - 最大ドローダウン → kill switch (手動の `resume` まで停止)
7. **学習による変更は検証してから適用**: パラメータ調整は、feed から取った長い履歴 (主時間足 3000 本、scalp は 14 日分) を 5 区間に分けたバックテストで、区間ごとの符号検定 (片側 p < 0.1)・改善幅・取引数の条件をすべて満たすときだけ適用する (`learningHooks.ts` の `createParamValidator`、`tuner.ts`)。hub の短い足では代用しない。
   - 適用後は、判断に使った期間より前の取引と Welch の t 検定で比べ、有意に悪化したら元に戻す。評価待ちは 14 日で期限切れ。
   - LLM の提案も同じ検証経路を通す (`ParamTuner.propose`)。
   - 値動きの予想 (`forecast.ts`) によるエントリーサイズの倍率はパラメータの変更ではない。consensus を除いた基礎モデルで、同じ時刻・同じ資産クラスの予想を 1 観測にまとめ、12 グループの多重検定 (Bonferroni) で補正した有意性 (入る z ≥ 2.638、出る z < 2.138、判定済み 100 件以上) を満たしたときだけ 0.7〜1.2 倍で効く。結果は RiskManager の上限 (`MAX_SIZE_MULTIPLIER` = 1.5) の範囲内に収まる。満たさない間は常に 1.0。リスク判定は迂回しない。
8. **学習状態は mode 別キー**: 腕・パラメータ・調整履歴・情報源の信頼度・ニュースの答え合わせ・予想・仮想トレードの kv は `<名前空間>:<mode>:...` (信頼度は `intel:sourceReliability:<mode>`)。paper の学習を live に持ち込まない。旧キー (mode なし) は paper にだけ初回起動時に引き継ぐ (`migration.ts`)。live は初期状態から始める。
9. **仮想トレードの重みと停止中の扱い**: 見送ったシグナルの結果は腕の配分に重み 0.25 (腕を止める判定には使わず、止まった腕の回復判定にだけ使う)。ニュースの答え合わせは 1 記事あたり合計 0.3 (時間 × 資産の数で割る)。取引による信頼度の更新は (情報源, 記事) ごとに 1 回。停止中 (`HALT_SHADOW_REASONS`) に記録した仮想トレードは学習に使わない。戦略がコストで見送ったシグナル (`strategy_filter:*`、`StrategyContext.onFiltered`) は観測専用で、保存だけして腕・情報の効き具合には使わない。
   - 観測専用の戦略 (`OBSERVE_ONLY_STRATEGIES`、既定 `scalp_rebound`、空文字で無効) は新規エントリーを発注せず、仮想トレード (`observe_only`) としてだけ記録する (RiskManager・腕の乱数に触れない。判定は腕・計画の判定より前で、戦略の対象レジームと低流動性の停止は守る)。`observe_only` は通常の見送りと同じく腕の配分に重み 0.25 で入り、腕を止める判定には使わない。
10. **腕の停止と回復**: 止めるのは実取引だけの統計で、件数 ≥ 30 かつ「縮小推定の平均 + 2.5·SE < 0」のとき。止まった腕も戦略は評価し、仮想トレード (`arm_disabled`) を記録して、回復の推定が 0 を越えたら戻す (`allocator.ts`)。
11. **ダッシュボードの書き込みはリスク設定だけ**: `/api/risk-settings` (kv `risk:limits:<mode>`)。CSRF トークン・Origin 確認・ループバック待ち受け (それ以外は `DASHBOARD_WRITE_TOKEN`) が必須。live でリスクを上げる変更は確認語が必要。範囲は `config.ts` の `RISK_SETTING_SPECS` が唯一の定義。
12. **空売りの再現は paper だけ** (`PAPER_SIMULATE_SHORT`、既定 true。`src/core/short.ts`): `allowShort=false` の銘柄は live では空売りしない (GMOコインのレバレッジ銘柄は `allowShort=true` なので live でも売りから建てられる。13 を参照)。
   - `allowShort` (取引所の仕様) は書き換えない。paper かつ有効のとき、`allowShort=false` の `crypto` (meme・DEX は対象外) に `simulatedShort: true` を付ける (`setup.ts`)。
   - 実効の空売り可否は必ず `canShort(inst, mode)` で判定する (戦略 `common.ts` は `ctx.mode`、RiskManager、PaperBroker、planner)。live・バックテスト・mode 不明では `allowShort` だけ。
   - PaperBroker は負の建玉で約定し、建玉代金を余力から拘束、買い戻し時に借入コスト (建玉代金 × `PAPER_SHORT_BORROW_RATE_DAILY` × 日数) を手数料に計上 (decimal)。
   - 取引・仮想トレードは `simulatedShort: true` を付け、腕は `<戦略>|<レジーム>|<資産クラス>|short` で学習する (買いと取引所で可能な売りは従来のキー)。ParamTuner・振り返り・情報源の信頼度・情報の効き具合・予想の applied からは除外。
   - report / simulate / ダッシュボードは「買い」「売り」「空売り (paper 再現)」に分け、live で実際にできる成績 (再現の空売りを除く) を明示する。

13. **GMOコイン** (venue `gmo`。取引所のレバレッジ取引、銘柄 `GMO_SYMBOLS`):
   - reduceOnly は必ず `/v1/closeBulkOrder` に送る。反対側の建玉があるとき・建玉を照会できないときの新規は送らない (両建て防止)。POST は再試行しない。protectiveStop は付けない。
   - GMO の建玉の合計 (絶対値の円換算) は評価額 × `GMO_MAX_EFFECTIVE_LEVERAGE` (既定 1、0.1〜2) までに RiskManager が抑える (既存の判定より緩めない)。
   - paper と仮想トレードでは、建玉代金 × `meta.holdingFeeDaily` (`GMO_LEVERAGE_FEE_DAILY`、既定 0.0004) × 日本時間 6:00 をまたいだ回数を手数料に計上する (`src/core/holdingFee.ts`)。
   - live で VENUES に GMO 以外の発注先 (dex・synthetic を除く) があるときは、GMO の新規エントリーを拒否する (評価額が全口座の合計で、GMO 単独の上限にならないため)。
   - 建玉・注文の照会は形が想定と違えば例外。新規の前に positionSummary・openPositions・activeOrders を確認し (反対建玉・反対方向の新規注文があれば送らない)、銘柄ごとに直列化する。POST は `allowPost: true` のクライアント (GmoBroker が assertLive の後に作る) だけ。
   - レバレッジ銘柄の足が取れないときの現物の足への切り替えは、paper では許可 (監査ログ `gmo.spot_candles`)、live では `GMO_ALLOW_SPOT_CANDLES=true` のときだけ。
   - API の仕様は公式資料と未照合 (要確認の項目は `gmo check` が表示する)。応答の形が想定と違えば例外 (fail-closed)。

14. **相場構造 (ダウ理論) フィルター** (`src/structure/`、`STRUCTURE_MODE=filter` が既定。`off` なら従来と同一):
   - 戦略の一覧を作る箇所で `withStructure` / `configuredStrategies` がラッパーを掛ける。エンジン・バックテスト・`createParamValidator` は同じ一覧を使い、エンジン本体は変更しない。
   - 確定足だけ (各時間足で直近 300 本)。スイング点は左は厳密・右は `>=` (横ばい対応) で、N 本後に確定する (リペイントしない)。上位足も確定足だけ (MTF: 1m→15m、5m/15m→1h、1h→4h、4h→1d、1d→1w。1w は直近 300 本の 1d から作り、形成中の週は除く)。
   - 弾いたシグナルは観測専用の仮想トレード `strategy_filter:structure_*` (bias / mtf / chop / none / weak / po / stop) だけで、学習には使わない。
   - 構造の損切り (`STRUCTURE_STOP_MODE=structure`) は損切りを押し安値/戻り高値 ± ATR × バッファへ動かすだけ。サイズは RiskManager が決め、期待値は増やさない。新しい損切り幅が元の 0.5 倍未満・3 倍超・0.5 ATR 未満、または利確が不正なら見送る。
   - 既定の対象: scalp_momentum_burst, scalp_micro, short_ema_trend, short_breakout, mid_trend_follow, long_momentum, meme_momentum (対象外: scalp_obi, scalp_vwap_revert, short_rsi_revert, scalp_rebound, scalp_pullback)。未知の id と、purist での `STRUCTURE_EXIT_ON_WEAKENING` は起動時に警告する。
   - 設定: `STRUCTURE_MODE` / `_STRATEGIES` / `_PIVOT_N` (3〜20、既定 6) / `_BREAK_MODE` / `_BIAS_METHOD` / `_REVERSAL_MODE` / `_USE_MTF` / `_USE_PERFECT_ORDER` / `_STOP_MODE` / `_STOP_ATR_BUFFER` / `_EXIT_ON_REVERSAL` / `_EXIT_ON_WEAKENING` / `_CHOP_M` / `_CHOP_R` (`config.ts`、既定は README)。
15. **指値 (maker)** (`LIMIT_ENTRY` 既定 true、`src/engine/limitOrders.ts`、`orders.ts`):
   - 新規は買いが最良の買い気配、売りが最良の売り気配への指値。優先順位は シグナル自身の指値価格 > 戦略の `entryOrder` > 設定。`scalp_micro` は成行。post-only は `capabilities.postOnly` のある取引先だけ (PaperBroker は可、GMO は不可。GMO の SOK は現物のみ (要確認) なので、レバレッジの指値は通常の LIMIT)。
   - RiskManager は発注前に、指値価格でサイズを決めて評価する。待機中は kv `orders:pending:<mode>` に保存し、その銘柄の新規を止める。期限・反対シグナル・損切り価格の通過・新規を止める条件 (停止・日次停止・kill switch・状態不明の注文・口座取得不可・気配の古さ) で取り消す。
   - 取消 → 照会で確認する。取消が確定し注文の消滅を確認するまで追跡から外さない (確認できなければ escalate し、新規を止める。取引所側に余分な建玉があれば異常 / kill switch)。一部約定はその数量の建玉にする。最小数量未満の端数は追跡外で、監査ログ `limit.dust_entry`。期限切れは仮想トレード `limit_unfilled` (重み 0.25)。protectiveStop は従来どおり渡す (OANDA の stopLossOnFill)。
   - 待機の利確 (`LIMIT_TAKE_PROFIT`、既定 false、paper のみ。live では無視して起動時に警告): reduceOnly の指値を利確価格に置く。成行で決済する前に、必ず取り消して確認する。
   - PaperBroker は気配が価格を通過したときだけ約定 (触れただけでは約定しない)、maker 手数料。バックテスト (`limitOrders`) は次の足から高値・安値が通過したときだけ約定し、maker 手数料、同じ足では損切り優先。検証・CLI のバックテストも現在の mode と同じ前提にする。約定率は kv `orders:limitStats:<mode>`。
16. **テンポと最大保有** (`src/engine/tempo.ts`、`TARGET_ENTRIES_PER_HOUR` 既定 0 = 無効、`MAX_HOLD_MINUTES` 既定 0 = 無効):
   - tempo (0〜1) = 不足 (1 − 直近 1 時間のエントリー / 目標) × 待ち (最後のエントリーから 60/目標 分まで 0、その 2 倍で 1)。ティックごとに 1 回計算し、新規エントリーの戦略評価 (`StrategyContext.tempo` / `tempoExplore`) と `RiskManager.evaluateEntry` (`EntryParams`) にだけ渡す。決済・バックテスト・パラメータ検証には渡さない。無効なら何も渡さず従来と同一。
   - 緩めるのは戦略の costMult (1.5 へ)、scalp_pullback の閾値、MIN_EDGE_TO_COST (`TEMPO_MIN_EDGE_TO_COST` へ。1 未満にしない) だけ。edgeIsNet のシグナルはコストを二重計上しない。クールダウン・損切り幅の制限・最大保有・RiskManager のそのほかの判定は緩めない。
   - 探索は paper では常に、live では `TEMPO_ALLOW_LIVE_EXPLORE=true` のときだけ。純期待値の下限を tempo × 往復コストだけ下げ (`tempoNetEdgeFloor`。RiskManager も同じ)、純期待値 ≤ 0 のエントリーはサイズ × `TEMPO_EXPLORE_SIZE` (既定 0.5) で `features.tempoExplore=1`。NaN は常に拒否。
   - 上限: 直近 1 時間のエントリーが ceil(目標 × `TEMPO_CAP_MULTIPLIER` (既定 2)) に達したら新規を止め、仮想トレード `tempo_cap`。エントリーは約定して建玉になった時に 1 回数え、再起動時はこの mode の直近 1 時間の取引と建玉から復元する。
   - `MAX_HOLD_MINUTES` (0 = 無効、5〜1440): mid / long は新規を発注せず仮想トレード `hold_limit` (observe_only と同じ扱い、重み 0.25、腕の停止には使わない)。ほかの戦略は maxHold (と expectedMs) を丸める。保有中の建玉は変えない。バックテスト・検証も同じ `maxHoldMinutes` (mid / long は丸めない)。
   - `THESIS_EXIT` が有効 (既定) なら `MAX_HOLD_MINUTES` は読みの期限の上限で、読みが当たっている建玉は 期限 × `THESIS_EXTEND_MULT` まで持ちうる (17)。
17. **読みの管理** (`THESIS_EXIT` 既定 true、`src/engine/thesis.ts` が純粋な判定。false なら従来の時間切れ `time` と同一):
   - 期限 = entryTs + expectedMs (`Signal.expectedMs`、無ければ丸めた maxHoldMs)。plan に maxHoldMs / expectedMs が無い建玉・当初リスク |建値 − 当初ストップ| ≤ 0 は従来どおり。
   - 純 R = (方向 × (決済できる価格 (買い bid / 売り ask) − 建値) − 実際のエントリー手数料/単位 − taker 率 × 決済できる価格) / 当初リスク。建玉の純 R には GMO の持ち越し手数料と paper の空売りの借入コストを含めない (仮想トレードの純 R は含む)。そのため日本時間 6:00 をまたいだ GMO の建玉の「建値」決済はわずかな損失になりうる。
   - 途中で読み外れ `thesis_failed`: 期限の半分以降で 値動きだけの R (grossR = 方向 × (仲値 − 建値) / 当初リスク。バックテストは終値) ≤ −`THESIS_EARLY_CUT_R` (0〜1、既定 0.5。0 で無効)。コスト (手数料・スプレッド) だけでは切らない。期限 `thesis_timeout`: 純 R < `THESIS_MIN_R` (0〜2、既定 0.1)。それ以外は延長。期限 × `THESIS_EXTEND_MULT` (1〜20、既定 4) → `thesis_cap` (延長前に上限に届いた建玉も、利益が出ていれば延長を記録してから決済 = 答え合わせは延長)。
   - 決めた読みの決済は決済計画の `thesis.exit` に保存し、約定するまで同じ理由で再試行する (従来の時間切れと同じく損切り・利確・トレーリングが先、再試行の待ちも同じ)。その間・一部約定の残り (`retryExit`) の間は延長しない。
   - 延長: 決済計画 (kv `positions:exitPlans:<mode>`) の `thesis` (extendedAt・peak・stop) に保存 (再起動後も継続)、監査ログ `thesis.extended`。保護ストップ = 今のストップと max(建値 (往復手数料込み), 延長後の極値 − `THESIS_TRAIL_R` (0.1〜3、既定 0.5) × 当初リスク) のきつい方 (売りは逆)。極値は延長した時点の決済できる価格から始め、延長より前の高値・安値は使わない。延長した判定ではストップを判定しない (延長そのもので決済しない)。保存したストップ (`thesis.stop`) とのきつい方を使い、設定・手数料が変わっても緩めない。`THESIS_EXIT=false` で再起動しても保存したストップで守る。この決済は `trailing` で、決済の注文 (`PendingExit.thesisStop`) に印を付けて約定したときだけ `thesisStopExit: true` (ParamTuner の trail_loosen・exit_sooner の根拠から除く: `isStrategyTrailingExit`)。利確・損切り・シグナルは従来どおり。
   - 判定は PositionManager の毎ティック (時間切れと同じ位置)。決済は通常の成行 (利確の指値の取消確認・reduceOnly・状態不明の扱いはそのまま)。live で読みの管理が有効なまま決済計画つきの建玉を引き継いだら、起動時に警告して監査ログ `thesis.enabled_live` (設定と建玉)。
   - バックテストは足の終値で判定 (期限は終値 ∓ 半スプレッドの純 R、途中は終値の grossR) して次の足の始値で決済、延長後のストップは次の足から、極値は延長した足以降の高値・安値 (∓ 半スプレッド) を前の足まで (先読みなし)。`thesis` を backtest・`createParamValidator`・setup・backtest コマンドへ渡す。
   - 仮想トレードも同じ規則。`thesisExpectedMs` は読みの管理が有効なときだけ記録 (無い古い記録は従来どおり)。極値と延長後の保護ストップの判定は、延長した時刻以降に始まった 1m 足と気配だけ (当初の損切りは従来どおりの範囲)。
   - TradeRecord / ShadowTradeRecord に `thesisExpectedMs` / `thesisDeadlineTs` / `thesisExtendedAt` / `thesisOutcome` (failed_early / timeout / extended / none) / `thesisNetRAtDeadline` / `thesisStopExit` (TradeRecord のみ) (任意。古い記録も読める)。要因分析・ParamTuner は 3 つの理由を time と同じ扱い (`isTimeLikeExit`)。
   - 表示: report / simulate の「読みの答え合わせ」(テンポの表と同じく「うち空売り (paper 再現)」の件数・純損益を注記)、ダッシュボードの保有ポジション (読みの期限・残り分・状態・現在の R)、status の設定と各建玉の期限。ラベルは 読み外れ(途中) / 読み外れ(期限) / 延長の上限。

## 4. 構成
- `src/core/`: 型の契約 (`types.ts`)、設定、decimal、HTTP リトライ、Claude 呼び出し (`ai.ts`。構造化出力、拒否時はサーバー側フォールバック、キー未設定時はルールベース)
- `src/indicators/`, `src/regime/`: 指標・リサンプル・相場環境の判定
- `src/strategies/`: 12 戦略 (scalp 6 / short 3 / mid / long / meme)。scalp_rebound は 15m の下降トレンド中の 1m の反発を買う (買いのみ・crypto。既定で観測専用)。scalp_pullback は 15m EMA20 の傾きで方向を決め、上昇中の 1m の押しを買い・下降中の戻りを売る (crypto。売りは canShort。損切り = 押しの極値 ± stopAtr (0.3) ATR を 0.8〜3.5 ATR に収める (超えたら見送り)、利確 = tpR (2) × 損切り幅、保有 10〜30 分、純期待値 (edgeIsNet)、コスト条件と 5 本のクールダウンあり。構造ラッパーなし・観測専用でない)。パラメータの標準名は stopAtr, tpAtr, trailAtr, entryThreshold, maxHoldBars
- `src/structure/`: 相場構造 (pivots・machine・perfectOrder・mtf・wrap・settings)。`src/engine/structureCompare.ts` は `--structure-compare`
- `src/engine/tempo.ts`: テンポ・上限・探索。`thesis.ts`: 読みの管理の純粋な判定 (期限・純 R・延長後の保護ストップ・決済理由)。`limitOrders.ts`: 指値エントリー / 待機の利確の管理。`orders.ts`: 保留中・状態不明の注文の管理 (指値の取消確認・約定率の統計を含む)
- `src/backtest/`: イベント駆動バックテスト、`evaluateParams`、`walkForward`、合成データ
- `src/market/`: feed (ccxt / GMOコイン / OANDA / Alpaca / DexScreener / synthetic) と MarketHub。GMO は `src/market/gmo/` (client・klines・check) と `feeds/gmo.ts`
- `src/execution/`: PaperBroker、実口座アダプター (ccxt / GMO `gmoBroker.ts` / OANDA / Alpaca)、router
- `src/risk/`: RiskManager (実効の上限 = .env + ダッシュボードの上書き。`settings.ts`)
- `src/intel/`: 情報源 → 分析 (Claude) → 資産別バイアス → 戦略計画
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
