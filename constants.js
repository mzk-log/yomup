// Content Script for Chrome Extension 読むプ
// Copyright (c) 2025 [MZK]
// All rights reserved.
// このソフトウェアおよび関連文書ファイル（以下「ソフトウェア」）の複製、
// 使用、改変、配布を禁止します。


// 右クリックメニューの設定を2次元配列で一元管理
const MENU_CONFIG = [
  { id: 'YomuP-apl', title: '読むプDEV' }
];

// PDF: Chromium 内蔵 PDF ビューアの拡張 ID（Chrome / Edge 共通）
const CHROME_BUILTIN_PDF_VIEWER_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';

// PDF: 内蔵ビューア ID 一覧（将来別 ID があれば追加）
const BUILTIN_PDF_VIEWER_IDS = [
  CHROME_BUILTIN_PDF_VIEWER_ID
];

// PDF: リンク右クリック用メニュー
const PDF_LINK_MENU = {
  id: 'YomuP-pdf-link',
  title: '読むプでPDFを開く'
};

// PDF: 内蔵ビューア表示中タブのページ右クリック用メニュー
const PDF_PAGE_MENU = {
  id: 'YomuP-pdf-page',
  title: '読むプでPDFを開く'
};

// 読むプバージョン（機能変更.不具合修正・改善.申請）
const YOMUP_VERSION = "3.2.DEV";


// デバッグログ出力の有効/無効（コンパイルスイッチ）
const ENABLE_DEBUG_LOG = false; // true: 有効, false: 無効（本番環境）

// テキストハイライトの文字数制限（日本語）
const MAX_TEXT_LENGTH_FOR_HIGHLIGHT = 100;

// テキストハイライトの語数制限（英語・1〜2文相当の一呼吸）
const MAX_WORDS_FOR_HIGHLIGHT = 18;

// ハイライト上限の余裕（実効上限 = MAX_* + SLACK）。英文 30+15=45語まで表示可
const HIGHLIGHT_UNIT_SLACK_JA = 5;
const HIGHLIGHT_UNIT_SLACK_EN = 15;

// ハイライト描画（プロトタイプ）: 'outline' | 'underline'
const HIGHLIGHT_OVERLAY_STYLE = 'underline';
const HIGHLIGHT_UNDERLINE_THICKNESS_PX = 2;
const HIGHLIGHT_UNDERLINE_COLOR = 'red';
const HIGHLIGHT_UNDERLINE_GOAL_COLOR = 'rgba(255, 0, 0, 0.28)';
// 下線ゴール（薄）→ 読書時間に合わせて濃い色が行順に伸長（underline 時のみ）
const ENABLE_HIGHLIGHT_UNDERLINE_PROGRESS = true;
const HIGHLIGHT_UNDERLINE_PROGRESS_MIN_SECONDS = 0.3;
// 確定ハイライト内の再描画抑制: 矩形内のみ（右端だけ余白 px。0 で厳密）
const HIGHLIGHT_STICKY_RIGHT_PADDING_PX = 4;

// 読書速度（英語: 単語/分）— 基準 500字/分 ＝ 225語/分（UI 未接続時のフォールバック）
const WORDS_PER_MINUTE = 225;

// 読書速度（日本語: 字/分）— UI 未接続時のフォールバック
const READING_SPEED_CHARS_PER_MIN = 500;

// 言語ヒューリスティック: CJK文字の比率がこの値以上なら日本語
const CJK_RATIO_THRESHOLD = 0.15;

// 英文分割: 目標位置から前後に探す語数窓
const EN_BOUNDARY_SEARCH_WINDOW_WORDS = 15;

// 日本語分割: 目標位置から前方に許容する文字数（句読点が maxLength を少し超える場合）
const JA_BOUNDARY_SEARCH_WINDOW_FORWARD = 10;

// ハイライト対象となるタグ名（findParentWithConsecutiveSpansの引数として受け入れるタグ）
const HIGHLIGHT_TARGET_TAGS = ['SPAN', 'STRONG'];

// 連続グループとして扱うタグ名（親要素内で連続している場合にグループ化するタグ）
const CONSECUTIVE_GROUP_TAGS = ['SPAN', 'A', 'STRONG'];


// ポップアップID名
const ID_YOMUP_POPUP_CONTAINER = 'YomuP-popup-container';
const ID_SUBPOPUP_CONTAINER = 'subpopup-container';

// ポップアップクラス名
const CLASS_YOMUP_POPUP = 'YomuP-popup';
const CLASS_SUBPOPUP = 'subpopup';


// code要素ラッピング用のクラス名
const CODE_WRAP_CLASS_NAME = 'yomup_codewrap';
const CLASS_BR_LINE_WRAP = 'br_line_wrap';
const CLASS_CODE_LINE_WRAP = 'code_line_wrap';
const CLASS_PROCESSED_SPAN = 'processed-span';


