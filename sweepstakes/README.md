# 懸賞自動応募ツール (sweepstakes)

せどりツール本体 (リポジトリ直下) とは独立したパッケージです。

- **Webフォーム型懸賞**: プロフィールから自動入力し、ガードを通過したものだけ送信します (既定は dry-run)
- **X / Instagram / 仮想通貨クエスト**: 収集・採点・「今日やること」リスト化まで。フォロー・RT・いいね・コメント・ウォレット署名などの**自動操作は一切行いません**
- コア機能は `src/core/` の関数群 (`src/core/index.ts` から export)。CLI (`src/cli.ts`) はその薄いラッパーです。将来 MCP サーバーから同じ関数を呼ぶ想定です

## セットアップ

Node.js 22.13 以上が必要です (`node:sqlite` を使うため。ネイティブモジュールは使いません)。

```bash
cd sweepstakes
npm install
npx playwright install chromium      # Chromium をまだ入れていない場合のみ
cp profile.example.json profile.json # 自分の情報に書き換える
npm test                             # テスト (外部サイトには一切アクセスしません)
```

`data/` (DB・スクリーンショット) と `profile.json` は `.gitignore` 済みです。

### 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `SWEEP_DB` | `./data/sweep.db` | SQLite DB のパス |
| `SWEEP_PROFILE` | `./profile.json` | プロフィールのパス |
| `SWEEP_SCREENSHOT_DIR` | `./data/screenshots` | スクリーンショット保存先 |
| `SWEEP_MIN_INTERVAL_SEC` / `SWEEP_MAX_INTERVAL_SEC` | `60` / `180` | 送信間隔 (この範囲でランダム) |
| `SWEEP_DAILY_LIMIT` | `30` | 1 日 (ローカル時刻 0 時起点) の送信上限 |
| `SWEEP_HEADLESS` | `1` | `0` でブラウザを表示 |
| `SWEEP_CHROMIUM_PATH` | なし | 使用する Chromium の実行ファイルを明示 |
| `SWEEP_NAV_TIMEOUT_MS` | `30000` | ページ操作のタイムアウト |

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
| `collect --source koubo [--pages n] [--max-details n]` | 実在サイト (公募ガイド) から収集し、詐欺チェック・採点して保存 (URL で重複排除) |
| `collect --html <file> [--html <file>...]` | ローカル HTML (例示用フォーマット) から収集 |
| `list [--kind web_form\|x\|instagram\|crypto_quest]` | 一覧 (スコア順) |
| `enter <id>` | Webフォームに入力し、**送信直前で停止**してスクリーンショットを保存 (dry-run) |
| `enter <id> --submit` | 実際に送信 |
| `run [--submit]` | 応募可能な Webフォーム懸賞を一括処理 (未処理のもののみ・ガード適用・日次上限で停止) |
| `todo` | X / Instagram / 仮想通貨クエストの「今日やること」(締切が近い順 → 同じ日ならスコア順) |
| `mark <id> [--note <メモ>]` | 手動タスクを完了として記録 (todo から消える) |
| `history [--limit n]` | 応募履歴 |

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

- 一覧 `https://koubo.jp/contest/list?c=13&p=0..` (c=13 は懸賞カテゴリ。`--pages` で最大ページ数、既定 3) → 各項目の詳細 `https://koubo.jp/contest/{id}` を取得します (`--max-details` で上限、既定 60)
- 詳細ページから 締切・主催者・賞・応募資格・主催者サイト URL・募集内容 を読み、次のように変換します
  - `url` は主催者サイト (応募先)。取れなかった場合は掲載ページを `url` にし、リスクフラグ `entry_url_unverified` (要確認) を付けます。このフラグがあるものは `enter` / `run` で自動応募しません
  - 掲載ページの URL は `conditions.sourceUrl`、タグ (「クイズ」「食品」「WEB応募可」など) は `conditions.tags`、募集内容など詳細の全項目は `conditions.terms` (規約の自動応募禁止ガードの対象) に入ります
  - 種別: 応募先が x.com / instagram.com、または応募方法に X / Instagram と明記 → `x` / `instagram`。Web フォーム・「WEB応募可」→ `web_form`。はがき・郵送・レシートのみ → 収集しません。判定不能は `web_form` (送信前ガードに任せます。クイズ型は不明な必須欄で `needs_manual` になる想定)
  - 締切切れは詳細を取得せずに除外します
- Next.js のストリーミング SSR で後から差し込まれる部分 (`<template id="P:x">` ← `<div hidden id="S:x">`) は解決してからパースします

#### 取得の礼儀 (`src/collectors/http.ts` の `PoliteFetcher`、実在サイト用 Collector 共通)

- User-Agent は正直な識別子 `sweepstakes-collector/0.1 (+personal use)`。ブラウザ偽装はしません
- 実行時に `robots.txt` を取得し、対象パスが Disallow なら取得せず中止します (RFC 9309 準拠の簡易実装。同じ User-agent のグループは統合し、最長一致・`*`・`$` に対応。robots.txt が 404 なら制限なし、5xx なら全拒否)
- リクエスト間隔は 3〜6 秒のランダム
- 403 / 429 を受けたらその回の収集を中止してエラーにします (回避・リトライはしません)
- 1 回の収集で取得する詳細ページは最大 60 件 (`--max-details`)
- テストは fetch を差し替えたモックとフィクスチャ (`tests/fixtures/koubo/`、実ページから構造確認用に抜粋) を使い、実サイトにはアクセスしません

**注意 (2026-11 時点)**: koubo.jp の robots.txt は `User-Agent: *` に対して `Disallow: /contest/list?*` を指定しているため、既定の一覧 URL は robots チェックで拒否され、収集は一覧を取得せずに中止します (詳細ページ `/contest/{id}` は許可)。robots.txt で許可された別の一覧 (例: `/category/present/all`) を使う場合は `KouboCollector` の `listUrl` オプションで差し替えられますが、構造が同じかは未確認です。

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
  - **減点**: `approve` / `setApprovalForAll` / permit 等の承認要求
  - 既知の公式ドメイン一覧は `KNOWN_OFFICIAL_DOMAINS` (必要に応じて追加してください)

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
- 定期実行は cron / systemd timer で `npm run sweep -- run --submit` を 1 日数回程度にしてください (日次上限とランダム間隔は DB で管理されます)
- メモリ 1GB 程度のインスタンスでは Chromium が不安定になることがあるため、スワップの追加を推奨します

## テスト

```bash
npm test          # vitest
npx tsc --noEmit  # 型チェック
```

- テストは `node:http` で `tests/fixtures/forms/` のフォーム HTML (合成データ) をローカル配信し、Playwright で検証します。ブラウザからの通信は `127.0.0.1` 以外を遮断しています
- 検証内容: 公募ガイドの一覧/詳細パース・種別判定・締切切れ除外・403 で中止・robots Disallow で中止・取得間隔、通常フォームの入力・送信値、確認画面付き 2 段階フォーム、CAPTCHA → needs_manual、規約で自動応募禁止 → skipped、不明な必須欄 → needs_manual、dry-run で未送信、重複応募・日次上限・送信間隔、欄推定・採点・詐欺チェックの単体テスト

## 構成

```
src/
  cli.ts              CLI (薄いラッパー)
  core/
    index.ts          公開 API (CLI / 将来の MCP から利用)
    service.ts        collect / listCampaigns / enter / runAll / todo / mark / history
    types.ts          Campaign / Entry / Profile など
    config.ts         環境変数
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
tests/
  fixtures/           合成 HTML
  helpers/            ローカル HTTP サーバー・テスト用コンテキスト
```
