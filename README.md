# 読むプ（YomuP）

Web ページおよび PDF での読書を支援する Chrome 拡張機能です。マウスオーバーによるハイライト、文字数（日本文）／語数（英文）カウント、読了時間の目安、ストップウォッチ・ハイライト読了タイマーなどを提供します。

**現在のリリース: 3.1.0**（Web ハイライト改善・h4 対応）

### 3.1.0（2026-06-14）

- **ハイライト予備ボタンの廃止** — 「うまくできない時」用ボタンを削除し、自動判定に統一
- **h4 見出し** — テキスト幅のみ光るよう修正（h1–h3 と同型）

**本リポジトリに含まれるソースコードは、開発者 MZK（以下「作者」）が作成した作品です。**  
ライセンスはリポジトリルートの [LICENSE](./LICENSE)（MIT）に従います。

## Chrome ウェブストア

インストール・概要・更新履歴はストアのページを参照してください。

- [読むプ ： ハイライト・タイマーで集中Web読書（Chrome ウェブストア）](https://chromewebstore.google.com/detail/%E8%AA%AD%E3%82%80%E3%83%97-%EF%BC%9A-%E3%83%8F%E3%82%A4%E3%83%A9%E3%82%A4%E3%83%88%E3%83%BB%E3%82%BF%E3%82%A4%E3%83%9E%E3%83%BC%E3%81%A7%E9%9B%86%E4%B8%ADweb%E8%AA%AD%E6%9B%B8/ikckgloaoidjoddhldocajagcofeneif?hl=ja)

## プライバシーポリシー

本拡張機能のプライバシーポリシーは、以下の公式 URL にて公開しています。  
Chrome ウェブストアへの登録や、ユーザーへの説明にはこちらを使用してください。

- **[読むプ：プライバシーポリシー](https://mzk-log.github.io/yomup/yomup-privacy-policy.html)**

## 主な機能

### Web ページ

- **マウスオーバーハイライト** — ホバー位置のテキストを読みやすい単位で赤枠表示（日英自動判定。块の目安は `constants.js` の `MAX_TEXT_LENGTH_FOR_HIGHLIGHT` / `MAX_WORDS_FOR_HIGHLIGHT`）。h1–h4 見出しは見出しテキスト幅のみ
- **文字数カウント** — ページ全体または選択範囲の文字数（日本文）／語数（英文）
- **読了時間の目安** — 日本文 250 字／分、英文 225 語／分を基準
- **ストップウォッチ／カウントダウン** — 読書時間の計測と目標時間までのカウントダウン
- **起動** — ツールバーアイコンまたは右クリック「読むプ」

### PDF ファイル（3.0.0以降）

- **専用 viewer** — ブラウザで開いた PDF を、拡張アイコンまたは右クリック「読むプでPDFを開く」から表示（`https://` / `http://` / `file://`）
- **Web 版と同等の支援** — ハイライト、ストップウォッチ、カウントダウンタイマー
- **文字数・読書時間** — 全体および選択範囲（英文は語数）
- **ローカル PDF** — `file://` 利用時は拡張機能の設定で「ファイルの URL へのアクセスを許可」が必要

## 開発者向け：ソースから読み込む

1. Chrome で `chrome://extensions/` を開く  
2. 「デベロッパーモード」をオン  
3. 「パッケージ化されていない拡張機能を読み込む」で、**このフォルダ（`manifest.json` がある階層）** を指定  

※ ストア提出用 ZIP は、このルートの**中身**を zip します（`node_modules/` は含めない。親フォルダを zip のルートにしないこと）。

## 権限（`manifest.json`）

| 権限 | 用途の概要 |
|------|------------|
| `contextMenus` | 右クリック「読むプ」「読むプでPDFを開く」 |
| `activeTab` | アクティブなタブでスクリプト注入・操作 |
| `scripting` | 未注入タブへの動的注入（アイコン・右クリック起動時など） |
| `tabs` | PDF タブ・内蔵 PDF ビューアの判定、viewer への遷移 |
| `host_permissions`（`https://*/*` `http://*/*`） | ユーザー操作時に PDF を fetch して viewer 表示 |
| `host_permissions`（`file:///*`） | ローカル PDF（拡張設定で許可が必要） |

※ `content_scripts` により、Web ページ読込時にも `constants.js` / `content.js` を注入します。

## サードパーティ

### Font Awesome（アイコン）

UI の SVG アイコンに **Font Awesome**（無料版）を利用しています。

- [Font Awesome Free のライセンス](https://fontawesome.com/license/free)

Icons by [Font Awesome](https://fontawesome.com), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

### PDF.js

PDF 表示に **PDF.js**（Mozilla）を同梱しています。帰属表示は [NOTICE](./NOTICE) を参照してください。

- [PDF.js](https://github.com/mozilla/pdf.js) — Apache License 2.0

## フォルダ構成（抜粋）

- **manifest.json** — 拡張機能の定義と権限  
- **background.js** — アイコン・右クリック、PDF fetch / viewer 起動、content 注入  
- **constants.js** — 定数（ハイライト上限、PDF メニュー文言等）  
- **content.js** — Web 版：ハイライト、ポップアップ UI、文字数／読了時間等  
- **pdf/** — PDF viewer（`viewer.html` / `viewer.js` / `highlight-core.js` 等）  
- **vendor/** — PDF.js（`pdf.mjs`）、CMap（`cmaps/`）、標準フォント（`standard_fonts/`）  
- **images/** — UI 用 SVG 等  
- **docs/** — プライバシーポリシー・デモ用 HTML  
- **NOTICE** — PDF.js 等の帰属  
- **LICENSE** / **README.md**

## 今後の開発課題

- **PDF 対応**（3.0.0）— PDF.js viewer、ハイライト・タイマー・文字数、多カラム、`file://`、内蔵 PDF ビューアからの起動
- ハイライトがうまくできない箇所に対応する（難易度高。デグレが起きやすい）
    - 2026/5/10 修正実施
    - 2026/5/30 `<dd>` 内の見出しと概要の連結、`pre`（表セル内含む）の1行単位ハイライト等（2.6.0）
    - 2026/5/31 カード型 div、アコーディオン FAQ（2.7.0）
    - 2026/6/6 日本語句読点優先、リスト・nav・表目次列、ニュース記事型 `<p>` 等（2.8.0）
    - 2026/6/14 日経 blockLink 型・PR 誤光り・右空白 hover、Gemini 箇条書き／引用ラベル／タイムライン、h4・予備ボタン廃止（3.1.0）
- tooltip の座標調整 — 2026/5/16 修正実施
- 英文ハイライト — 2026/5/24 対応（2.5.0）
- UI の変更としてハイライトを強調する（難易度中）
- 読むプ窓の横長/縦長切り替え（難易度中）
- 読むプ窓がブラウザ縮小で画面外 — 2026/5/30 修正（2.6.0）

## ライセンス

MIT License — 詳細は [LICENSE](./LICENSE) を参照してください。

## 作者・著作権

Copyright (c) 2026 MZK
