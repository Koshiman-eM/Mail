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
- `npm run report`

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
  - SourceReliabilityTracker (情報源の信頼度。kv `intel:sourceReliability` 経由で intel が読む)
  - ParamTuner
  - reflect (定期的な振り返り)
- `src/storage/`: Store (node:sqlite / memory)
- `src/engine/`, `src/cli.ts`, `src/dashboard/`: 統合・CLI・閲覧専用のダッシュボード

## 5. 既定モデル
Claude API は `claude-opus-5-5` (`ANTHROPIC_MODEL` で変更可)。
