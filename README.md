# 撮可チェック (Satsuka Check)

チケットURLを入力すると、そのページ本文を取得し、Notionの「アイドル撮影レギュレーション」DBと突き合わせて
出演グループの静止画/動画撮影可否を一覧表示する小さなWebアプリです。

- 入力: チケット詳細ページのURL(ticketvillage, イープラス, Zaikoなど何でも)
- サーバー側でページを取得し、本文テキストとDB内の全グループ名を突き合わせ
- 一致したグループを静止画/動画レギュ・備考つきで表示

サイトごとの構造(HTML)に依存しない方式なので、対応サイトを増やす追加実装は基本的に不要です。

---

## 1. Notion側の準備 (最初の1回だけ)

1. https://www.notion.so/my-integrations を開き、「+ New integration」で新規作成
   - 名前は何でもOK (例: `satsuka-check`)
   - 権限は「Read content」のみで十分
2. 作成後に表示される **Internal Integration Secret** をコピー(`secret_...` や `ntn_...` から始まる文字列)
3. Notionで対象のデータベース「アイドル撮影レギュレーション」のページを開き、
   右上の「... 」メニュー →「コネクト」→ 作成したインテグレーションを選択して接続
   (これをしないとAPIから見えず404になります)

---

## 2. セットアップ

```bash
cd satsuka-check
npm install
cp .env.example .env
```

`.env` を開いて `NOTION_TOKEN` に手順1でコピーしたシークレットを貼り付けます。
`NOTION_DATABASE_ID` は既定で「アイドル撮影レギュレーション」DBのIDが入っているので、
別のDBを使う場合だけ書き換えてください。

---

## 3. 起動

```bash
npm start
```

`http://localhost:3000` を開けば使えます。

開発中に自動リロードしたい場合は `npm run dev` (Node 18.11+ の `--watch` を使用)。

---

## 4. デプロイ (常用するなら)

ローカルでずっと起動しておくのが手間なら、無料枠のあるホスティングにデプロイすると
どこからでもURLを開くだけで使えます。おすすめは以下のどれか(いずれもNode.jsをそのまま動かせます):

- **Railway** (https://railway.app) — GitHubリポジトリを繋ぐだけでほぼ自動デプロイ
- **Render** (https://render.com) — 無料のWeb Service枠あり
- **Fly.io** (https://fly.io)

どのサービスでも共通の手順:

1. このフォルダをGitHubリポジトリにpush
2. サービス側で「このリポジトリからWebアプリを作成」
3. 環境変数に `NOTION_TOKEN` と `NOTION_DATABASE_ID` を設定(`.env`の中身と同じ)
4. Build Command: `npm install` / Start Command: `npm start`
5. デプロイ後に発行されるURLをブックマークして使う

---

## 仕組みの補足

- `/api/lookup` にURLをPOSTすると、サーバーがそのページを取得し、
  `<script>`や`<style>`を除いた本文テキストを抽出します。
- Notion DBの全グループ名(約800件)をキャッシュしておき、
  「ページ本文にグループ名の文字列がそのまま含まれているか」で一致判定します。
- DBは10分間キャッシュされます。DBを更新した直後に反映したい場合は
  画面右上の「DBを再取得」ボタンを押してください。
- この方式はサイトの見た目やHTML構造に依存しないので、どんなチケットサイトでも
  基本的にそのまま使えますが、グループ名の表記ゆれ(全角/半角、記号違いなど)が
  ある場合は一致しないことがあります。その場合はNotion DB側に別名を項目として
  追加するか、`server.js` の照合ロジックに正規化処理を足すと精度が上がります。
