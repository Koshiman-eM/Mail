# MessageHub

LINE と Gmail のメッセージを一つの受信トレイに集約し、本文から日時を自動検出して Google カレンダーに予定を登録するアプリケーションです。

## 仕組み

```
Gmail  ──(OAuth2 / Gmail API)──┐
                                ├─▶ 統合メッセージストア ─▶ 日時検出 ─▶ Google カレンダーに登録
LINE   ──(Webhook)─────────────┘        (SQLite)         (chrono-node)      (Calendar API)
```

- **server/** — Express + TypeScript の API サーバー。Gmail/LINE からメッセージを取り込み、
  [chrono-node](https://github.com/wanasit/chrono) で日時・場所を抽出し、検出した予定を
  Google カレンダーに自動登録します。永続化には Node.js 標準の `node:sqlite` を使用しており、
  追加のネイティブ依存やDBサーバーなしで動きます。
- **client/** — React + Vite のフロントエンド。「受信トレイ」「予定」「設定」の3タブ構成です。

### メッセージ処理パイプライン

1. Gmail は `POST /api/sync/gmail`（設定画面の「今すぐ同期」ボタン）で直近7日分を取得します。
   LINE は Webhook (`POST /webhook/line`) でリアルタイムに受信します。
2. 新規メッセージごとに本文（+ Gmail は件名）を日時抽出にかけます（`server/src/services/scheduleExtractor.ts`）。
   - 日本語・英語どちらの表現にも対応（例:「8月10日 14時」「August 12th at 3pm」）。
   - タイムゾーンは既定で JST(UTC+9) として解釈します。
   - 「場所：〜」等のラベルや「〜で開催」等のパターンから場所も抽出を試みます。
3. 日時が検出できたら `events` テーブルに `pending` として記録し、`AUTO_CREATE_EVENTS=true`
   （既定）なら即座に Google カレンダーへ登録します。失敗時は `failed` として記録し、
   「予定」タブから手動で再登録・却下できます。
4. LINE 経由で予定登録に成功した場合は、返信メッセージで登録結果を通知します。

## セットアップ

```bash
npm install          # ルートで一括インストール（server / client のワークスペース）
cp .env.example .env # 値は空のままでもアプリは起動します
```

### 開発サーバーの起動

```bash
npm run dev:server   # http://localhost:4000
npm run dev:client   # http://localhost:5173 (Vite; /api, /auth は自動的に4000へプロキシ)
```

`http://localhost:5173` を開き、「設定」タブの「デモデータを投入」を押すと、実際の
Gmail/LINE 連携なしでメッセージ統合〜予定検出の一連の動作を確認できます。

### テスト

```bash
npm test             # server: 日時抽出ロジックの単体テスト (vitest)
```

日時抽出ロジックはネットワークアクセスなしで決定論的にテストされています
（`server/test/scheduleExtractor.test.ts`）。

## 実際の連携を有効にする

### Gmail / Google カレンダー

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成し、
   **Gmail API** と **Google Calendar API** を有効化します。
2. 「APIとサービス > 認証情報」で OAuth クライアント ID（ウェブアプリケーション）を作成し、
   承認済みリダイレクト URI に `http://localhost:4000/auth/google/callback` を追加します。
3. 取得した値を `.env` の `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` に設定します。
4. サーバーを再起動し、「設定」タブの「Googleアカウントを連携」からOAuth同意画面を通します。
5. 連携後は「Gmailを今すぐ同期」で取り込み、または定期実行（cronなど）で
   `POST /api/sync/gmail` を呼び出してください。

### LINE

1. [LINE Developers Console](https://developers.line.biz/) で Messaging API チャネルを作成します。
2. チャネルシークレットとチャネルアクセストークンを `.env` の
   `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` に設定します。
3. Webhook URL に `https://<公開URL>/webhook/line` を設定します（ローカル開発では
   [ngrok](https://ngrok.com/) 等でトンネリングしてください）。
4. Webhookの利用をオンにし、応答メッセージ機能はオフにしておくことを推奨します
   （本アプリが予定登録の結果を自動返信するため）。

## API 概要

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/messages` | 統合済みメッセージ一覧 |
| GET | `/api/events` | 検出された予定一覧 |
| POST | `/api/events/:id/create` | 保留中/失敗した予定を手動でカレンダー登録 |
| POST | `/api/events/:id/dismiss` | 予定候補を却下 |
| GET | `/api/accounts` | 連携状態（Gmail/LINE） |
| POST | `/api/sync/gmail` | Gmailの手動同期 |
| POST | `/webhook/line` | LINEからのWebhook受信 |
| GET | `/auth/google`, `/auth/google/callback` | Google OAuth フロー |
| POST | `/api/dev/seed` | デモデータ投入（`ENABLE_DEV_SEED=false`で無効化可） |

## 既知の制約

- Google のアクセストークンは自動更新（refresh_token 利用）を想定した設計ですが、
  期限切れ時の明示的な再認証フローは実装していません。エラー時は「設定」画面から
  再連携してください。
- 日時抽出はヒューリスティックであり、曖昧な表現や複数日時が並記された文面では
  誤検出・見落としが起こり得ます。「予定」タブで確認・却下できる設計にしています。
- LINE のグループ/ルームメッセージも取り込み対象ですが、送信者の表示名解決はせず
  内部IDをそのまま表示します。
