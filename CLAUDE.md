# Claude Code Project Guidelines: 海外通販せどり支援ツール開発

本ファイル (`CLAUDE.md`) は、Claude Code が本プロジェクトのリポジトリ内でコード生成、テスト実行、およびファイル操作を行う際のシステム指示書およびプロジェクト仕様の単一情報源（SSOT）として機能する。

---

## 1. プロジェクト概要

Alibaba.com、1688.com、AliExpress等の海外ECプラットフォームから仕入れ候補を収集し、輸入諸経費込みの正確な利益計算、価格・在庫変動のアプリ内通知、および人間の承認を介したサプライヤー交渉チャットの自動返信を一元管理するWebアプリケーションを構築する。

### 技術スタック
- **Frontend**: Next.js (App Router), TypeScript, Tailwind CSS, shadcn/ui, TanStack Query
- **Backend/DB**: Node.js, PostgreSQL, Prisma
- **Queue/Realtime**: Redis, BullMQ, Server-Sent Events (SSE)
- **External/AI**: Playwright, Claude API (Anthropic)

---

## 2. 開発コマンド・運用ルール (Claude Code 実行用)

Claude Code で作業を行う際は、以下のコマンドおよび制約を厳守すること。

### 常用コマンド
- 依存関係インストール: `npm install`
- データベースマイグレーション: `npx prisma migrate dev`
- テスト実行: `npm test`
- ビルド確認: `npm run build`

### 開発時の安全ガードレール
1. **外部誤送信の絶対防止**: テストやローカル実行時は必ず `MockSupplierAdapter` を使用し、実在するAlibaba等のサプライヤーへ自動テストメッセージを外部送信しないこと。
2. **承認ガードレールの強制**: チャット送信処理では、DB上のステータスが `APPROVED` かつ `approvedAt` が非nullであることをトランザクション内で再検証し、不一致時は例外をスローする単体テストを実装・通過させること。
3. **計算精度の担保**: 金額や税額の計算では浮動小数点誤差を防ぐため、`decimal.js` または整数演算（最小通貨単位）を使用すること。
4. **シークレット分離**: APIキーやセッション情報はコードにハードコーディングせず、必ず環境変数 (`.env.local`) 経由で取得すること。

---

## 3. 実装すべき必須コア機能

### 3.1 越境せどり利益計算エンジン
- **多通貨・為替バッファ**: 外貨の最新レートに任意のバッファ率（例: 2〜3%）を上乗せして円換算。
- **MOQ・数量別単価**: 最小発注数量（MOQ）および段階的単価（Tiered Pricing）の保持・自動選択。
- **国際送料の重量比較**: 実重量と容積重量（$\frac{\text{縦} \times \text{横} \times \text{高さ}}{5000 \text{ or } 6000}$）の大きい方を適用。
- **諸経費合算**: 現地国内送料、代行手数料、品目別関税、輸入消費税、通関手数料、国内販売手数料・送料を一括計上。

### 3.2 スクレイピングとアプリ内通知
- **BullMQによるワーカー制御**: ジッター、同時実行数制限、指数バックオフによるリトライ。
- **異常検知**: CAPTCHAやセッション切れ時は自動突破せず、ジョブを一時停止して手動再認証通知を発行。
- **SSEリアルタイム通知**: 画面上部のベルアイコンへ未読バッジと重要度別フィルタを提供。

### 3.3 業者チャットの承認制自動返信（Human-in-the-Loop）
- **多言語リアルタイム翻訳**: 中国語・英語メッセージを日本語へ自動翻訳し並列表示。
- **AIドラフト生成**: 交渉ゴール（目標単価、MOQ、OEM等）をコンテキストに含め、Claude APIで返信案を生成。
- **承認ステートマシン**: `RECEIVED` -> `DRAFT_READY` -> `APPROVED` / `REJECTED` -> `SENDING` -> `SENT` の厳格な状態管理。

---

## 4. コアデータモデル (Prisma Schema 概要)

- `Supplier`: 業者情報、評価、ブラックリストフラグ
- `Product`: 商品基本情報、国内比較対象ID、寸法・重量
- `PriceSnapshot`: スクレイピング時系列履歴
- `ProfitSimulation`: 諸経費パラメータと利益・ROI計算結果
- `ChatMessage`: 原文、翻訳文、AI返信案、承認証跡
- `Notification`: アプリ内通知の配信状態
- `AuditLog`: 承認送信や設定変更の監査証跡

---

## 5. 実装メモ (コード上の対応箇所)

- Prisma CLI は `.env` のみを読む。`.env.local` を使う場合は `npm run db:migrate` (dotenv-cli 経由) を使用する。
- 利益計算: `src/lib/profit/engine.ts` / テスト `tests/profitEngine.test.ts`
- 承認ガード: `src/lib/chat/service.ts` の `sendApprovedMessage` / テスト `tests/chatApproval.test.ts`
- 送信アダプター選択: `src/lib/suppliers/index.ts` (production かつ `SUPPLIER_ADAPTER=alibaba` 以外は常に Mock)
- AI: Claude API (`@anthropic-ai/sdk`, 既定モデル `claude-opus-5-5`)。構造化出力で JSON を受け取り、拒否時はサーバー側フォールバックを有効化。キー未設定時はスタブ応答: `src/lib/ai/claude.ts`
- 認証: `src/lib/auth/*`, `src/middleware.ts`。API は `src/app/api/_lib/http.ts` の `handler()` で包むと DB 検証済みユーザーが渡される (ログイン不要な API のみ `publicHandler()`)。監査ログの actor はログインユーザー。
- スクレイピングのパーサー: `src/lib/scraper/parse.ts`。フィクスチャ (`tests/fixtures/`) は合成データ。
- 手動返信: `createManualOutbound` / `attachDraft(source: "MANUAL")` / `approveAndSend` (`src/lib/chat/service.ts`)。「承認して送信」も承認記録を残してから `sendApprovedMessage` を通す (ガードを迂回しない)。
- 利益の自動計算: 入力組み立てと通知判定は純粋関数 `src/lib/profit/auto.ts`、DB 処理・トリガーは `src/lib/profit/autoService.ts`。定期再計算は `src/workers/profitWorker.ts`。
- 追加モデル: `User`, `Session` (認証), `ProfitSettings` (自動計算の既定値), `NegotiationGoal` (交渉ゴール), `FxRate` (為替キャッシュ), `ScraperState` (プラットフォーム別停止状態)。`ChatStatus` には送信失敗用の `SEND_FAILED` を追加 (再送は再ドラフト・再承認必須)。

---

## 6. エージェント運用ルール

@.claude/agent-rules.md
