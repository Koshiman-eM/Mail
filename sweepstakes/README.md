# 懸賞自動応募ツール (sweepstakes)

せどりツール本体 (リポジトリ直下) とは独立したパッケージです。

- **Webフォーム型懸賞**: プロフィールから自動入力し、ガードを通過したものだけ送信します (既定は dry-run)
- **X / Instagram / 仮想通貨クエスト**: 収集・採点・「今日やること」リスト化まで。フォロー・RT・いいね・コメント・ウォレット署名などの**自動操作は一切行いません**
- コア機能は `src/core/` の関数群 (`src/core/index.ts` から export)。CLI (`src/cli.ts`) と MCP サーバー (`src/mcp/server.ts`) はその薄いラッパーです

## セットアップ

Node.js 22.13 以上が必要です (`node:sqlite` を使うため。ネイティブモジュールは使いません。`npm run sweep` / `npm run mcp` が使う `--env-file-if-exists` は 22.9 以上)。Windows PC で常用する場合は「[Windows PC で運用する](#windows-pc-で運用する)」を参照してください。

```bash
cd sweepstakes
npm install
npx playwright install chromium      # Chromium をまだ入れていない場合のみ
cp profile.example.json profile.json # 自分の情報に書き換える
npm test                             # テスト (外部サイトには一切アクセスしません)
```

`data/` (DB・スクリーンショット・ログ・ロックファイル)、`profile.json`、`.env` は `.gitignore` 済みです。

`npm run sweep` / `npm run mcp` は `sweepstakes/.env` があれば読み込みます (Node の `--env-file-if-exists`。OS の環境変数に同じ名前があればそちらが優先)。ひな形は `.env.example`。`.env` が無いと Node が `.env not found. Continuing without it.` と表示しますが無害です。

### 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `SWEEP_DB` | `./data/sweep.db` | SQLite DB のパス |
| `SWEEP_PROFILE` | `./profile.json` | プロフィールのパス |
| `SWEEP_SCREENSHOT_DIR` | `./data/screenshots` | スクリーンショット保存先 |
| `SWEEP_MIN_INTERVAL_SEC` / `SWEEP_MAX_INTERVAL_SEC` | `60` / `180` | 送信間隔 (この範囲でランダム) |
| `SWEEP_DAILY_LIMIT` | `30` | 1 日 (`SWEEP_TIMEZONE` の 0 時起点) の送信上限 |
| `SWEEP_TIMEZONE` | `Asia/Tokyo` | 日次上限の「1 日」の境界のタイムゾーン。OS のタイムゾーンや `TZ` (Windows では効かない場合がある) に依存しません。締切 (`YYYY-MM-DD` → その日の 23:59:59) は OS のローカル時刻で判定します |
| `SWEEP_LOCK_PATH` | DB と同じフォルダの `browser.lock` | ブラウザ操作・収集のプロセス間ロックファイル (下記) |
| `SWEEP_HEADLESS` | `1` | `0` でブラウザを表示 |
| `SWEEP_CHROMIUM_PATH` | なし | 使用する Chromium の実行ファイルを明示 |
| `SWEEP_NAV_TIMEOUT_MS` | `30000` | ページ操作のタイムアウト |
| `SWEEP_USDJPY` | なし | 仮想通貨クエストの USD / USDT / USDC 報酬を円換算するレート (例: `150`)。未設定なら換算せず「価値不明」 |
| `SWEEP_MCP_TOKEN` | なし (必須) | MCP サーバーの認証トークン。32 文字以上 (`openssl rand -hex 32`)。未設定・短すぎる場合は起動しません |
| `SWEEP_MCP_HOST` / `SWEEP_MCP_PORT` | `127.0.0.1` / `8787` | MCP サーバーの待ち受け |
| `SWEEP_MCP_TRUST_PROXY` | `1` | ループバックからの接続 (Caddy 経由) に限り `X-Forwarded-For` の右端を接続元 IP とみなす (認証失敗のレート制限用)。`0` で無効 |

## profile.json

```json
{
  "lastName": "山田", "firstName": "太郎",
  "lastNameKana": "ヤマダ", "firstNameKana": "タロウ",
  "email": "taro.yamada@example.com", "phone": "090-1234-5678",
  "zip": "100-0001", "prefecture": "東京都", "city": "千代田区",
  "address1": "千代田1-1", "address2": "サンプルマンション101",
  "birthday": "1990-04-01", "gender": "male"
}
```

- カナはカタカナで記入 (フォームが「ふりがな」「ひらがな」の場合は自動でひらがなに変換)
- `gender` は `male` / `female` / `other` (`男性` / `女性` も可)
- `address2` (建物名) のみ省略可
- 郵便番号・電話番号のハイフン有無や分割欄 (zip1/zip2, tel1〜3)、生年月日の年/月/日分割はフォームに合わせて自動整形します

## CLI の使い方

```bash
npm run sweep -- <コマンド>      # または ./bin/sweep.mjs <コマンド>
```

| コマンド | 説明 |
| --- | --- |
| `collect --source koubo [--categories all,food,...] [--max-details n]` | 実在サイト (公募ガイド) から収集し、詐欺チェック・採点して保存 (URL で重複排除) |
| `collect --html <file> [--html <file>...]` | ローカル HTML (例示用フォーマット) から収集 |
| `list [--kind web_form\|x\|instagram\|crypto_quest]` | 一覧 (スコア順) |
| `enter <id>` | Webフォームに入力し、**送信直前で停止**してスクリーンショットを保存 (dry-run) |
| `enter <id> --submit` | 実際に送信 |
| `run [--submit]` | 応募可能な Webフォーム懸賞を一括処理 (未処理のもののみ・ガード適用・日次上限で停止) |
| `todo` | X / Instagram / 仮想通貨クエストの「今日やること」(締切が近い順 → 同じ日ならスコア順) |
| `mark <id> [--note <メモ>]` | 手動タスクを完了として記録 (todo から消える) |
| `history [--limit n]` | 応募履歴 |
| `quest add <url> [オプション] [--fetch]` | 仮想通貨クエストを手動登録 (詐欺チェック・採点) |
| `quest update <id> [オプション] [--clear 項目,...]` | 登録済みクエストを更新して再採点 |
| `quest list` | クエスト一覧 (時給の高い順、価値不明は末尾、除外は最後) |

推奨の流れ:

```bash
npm run sweep -- collect --html ./某まとめ.html
npm run sweep -- run            # まず dry-run でスクリーンショットを確認
npm run sweep -- run --submit   # 問題なければ送信
npm run sweep -- todo           # SNS / クエストは手で実施して mark
```

### 収集 (Collector)

`src/core/collector.ts` の `Collector` インターフェース (`fetch(): Promise<CampaignInput[]>`) を実装して追加します。
例示用に、合成フォーマットの HTML を読む `FixtureHtmlCollector` / `parseCampaignListHtml` があります (フォーマットは `tests/fixtures/campaign_list.html` を参照)。

#### 収集元: 公募ガイド (`--source koubo`, `src/collectors/koubo.ts`)

- 一覧は robots.txt で許可されているカテゴリページ `https://koubo.jp/category/present/all` → 各サブカテゴリ (`baby` `entertainment` `fashion` `food` `gift-certificate` `life` `luxury` `pet` `prize`) の順に取得し、各項目の詳細 `https://koubo.jp/contest/{id}` を取得します
  - `--categories all,food` のように絞れます (既定は all と全サブカテゴリ)。カテゴリページにはページ送りがないので各 1 ページです
  - 詳細は id で重複排除し、`--max-details` 件 (既定 60) まで。上限に達したら残りのカテゴリページも取得しません
  - robots.txt で Disallow されているクエリ付き一覧 (`/contest/list?...`) は使いません
  - 一覧の締切は「11/30 締切」のように年がないため、現在の年 (180 日以上前になる場合は翌年) とみなします。正確な締切は詳細ページの値を使います
- 詳細ページから 締切・主催者・賞・応募資格・主催者サイト URL・募集内容 を読み、次のように変換します
  - `url` は主催者サイト (応募先)。取れなかった場合は掲載ページを `url` にし、リスクフラグ `entry_url_unverified` (要確認) を付けます。このフラグがあるものは `enter` / `run` で自動応募しません
  - 掲載ページの URL は `conditions.sourceUrl`、タグ (「クイズ」「食品」「WEB応募可」など) は `conditions.tags`、募集内容など詳細の全項目は `conditions.terms` (規約の自動応募禁止ガードの対象) に入ります
  - 種別: 一覧に応募方法 (「WEB応募可」) が出ていない項目が多いため、主に詳細ページの「応募方法/応募先」で判定します。応募先が x.com / instagram.com、または応募方法に X / Instagram と明記 → `x` / `instagram`。Web フォーム・「WEB応募可」→ `web_form`。はがき・郵送・レシートのみ → 収集しません。判定不能は `web_form` (送信前ガードに任せます。クイズ型は不明な必須欄で `needs_manual` になる想定)
  - 締切切れは詳細を取得せずに除外します
- Next.js のストリーミング SSR で後から差し込まれる部分 (`<template id="P:x">` ← `<div hidden id="S:x">`) は解決してからパースします

#### 取得の礼儀 (`src/collectors/http.ts` の `PoliteFetcher`、実在サイト用 Collector 共通)

- User-Agent は正直な識別子 `sweepstakes-collector/0.1 (+personal use)`。ブラウザ偽装はしません
- 実行時に `robots.txt` を取得し、対象パスが Disallow なら取得せず中止します (RFC 9309 準拠の簡易実装。同じ User-agent のグループは統合し、最長一致・`*`・`$` に対応。robots.txt が 404 なら制限なし、5xx なら全拒否)
- リクエスト間隔は 3〜6 秒のランダム
- 403 / 429 を受けたらその回の収集を中止してエラーにします (回避・リトライはしません)
- 1 回の収集で取得する詳細ページは最大 60 件 (`--max-details`)
- テストは fetch を差し替えたモックとフィクスチャ (`tests/fixtures/koubo/`、実ページから構造確認用に抜粋) を使い、実サイトにはアクセスしません

**注意**: koubo.jp の robots.txt は `User-Agent: *` に対して `Disallow: /contest/list?*` を指定しています (ファイル後半の 2 つ目の `User-Agent: *` グループ)。そのため一覧にはカテゴリページを使います。カテゴリページの構造が変わったらパーサー (`parseKouboList`) とフィクスチャ (`tests/fixtures/koubo/present_all.html`) を更新してください。

## 仮想通貨クエストの手動登録 (`quest`)

Galxe / Zealy などには誰でも使えるクエスト一覧 API がなく、非公開 API の利用は規約上避けるため、**クエストは自動収集しません**。
URL と分かっている情報を登録すると、ツールが詐欺チェック・期待値の採点・締切管理・「今日やること」化を行います (kind=`crypto_quest`, source=`manual`)。
コア関数は `addQuest(ctx, input, { fetch })` / `updateQuest(ctx, id, patch)` / `listQuests(ctx)` (`src/core/service.ts`) で、将来 MCP からも同じ関数を呼ぶ想定です。

**ウォレット署名・トランザクション・SNS 操作の自動化は一切実装していません。** クエストの実施は必ず自分の手で行ってください。

```bash
export SWEEP_USDJPY=150
npm run sweep -- quest add https://app.galxe.com/quest/xxxx/GCxxxx \
  --title "Example Quest" --reward-type stablecoin --amount 100 --currency USDC \
  --winners 50 --participants 5000 --distribution raffle --minutes 10 \
  --deadline 2026-12-01 --onchain --gas-jpy 30
npm run sweep -- quest update 12 --participants 8000 --clear gas-jpy
npm run sweep -- quest list
npm run sweep -- todo           # 手順と安全注意を確認して手で実施
npm run sweep -- mark 12        # 終わったら完了記録
```

| オプション | 内容 |
| --- | --- |
| `--title` | タイトル (`--fetch` 時は未指定ならページの og:title / `<title>` で補完。それもなければ URL) |
| `--reward-type` | `token` / `stablecoin` / `nft` / `points` / `whitelist` / `other` (既定 `other`) |
| `--amount` / `--currency` | 報酬額と通貨 (`USD` `USDT` `USDC` `JPY` またはトークン記号) |
| `--value-jpy` | 円換算額を直接指定 (換算より優先。points / NFT などの価値が分かる場合にも使う) |
| `--winners` / `--participants` | 当選数 (先着枠) / 参加者数 |
| `--distribution` | `raffle` (抽選・既定) / `fcfs` (先着) / `all` (全員) / `leaderboard` (順位制) |
| `--minutes` | 所要時間 (分。既定 15) |
| `--deadline` | 締切 (`YYYY-MM-DD` または ISO 8601) |
| `--onchain` / `--no-onchain` | オンチェーン操作 (トランザクション) が必要か |
| `--gas-jpy` | ガス代の見込み (円) |
| `--notes` | メモ (詐欺チェックの対象にもなります) |
| `--fetch` | (add のみ) URL を 1 回だけ取得 (後述) |
| `--clear` | (update のみ) 値を消す: `amount,currency,value-jpy,winners,participants,minutes,deadline,gas-jpy,notes` |

### 円換算

- 直接指定 (`--value-jpy`) > `JPY` > `USD` / `USDT` / `USDC` × `SWEEP_USDJPY` の順
- `SWEEP_USDJPY` が未設定なら換算できないため価値不明 (警告を表示)。update 時に未設定なら登録時のレートを使います
- その他のトークンは自動換算しません (価格 API を使わないため)。`--value-jpy` がなければ価値不明
- `points` / `nft` / `whitelist` は価値不明扱い (0 円ではなく null。表示は「価値不明」)

### 採点

- 期待値 (円): `raffle` = 価値 × 当選数 / max(参加者数, 1) (参加者数不明は 1000 人と仮定) / `fcfs` = 参加者数 < 枠なら価値そのもの、枠以上なら価値 × 0.01 (ほぼ 0) / `all` = 価値そのもの / `leaderboard` = 不明
- 正味 = 期待値 − ガス代、時給換算 (円/時) = 正味 ÷ 所要分数 × 60 (赤字はマイナスのまま表示)
- `score` (円/分) = 正味 ÷ 所要分数 × リスク減点係数。価値不明は 0。既存の `list` / `todo` の並び順にそのまま統合されます

### `--fetch`

- 既存の `PoliteFetcher` で robots.txt を確認してからページを 1 回だけ取得し、og:title / `<title>` / og:description / 本文テキスト (script・style は除く) を読みます
- 本文テキストは詐欺チェックにかけ、`conditions.terms` に保存します (update 時の再チェックにも使用)
- robots.txt で不許可・403・429・その他の取得失敗は取得を中止し、**登録は取得なしで続行**して警告を表示します
- Galxe などは JavaScript で描画されるため、取得しても情報はほとんど得られないことがあります

### 安全注意

- **懸賞専用のウォレットを使う** (資産の入ったメインウォレットは接続しない)
- **シードフレーズ / 秘密鍵は絶対に入力しない** (公式が求めることはありません)
- **approve / setApprovalForAll / 無制限承認の署名は拒否する**
- `todo` の仮想通貨クエストの手順には上記の注意が必ず先頭に付き、`--onchain` の場合はガス代も表示されます
- 致命的な詐欺フラグ (偽ドメイン・シードフレーズ要求・無制限承認) が付いたクエストも記録はしますが、状態は「除外」になり `todo` に出ません。理由は `quest add` / `quest list` に表示されます

## 送信前ガード (`src/core/guards.ts`)

ガードはすべて純粋関数で、以下のどれかに該当すると送信しません。

| ガード | 結果 | 内容 |
| --- | --- | --- |
| CAPTCHA 検出 | `needs_manual` | reCAPTCHA / hCaptcha / Cloudflare Turnstile / Cloudflare チャレンジの iframe・script・要素・応答欄を検出したら停止 (確認画面に出た場合も同様)。**CAPTCHA の突破・回避は実装していませんし、今後も実装しません** |
| 規約の自動応募禁止 | `skipped` | ページ本文と収集時の規約テキストに「自動応募ツール・bot・プログラム・スクリプト等の使用禁止/無効」の記述があれば見送り |
| 重複応募 | `skipped` | 送信済み / 手動完了の記録があるキャンペーンには送らない |
| レート制限 | 待機 / `deferred` | 前回送信から 60〜180 秒 (ランダム) 空ける。1 日 30 件を超えたら停止 |
| 不明な必須欄 | `needs_manual` | 必須欄のうち 1 つでも信頼度高く埋められない (応募理由の自由記述、未知の select、プロフィールにない項目など) と送信しない |

その他の安全策:

- 欄の推定は label / name / id / placeholder / autocomplete / 直前テキスト / 表の見出しを総合し、根拠が矛盾する欄は信頼度を下げます
- CSS で非表示の欄 (ハニーポット) には触れません。メルマガ購読チェックは付けません (同意チェックのみ ON)
- 完了表示が確認できなかった場合も、重複送信を避けるため「送信済み」として記録します
- dry-run では DB に何も記録しません

## 採点と詐欺チェック (`src/core/score.ts`)

- スコア (円/分) ≒ `賞品価値 × 当選数 / max(応募者数, 1) ÷ 所要分数`
  - 応募者数不明は 1000 人、所要分数不明は種別ごとの既定値 (web_form 3 分、X 1 分、Instagram 2 分、クエスト 15 分) で計算
  - 締切切れは `expired`、致命的リスクは `excluded`、その他のリスクフラグは係数で減点
- 仮想通貨クエストの詐欺チェック `checkCryptoScam()`
  - **致命的 (除外)**: 公式ドメインに似た偽ドメイン (TLD 違い・綴り違い・紛らわしい文字・公式名を含む別ドメイン・IDN)、シードフレーズ / 秘密鍵 / recovery phrase の入力要求、無制限承認
  - **減点**: `approve` / `setApprovalForAll` / permit 等の承認要求、既知のクエストプラットフォーム以外のドメイン (`unknown_platform`)
  - 既知の公式ドメイン一覧は `KNOWN_OFFICIAL_DOMAINS`、正規のクエストプラットフォーム一覧は `QUEST_PLATFORM_DOMAINS` (galxe.com / zealy.io / layer3.xyz / taskon.xyz / intract.io / questn.com / quest3.xyz とそのサブドメイン)。必要に応じて追加してください

## Oracle Cloud (Arm / aarch64 Linux) での導入メモ

Ampere A1 (aarch64) の Ubuntu 22.04 / 24.04 を想定しています。

```bash
# Node.js 22 (nvm か NodeSource の arm64 版)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

cd sweepstakes
npm install
# Playwright の Chromium (linux-arm64 ビルドあり) と依存ライブラリを入れる
npx playwright install --with-deps chromium
```

- `--with-deps` が使えない環境では、Chromium の依存ライブラリを手動で入れます (Ubuntu 24.04 の例):
  ```bash
  sudo apt-get install -y libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0t64 fonts-noto-cjk
  ```
  (22.04 では `t64` の付かないパッケージ名です。日本語ページのスクリーンショットが文字化けする場合は `fonts-noto-cjk` を入れてください)
- Oracle Linux の場合は `npx playwright install-deps` が非対応なので、`dnf install -y nss atk at-spi2-atk cups-libs libdrm libxkbcommon libXcomposite libXdamage libXrandr mesa-libgbm pango alsa-lib google-noto-sans-cjk-ttc-fonts` などで個別に入れてください
- Playwright が配布する Chromium が動かない場合は、ディストリビューションの Chromium を入れて `SWEEP_CHROMIUM_PATH=/usr/bin/chromium` のように指定できます
- `package.json` の `playwright` は事前インストール済みブラウザ (開発環境) に合わせて `1.63.0` に固定しています。上げる場合は `npx playwright install chromium` もやり直してください
- 定期実行は `deploy/sweep-run.timer` (後述「サーバー導入 (Oracle Cloud)」) を使えます。日次上限とランダム間隔は DB で管理されます
- メモリ 1GB 程度のインスタンスでは Chromium が不安定になることがあるため、スワップの追加を推奨します

## MCP サーバー (`src/mcp/`)

Meta Muse などの AI エージェントから操作するためのリモート MCP サーバーです。`@modelcontextprotocol/sdk` (1.32.2 に固定) の Streamable HTTP トランスポートをステートレス (セッションなし・JSON 応答) で使います。

```bash
SWEEP_MCP_TOKEN=$(openssl rand -hex 32) npm run mcp
# → http://127.0.0.1:8787/mcp   (HTTPS 終端は前段の Caddy に任せる)
```

| パス | 説明 |
| --- | --- |
| `POST /mcp` | `Authorization: Bearer <token>` で認証 |
| `POST /mcp/<token>` | ヘッダーを設定できないクライアント向けの URL パス方式 |
| `GET /healthz` | 認証不要。`ok` のみ返す |

- トークンの比較は `timingSafeEqual` (SHA-256 同士を比較するので長さも漏れません)。失敗は 401。ログ (`journalctl -u sweep-mcp`) にはトークンを出さず、パス方式は `/mcp/***` と記録します
- 認証失敗が 1 分に 10 回続いた IP は 10 分間ブロックし、正しいトークンでも 429 を返します (メモリ内。再起動で解除)
- `GET` / `DELETE /mcp` はステートレス運用のため 405 です

### ツール

すべて `src/core/service.ts` の関数を呼ぶだけです。CAPTCHA・規約で自動応募禁止・重複・日次上限・送信間隔・応募先 URL 未確認・詐欺除外のガードはサービス層で適用され、MCP から迂回する経路はありません。入力は zod で検証し、出力は日本語テキスト + `structuredContent` です。

| ツール | 説明 | 注釈 |
| --- | --- | --- |
| `collect_sweepstakes` (source: `koubo`, categories?, maxDetails?) | 収集ジョブを開始してジョブ ID を返す | 書き込み・外部アクセス |
| `run_web_forms` (submit=false, limit?) | Webフォーム一括応募ジョブを開始してジョブ ID を返す | **destructive** |
| `get_job` (id?) | ジョブの進捗ログと結果。id 省略で最近のジョブ一覧 | 読み取り |
| `enter_campaign` (id, submit=false) | 1 件応募。同期だが 120 秒を超えたらジョブ ID を返してバックグラウンドで継続 | **destructive** |
| `list_campaigns` (kind?, status?, limit?) | キャンペーン一覧 (スコア順) | 読み取り |
| `get_todo` (limit?) / `mark_done` (id, note?) / `get_history` (limit?) | 今日やること / 手動完了の記録 / 履歴 | |
| `quest_add` / `quest_update` / `quest_list` | 仮想通貨クエストの登録・更新 (null で値を消す)・一覧。引数は CLI の `quest` と同じ項目 (`url`, `rewardType`, `rewardAmount`, ... , `fetch`) | |
| `get_profile` / `update_profile` | プロフィールの表示・部分更新。郵便番号・電話・メール・生年月日・性別・フリガナの形式を検証し、不正なら書き込みません (一時ファイル → rename、権限 0600) | update は destructive |

- `collect_sweepstakes` / `run_web_forms` は送信間隔の待機で数分〜数十分かかるため、ジョブとして実行します (メモリ内。完了済みは直近 50 件を保持。サーバー再起動で消えます)
- ブラウザ操作・収集は同時に 1 ジョブまでです (`enter_campaign` も含む)。実行中に開始しようとするとエラーを返します
- さらに、定期実行 (CLI の `collect` / `run` / `enter`) とはファイルロックで排他します (下記「プロセス間ロック」)。CLI 側が実行中ならジョブを作らずに「他の処理が実行中です」と返します

### プロセス間ロック (`src/core/lock.ts`)

収集・応募 (`collect` / `enter` / `run`) は、service 関数の入口で `data/browser.lock` (`SWEEP_LOCK_PATH`) を取得します。Linux / Windows 共通で、`flock` には依存しません。

- `fs.openSync(path, "wx")` で排他的に作成し、pid・ホスト名・処理名・開始時刻を JSON で書きます。保持中は 5 分ごとに更新時刻を更新します
- 取得できなければ**待たずに**エラー (`他の処理が実行中です`)。CLI は終了コード **75** で終わり、定期実行スクリプト (`deploy/sweep-run.sh` / `deploy/windows/run-once.ps1`) は「見送り」として正常終了します
- 保持プロセスが存在しない、または最終更新から 2 時間を超えたロックは stale とみなして奪取します (強制終了・停電の後も自動で回復)
- 正常終了・例外時は `finally` で、`Ctrl+C` (SIGINT) / SIGTERM / プロセス終了時はハンドラで解放します
- MCP サーバーでは `JobManager.start` がプロセス内の排他を確認した後にロックを取得し、ジョブ終了時に解放します。ジョブ内の service 関数はロックを取り直しません (`browserLockHeld`)。`runAll` 内部の 1 件ごとの応募もロックを取り直さないので、二重取得でデッドロック・自己 busy になることはありません
- `submit` は既定 `false` (dry-run)。サーバーの instructions でも「利用者が明示的に指示したときだけ submit=true」と伝えています

## サーバー導入 (Oracle Cloud)

Oracle Cloud の Always Free の Ampere A1 (aarch64) / Ubuntu 24.04 を想定しています。資材は `deploy/` にあります。

| ファイル | 内容 |
| --- | --- |
| `deploy/setup.sh` | Node 22 導入 → 専用ユーザー `sweep` 作成 → `/opt/sweep` に配置して `npm ci` → `npx playwright install --with-deps chromium` (`/opt/sweep/ms-playwright`) → `/opt/sweep/data` 作成 → `/etc/sweep/env` 作成 (初回のみ、トークン自動生成) → systemd 登録。何度実行しても同じ結果になります |
| `deploy/sweep-mcp.service` | MCP サーバー (systemd)。`EnvironmentFile=/etc/sweep/env`、`Restart=always`、`ProtectSystem=strict` などの最小権限設定、書き込みは `/opt/sweep/data` のみ |
| `deploy/sweep-run.service` / `deploy/sweep-run.timer` / `deploy/sweep-run.sh` | 定期実行 (日本時間 8 / 13 / 19 時ごろ、30 分のランダム遅延)。収集 → `run`。**`SWEEP_AUTO_SUBMIT=1` のときだけ `run --submit`**、それ以外は dry-run |
| `deploy/Caddyfile` | `sweep.example.com` を差し替えて使う。自動 HTTPS (Let's Encrypt)、`/mcp*` と `/healthz` だけ `127.0.0.1:8787` へ転送し、それ以外は 404 |
| `deploy/env.example` | `/etc/sweep/env` のひな形 (`SWEEP_MCP_TOKEN` は `openssl rand -hex 32` で生成) |

### 手順

1. **ドメイン**: 使うドメイン (例: `sweep.example.com`) の A レコードをインスタンスのパブリック IP に向けます
2. **VCN のセキュリティリスト** (Oracle Cloud コンソール → ネットワーキング → 仮想クラウド・ネットワーク → サブネット → セキュリティ・リスト): イングレス・ルールに TCP 80 と 443 (ソース `0.0.0.0/0`) を追加します。80 は Let's Encrypt の HTTP-01 チャレンジと HTTPS へのリダイレクトに使います。8787 は開けないでください
3. **インスタンス内の iptables**: Oracle の Ubuntu イメージは VCN とは別に iptables で 22 番以外を `REJECT` しています。セキュリティリストを開けただけでは届きません。`OPEN_FIREWALL=1` を付けて setup.sh を実行するか、手動で次を実行します (ufw は Oracle のルールと競合するので使わない)
   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```
   (`6` は `sudo iptables -L INPUT --line-numbers` で見た REJECT 行より前の位置にしてください)
4. **導入**:
   ```bash
   git clone <このリポジトリ> && cd <リポジトリ>/sweepstakes
   sudo SWEEP_DOMAIN=sweep.example.com OPEN_FIREWALL=1 ./deploy/setup.sh
   sudo grep SWEEP_MCP_TOKEN /etc/sweep/env     # Muse に登録するトークン
   curl -s https://sweep.example.com/healthz    # → ok
   ```
5. **プロフィール**: Muse から `update_profile` で登録するか、`/opt/sweep/data/profile.json` (所有者 `sweep`、0600) を作成します
6. **定期実行** (任意): まず dry-run のまま `sudo systemctl enable --now sweep-run.timer` で様子を見て、`journalctl -u sweep-run` とスクリーンショット (`/opt/sweep/data/screenshots`) を確認してから `/etc/sweep/env` で `SWEEP_AUTO_SUBMIT=1` にします

- 更新: `git pull` して `sudo ./deploy/setup.sh` を再実行 (env と data は上書きしません)
- ログ: `journalctl -u sweep-mcp -f`。設定変更後は `sudo systemctl restart sweep-mcp`
- MCP サーバーのジョブと定期実行 (`sweep-run`) は別プロセスですが、ファイルロック (`/opt/sweep/data/browser.lock`) で排他されます。重なった側は「他の処理が実行中」で即終了します (定期実行は見送り、MCP はエラーを返す)
- メモリ 1GB 程度のシェイプではスワップを追加してください (A1 は 6GB 以上にできるので、余裕があれば 2 OCPU / 12GB 程度を推奨)

## Windows PC で運用する

自宅の Windows PC (Windows 11 / x64 想定) で、MCP サーバーと定期実行を常時動かす手順です。資材は `deploy/windows/` にあります (Oracle Cloud 用の `deploy/` 直下の資材はそのまま使えます)。

| ファイル | 内容 |
| --- | --- |
| `setup.ps1` | Node.js LTS (winget `OpenJS.NodeJS.LTS`、ユーザー範囲) → `npm ci` → `npx playwright install chromium` → `data\` 作成 → `.env` 作成 (初回のみ、トークンを暗号学的乱数で 64 桁生成) → `profile.json` をひな形から作成。何度実行しても同じ結果になります |
| `start-mcp.ps1` | MCP サーバー起動 (`npm run mcp`)。ログは `data\logs\mcp.log`。異常終了したら待って再起動 (`-Once` で 1 回だけ) |
| `run-once.ps1` | 定期実行 1 回分: `npm run sweep -- collect --source koubo` → `npm run sweep -- run` (`SWEEP_AUTO_SUBMIT=1` のときだけ `--submit`)。ログは `data\logs\run-YYYYMMDD.log`。他の処理が実行中 (ロック) なら見送って正常終了 |
| `start-tunnel.ps1` | cloudflared の名前付きトンネル起動 (ログ `data\logs\tunnel.log`)。終了したら待って再起動 |
| `register-tasks.ps1` | タスク スケジューラに `SweepMcp` (ログオン時) / `SweepRun` (毎日 9:10・13:10・20:10) / `SweepTunnel` (`-Tunnel` 指定時) を登録。`-Unregister` で削除 |
| `power.ps1` | (任意) AC 電源時のスリープ・休止を無効化。実行前に確認します。ふたを閉じたときの動作の案内 |
| `cloudflared-config.example.yml` | 名前付きトンネルの設定例 (`/mcp*` と `/healthz` だけ `http://127.0.0.1:8787` へ、それ以外は 404) |

スクリプトは Windows PowerShell 5.1 と PowerShell 7 の両方で動くように書いており、文字化け対策として UTF-8 (BOM 付き) で保存しています。

### 前提

- Windows 10 / 11 (x64)、winget (「アプリ インストーラー」。Windows 11 は標準で入っています)
- このリポジトリを clone 済み (例: `C:\Users\<ユーザー名>\src\<リポジトリ>`)。パスに日本語や空白があっても動くようにしていますが、トラブルを避けるなら英数字のみのパスが無難です
- 管理者権限は不要です (Node.js のインストーラーがユーザー範囲に対応していない場合だけ UAC の確認が出ます)
- タスクは「ログオン中のみ」実行されます。サインアウトせず、離席時は `Win+L` でロックしてください (ロック中も動きます)

### 手順

以下は PowerShell で `sweepstakes` フォルダに移動してから実行します。

```powershell
cd C:\Users\<ユーザー名>\src\<リポジトリ>\sweepstakes
```

1. **セットアップ**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\setup.ps1
   ```
   Node.js を新しく入れた場合、PowerShell を開き直してから `node --version` で 22.13 以上になっていることを確認してください。
2. **プロフィール**: `notepad .\profile.json` で自分の情報に書き換えて **UTF-8** で保存します (Muse から `update_profile` で登録しても構いません)
3. **`.env` の確認**: `notepad .\.env`。`SWEEP_MCP_TOKEN` (自動生成済み) は Muse の登録に使います。**まず `SWEEP_AUTO_SUBMIT=0` (dry-run) のまま**にしてください
4. **MCP サーバーの起動確認**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\start-mcp.ps1 -Once
   # 別の PowerShell で
   Invoke-RestMethod http://127.0.0.1:8787/healthz     # → ok
   ```
   確認できたら `Ctrl+C` で止めます。
5. **トンネル (外部から Muse が接続できるようにする)**: Cloudflare Tunnel を使います。PC 側でポートを開ける必要はありません
   ```powershell
   winget install --id Cloudflare.cloudflared
   ```
   - **お試し (クイック トンネル)**: ドメイン不要。`cloudflared tunnel --url http://127.0.0.1:8787` を実行すると `https://<ランダム>.trycloudflare.com` が表示されます。**URL は起動するたびに変わる**ので、Muse の登録もその都度やり直しになります。常用には向きません
   - **常用 (名前付きトンネル)**: **Cloudflare に登録したドメインが必要**です (ネームサーバーを Cloudflare に向ける)
     ```powershell
     cloudflared tunnel login                                # ブラウザでドメインを選んで許可
     cloudflared tunnel create sweep                         # <UUID>.json が %USERPROFILE%\.cloudflared に作られる
     cloudflared tunnel route dns sweep sweep.example.com    # DNS を登録
     Copy-Item .\deploy\windows\cloudflared-config.example.yml $env:USERPROFILE\.cloudflared\config.yml
     notepad $env:USERPROFILE\.cloudflared\config.yml        # <UUID>・ユーザー名・ドメインを書き換える
     cloudflared tunnel ingress validate
     cloudflared tunnel run sweep                            # 動作確認 (Ctrl+C で止める)
     Invoke-RestMethod https://sweep.example.com/healthz     # → ok
     ```
   - URL パス方式 (`/mcp/<トークン>`) を使うと、トークンが URL に含まれるため **Cloudflare 側のログ・分析やクライアントの履歴に残り得ます**。Muse でヘッダーを設定できるなら `Authorization: Bearer` 方式を使ってください
   - `<UUID>.json` と `cert.pem` はトンネルの秘密情報です。共有・コミットしないでください
6. **Muse に登録**: 下記「Meta Muse への接続」の URL を `https://sweep.example.com/...` (クイック トンネルなら `https://<ランダム>.trycloudflare.com/...`) にして登録します
7. **タスク登録**
   ```powershell
   # MCP サーバー + 定期実行 (9:10 / 13:10 / 20:10)
   powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\register-tasks.ps1
   # 名前付きトンネルも常駐させる / 時刻を変える場合
   powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\register-tasks.ps1 -Tunnel -TunnelName sweep -RunTimes 08:30,12:30,21:00
   # 確認
   Get-ScheduledTask -TaskName Sweep* | Get-ScheduledTaskInfo
   Start-ScheduledTask -TaskName SweepRun       # 定期実行を今すぐ試す (ログ: data\logs\run-YYYYMMDD.log)
   ```
   タスクは Windows PowerShell 5.1 (`powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ...`) で起動します (`-UsePwsh` で PowerShell 7)。起動時に一瞬ウィンドウが表示されることがあります。
8. **電源設定 (任意)**: スリープすると止まるので、AC 電源時はスリープしないようにします
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\power.ps1
   ```
   スリープ中に予定時刻を過ぎた定期実行は、復帰後に 1 回実行されます (StartWhenAvailable)。
9. **様子を見る**: 数日は dry-run のまま、`data\logs\run-*.log` とスクリーンショット (`data\screenshots\`) を確認します。問題なければ `.env` で `SWEEP_AUTO_SUBMIT=1` にします (次回の定期実行から反映。MCP サーバーの再起動は不要)

### 更新

```powershell
Stop-ScheduledTask -TaskName SweepMcp
git pull
npm ci
Start-ScheduledTask -TaskName SweepMcp
```

依存関係・Chromium のバージョンが変わった場合は `setup.ps1` を再実行してください (`.env` と `profile.json` は上書きしません)。`.env` を変更したら `SweepMcp` を再起動します (定期実行は次回から反映)。

### トラブルシュート

- **「このシステムではスクリプトの実行が無効になっている」**: 実行ポリシーです。上記のように `powershell -NoProfile -ExecutionPolicy Bypass -File ...` で起動するか、`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を設定します。ダウンロードした zip から展開した場合は `Get-ChildItem -Recurse .\deploy\windows | Unblock-File` も実行します。会社の PC でグループ ポリシーにより制限されている場合は管理者に相談してください
- **文字化け**: スクリプトは UTF-8 (BOM 付き) で保存しています。エディタで編集して BOM を消すと Windows PowerShell 5.1 で日本語が化けます (VS Code なら「UTF-8 with BOM」で保存)。ログ (`data\logs\*.log`) は UTF-8 (BOM なし) なので、メモ帳または `Get-Content -Encoding UTF8` で開いてください。`profile.json` も UTF-8 で保存します
- **ポート 8787 が使用中**: `Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object OwningProcess` で使用中のプロセスを確認し、前回の `node.exe` が残っていれば終了します。別のアプリなら `.env` の `SWEEP_MCP_PORT` と `cloudflared` の設定の両方を変えます
- **「他の処理が実行中です」**: 定期実行と MCP のジョブが重なっただけなら正常です (後から来た側が見送り)。強制終了などでロックが残っても、保持プロセスがいなければ次回自動で回収されます (2 時間経過でも回収)。手動で消す場合は他の処理が動いていないことを確認してから `data\browser.lock` を削除します
- **定期実行が動かない**: `Get-ScheduledTaskInfo -TaskName SweepRun` の `LastTaskResult` を確認します (`0` = 成功、`267009` = 実行中)。サインアウト中・スリープ中は動きません。Windows Update の再起動後はサインインするまで動かないので、自動ログオンを使わない場合はアクティブ時間を設定してください
- **ログの場所**: `data\logs\mcp.log` (MCP サーバー。10MB を超えると `mcp.log.1` に退避)、`data\logs\run-YYYYMMDD.log` (定期実行)、`data\logs\tunnel.log` (cloudflared)
- **タイムゾーン**: 日次上限の日付境界は `SWEEP_TIMEZONE` (既定 `Asia/Tokyo`) で計算するので、Windows で `TZ` を設定する必要はありません。締切は PC のローカル時刻で判定するので、PC のタイムゾーンは「(UTC+09:00) 大阪、札幌、東京」にしておいてください

## Meta Muse への接続

> **未確認**: Meta Muse のカスタムコネクタ画面の具体的な操作・項目名・対応する認証方式は確認できていません。以下は一般的なリモート MCP コネクタの登録方法です。

1. Muse の設定でカスタムコネクタ (リモート MCP サーバー) の追加を開きます
2. URL を登録します
   - ヘッダーを設定できる場合: URL `https://sweep.example.com/mcp`、ヘッダー `Authorization: Bearer <SWEEP_MCP_TOKEN>`
   - ヘッダーを設定できない場合: URL `https://sweep.example.com/mcp/<SWEEP_MCP_TOKEN>` (URL 自体が秘密情報になるので共有しない)
3. 接続できたら「今日やることを教えて」「公募ガイドから懸賞を集めて」「#12 に dry-run で応募して」のように話しかけます。収集・一括応募はジョブ ID が返るので「ジョブの結果を見せて」と続けます

- トランスポートは Streamable HTTP (ステートレス) です。SSE 専用 (旧方式) のクライアントや、OAuth 認証を必須とするクライアントには対応していません
- トークンを変えたら `/etc/sweep/env` を書き換えて `sudo systemctl restart sweep-mcp` し、Muse 側の登録も更新します
- 送信 (`submit=true`) を伴うツールは destructive として公開しています。Muse が実行前に確認を求めるかどうかはクライアント側の実装次第です (未確認)

## テスト

```bash
npm test          # vitest
npx tsc --noEmit  # 型チェック
```

- テストは `node:http` で `tests/fixtures/forms/` のフォーム HTML (合成データ) をローカル配信し、Playwright で検証します。ブラウザからの通信は `127.0.0.1` 以外を遮断しています
- 検証内容: 公募ガイドの一覧/詳細パース・種別判定・締切切れ除外・403 で中止・robots Disallow で中止・取得間隔、通常フォームの入力・送信値、確認画面付き 2 段階フォーム、CAPTCHA → needs_manual、規約で自動応募禁止 → skipped、不明な必須欄 → needs_manual、dry-run で未送信、重複応募・日次上限・送信間隔、欄推定・採点・詐欺チェックの単体テスト、仮想通貨クエストの登録・更新・円換算・distribution 別期待値・ガス差し引き・時給・unknown_platform・致命フラグでの除外・`--fetch` (モック)・todo の安全注意・CLI 引数パース (`tests/quest.test.ts`)、MCP サーバー (`tests/mcpServer.test.ts`: ランダムポートで起動し SDK クライアントで接続。認証なし/誤トークン 401・Bearer/パス方式・tools/list・各ツールの往復・プロフィールの形式検証・ジョブ開始→get_job (収集はモック fetch、応募はローカルフォーム)・同時ジョブのロック・CLI が保持するファイルロックとの排他・enter のタイムアウト・認証失敗のレート制限)、プロセス間ファイルロック (`tests/lock.test.ts`: 二重取得・stale 奪取 (pid 不在 / 時間超過)・ハートビート・例外時/プロセス終了時/SIGINT での解放・collect/enter/run の入口での取得・runAll の自己 busy なし・JobManager との整合・日本時間の日付境界・Windows 向けの rename 再試行)

## 構成

```
src/
  cli.ts              CLI (薄いラッパー)
  questCli.ts         CLI の quest サブコマンド (引数パース・表示)
  mcp/
    server.ts         MCP サーバー (Streamable HTTP・認証・healthz)
    tools.ts          ツール定義 (service.ts の薄いラッパー)
    jobs.ts           メモリ内ジョブ管理と排他 (プロセス間ロックの取得・解放も行う)
    auth.ts           トークン検証・認証失敗のレート制限
    profileStore.ts   profile.json の部分更新・形式検証
  core/
    index.ts          公開 API (CLI / MCP から利用)
    service.ts        collect / listCampaigns / enter / runAll / todo / mark / history / addQuest / updateQuest / listQuests
    quest.ts          仮想通貨クエストの入力検証・円換算・ページ情報抽出・並び順 (純粋関数)
    types.ts          Campaign / Entry / Profile など
    config.ts         環境変数
    lock.ts           プロセス間ファイルロック (data/browser.lock)
    db.ts             node:sqlite の保存層 (URL で重複排除)
    profile.ts        profile.json の読み込み・検証
    collector.ts      Collector インターフェースと例示用 HTML パーサー
  collectors/
    http.ts           礼儀正しい取得 (robots.txt・間隔・403/429 で中止)
    koubo.ts          公募ガイドの Collector
    guards.ts         送信前ガード (純粋関数)
    fieldMapper.ts    欄の推定・入力値生成・ボタン/画面状態の判定 (純粋関数)
    formFiller.ts     Playwright での入力・送信
    score.ts          採点・詐欺チェック (純粋関数)
    todo.ts           「今日やること」(純粋関数)
deploy/               Oracle Cloud 向け導入資材 (setup.sh・systemd・Caddyfile・env.example)
  windows/            Windows PC 向け (setup / run-once / start-mcp / start-tunnel / register-tasks / power .ps1、cloudflared 設定例)
.env.example          .env のひな形 (Windows 向けの値例)
tests/
  fixtures/           合成 HTML
  helpers/            ローカル HTTP サーバー・テスト用コンテキスト
```
