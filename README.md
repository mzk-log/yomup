# 読むプ（YomuP）

Web 読書向けの Chrome 拡張機能です。マウスオーバーによるハイライト、文字数カウント、読了時間の目安、ストップウォッチ／カウントダウンで読書を支援します。

**本リポジトリに含まれるソースコードは、開発者 MZK（以下「作者」）が作成した作品です。**  
ライセンスはリポジトリルートの [LICENSE](./LICENSE)（MIT）に従います。

## Chrome ウェブストア

インストール・概要・更新履歴はストアのページを参照してください。

- [読むプ ： ハイライト・タイマーで集中Web読書（Chrome ウェブストア）](https://chromewebstore.google.com/detail/%E8%AA%AD%E3%82%80%E3%83%97-%EF%BC%9A-%E3%83%8F%E3%82%A4%E3%83%A9%E3%82%A4%E3%83%88%E3%83%BB%E3%82%BF%E3%82%A4%E3%83%9E%E3%83%BC%E3%81%A7%E9%9B%86%E4%B8%ADweb%E8%AA%AD%E6%9B%B8/ikckgloaoidjoddhldocajagcofeneif?hl=ja)

## プライバシーポリシー

本拡張機能のプライバシーポリシーは、以下の公式URLにて公開しています。
Chromeウェブストアへの登録や、ユーザーへの説明にはこちらを使用してください。

- **[読むプ：プライバシーポリシー](https://mzk-log.github.io/yomup/yomup-privacy-policy.html)**

## 主な機能

- **マウスオーバーハイライト** — ホバーした要素を読みやすく強調
- **文字数カウント** — ページ全体または選択範囲の文字数
- **読了時間の目安** — 250 文字／分を基準とした目安表示
- **ストップウォッチ／カウントダウン** — 読書時間の計測と目標時間までのカウントダウン
- **右クリックメニュー** — コンテキストメニューからの起動（`background.js`）

## 開発者向け：ソースから読み込む

1. Chrome で `chrome://extensions/` を開く  
2. 「デベロッパーモード」をオン  
3. 「パッケージ化されていない拡張機能を読み込む」で、**このフォルダ（`manifest.json` がある階層）** を指定  

※ ストアに提出する ZIP も、通常はこのルートをそのまま zip します（親フォルダを zip のルートにしないこと）。

## 権限（`manifest.json`）

| 権限 | 用途の概要 |
|------|------------|
| `contextMenus` | 右クリックメニューに「読むプ」を追加 |
| `activeTab` | アクティブなタブでスクリプト注入・操作 |
| `scripting` | コンテンツスクリプトの動的注入 |

## サードパーティ：Font Awesome（アイコン）

UI の SVG アイコンに **Font Awesome**（無料版）を利用しています。

- [Font Awesome Free のライセンス](https://fontawesome.com/license/free)

Icons by [Font Awesome](https://fontawesome.com), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## フォルダ構成（抜粋）

- **manifest.json** ： 拡張機能の定義と権限管理 <br>
- **background.js** ： 拡張機能全体のイベント管理や各プログラム間の仲介を行う <br>
- **constants.js** ： 定数の定義ファイル <br>
- **content.js** ： 閲覧中のページからテキストを抽出するメインロジック <br>
- **icon16.png / icon48.png / icon128.png** ： アイコン画像 <br>
- **images/** ： UI 用 SVG 等 <br>
- **docs/** ： プライバシーポリシー・デモ用 HTML <br>
- **LICENSE** <br>
- **README.md** <br>

## 今後の開発課題

- ハイライトがうまくできない箇所に対応する（難易度高。デグレが起きやすい）
- ハイライトを英文に対応させる（難易度高。文字数の考え方が日本語と合わない）

## ライセンス

MIT License — 詳細は [LICENSE](./LICENSE) を参照してください。

## 作者・著作権

Copyright (c) 2026 MZK
