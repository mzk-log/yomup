// Content Script for Chrome Extension 読むプ
// Copyright (c) 2025 [MZK]
// All rights reserved.
// このソフトウェアおよび関連文書ファイル（以下「ソフトウェア」）の複製、
// 使用、改変、配布を禁止します。


// 右クリックメニューの設定を2次元配列で一元管理
const MENU_CONFIG = [
  { id: 'YomuP-apl', title: '読むプDEV' }
];

// 読むプバージョン（機能変更.不具合修正）
const YOMUP_VERSION = "2.5.1002DEV";


// デバッグログ出力の有効/無効（コンパイルスイッチ）
const ENABLE_DEBUG_LOG = false; // true: 有効, false: 無効（本番環境）

// テキストハイライトの文字数制限（日本語）
const MAX_TEXT_LENGTH_FOR_HIGHLIGHT = 150;

// テキストハイライトの語数制限（英語・1〜2文相当の一呼吸）
const MAX_WORDS_FOR_HIGHLIGHT = 30;

// ハイライト上限の余裕（実効上限 = MAX_* + SLACK）。英文 30+15=45語まで表示可
const HIGHLIGHT_UNIT_SLACK_JA = 5;
const HIGHLIGHT_UNIT_SLACK_EN = 15;

// 読書速度（英語: 単語/分）
const WORDS_PER_MINUTE = 225;

// 読書速度（日本語: 字/分）
const READING_SPEED_CHARS_PER_MIN = 250;

// 言語ヒューリスティック: CJK文字の比率がこの値以上なら日本語
const CJK_RATIO_THRESHOLD = 0.15;

// 英文分割: 目標位置から前後に探す語数窓
const EN_BOUNDARY_SEARCH_WINDOW_WORDS = 15;

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
const LOCALSTRG_NOTEXT_ONOFF = 'NoTextModeOnOff'; //テキスト外ボタン復元用
const LOCALSTRG_SUBPOPUP_ONOFF = 'subPopupOnOff'; //サブポップアップボタン復元用
const LOCALSTRG_STOPWATCH_STATE = 'stopwatchState'; //ストップウォッチ状態保存用

// sessionStorage用キー名（ページ遷移判定用）
const SESSIONSTRG_PAGE_TRANSITION = 'pageTransition'; //ページ遷移判定用
  
// ボタン状態復元機能の有効/無効（コンパイルスイッチ）
const ENABLE_BUTTON_STATE_RESTORE = true; // true: 有効, false: 無効

// グローバルスコープに公開（Service Worker用）
if (typeof self !== 'undefined') {
  self.MENU_CONFIG = MENU_CONFIG;
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
  window.HIGHLIGHT_TARGET_TAGS = HIGHLIGHT_TARGET_TAGS;
  window.CONSECUTIVE_GROUP_TAGS = CONSECUTIVE_GROUP_TAGS;
}

