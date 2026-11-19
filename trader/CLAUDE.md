# Claude Code Project Guidelines: 自己学習型マルチアセット自動売買ツール (`trader/`)

このディレクトリは、リポジトリ直下のせどり支援ツールとは独立したパッケージ。ここで作業するときは本ファイルを優先する。

## 1. 概要
仮想通貨 (ミームコイン含む)・FX・株式を自律売買する。メインはスキャルピングと短期で、中期・長期にも対応する。
- インターネットから情報を収集して戦略を立てる (`src/intel/`)。
- 損益の要因を分析し、戦略配分・パラメータ・情報源の信頼度へフィードバックする (`src/learning/`)。

## 2. コマンド
- `npm install` / `npm test` / `npm run typecheck`
- `npm run simulate -- --days 1`: 合成データで高速にペーパー運転する (ネット不要)
- `npm run backtest -- --strategy all`
- `npm start`: 実時間で起動する。既定は paper
- `npm run report`: 成績と学習状態 (現在の mode のもの) を表示
- `npm run trader -- intel`: 情報収集を 1 回実行してブリーフを表示
- `npm run status`: 設定と現在の状態を表示
- `npm run trader -- resume`: キルスイッチ・日次停止を解除 (監査ログに記録。動作中のエンジンにも次のティックで反映)
- `npm run trader -- orders` (`orders list`): 保留中・状態不明の注文を一覧
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
7. **学習による変更は検証してから適用**: パラメータ調整はバックテストで現行より良い場合だけ適用し、悪化したら元に戻す。
   - LLM の提案も同じ検証経路を通す (`ParamTuner.propose`)。
   - 値動きの予想 (`forecast.ts`) によるエントリーサイズの倍率はパラメータの変更ではない。(予想時間, 資産クラス) ごとに、統計的な有意性 (重複する予想の補正後に片側 95%、判定済み 100 件以上) を満たしたときだけ 0.7〜1.2 倍で効き、結果は RiskManager の上限 (`MAX_SIZE_MULTIPLIER` = 1.5) の範囲内に収まる。満たさない間は常に 1.0。リスク判定は迂回しない。
8. **学習状態は mode 別キー**: 腕・パラメータ・調整履歴・情報源の信頼度・ニュースの答え合わせ・予想・仮想トレードの kv は `<名前空間>:<mode>:...` (信頼度は `intel:sourceReliability:<mode>`)。paper の学習を live に持ち込まない。旧キー (mode なし) は paper にだけ初回起動時に引き継ぐ (`migration.ts`)。live は初期状態から始める。
9. **仮想トレードの重みと停止中の扱い**: 見送ったシグナルの結果は腕の更新に重み 0.25、ニュースの答え合わせは情報源の信頼度に重み 0.3。停止中 (`HALT_SHADOW_REASONS`) に記録した仮想トレードは学習に使わない。

## 4. 構成
- `src/core/`: 型の契約 (`types.ts`)、設定、decimal、HTTP リトライ、Claude 呼び出し (`ai.ts`。構造化出力、拒否時はサーバー側フォールバック、キー未設定時はルールベース)
- `src/indicators/`, `src/regime/`: 指標・リサンプル・相場環境の判定
- `src/strategies/`: 9 戦略 (scalp 3 / short 3 / mid / long / meme)。パラメータの標準名は stopAtr, tpAtr, trailAtr, entryThreshold, maxHoldBars
- `src/backtest/`: イベント駆動バックテスト、`evaluateParams`、`walkForward`、合成データ
- `src/market/`: feed (ccxt / OANDA / Alpaca / DexScreener / synthetic) と MarketHub
- `src/execution/`: PaperBroker、実口座アダプター、router
- `src/risk/`: RiskManager
- `src/intel/`: 情報源 → 分析 (Claude) → 資産別バイアス → 戦略計画
- `src/learning/`: 次の部品で構成する
  - TradeJournal
  - attributeTrade (損益の要因分析)
  - StrategyAllocator (戦略×レジーム×資産クラスのベイズ配分)
  - SourceReliabilityTracker (情報源の信頼度。kv `intel:sourceReliability:<mode>` 経由で intel が読む。ニュースの答え合わせもこの mode 別キーを更新する)
  - ParamTuner
  - reflect (定期的な振り返り)
  - `shadow.ts`: 見送ったシグナルを仮想トレードとして追跡し、決済結果を腕の更新 (重み 0.25) に渡す。未決済は kv `shadow:open:<mode>`
  - `newsCheck.ts`: ニュースの向きと 15m / 1h / 4h 後の値動きの答え合わせ。情報源の信頼度に重み 0.3 で反映。状態は kv `newsCheck:<mode>:*`
  - `forecast.ts`: 銘柄ごとの値動きの予想 (15m / 1h / 4h)・答え合わせ・オンライン学習。有意なときだけエントリーサイズの倍率を返す。kv `forecast:*:<mode>`
  - `migration.ts`: 学習状態の mode 分離の移行 (旧キー → `<mode>` 付きキー。paper はコピー、live は初期状態。フラグ kv `migration:learningModeSplit:<mode>`)
- `src/storage/`: Store (node:sqlite / memory)
- `src/engine/`, `src/cli.ts`, `src/dashboard/`: 統合・CLI・閲覧専用のダッシュボード

## 5. 既定モデル
Claude API は `claude-opus-5-5` (`ANTHROPIC_MODEL` で変更可)。