// localStorage用キー名（ポップアップ関連）
const LOCALSTRG_YOMUP_REDISP = 'YomuPPopupVisible'; //リロード時の再表示用
const LOCALSTRG_YOMUP_XYPOS = 'YomuPPopupPosition'; //メインポップアップのXY座標
const LOCALSTRG_YOMUPSUB_XYPOS = 'subPopupPosition'; //サブポップアップのXY座標
const LOCALSTRG_HIGHLIGHT_ONOFF = 'highLightOnOff'; //電球ボタン復元用
const LOCALSTRG_SUBPOPUP_ONOFF = 'subPopupOnOff'; //サブポップアップボタン復元用
const LOCALSTRG_STOPWATCH_STATE = 'stopwatchState'; //ストップウォッチ状態保存用

// sessionStorage用キー名（ページ遷移判定用）
const SESSIONSTRG_PAGE_TRANSITION = 'pageTransition'; //ページ遷移判定用
  
// ボタン状態復元機能の有効/無効（コンパイルスイッチ）
const ENABLE_BUTTON_STATE_RESTORE = true; // true: 有効, false: 無効

// グローバルスコープに公開（Service Worker用）
if (typeof self !== 'undefined') {
  self.MENU_CONFIG = MENU_CONFIG;
  self.CHROME_BUILTIN_PDF_VIEWER_ID = CHROME_BUILTIN_PDF_VIEWER_ID;
  self.BUILTIN_PDF_VIEWER_IDS = BUILTIN_PDF_VIEWER_IDS;
  self.PDF_LINK_MENU = PDF_LINK_MENU;
  self.PDF_PAGE_MENU = PDF_PAGE_MENU;
  self.MAX_TEXT_LENGTH_FOR_HIGHLIGHT = MAX_TEXT_LENGTH_FOR_HIGHLIGHT;
  self.MAX_WORDS_FOR_HIGHLIGHT = MAX_WORDS_FOR_HIGHLIGHT;
  self.HIGHLIGHT_UNIT_SLACK_JA = HIGHLIGHT_UNIT_SLACK_JA;
  self.HIGHLIGHT_UNIT_SLACK_EN = HIGHLIGHT_UNIT_SLACK_EN;
  self.WORDS_PER_MINUTE = WORDS_PER_MINUTE;
  self.READING_SPEED_CHARS_PER_MIN = READING_SPEED_CHARS_PER_MIN;
  self.HIGHLIGHT_TARGET_TAGS = HIGHLIGHT_TARGET_TAGS;
  self.CONSECUTIVE_GROUP_TAGS = CONSECUTIVE_GROUP_TAGS;
}

// グローバルスコープに公開（Content Script用）
if (typeof window !== 'undefined') {
  window.MAX_TEXT_LENGTH_FOR_HIGHLIGHT = MAX_TEXT_LENGTH_FOR_HIGHLIGHT;
  window.MAX_WORDS_FOR_HIGHLIGHT = MAX_WORDS_FOR_HIGHLIGHT;
  window.HIGHLIGHT_UNIT_SLACK_JA = HIGHLIGHT_UNIT_SLACK_JA;
  window.HIGHLIGHT_UNIT_SLACK_EN = HIGHLIGHT_UNIT_SLACK_EN;
  window.WORDS_PER_MINUTE = WORDS_PER_MINUTE;
  window.READING_SPEED_CHARS_PER_MIN = READING_SPEED_CHARS_PER_MIN;
  window.CJK_RATIO_THRESHOLD = CJK_RATIO_THRESHOLD;
  window.EN_BOUNDARY_SEARCH_WINDOW_WORDS = EN_BOUNDARY_SEARCH_WINDOW_WORDS;
  window.JA_BOUNDARY_SEARCH_WINDOW_FORWARD = JA_BOUNDARY_SEARCH_WINDOW_FORWARD;
  window.HIGHLIGHT_TARGET_TAGS = HIGHLIGHT_TARGET_TAGS;
  window.CONSECUTIVE_GROUP_TAGS = CONSECUTIVE_GROUP_TAGS;
  window.HIGHLIGHT_OVERLAY_STYLE = HIGHLIGHT_OVERLAY_STYLE;
  window.HIGHLIGHT_UNDERLINE_THICKNESS_PX = HIGHLIGHT_UNDERLINE_THICKNESS_PX;
  window.HIGHLIGHT_UNDERLINE_COLOR = HIGHLIGHT_UNDERLINE_COLOR;
  window.HIGHLIGHT_UNDERLINE_GOAL_COLOR = HIGHLIGHT_UNDERLINE_GOAL_COLOR;
  window.ENABLE_HIGHLIGHT_UNDERLINE_PROGRESS = ENABLE_HIGHLIGHT_UNDERLINE_PROGRESS;
  window.HIGHLIGHT_UNDERLINE_PROGRESS_MIN_SECONDS = HIGHLIGHT_UNDERLINE_PROGRESS_MIN_SECONDS;
  window.HIGHLIGHT_STICKY_RIGHT_PADDING_PX = HIGHLIGHT_STICKY_RIGHT_PADDING_PX;
}

