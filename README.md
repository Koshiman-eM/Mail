# 越境せどり支援ツール

Alibaba.com / 1688.com / AliExpress の仕入れ候補について、輸入諸経費込みの利益計算・価格/在庫の巡回監視・
サプライヤー交渉チャットの承認制自動返信を一元管理する Web アプリです。仕様の詳細は [CLAUDE.md](./CLAUDE.md) を参照。

## 構成

```
src/
  app/                    Next.js App Router (画面 + API Route Handlers)
    login/                ログイン / 初期管理者作成
    (app)/                ログイン後の画面 (ダッシュボード, products, calculator, chat, settings)
    api/                  auth, users, dashboard, profit, fx, products, suppliers, chat, notifications(+SSE), scraper
  middleware.ts           未ログイン時のリダイレクト / 401、別オリジンからの更新系リクエスト拒否
  components/             shadcn/ui 互換 UI, アプリシェル, チャート, 通知ベル (SSE + 重要度フィルタ)
  lib/
    profit/               利益計算エンジン (decimal.js)
    chat/                 承認ステートマシン + 送信ガードレール + AI ドラフト生成
    suppliers/            送信アダプター (MockSupplierAdapter / 実送信は未実装)
    auth/                 パスワードハッシュ (scrypt), セッション, ログイン試行制限
    scraper/              CAPTCHA 検知, プラットフォーム別ページ解析, 差分検知, BullMQ キュー設定
    notifications/        通知永続化 + Redis Pub/Sub → SSE
    ai/                   Claude API (翻訳・返信案, 構造化出力)。キー未設定時はスタブ
    fx/                   為替レート取得 (1時間キャッシュ)
  workers/                BullMQ スクレイピングワーカー (Playwright)
prisma/schema.prisma      データモデル
tests/                    vitest 単体テスト
```

## セットアップ

前提: Node.js 20+, PostgreSQL, Redis

```bash
npm install
cp .env.example .env.local        # DATABASE_URL / REDIS_URL などを設定
npm run db:migrate                # = prisma migrate dev (.env.local を読み込む)
npm run db:seed                   # デモ用の業者・商品・受信メッセージ
npm run dev                       # http://localhost:3000 → 初回は「初期管理者を作成」画面
npm run worker                    # 別ターミナルでスクレイピングワーカー
```

> `npx prisma migrate dev` を直接使う場合、Prisma CLI は `.env` しか読まないため `DATABASE_URL` を `.env` にも置くか、
> `npm run db:migrate` を使ってください。

| コマンド | 内容 |
|---|---|
| `npm test` | 単体テスト (利益計算・承認ガード・スクレイピング検知・プロンプト) |
| `npm run build` | 本番ビルド |
| `npm run typecheck` | 型チェック |

## ログイン・権限
- 初回アクセス時、ユーザーが1人もいなければ最初の管理者を作成する画面が表示されます。以降のユーザーは「設定 > ユーザー」から管理者が追加します。
- パスワードは scrypt でハッシュ化し、セッショントークンは DB にハッシュのみ保存 (Cookie は httpOnly / SameSite=Lax)。
- 全 API は DB でセッションを検証してから実行し、監査ログには操作したユーザー名が記録されます。
- 同一メールアドレス / IP で15分間に10回ログインに失敗するとロックします (プロセス内メモリ。複数台構成では Redis 等に置き換えてください)。
- 管理者のみ: ユーザー管理、巡回の再開。

## 主な機能

### 利益計算 (`/calculator`, `POST /api/profit/calculate`)
- 為替: 最新レート (`/api/fx`) × (1 + バッファ%)
- MOQ チェックと数量別段階単価の自動選択
- 国際送料: 実重量と容積重量 (縦×横×高さ / 5000 or 6000) の大きい方を刻み単位で切り上げ、最低料金・燃油サーチャージ対応
- 現地送料・代行手数料・関税・輸入消費税・通関手数料・販売手数料・国内送料を合算
- 関税/消費税は CIF 課税。既定で日本の税関端数処理 (課税標準1,000円未満・税額100円未満切捨て) を適用
- 利益・ROI・利益率・損益分岐販売単価を算出。登録商品に対してはシミュレーションとして保存可能

### スクレイピングと通知
- プラットフォーム別 BullMQ キュー。ジッター付き投入、同時実行数・レート制限、指数バックオフリトライ
- CAPTCHA / ログイン要求 / ブロックを検知すると**自動突破せず**そのプラットフォームのキューを一時停止し、
  CRITICAL 通知で手動再認証を促す (`/settings` から再開)
- 価格変動 (既定 3% 以上)・在庫切れ/復活・MOQ 変更を通知
- 通知は DB に保存し、Redis Pub/Sub 経由で SSE (`/api/notifications/stream`) に配信。ヘッダーのベルに未読バッジと重要度フィルタ
- ページ解析 (`src/lib/scraper/parse.ts`) はプラットフォーム別に埋め込みデータ (Alibaba.com: `window.detailData` の
  `productLadderPrices`、1688: `window.__INIT_DATA` の `skuRangePrices` と SKU 在庫、AliExpress: `window.runParams` の
  `skuPriceList`) をキー名で探索し、取れなければ JSON-LD 等にフォールバックします。
  **テストのフィクスチャは既知の構造を模した合成データで、実ページでは未検証です。** 「設定 > パーサー検証」に実ページの
  HTML を貼り付けると、外部アクセスなしで抽出結果を確認できます

### 業者チャット (`/chat`)
- 受信メッセージを取り込むと Claude で日本語訳を作成し、原文と並べて表示
- 交渉ゴール (目標単価・MOQ・OEM 等) を含めて AI 返信案を生成
- `RECEIVED → DRAFT_READY → APPROVED / REJECTED → SENDING → SENT` (失敗時 `SEND_FAILED` → 再ドラフト・再承認)
- 送信時はトランザクション内で `status = APPROVED` かつ `approvedAt != null` を再検証し、同条件付き CAS 更新で `SENDING` に遷移。
  不一致なら `ApprovalGuardError` (HTTP 409)。ブラックリスト業者への送信も拒否
- 全操作を `AuditLog` に記録

## 安全上の注意
- 送信アダプターは `NODE_ENV=production` **かつ** `SUPPLIER_ADAPTER=alibaba` の場合のみ実アダプターを返します。
  それ以外は常に `MockSupplierAdapter` で、外部送信は発生しません。実アダプター (`AlibabaSupplierAdapter`) は意図的に未実装です。
- 受信メッセージの取り込みは現状、画面からの手動貼り付け (`POST /api/chat/messages`) です。
- API キー・セッション情報 (`SCRAPER_STORAGE_STATE_PATH`) は `.env.local` で管理し、リポジトリにコミットしないでください。
