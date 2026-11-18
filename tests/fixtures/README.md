# スクレイピング用フィクスチャ

ここの HTML は各サイトの商品ページに埋め込まれている既知のデータ構造 (`window.detailData`, `window.__INIT_DATA`,
`window.runParams` 等) を模して作成した**合成データ**です。実ページから取得したものではありません。
業者情報 (Alibaba の `companyName` / `companyId` / `companyHomeUrl`、1688 の `companyName` / `memberId` /
`sellerWinportUrl`、AliExpress の `storeName` / `storeNum` / `storeURL`) も、公開情報から推測したキー名で作った架空の値です。
実サイトのキー名・ネスト位置とは異なる可能性があります (パーサーはキー名でネスト位置に依存せず探索します)。

実ページで抽出に失敗した場合は、取得した HTML (個人情報・Cookie を除去したもの) をここに追加してテストを拡充してください。

## 検索結果ページ (自動探索)

`search-alibaba.html` / `search-aliexpress.html` / `search-1688.html` / `search-dom.html` は、各サイトの**検索結果ページ**に
埋め込まれていると推測されるデータ構造 (Alibaba の `window.__page__data_sse10.offerResultData.offerList`、AliExpress の
`window._dida_config_._init_data_ ... itemList.content`、1688 の `window.data.offerList`) と、埋め込みデータが無い場合の
商品リンク (`<a href title data-price>`) を模して作成した**合成データ**です。

この開発環境 (コンテナ) からは Alibaba.com・AliExpress・1688.com に接続できないため、実ページでの確認はしていません。
変数名・キー名・ネスト位置は実サイトと異なる可能性があります (パーサーはキー名でネスト位置に依存せず「商品一覧らしい配列」を探します)。
実ページで読み取れない場合は、ブラウザで検索結果ページのソースを保存し (Cookie・個人情報を除去)、ここに追加してテストを拡充してください。
