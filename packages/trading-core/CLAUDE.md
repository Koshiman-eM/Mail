# @trading/core

資産クラスに依存しない共通コア。`trader/` (暗号資産) と、将来の `fx-trader/`・`stock-trader/` から `file:` 依存で利用される。ソースのみ (ビルドなし、`exports` は `./src/*.ts`)。

## 安全不変条件
- ライブ二重ロック (`TRADING_MODE=live` + `LIVE_TRADING_CONFIRM`) はコアにのみ存在する。アプリ側で再定義しない。
- 新規エントリーは必ず `RiskManager.evaluateEntry` を通す。
- 未知の venue / symbol / レートは fail closed (拒否) にする。
- テストは完全オフライン (外部 API・実取引所に接続しない)。
- 会計・金額計算は decimal (`decimal.js`) を使う。
- kv キー、class 文字列、strategy id は変更しない (学習データ保全)。
- コアにアプリ固有の分岐を入れない。必要ならフック (注入点) を追加する。
- コアと全アプリのテストを常に green に保つ。

## コマンド
- `npm test` / `npm run typecheck`
