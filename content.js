// Content Script for Chrome Extension 読むプ
// Copyright (c) 2025 [MZK]
// All rights reserved.
// このソフトウェアおよび関連文書ファイル（以下「ソフトウェア」）の複製、
// 使用、改変、配布を禁止します。

// == 重複注入チェック ===================================================
// 次回以降の重複実行を防ぐ
if (typeof window !== 'undefined') {
  window.YOMUP_CONTENT_SCRIPT_LOADED = true;
}


// == グローバル変数定義 =======================================================
//要素の重複処理を防ぐためのキャッシュ
const processedElementCache = new Set();

// ハイライト処理のマウスカーソル機能
let highLightOnOff = false; // 機能が有効かどうかのフラグ
let highlightListenersAttached = false; // attach/detach の二重登録防止
let currentHighlightedElement = null; // 現在ハイライトされている要素
let mouseTimeoutForHighlight = null; // マウスが250ms間動かなかった場合のタイマー

// §71 RK-2: トップ以外（iframe）では UI を出さずハイライト同期のみ
function isTopBrowsingContext() {
  try {
    return window === window.top;
  } catch (_e) {
    // cross-origin で top に触れない場合はフレーム側として扱う
    return false;
  }
}

function shouldSkipSubframeHighlightBootstrap() {
  if (isTopBrowsingContext()) return false;
  try {
    const host = location.hostname || '';
    // 広告・計測系 iframe は初期化を省略（§71）
    if (
      /doubleclick|googlesyndication|googletagmanager|criteo|rokt\.com|rokt-api|facebook\.com|scorecardresearch|taboola|outbrain|amazon-adsystem|adservice\./i.test(
        host
      ) ||
      (/ias\.rakuten\.co\.jp/i.test(host) && /\/gw\.js/i.test(location.pathname + location.search))
    ) {
      return true;
    }
    // 極小フレームは初期化を省略
    if (window.innerWidth > 0 && window.innerHeight > 0) {
      if (window.innerWidth < 40 || window.innerHeight < 40) return true;
    }
  } catch (_e) {
    return true;
  }
  return false;
}

function persistHighlightOnOffToChromeStorage(enabled) {
  try {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.set({ [CHROME_STORAGE_HIGHLIGHT_ONOFF]: !!enabled });
  } catch (_e) {
    /* ignore storage write errors */
  }
}

function syncHighlightButtonUi() {
  if (!isTopBrowsingContext()) return;
  try {
    const host = document.getElementById(ID_YOMUP_POPUP_CONTAINER);
    const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
    if (!img) return;
    if (highLightOnOff) img.classList.add('active');
    else img.classList.remove('active');
  } catch (_e) {
    /* ignore */
  }
}

function setHighlightModeEnabled(enabled, options) {
  const next = !!enabled;
  const skipPersist = !!(options && options.skipPersist);
  const changed = next !== highLightOnOff;
  highLightOnOff = next;
  if (!skipPersist) {
    try {
      localStorage.setItem(LOCALSTRG_HIGHLIGHT_ONOFF, highLightOnOff.toString());
    } catch (_e) {
      /* ignore */
    }
    persistHighlightOnOffToChromeStorage(highLightOnOff);
  }
  if (highLightOnOff) {
    attachHighlightListeners();
  } else {
    clearCurrentHighlight();
    detachHighlightListeners();
  }
  if (changed) syncHighlightButtonUi();
}

function applySharedHighlightOnOff(enabled) {
  setHighlightModeEnabled(enabled, { skipPersist: true });
}

function bootstrapSharedHighlightState() {
  if (shouldSkipSubframeHighlightBootstrap()) return;
  try {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.get([CHROME_STORAGE_HIGHLIGHT_ONOFF], (result) => {
      try {
        if (chrome.runtime?.lastError) return;
        let enabled = result && result[CHROME_STORAGE_HIGHLIGHT_ONOFF];
        if (typeof enabled !== 'boolean') {
          // 未移行: トップの localStorage を種にしつつ、iframe は storage 待ち
          if (isTopBrowsingContext()) {
            enabled = localStorage.getItem(LOCALSTRG_HIGHLIGHT_ONOFF) === 'true';
            persistHighlightOnOffToChromeStorage(enabled);
          } else {
            enabled = false;
          }
        }
        if (enabled) applySharedHighlightOnOff(true);
      } catch (_e) {
        /* ignore */
      }
    });
  } catch (_e) {
    /* ignore */
  }
}

function bindSharedHighlightStorageListener() {
  try {
    if (!chrome?.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const change = changes && changes[CHROME_STORAGE_HIGHLIGHT_ONOFF];
      if (!change) return;
      applySharedHighlightOnOff(!!change.newValue);
    });
  } catch (_e) {
    /* ignore */
  }
}

//ポップアップ内ストップウォッチ
let stopwatchOnOff = false; // ストップウォッチUI表示中かどうかのフラグ
let stopwatchTimerID = null; //ストップウォッチのタイマーID
let stopwatchSeconds = 0; //ストップウォッチ経過時間(秒)
let stopwatchLimitMinutes = null; // ループタイマーの上限時間（分）。nullの場合は通常のストップウォッチ
let stopwatchLoopCount = 0; // ループ回数

// サブポップアップのトグル機能
let subPopupOnOff = false; // 機能が有効かどうかのフラグ
let countDownTimerForSub = 0;
let countDownIntervalForSub = null; // カウントダウンタイマーのIDを保存
let highlightProgressSession = null; // §19: ライン進行の一時停止／再開セッション
let highlightProgressCountdownInterval = null; // §21: ライン進行用カウントダウン（部分タイマーと分離）

// ドラッグ移動機能用の変数
let isDragging = false; // ドラッグ中かどうかのフラグ
let startX, startY, startLeft, startTop; // ドラッグ開始時の座標
let currentDraggingPopup = null; // 現在ドラッグ中のポップアップ要素
let popupViewportResizeDebounceTimer = null; // resize 時のポップアップ再配置 debounce用

// 読書速度設定（reading-settings.js が localStorage を正とする）
let isPageTransition = false; // ページ遷移時かブラウザ起動時かを判定するフラグ

// ハイライト遅延処理で使う最新ポインタ座標（setTimeout 内の event は古くなりうる）
let lastHighlightClientX = 0;
let lastHighlightClientY = 0;

// 論理塊ハイライト（オーバーレイ）用
const LANGUAGE_MODE_JA = 'ja';
const LANGUAGE_MODE_EN = 'en';
const COALESCE_MIN_WORDS_EN = 8;
const COALESCE_MIN_CHARS_JA = 40;
const BLOCK_ANCESTOR_TAGS = new Set([
  'P', 'LI', 'DD', 'DT', 'BLOCKQUOTE', 'FIGCAPTION', 'CAPTION', 'TD', 'TH', 'PRE', 'ADDRESS'
]);
const LIST_LINE_BREAK_TAGS = new Set(['LI', 'UL', 'OL']);
const INTERVAL_LINE_BREAK_TAGS = new Set([
  'HEADER', 'FOOTER', 'P', 'LI', 'UL', 'OL', 'H4', 'H5', 'H6', 'PRE'
]);
const INLINE_TEXT_HOST_TAGS = new Set(['TIME', 'A', 'BUTTON', 'LABEL', 'SPAN', 'CODE']);
// Gemini sequence（タイムライン）のタイトル・サブタイトル行
const GEMINI_SEQUENCE_TEXT_UNIT_CLASSES = new Set([
  'sequence-event-title',
  'sequence-event-subtitle'
]);
const BR_FLOW_CONTAINER_TAGS = new Set(['DIV', 'ARTICLE', 'SECTION', 'MAIN']);
const BR_FLOW_BOUNDARY_TAGS = new Set(['H2', 'H3']);
// Tailwind 等の div カード（grid 内セル）: 親は構造判定、ブロックは直下テキスト div
const CARD_CELL_MIN_TEXT_DIVS = 2;
const CARD_CELL_MAX_DIRECT_CHILDREN = 8;
const CARD_CELL_MIN_SIBLING_DIVS = 3;
// §29 inner-card-cell: 見出し div + 本文 div（MSG box03 等）
const INNER_CARD_CELL_TEXT_DIV_COUNT = 2;
// §30 flow-step-li: 見出し div 内の子 div 最小数（Step ラベル + タイトル）
const FLOW_STEP_MIN_HEADER_CHILD_DIVS = 2;
// Ko-fi 料金プラン等: H2/H3 + 直下テキスト div（card-cell の 2-div 要件を満たさない行）
const CARD_CELL_PRICING_ROW_HEADING_TAGS = new Set(['H2', 'H3']);
// Ko-fi feature grid 等: img + h3 + p のアイコン付きカード1枚
const FEATURE_ICON_CARD_MEDIA_TAGS = new Set(['IMG', 'SVG', 'PICTURE']);
// ruby-br-block（§16）: 青空ホスト + DIV + br 区切り構造（ruby / クラス名は不問）
const RUBY_BR_BLOCK_HOST = 'aozora.gr.jp';
const RUBY_BR_BLOCK_MIN_BR_COUNT = 2;
const RUBY_BR_BLOCK_MIN_TEXT_LENGTH = 30;
const RUBY_BR_BLOCK_EXCLUDED_CLASSES = new Set([
  'title', 'author', 'metadata', 'midashi_anchor'
]);
const AOZORA_ORPHAN_TEXT_PARENT_TAGS = new Set(['CENTER', 'BODY']);
const AOZORA_BR_LINE_MIN_TEXT_LENGTH = 4;
// 書誌・注記のみ br 直下テキストを 1 行 scoped に（main_text はルビ分割のため対象外）
const AOZORA_BR_SEPARATED_LINE_CONTAINER_CLASSES = new Set([
  'bibliographical_information',
  'notation_notes'
]);
// dd 直下のブロック子要素を論理行境界とする（h4 + 概要 div 等の連結防止）
const DD_CHILD_LINE_BREAK_TAGS = new Set([
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'P', 'DIV', 'BLOCKQUOTE', 'PRE', 'FIGCAPTION', 'SECTION', 'ARTICLE'
]);
// li 直下の h1–h4 / p を論理行境界とする（見出し+本文・複数 p の連結防止）
const LI_CHILD_LINE_BREAK_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'P']);
// td/th 直下の h1–h3 を論理行境界とする（目次型セル内の見出し+本文連結防止）
const TD_CHILD_LINE_BREAK_TAGS = new Set(['H1', 'H2', 'H3']);
// レイアウト目次型表セル（Arduino リファレンス左列等）の構造判定
const LAYOUT_TABLE_CELL_MIN_HEADINGS = 2;
const LAYOUT_TABLE_CELL_MIN_LINKS = 3;
const LAYOUT_TABLE_CELL_MIN_BRS = 3;
// 見出し専用 Range（ブロック祖先には含めない）。H1–H6 をテキスト幅のみ光らせる
const HEADING_SECTION_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
// p/li/dd 先頭の b/strong ラベル（Gemini「結果：」型）。§3.7 inline 経路でテキスト幅のみ光らせる
const BLOCK_LABEL_TAGS = new Set(['B', 'STRONG']);
const BLOCK_LABEL_PARENT_TAGS = new Set(['P', 'LI', 'DD']);
// §43 AL-1: div.intro-box 型（先頭 strong + 続く p）もラベル親として許可
const BLOCK_LABEL_DIV_PARENT_OK = true;
const BLOCK_LABEL_MIN_FOLLOWING_CHARS = 10;
// §43: ハイライト用 phrasing（文中に置ける短いタグ）。div/p/img 等の塊要素は含めない
const PHRASING_HIGHLIGHT_TAGS = new Set([
  'BR', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'CODE', 'SMALL', 'MARK', 'S', 'SUB', 'SUP'
]);
// 構造ラベル上限（コロン付き / ol・ul>li>p 先頭見出し / p 先頭 b）
const BLOCK_LABEL_MAX_COLON_CHARS = 40;
// p 先頭 b の直前に許容するプレフィックス（💡 等）の最大字数
const BLOCK_LABEL_MAX_LEADING_PREFIX_CHARS = 4;
let highlightOverlayRoot = null;
let currentHighlightRange = null;
let currentHighlightRects = null;

function getDominantVisualLineTopFromRects(rects, lineTolerance) {
  const tops = getVisualLineTopsFromClientRects(rects, lineTolerance);
  return tops.length === 1 ? tops[0] : null;
}

function isPointInCurrentHighlight(clientX, clientY) {
  if (currentHighlightRects && currentHighlightRects.length > 0) {
    const rightPad = typeof HIGHLIGHT_STICKY_RIGHT_PADDING_PX !== 'undefined'
      ? HIGHLIGHT_STICKY_RIGHT_PADDING_PX
      : 0;
    return clientPointInClientRects(currentHighlightRects, clientX, clientY, { rightPad });
  }
  return !!(
    currentHighlightRange &&
    clientPointInStickyHighlightRects(currentHighlightRange, clientX, clientY)
  );
}

function isPointInCurrentHighlightOverlay(clientX, clientY) {
  if (!highlightOverlayRoot) return false;
  const segments = highlightOverlayRoot.querySelectorAll('.yomup-highlight-underline-segment');
  const linePad = typeof HIGHLIGHT_RECT_MERGE_LINE_TOLERANCE_PX !== 'undefined'
    ? HIGHLIGHT_RECT_MERGE_LINE_TOLERANCE_PX
    : 6;
  for (let i = 0; i < segments.length; i++) {
    const rect = segments[i].getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top - linePad &&
      clientY <= rect.bottom + linePad
    ) {
      return true;
    }
  }
  return false;
}

// getClientRects の矩形をマージして枠の細片化を抑える（テストNG時は false に戻す）
const ENABLE_HIGHLIGHT_OVERLAY_RECT_MERGE = true;
const HIGHLIGHT_RECT_MERGE_LINE_TOLERANCE_PX = 6;
const HIGHLIGHT_RECT_MERGE_GAP_TOLERANCE_PX = 12;
// 大フォント折り返し行 ClientRect（行同士 Y 重なり）の下線: top + lh + gap
const HIGHLIGHT_UNDERLINE_WRAPPED_LINE_GAP_PX = 4;
// 日経型: 全面 <a> のヒット矩形が直下テキスト矩形より明らかに大きいときだけゴースト扱い
const GHOST_OVERLAY_MIN_AREA_RATIO = 2.5;
const GHOST_OVERLAY_MIN_WIDTH_RATIO = 1.8;
const GHOST_OVERLAY_MIN_HEIGHT_RATIO = 1.8;


// === ページの読み込み状態に応じて初期化処理を実行================================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}


// == ページ読み込み完了時の処理 ===============================================
function init() {
  debugLog('拡張機能のContent Scriptが読み込まれました');

  bindSharedHighlightStorageListener();

  // §71: iframe はポップアップ復元なし。共有ハイライトのみ同期
  if (!isTopBrowsingContext()) {
    bootstrapSharedHighlightState();
    sessionStorage.removeItem(SESSIONSTRG_PAGE_TRANSITION);
    return;
  }

  // ページ遷移時かブラウザ起動時かを判定（sessionStorageを使用）
  const pageTransitionFlag = sessionStorage.getItem(SESSIONSTRG_PAGE_TRANSITION);
  isPageTransition = pageTransitionFlag === 'true';
  debugLog('ページ遷移判定:', isPageTransition ? 'ページ遷移' : 'ブラウザ起動');

  // ポップアップ表示状態を確認
  const isPopupMainVisible = localStorage.getItem(LOCALSTRG_YOMUP_REDISP);
  debugLog('ポップアップ復元チェック:', isPopupMainVisible);
  
  // ボタンの状態をlocalStorageから復元（ページ遷移時のみ）
  if (ENABLE_BUTTON_STATE_RESTORE && isPageTransition && isPopupMainVisible === 'true') { //有効 or 無効を定数で切り替え、かつページ遷移時のみ
    // 電球ボタン
    const savedHighLight = localStorage.getItem(LOCALSTRG_HIGHLIGHT_ONOFF);
    if (savedHighLight === 'true') {
      highLightOnOff = true;
      attachHighlightListeners(); // 復元時にリスナーを追加
      persistHighlightOnOffToChromeStorage(true);
    }

    // サブポップアップボタン
    const savedSubPopup = localStorage.getItem(LOCALSTRG_SUBPOPUP_ONOFF);
    if (savedSubPopup === 'true') subPopupOnOff = true;
  } else {
    // トップ: storage と localStorage の初期同期（iframe 用の種）
    bootstrapSharedHighlightState();
  }

  if (isPageTransition && isPopupMainVisible === 'true') {
    debugLog('ポップアップを復元します');
    // 少し遅延させてからポップアップを表示（2000msくらいが実測で妥当）
    setTimeout(() => {
      debugLog('executeYomuP()を実行します');
      executeYomuP();
      // 状態をクリア
      localStorage.removeItem(LOCALSTRG_YOMUP_REDISP);
      debugLog('localStorageをクリアしました');
    }, 2000);
  } else if (isPopupMainVisible === 'true') {
    // ブラウザ起動時などページ遷移以外では復元しない（§20）
    localStorage.removeItem(LOCALSTRG_YOMUP_REDISP);
    debugLog('ページ遷移以外のためポップアップ復元フラグをクリアしました');
  }

  // sessionStorageのフラグを削除（次回の判定のため）
  sessionStorage.removeItem(SESSIONSTRG_PAGE_TRANSITION);

}; //end init


// === 拡張機能ボタンクリック時の処理（Background scriptからのメッセージ受信）======
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  // 拡張機能アイコンがクリックされた場合
  if (request && request.action === 'extensionIconClicked') {
    debugLog('Content Script: 読むプ拡張機能ボタンを押しました');
  }

  // 読むプが選択された場合（右クリックメニュー）
  if (request && request.action === 'executeYomuP') {
    // §71: iframe にはポップアップを出さない（トップのみ）
    if (isTopBrowsingContext()) {
      executeYomuP();
    }
  }

  // レスポンスを返す
  sendResponse({ success: true });

  return true;
});


// === 読むプ本体処理 =========================================================
function executeYomuP() {
  if (!isTopBrowsingContext()) return;

  // ポップアップが表示されているかどうかを確認
  const existingPopup = document.getElementById(ID_YOMUP_POPUP_CONTAINER);
  
  if (existingPopup) {
    // ポップアップが表示されている場合は閉じる（ダブルクリックと同じ動作）
    hideYomuPPopup();
  } else {
    // ポップアップが表示されていない場合は表示する
    const charCountInfo = getCharCountInfo(); // 共通関数を使用

    if (charCountInfo.selectedText && charCountInfo.selectedLength > 0) {
      //選択テキストがある場合
      showYomuPPopup(
        charCountInfo.textLengthAll,
        charCountInfo.readingTimeAll,
        charCountInfo.selectedText,
        charCountInfo.selectedLength,
        charCountInfo.selectedReadingTime,
        charCountInfo.unitLabelAll
      );
    } else {
      //選択テキストがない場合
      showYomuPPopup(
        charCountInfo.textLengthAll,
        charCountInfo.readingTimeAll,
        null,
        0,
        0,
        charCountInfo.unitLabelAll
      );
    }
  }
} //end executeYomuP


// === 文字数情報を取得する共通関数 ===========================================
function removeRubyFuriganaFromSubtree(root) {
  if (!root || !root.querySelectorAll) return;
  const furiganaEls = root.querySelectorAll('rt, rp');
  for (let i = furiganaEls.length - 1; i >= 0; i--) {
    furiganaEls[i].remove();
  }
}

function removeYomupUiFromSubtree(root) {
  if (!root || !root.querySelectorAll) return;
  const popup = root.querySelector('#' + ID_YOMUP_POPUP_CONTAINER);
  if (popup) popup.remove();
  const subPopup = root.querySelector('#' + ID_SUBPOPUP_CONTAINER);
  if (subPopup) subPopup.remove();
}

function shouldRejectRubyFuriganaTextNode(node) {
  const parent = node.parentElement;
  if (!parent) return false;
  if (parent.closest('rt, rp')) return true;
  // §54 GL-2: 全体カウント／言語判定に script 等の JS ソースを混ぜない（ハイライト収集と同型）
  if (parent.closest('script, style, noscript, template')) return true;
  if (parent.closest('#' + ID_YOMUP_POPUP_CONTAINER + ', #' + ID_SUBPOPUP_CONTAINER)) return true;
  return false;
}

function collectTextExcludingRubyFurigana(root) {
  if (!root) return '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return shouldRejectRubyFuriganaTextNode(node)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    }
  });
  let text = '';
  while (walker.nextNode()) {
    text += walker.currentNode.textContent || '';
  }
  return text;
}

function collectRangeTextExcludingRubyFurigana(range) {
  if (!range || range.collapsed) return '';
  const root = range.commonAncestorContainer;
  const rootEl = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
  if (!rootEl) {
    try {
      return (range.toString() || '').trim();
    } catch (_e) {
      return '';
    }
  }
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (shouldRejectRubyFuriganaTextNode(node)) return NodeFilter.FILTER_REJECT;
      try {
        if (typeof range.intersectsNode === 'function' && !range.intersectsNode(node)) {
          return NodeFilter.FILTER_REJECT;
        }
      } catch (_e) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let text = '';
  while (walker.nextNode()) {
    text += walker.currentNode.textContent || '';
  }
  return text;
}

function getInnerTextExcludingRubyFurigana(rootElement) {
  if (!rootElement) return '';
  return collectTextExcludingRubyFurigana(rootElement).trim();
}

function getRangeTextExcludingRubyFurigana(range) {
  if (!range || range.collapsed) return '';
  return collectRangeTextExcludingRubyFurigana(range);
}

function getSelectionTextExcludingRubyFurigana(selection) {
  if (!selection || selection.rangeCount === 0) return '';
  let text = '';
  for (let i = 0; i < selection.rangeCount; i++) {
    text += getRangeTextExcludingRubyFurigana(selection.getRangeAt(i));
  }
  return text.trim();
}

function refreshYomuPPopupTotalInfo() {
  const existingPopup = document.getElementById(ID_YOMUP_POPUP_CONTAINER);
  if (!existingPopup?.shadowRoot) return;
  const totalInfo = existingPopup.shadowRoot.querySelector('.total-info');
  if (!totalInfo) return;
  const charCountInfo = getCharCountInfo();
  totalInfo.textContent = formatUiTotalLine(
    charCountInfo.textLengthAll,
    charCountInfo.unitLabelAll,
    charCountInfo.readingTimeAll
  );
}

function getCharCountInfo() {
  const pageRoot = findPageMainContentRoot();
  const bodyText = getInnerTextExcludingRubyFurigana(pageRoot);
  const languageModeAll = detectLanguageMode(bodyText);
  const unitCountAll = countUnits(bodyText, languageModeAll);
  const readingTimeAll = calculateReadingTime(unitCountAll, languageModeAll);

  const selection = window.getSelection();
  const selectedText = getSelectionTextExcludingRubyFurigana(selection);
  const hasSelection = selectedText.length > 0;
  const languageModeSelected = hasSelection
    ? detectLanguageMode(selectedText, selection.anchorNode)
    : languageModeAll;
  const unitCountSelected = hasSelection
    ? countUnits(selectedText, languageModeSelected)
    : 0;
  const selectedReadingTime = hasSelection
    ? calculateReadingTime(unitCountSelected, languageModeSelected)
    : 0;

  return {
    textLengthAll: unitCountAll,
    readingTimeAll,
    languageModeAll,
    unitLabelAll: getUnitLabel(languageModeAll),
    selectedText: hasSelection ? selectedText : null,
    selectedLength: unitCountSelected,
    selectedReadingTime,
    languageModeSelected,
    unitLabelSelected: getUnitLabel(languageModeSelected)
  };
}


// === 読書時間計算関数 ================== ===================================
function calculateReadingTime(unitCount, languageMode = LANGUAGE_MODE_JA) {
  if (typeof calculateReadingTimeWithSettings === 'function') {
    return calculateReadingTimeWithSettings(unitCount, languageMode);
  }
  if (languageMode === LANGUAGE_MODE_EN) {
    return Math.round(unitCount * (60 / WORDS_PER_MINUTE));
  }
  return Math.round(unitCount * (60 / READING_SPEED_CHARS_PER_MIN));
}


// === 言語モード・単位カウント（フェーズ A）===================================
function getUnitLabel(languageMode) {
  return languageMode === LANGUAGE_MODE_EN ? '語' : '字';
}

// 語数: 空白区切り。ハイフン語は1語、句読点直後の空トークンは filter で除外
function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

function countUnits(text, languageMode) {
  if (languageMode === LANGUAGE_MODE_EN) {
    return countWords(text);
  }
  return (text || '').trim().length;
}

function normalizeLangTag(lang) {
  if (!lang) return null;
  const primary = lang.trim().toLowerCase().split(/[-_]/)[0];
  if (primary === 'ja' || primary === 'jp') return LANGUAGE_MODE_JA;
  if (primary === 'en') return LANGUAGE_MODE_EN;
  return null;
}

function detectLanguageByHeuristic(text) {
  const sample = (text || '').slice(0, 4000);
  if (!sample.trim()) return LANGUAGE_MODE_JA;

  const cjk = (sample.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const letters = (sample.match(/[A-Za-z]/g) || []).length;
  const denom = cjk + letters;
  const ratio = denom > 0 ? cjk / denom : 0;
  if (ratio >= CJK_RATIO_THRESHOLD) return LANGUAGE_MODE_JA;

  const words = countWords(sample);
  if (words >= 3 && letters > cjk * 2) return LANGUAGE_MODE_EN;
  return LANGUAGE_MODE_JA;
}

// §25: ページ全体カウント用 — UI クロームを除き README / article 等を優先
const PAGE_MAIN_CONTENT_MIN_CHARS = 50;
const PAGE_MAIN_CONTENT_SELECTORS = [
  '#readme article.markdown-body',
  '#readme .markdown-body',
  '#readme article',
  '#readme',
  'article.markdown-body',
  'article',
  'main',
  '[role="main"]'
];

function findPageMainContentRoot() {
  for (const selector of PAGE_MAIN_CONTENT_SELECTORS) {
    const el = document.querySelector(selector);
    if (!el) continue;
    if (getInnerTextExcludingRubyFurigana(el).length >= PAGE_MAIN_CONTENT_MIN_CHARS) {
      return el;
    }
  }
  return document.body;
}

function detectLanguageMode(text, contextNode) {
  const docElement = document.documentElement;
  let el = contextNode;
  if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  // `<html lang>` は祖先走査に含めない（GitHub 等 UI=en + 本文=ja の誤判定防止・§25）
  while (el && el.nodeType === Node.ELEMENT_NODE && el !== docElement) {
    const fromAttr = normalizeLangTag(el.getAttribute && el.getAttribute('lang'));
    if (fromAttr) return fromAttr;
    el = el.parentElement;
  }

  if ((text || '').trim()) {
    return detectLanguageByHeuristic(text);
  }

  const docLang = normalizeLangTag(docElement.getAttribute('lang'));
  if (docLang) return docLang;

  return LANGUAGE_MODE_JA;
}


// === 文字数情報のみを更新する関数 ===========================================
function updateCharCountInfo() {
  const existingPopup = document.getElementById(ID_YOMUP_POPUP_CONTAINER);
  if (!existingPopup) {
    // ポップアップが存在しない場合は早期リターン（エラー処理）
    return;
  }

  // 共通関数で文字数情報を取得
  const charCountInfo = getCharCountInfo();

  // 既存ポップアップ内の文字数情報のみを更新
  const shadow = existingPopup.shadowRoot;
  if (!shadow) return;

  const selectionInfo = shadow.querySelector('.selection-info');

  if (selectionInfo) {
    setSelectionInfoContent(
      selectionInfo,
      charCountInfo.selectedText,
      charCountInfo.selectedLength,
      charCountInfo.selectedReadingTime,
      charCountInfo.unitLabelSelected
    );
  }
}

// === 時間表示フォーマット関数 ================================================
function formatReadingTime(seconds) {
  return formatUiReadingTime(seconds);
}

// === 選択範囲情報を表示する共通関数 ==========================================
function setSelectionInfoContent(
  selectionInfoElement,
  selectedText,
  selectedLength,
  selectedReadingTime,
  unitLabel = '字'
) {
  if (!selectionInfoElement) return;

  if (selectedText && selectedLength > 0) {
    // セキュリティ対策: テキストを安全に処理
    const startText = selectedText.substring(0, 3);
    const endText = selectedText.substring(selectedText.length - 3);

    // innerHTMLの代わりに安全な方法で表示
    selectionInfoElement.textContent = ''; // クリア

    // 1行目: 選択範囲の表示
    const line1 = document.createElement('div');
    line1.textContent = formatUiSelectionLine(startText, endText);
    selectionInfoElement.appendChild(line1);

    const line2 = document.createElement('div');
    line2.textContent = formatUiSelectionStats(selectedLength, unitLabel, selectedReadingTime);
    selectionInfoElement.appendChild(line2);
  } else {
    selectionInfoElement.textContent = formatUiSelectionEmpty();
  }
}  //end setSelectionInfoContent


// === 読むプのポップアップ本体を表示 ===========================================
function showYomuPPopup(
  textLength,
  readingTime,
  selectedText = null,
  selectedLength = 0,
  selectedReadingTime = 0,
  unitLabel = '字'
) {
  // 既存のポップアップを削除
  hideYomuPPopup(true);
  
  // ページ遷移時かブラウザ起動時かを判定（グローバル変数を使用）
  // isPageTransitionはinit()で設定される

  // Shadow DOMコンテナを作成
  const container = document.createElement('div');
  container.id = ID_YOMUP_POPUP_CONTAINER;

  const shadow = container.attachShadow({ mode: 'open' });

  // スタイルシート（CSS）
  const isEnPopup = getYomupUiLocale() === 'en';
  const popupLocaleClass = isEnPopup ? 'yomup-popup-en' : 'yomup-popup-ja';
  const style = document.createElement('style');
  style.textContent = `
  .${CLASS_YOMUP_POPUP} {
    position: fixed !important;
    top: var(--YomuP-popup-top, 30%) !important;
    left: var(--YomuP-popup-left, 10%) !important;
    background: #f8f9fa !important;
    border: 1px solid #dee2e6 !important;
    border-radius: 8px !important;
    padding: 6px 8px !important;
    font-size: 14px !important;
    font-family: Arial, sans-serif !important;
    color: #495057 !important;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1) !important;
    z-index: 90001 !important;
    width: 180px !important;
    cursor: move !important;
    user-select: none !important;
    text-align: center !important;
    line-height: 1.2 !important;
    box-sizing: border-box !important;
  }
  .${CLASS_YOMUP_POPUP}.yomup-popup-en {
    padding: 6px 8px !important;
  }
  .yomup-popup-en .total-info,
  .yomup-popup-en .selection-info {
    white-space: normal !important;
    word-break: break-word !important;
  }
  .yomup-popup-en .reading-settings-row {
    gap: 0 !important;
    margin-top: 6px !important;
  }
  .yomup-popup-en .reading-speed-label {
    margin-right: 1px !important;
  }
  .yomup-popup-en .reading-speed-select-wrapper {
    flex: 1 1 auto !important;
    min-width: 0 !important;
    max-width: 104px !important;
  }
  .yomup-popup-en .reading-speed-select {
    max-width: 100% !important;
    padding: 2px 1px !important;
  }
  .yomup-popup-en .reading-mode-button {
    padding: 2px 3px !important;
    min-width: 18px !important;
    margin-left: 1px !important;
  }
  .yomup-popup-icon {
    position: absolute !important;
    top: 6px !important;
    left: 4px !important;
    width: var(--yomup-icon-size, 14px) !important;
    height: var(--yomup-icon-size, 14px) !important;
    z-index: 1 !important;
  }
  .yomup-popup-icon img {
    width: 100% !important;
    height: 100% !important;
    display: block !important;
  }
  .total-info {
    font-weight: bold !important;
    margin-bottom: 4px !important;
    margin-left: 10px !important;
    font-size: 12px !important;
  }
  .selection-info {
    font-size: 12px !important;
    color: #6c757d !important;
    display: flex !important;
    flex-direction: column !important;
    justify-content: center !important;
    align-items: center !important;
    height: auto !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  .stopwatch-container {
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 8px !important;
    margin-top: 8px !important;
    flex-direction: column !important;
  }
  .stopwatch-row {
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 8px !important;
    width: 100% !important;
  }
  .stopwatch {
    text-align: center !important;
    color: #6c757d !important;
    font-size: 16px !important;
    font-weight: bold !important;
    line-height: 1.2 !important;
  }
  .stopwatch-limit-select-wrapper {
    position: relative !important;
    display: inline-block !important;
  }
  .stopwatch-limit-select {
    font-size: 12px !important;
    padding: 2px 4px !important;
    border: 1px solid #dee2e6 !important;
    border-radius: 4px !important;
    background: white !important;
    color: #495057 !important;
    cursor: pointer !important;
    pointer-events: auto !important;
    z-index: 10 !important;
    position: relative !important;
  }
  .stopwatch-limit-select-wrapper .tooltip {
    white-space: nowrap !important;
    left: 50% !important;
    transform: translateX(-50%) !important;
  }
  .stopwatch-loop-count {
    font-size: 11px !important;
    color: #6c757d !important;
    text-align: center !important;
    display: none !important; /* デフォルトは非表示 */
  }
  .stopwatch-loop-count.visible {
    display: block !important;
  }
  .stopwatch-button-container {
    margin-left: 4px !important; /*微調整*/
    vertical-align: middle !important;
  }
  .stopwatch-control-button {
    display: inline-block !important;
    margin-right: 4px !important;
    cursor: pointer !important;
    position: relative !important;
  }
  .play-icon {
    margin-top: 8px !important;
    text-align: center !important;
    color: #6c757d !important;
    font-size: 16px !important;
    line-height: 1.2 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 6px !important;
  }
  .strCnt-button,
  .lightbulb-button,
  .stopwatch-button,
  .hourglass-button {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    margin-right: 0 !important;
    cursor: pointer !important;
    position: relative !important;
    vertical-align: middle !important;
    box-sizing: border-box !important;
    /* 4ボタン共通: 影付き枠（高さ揃え） */
    border: 1px solid #ced4da !important;
    border-radius: 6px !important;
    background-color: #f8f9fa !important;
    padding: 3px 4px !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12) !important;
  }
  /* 主機能: ハイライトだけ枠色をやや黒寄り（影は他と同じ） */
  .lightbulb-button {
    border-color: #6c757d !important;
  }
  /* ON: 枠内を赤で埋める（枠線は残す）— ハイライト／砂時計／ストップウォッチ共通 */
  .lightbulb-button:has(img.active),
  .hourglass-button:has(img.active),
  .stopwatch-button:has(img.active) {
    background-color: red !important;
  }
  .lightbulb-button img.active,
  .hourglass-button img.active,
  .stopwatch-button img.active {
    background-color: transparent !important;
    border-radius: 0 !important;
    padding: 0px !important;
  }
  /* ツールチップのスタイル */
  .tooltip {
    position: absolute !important;
    top: auto !important;
    bottom: 100% !important;
    margin-bottom: 5px !important;
    left: 50% !important;
    transform: translateX(-50%) !important;
    background-color: rgba(0, 0, 0, 0.5) !important;
    color: white !important;
    padding: 4px 8px !important;
    border-radius: 4px !important;
    font-size: 12px !important;
    white-space: nowrap !important;
    opacity: 0 !important;
    visibility: hidden !important;
    transition: opacity 0.3s ease, visibility 0.3s ease !important;
    pointer-events: none !important;
    z-index: 1000 !important;
    line-height: 1.2 !important;
  }
  .tooltip.show {
    opacity: 1 !important;
    visibility: visible !important;
  }
  .yomup-popup-icon .tooltip {
    white-space: nowrap !important;
    left: -8px !important; /* ポップアップの左端に揃える */
    transform: none !important;
  }
  .strCnt-button .tooltip {
    white-space: nowrap !important;
    left: -12px !important; /* ポップアップの左端に揃える */
    transform: none !important;
  }
  .reading-settings-row {
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 4px !important;
    margin-top: 6px !important;
    width: 100% !important;
  }
  .reading-speed-label {
    font-size: 11px !important;
    color: #6c757d !important;
    flex-shrink: 0 !important;
  }
  .reading-speed-select-wrapper {
    position: relative !important;
    display: inline-block !important;
    flex: 1 1 auto !important;
    min-width: 0 !important;
  }
  .reading-speed-select {
    font-size: 11px !important;
    padding: 2px 2px !important;
    border: 1px solid #dee2e6 !important;
    border-radius: 4px !important;
    background: white !important;
    color: #495057 !important;
    cursor: pointer !important;
    width: 100% !important;
    max-width: 108px !important;
    pointer-events: auto !important;
  }
  .reading-mode-button {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    box-sizing: border-box !important;
    min-width: 20px !important;
    height: auto !important;
    padding: 2px 5px !important;
    border: 1px solid #dee2e6 !important;
    border-radius: 4px !important;
    background: white !important;
    color: #495057 !important;
    font-size: 11px !important;
    line-height: 1.2 !important;
    cursor: pointer !important;
    position: relative !important;
    flex-shrink: 0 !important;
    pointer-events: auto !important;
  }
  .reading-mode-button.active {
    background-color: #fde8e8 !important;
    border-color: #e8a0a0 !important;
    color: #b54747 !important;
  }
  .reading-speed-select-wrapper .tooltip,
  .reading-mode-button .tooltip {
    white-space: nowrap !important;
    left: 50% !important;
    transform: translateX(-50%) !important;
  }
  .donation-link-row {
    margin-top: 6px !important;
    padding-top: 4px !important;
    border-top: 1px solid #e9ecef !important;
    position: relative !important;
  }
  .donation-link {
    font-size: 10px !important;
    color: #868e96 !important;
    text-decoration: none !important;
    cursor: pointer !important;
    pointer-events: auto !important;
    display: inline-block !important;
    line-height: 1.3 !important;
    position: relative !important;
  }
  .donation-link-row .tooltip {
    white-space: normal !important;
    width: 168px !important;
    max-width: 168px !important;
    box-sizing: border-box !important;
    text-align: center !important;
    line-height: 1.4 !important;
    left: 50% !important;
    transform: translateX(-50%) !important;
    /* 上に出すとポップアップ本体が隠れるため下側に表示 */
    top: 100% !important;
    bottom: auto !important;
    margin-top: 0 !important;
    margin-bottom: 0 !important;
    /* ホバー継続用: リンクとの隙間を透明 padding でつなぎ、カーソルを受け取る */
    padding-top: 6px !important;
    background-clip: content-box !important;
    pointer-events: auto !important;
  }
  .donation-link:hover {
    color: #495057 !important;
    text-decoration: underline !important;
  }
`;

  // ポップアップ要素
  const popup = document.createElement('div');
  popup.className = `${CLASS_YOMUP_POPUP} ${popupLocaleClass}`;

  // 左上にアイコンを追加
  const popupIcon = document.createElement('div');
  popupIcon.className = 'yomup-popup-icon';
  popupIcon.innerHTML = `<img src="${chrome.runtime.getURL('icon48.png')}" alt="${t('altIcon')}" style="width: 100%; height: 100%;"><div class="tooltip">${t('appNameTooltip', { version: YOMUP_VERSION })}</div>`;
  popup.appendChild(popupIcon);

  // アイコンを横並びで配置
  // 文字カウントボタン
  const strCntButton = document.createElement('div');
  strCntButton.className = 'strCnt-button';
  strCntButton.innerHTML = `<img src="${chrome.runtime.getURL('images/GB01_object-group-solid-full.svg')}" width="16" height="16" alt="${t('altCharCount')}" style="cursor: pointer;"><div class="tooltip">${t('countSelectionTooltip')}</div>`;

  // 電球ボタン
  const lightbulbButton = document.createElement('div');
  lightbulbButton.className = 'lightbulb-button';
  lightbulbButton.innerHTML = `<img src="${chrome.runtime.getURL('images/GA01_lightbulb-solid-full.svg')}" width="16" height="16" alt="${t('altLightbulb')}" style="cursor: pointer;"><div class="tooltip">${t('highlightTooltip')}</div>`;

  // ストップウォッチボタン
  const stopwatchButton = document.createElement('div');
  stopwatchButton.className = 'stopwatch-button';
  stopwatchButton.innerHTML = `<img src="${chrome.runtime.getURL('images/GB02_stopwatch-solid-full.svg')}" width="16" height="16" alt="${t('altStopwatch')}" style="cursor: pointer;"><div class="tooltip">${t('stopwatchTooltip')}</div>`;

  // 砂時計ボタンを作成
  const hourglassButton = document.createElement('div');
  hourglassButton.className = 'hourglass-button';
  hourglassButton.innerHTML = `<img src="${chrome.runtime.getURL('images/GA02_hourglass-start-solid-full.svg')}" width="16" height="16" alt="${t('altHourglass')}" style="cursor: pointer;"><div class="tooltip">${t('partialTimerTooltip')}</div>`;


  // 文字数カウントボタンのクリックイベントを追加
  const strCntIcon = strCntButton.querySelector('img');
  strCntIcon.addEventListener('click', function (e) {
    e.stopPropagation(); // イベントの伝播を停止
    this.classList.toggle('active');
    updateCharCountInfo(); // 文字数情報箇所を更新
  });


  // 電球アイコンのクリックイベントを追加
  const lightbulbIcon = lightbulbButton.querySelector('img');
  lightbulbIcon.addEventListener('click', function (e) {
    e.stopPropagation(); // イベントの伝播を停止
    this.classList.toggle('active');
    toggleHighlightMode(); // ハイライト処理を実行
  });


  // ストップウォッチ表示要素を追加（コンテナで囲む）
  const stopwatchContainer = document.createElement('div');
  stopwatchContainer.className = 'stopwatch-container';
  stopwatchContainer.style.setProperty('display', 'none', 'important'); // 初期状態は非表示

  // ストップウォッチ表示とドロップダウンを横並びにするコンテナ
  const stopwatchRow = document.createElement('div');
  stopwatchRow.className = 'stopwatch-row';

  const stopwatch = document.createElement('div');
  stopwatch.className = 'stopwatch';
  stopwatch.textContent = '00:00';

  // ドロップダウンリストを追加（ラッパーで囲む）
  const limitSelectWrapper = document.createElement('div');
  limitSelectWrapper.className = 'stopwatch-limit-select-wrapper';
  
  const limitSelect = document.createElement('select');
  limitSelect.className = 'stopwatch-limit-select';
  limitSelect.innerHTML = buildStopwatchIntervalOptionsHtml();
  limitSelect.value = '-';

  const limitSelectTooltip = document.createElement('div');
  limitSelectTooltip.className = 'tooltip';
  limitSelectTooltip.textContent = t('intervalMinutesTooltip');
  
  limitSelectWrapper.appendChild(limitSelect);
  limitSelectWrapper.appendChild(limitSelectTooltip);

  // ループ回数表示を追加
  const loopCountDisplay = document.createElement('div');
  loopCountDisplay.className = 'stopwatch-loop-count';
  loopCountDisplay.textContent = formatUiLoopCount(0);

  // 横並びコンテナにストップウォッチ、ドロップダウン、ループ回数表示を追加
  stopwatchRow.appendChild(stopwatch);
  stopwatchRow.appendChild(limitSelectWrapper);
  stopwatchRow.appendChild(loopCountDisplay);
  
  // 外側コンテナに横並びコンテナを追加
  stopwatchContainer.appendChild(stopwatchRow);

  // ストップウォッチ用のボタンコンテナを作成
  const stopwatchButtonContainer = document.createElement('div');
  stopwatchButtonContainer.className = 'stopwatch-button-container';
  stopwatchButtonContainer.style.setProperty('display', 'none', 'important'); // 強制的に非表示

  // 再生ボタン
  const playButton = document.createElement('div');
  playButton.className = 'stopwatch-control-button';
  playButton.innerHTML = `<img src="${chrome.runtime.getURL('images/GC01_play-solid-full.svg')}" width="10" height="10" alt="${t('altPlay')}" style="cursor: pointer;">`;

  // 一時停止ボタン
  const pauseButton = document.createElement('div');
  pauseButton.className = 'stopwatch-control-button';
  pauseButton.innerHTML = `<img src="${chrome.runtime.getURL('images/GC02_pause-solid-full.svg')}" width="10" height="10" alt="${t('altPause')}" style="cursor: pointer;">`;
  pauseButton.style.display = 'none'; // 初期状態は非表示

  // 停止ボタン
  const stopButton = document.createElement('div');
  stopButton.className = 'stopwatch-control-button';
  stopButton.innerHTML = `<img src="${chrome.runtime.getURL('images/GC03_stop-solid-full.svg')}" width="10" height="10" alt="${t('altStop')}" style="cursor: pointer;">`;

  // ストップウォッチ制御ボタンをコンテナに追加
  stopwatchButtonContainer.appendChild(playButton);
  stopwatchButtonContainer.appendChild(stopButton);

  // ストップウォッチボタンのクリックイベントを追加
  const stopwatchIcon = stopwatchButton.querySelector('img'); // 追加
  stopwatchButton.addEventListener('click', function (e) {
    e.stopPropagation();
    // ストップウォッチの表示・非表示を制御（activeクラスで判定）
    const isCurrentlyVisible = stopwatchIcon.classList.contains('active');
    
    if (!isCurrentlyVisible) {
      // 表示
      stopwatchOnOff = true;
      stopwatchContainer.style.setProperty('display', 'flex', 'important');
      stopwatchButtonContainer.style.setProperty('display', 'block', 'important');
      stopwatchIcon.classList.add('active');
    } else {
      // 非表示
      // 動作中の場合は停止してリセット
      if (stopwatchTimerID) {
        try {
          // タイマーを停止
          clearInterval(stopwatchTimerID);
          stopwatchTimerID = null;
          stopwatchSeconds = 0;
          stopwatchLoopCount = 0;
          if (stopwatch && stopwatch.textContent !== undefined) {
            stopwatch.textContent = '00:00';
          }
          if (loopCountDisplay) {
            loopCountDisplay.textContent = formatUiLoopCount(0);
          }
          // ボタンを再生/停止に戻す
          if (playButton?.parentNode) playButton.remove();
          if (pauseButton?.parentNode) pauseButton.remove();
          if (stopButton?.parentNode) stopButton.remove();
          if (stopwatchButtonContainer) {
            stopwatchButtonContainer.appendChild(playButton);
            stopwatchButtonContainer.appendChild(stopButton);
          }
        } catch (error) {
          debugError('ストップウォッチ停止処理中にエラーが発生:', error);
        }
      }
      // 非表示にする（ループ回数は保持しない）
      stopwatchOnOff = false;
      stopwatchContainer.style.setProperty('display', 'none', 'important');
      stopwatchButtonContainer.style.setProperty('display', 'none', 'important');
      stopwatchIcon.classList.remove('active');
    }
  });

  // ドロップダウンリストのクリックイベント（ドラッグとの干渉を防ぐ）
  limitSelect.addEventListener('click', function (e) {
    e.stopPropagation();
    // ツールチップを非表示にする
    if (limitSelectTooltip) {
      limitSelectTooltip.classList.remove('show');
    }
  });

  limitSelect.addEventListener('mousedown', function (e) {
    e.stopPropagation();
    // ツールチップを非表示にする
    if (limitSelectTooltip) {
      limitSelectTooltip.classList.remove('show');
    }
  });

  // ドロップダウンリストの変更イベント
  limitSelect.addEventListener('change', function (e) {
    e.stopPropagation();
    const selectedValue = this.value;
    
    // ストップウォッチを停止してリセット
    if (stopwatchTimerID) {
      clearInterval(stopwatchTimerID);
      stopwatchTimerID = null;
    }
    stopwatchSeconds = 0;
    stopwatchLoopCount = 0;
    stopwatch.textContent = '00:00';
    loopCountDisplay.textContent = formatUiLoopCount(0);
    
    // ループ回数表示の表示/非表示を切り替え
    if (selectedValue === '-') {
      stopwatchLimitMinutes = null;
      loopCountDisplay.classList.remove('visible');
    } else {
      stopwatchLimitMinutes = parseInt(selectedValue);
      loopCountDisplay.classList.add('visible');
      loopCountDisplay.textContent = formatUiLoopCount(0);
    }
    
    // ボタンを再生/停止に戻す
    if (playButton?.parentNode) playButton.remove();
    if (pauseButton?.parentNode) pauseButton.remove();
    if (stopButton?.parentNode) stopButton.remove();
    if (stopwatchButtonContainer) {
      stopwatchButtonContainer.appendChild(playButton);
      stopwatchButtonContainer.appendChild(stopButton);
    }
  });

  // 再生ボタンのクリックイベント
  playButton.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!stopwatchTimerID) {
      try {
        // ストップウォッチ開始
        stopwatchTimerID = setInterval(() => {
          try {
            stopwatchSeconds++;
            
            // ループタイマーの上限チェック
            if (stopwatchLimitMinutes !== null) {
              const limitSeconds = stopwatchLimitMinutes * 60;
              if (stopwatchSeconds >= limitSeconds) {
                // 上限に達したら0にリセットしてループ回数を増やす
                stopwatchSeconds = 0;
                stopwatchLoopCount++;
                loopCountDisplay.textContent = formatUiLoopCount(stopwatchLoopCount);
              }
            }
            
            const minutes = Math.floor(stopwatchSeconds / 60);
            const seconds = stopwatchSeconds % 60;
            if (stopwatch && stopwatch.textContent !== undefined) {
              stopwatch.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            }
          } catch (error) {
            debugError('ストップウォッチ更新中にエラーが発生:', error);
            // タイマーを停止してエラーを防ぐ
            if (stopwatchTimerID) {
              clearInterval(stopwatchTimerID);
              stopwatchTimerID = null;
            }
          }
        }, 1000);
        // playButtonをpauseButtonに置き換え
        if (playButton?.parentNode) playButton.remove();
        if (stopButton?.parentNode) stopButton.remove();
        if (stopwatchButtonContainer) {
          stopwatchButtonContainer.appendChild(pauseButton);
          stopwatchButtonContainer.appendChild(stopButton);
        }
      } catch (error) {
        debugError('ストップウォッチ開始中にエラーが発生:', error);
      }
    }
  });

  // 一時停止ボタンのクリックイベント
  pauseButton.addEventListener('click', function (e) {
    e.stopPropagation();
    try {
      if (stopwatchTimerID) {
        clearInterval(stopwatchTimerID);
        stopwatchTimerID = null;
        if (pauseButton?.parentNode) pauseButton.remove();
        if (stopButton?.parentNode) stopButton.remove();
        if (stopwatchButtonContainer) { // nullチェック
          stopwatchButtonContainer.appendChild(playButton);
          stopwatchButtonContainer.appendChild(stopButton);
        }
      }
    } catch (error) {
      debugError('一時停止処理中にエラーが発生:', error);
    }
  });

  // 停止ボタンのクリックイベント
  stopButton.addEventListener('click', function (e) {
    e.stopPropagation();
    try {
      if (stopwatchTimerID) {
        // 停止
        clearInterval(stopwatchTimerID);
        stopwatchTimerID = null;
      }
      stopwatchSeconds = 0;
      stopwatchLoopCount = 0; // ループ回数もリセット
      if (stopwatch && stopwatch.textContent !== undefined) {
        stopwatch.textContent = '00:00';
      }
      if (loopCountDisplay) {
        loopCountDisplay.textContent = formatUiLoopCount(0);
      }
      if (playButton?.parentNode) playButton.remove();
      if (pauseButton?.parentNode) pauseButton.remove();
      if (stopButton?.parentNode) stopButton.remove();
      if (stopwatchButtonContainer) {
        stopwatchButtonContainer.appendChild(playButton);
        stopwatchButtonContainer.appendChild(stopButton);
      }
    } catch (error) {
      debugError('停止処理中にエラーが発生:', error);
    }
  });

  // 砂時計ボタンのクリックイベントを追加
  const hourglassIcon = hourglassButton.querySelector('img');
  hourglassIcon.addEventListener('click', function (e) {
    e.stopPropagation();
    this.classList.toggle('active');
    debugLog('砂時計ボタンがクリックされました');
    toggleSubPopup(); // サブポップアップの処理を実行
  });


  // 全体情報（1行目）
  const totalInfo = document.createElement('div');
  totalInfo.className = 'total-info';
  totalInfo.textContent = formatUiTotalLine(textLength, unitLabel, readingTime);

  // 選択範囲情報（2-3行目）
  const selectionInfo = document.createElement('div');
  selectionInfo.className = 'selection-info';

  setSelectionInfoContent(selectionInfo, selectedText, selectedLength, selectedReadingTime, unitLabel);

  popup.appendChild(totalInfo);
  popup.appendChild(selectionInfo);


  //要素の配置（上から並べる順番が大切）
  // アイコンを追加
  const playIcon = document.createElement('div');
  playIcon.className = 'play-icon';
  playIcon.appendChild(strCntButton);
  playIcon.appendChild(lightbulbButton);
  playIcon.appendChild(hourglassButton);
  playIcon.appendChild(stopwatchButton);
  popup.appendChild(playIcon);

  const pageRoot = findPageMainContentRoot();
  const pageLanguageMode = detectLanguageMode(getInnerTextExcludingRubyFurigana(pageRoot));
  const readingSettingsRow = document.createElement('div');
  readingSettingsRow.className = 'reading-settings-row';

  const readingSpeedLabel = document.createElement('span');
  readingSpeedLabel.className = 'reading-speed-label';
  readingSpeedLabel.textContent = t('speedLabel');

  const readingSpeedSelectWrapper = document.createElement('div');
  readingSpeedSelectWrapper.className = 'reading-speed-select-wrapper';

  const readingSpeedSelect = document.createElement('select');
  readingSpeedSelect.className = 'reading-speed-select';
  populateReadingSpeedSelect(
    readingSpeedSelect,
    pageLanguageMode,
    loadReadingSpeedCharsPerMin()
  );

  const readingSpeedTooltip = document.createElement('div');
  readingSpeedTooltip.className = 'tooltip';
  readingSpeedTooltip.textContent = t('readingSpeedTooltip');

  readingSpeedSelectWrapper.appendChild(readingSpeedSelect);
  readingSpeedSelectWrapper.appendChild(readingSpeedTooltip);

  const readingModeProgressBtn = document.createElement('button');
  readingModeProgressBtn.type = 'button';
  readingModeProgressBtn.className = 'reading-mode-button';
  readingModeProgressBtn.setAttribute('aria-label', getHighlightModeToggleUiLabel());
  readingModeProgressBtn.textContent = '→';
  const progressModeTooltip = document.createElement('div');
  progressModeTooltip.className = 'tooltip';
  progressModeTooltip.textContent = getHighlightModeToggleUiLabel();
  readingModeProgressBtn.appendChild(progressModeTooltip);

  readingSettingsRow.appendChild(readingSpeedLabel);
  readingSettingsRow.appendChild(readingSpeedSelectWrapper);
  readingSettingsRow.appendChild(readingModeProgressBtn);
  popup.appendChild(readingSettingsRow);

  readingSpeedSelect.addEventListener('click', (e) => e.stopPropagation());
  readingSpeedSelect.addEventListener('mousedown', (e) => e.stopPropagation());
  readingSpeedSelect.addEventListener('change', (e) => {
    e.stopPropagation();
    saveReadingSpeedCharsPerMin(Number(readingSpeedSelect.value));
    refreshYomuPPopupTotalInfo();
    updateCharCountInfo();
    if (highlightProgressSession) {
      resetHighlightProgressOnSettingsChange();
    }
  });

  bindReadingModeToggleButton(readingModeProgressBtn, resetHighlightProgressOnSettingsChange);

  for (const controlEl of [readingSpeedSelect, readingModeProgressBtn]) {
    controlEl.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  popup.appendChild(stopwatchContainer);
  popup.appendChild(stopwatchButtonContainer);

  const donationLinkRow = document.createElement('div');
  donationLinkRow.className = 'donation-link-row';
  const donationLink = document.createElement('a');
  donationLink.className = 'donation-link';
  donationLink.href = DONATION_KOFI_URL;
  donationLink.target = '_blank';
  donationLink.rel = 'noopener noreferrer';
  donationLink.textContent = t('donationLinkText');
  donationLink.addEventListener('click', (e) => e.stopPropagation());
  donationLink.addEventListener('mousedown', (e) => e.stopPropagation());
  donationLinkRow.appendChild(donationLink);
  const donationTooltip = document.createElement('div');
  donationTooltip.className = 'tooltip';
  donationTooltip.innerHTML = t('donationLinkTitle');
  donationLinkRow.appendChild(donationTooltip);
  popup.appendChild(donationLinkRow);

  shadow.appendChild(style);
  shadow.appendChild(popup);

  document.body.appendChild(container);

  restorePopupPosition(
    popup,
    LOCALSTRG_YOMUP_XYPOS,
    '--YomuP-popup-top',
    '--YomuP-popup-left',
    'ポップアップ位置の復元に失敗しました:'
  );

  // ドラッグ移動機能を追加
  addDragFunctionality(popup);

  // ポップアップWクリック時の非表示機能
  addClickToCloseFunctionality(popup);


  // 各ボタンにマウスイベントを追加（表示は showDelayMs 後。離脱は即非表示。子へ移動時は継続）
  function addTooltipEvents(button, showDelayMs) {
    const tooltip = button.querySelector('.tooltip');
    const showDelay = typeof showDelayMs === 'number' ? showDelayMs : 500;
    let showTimer = null;

    button.addEventListener('mouseenter', function () {
      if (showTimer) clearTimeout(showTimer);
      showTimer = setTimeout(() => {
        showTimer = null;
        tooltip.classList.add('show');
      }, showDelay);
    });

    button.addEventListener('mouseleave', function (e) {
      // 吹き出し（子要素）へカーソルが移った場合は表示を維持
      if (e.relatedTarget && button.contains(e.relatedTarget)) return;
      if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
      }
      tooltip.classList.remove('show');
    });
  }

  // 各ボタンにイベントを追加（ツールチップ）
  addTooltipEvents(popupIcon);
  addTooltipEvents(strCntButton);
  addTooltipEvents(lightbulbButton);
  addTooltipEvents(hourglassButton);
  addTooltipEvents(stopwatchButton);
  addTooltipEvents(limitSelectWrapper);
  addTooltipEvents(readingSpeedSelectWrapper);
  addTooltipEvents(readingModeProgressBtn);
  // 寄付: 表示1秒遅延。吹き出し内ホバー中は表示継続
  addTooltipEvents(donationLinkRow, 1000);

  // モード状態に基づいてボタンのactiveクラスを復元
  if (isPageTransition && ENABLE_BUTTON_STATE_RESTORE) { //ページ遷移時のみ、有効 or 無効 を定数で切り替え
    if (highLightOnOff && lightbulbIcon) {
      lightbulbIcon.classList.add('active');
    }
    if (subPopupOnOff && hourglassIcon) {
      hourglassIcon.classList.add('active');
      showSubPopup();
    }
  } else if (!isPageTransition) {
    // ブラウザ起動時はボタン状態を初期化
    highLightOnOff = false;
    subPopupOnOff = false;
    stopwatchOnOff = false;
  }

  // ストップウォッチの状態を復元（ページ遷移時のみ）
  // ブラウザ起動時は、LOCALSTRG_STOPWATCH_STATEを削除してストップウォッチをOFFにする
  // ページ遷移時は、LOCALSTRG_STOPWATCH_STATEを復元する
  // 判定方法：isPageTransition（sessionStorageで判定）を使用
  const savedStopwatchState = localStorage.getItem(LOCALSTRG_STOPWATCH_STATE);
  if (isPageTransition && savedStopwatchState) {
    try {
      const stopwatchState = JSON.parse(savedStopwatchState);
      
      // ストップウォッチの状態を復元
      stopwatchSeconds = stopwatchState.seconds || 0;
      stopwatchLimitMinutes = stopwatchState.limitMinutes !== undefined ? stopwatchState.limitMinutes : null;
      stopwatchLoopCount = stopwatchState.loopCount || 0;
      
      // ストップウォッチが表示されていた場合
      if (stopwatchState.isVisible) {
        stopwatchOnOff = true;
        // ストップウォッチを表示
        stopwatchContainer.style.setProperty('display', 'flex', 'important');
        stopwatchButtonContainer.style.setProperty('display', 'block', 'important');
        stopwatchIcon.classList.add('active');
        
        // 経過時間を表示
        const minutes = Math.floor(stopwatchSeconds / 60);
        const seconds = stopwatchSeconds % 60;
        stopwatch.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        // ドロップダウンの選択値を復元
        if (stopwatchLimitMinutes !== null) {
          limitSelect.value = stopwatchLimitMinutes.toString();
          loopCountDisplay.classList.add('visible');
          loopCountDisplay.textContent = formatUiLoopCount(stopwatchLoopCount);
        } else {
          limitSelect.value = '-';
          loopCountDisplay.classList.remove('visible');
        }
        
        // ストップウォッチが動作中だった場合、タイマーを再開
        if (stopwatchState.isRunning) {
          // ボタンを一時停止/停止に変更
          if (playButton?.parentNode) playButton.remove();
          if (stopButton?.parentNode) stopButton.remove();
          if (stopwatchButtonContainer) {
            stopwatchButtonContainer.appendChild(pauseButton);
            stopwatchButtonContainer.appendChild(stopButton);
          }
          
          // タイマーを再開
          stopwatchTimerID = setInterval(() => {
            try {
              stopwatchSeconds++;
              
              // ループタイマーの上限チェック
              if (stopwatchLimitMinutes !== null) {
                const limitSeconds = stopwatchLimitMinutes * 60;
                if (stopwatchSeconds >= limitSeconds) {
                  // 上限に達したら0にリセットしてループ回数を増やす
                  stopwatchSeconds = 0;
                  stopwatchLoopCount++;
                  loopCountDisplay.textContent = formatUiLoopCount(stopwatchLoopCount);
                }
              }
              
              const minutes = Math.floor(stopwatchSeconds / 60);
              const seconds = stopwatchSeconds % 60;
              if (stopwatch && stopwatch.textContent !== undefined) {
                stopwatch.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
              }
            } catch (error) {
              debugError('ストップウォッチ更新中にエラーが発生:', error);
              // タイマーを停止してエラーを防ぐ
              if (stopwatchTimerID) {
                clearInterval(stopwatchTimerID);
                stopwatchTimerID = null;
              }
            }
          }, 1000);
        }
      }
      
      // 復元後、保存された状態をクリア
      localStorage.removeItem(LOCALSTRG_STOPWATCH_STATE);
    } catch (error) {
      debugError('ストップウォッチ状態の復元中にエラーが発生:', error);
    }
  } else if (savedStopwatchState) {
    // ブラウザ起動時はストップウォッチ状態を削除（ストップウォッチはOFFにする）
    // isPageTransitionがfalseの場合、またはsavedStopwatchStateが存在するがisPageTransitionがfalseの場合
    localStorage.removeItem(LOCALSTRG_STOPWATCH_STATE);
  }

} //end showYomuPPopup


// === 読むプのホップアップ本体を非表示 ========================================
function hideYomuPPopup(preserveModes = false) {
  const existingPopupMain = document.getElementById(ID_YOMUP_POPUP_CONTAINER);
  if (existingPopupMain) {
    debugLog('hideYomuPPopup() がコールされました'); // 追加
    // 1. 全モード状態をOFF化（リスナー・タイマーも同時クリア）
    // preserveModesがtrueの場合はモードを保持する
    if (!preserveModes) {
      if (highLightOnOff) {
        toggleHighlightMode();
      } else {
        // 念のため、highLightOnOffがfalseでもリスナーが残っている可能性があるので削除
        detachHighlightListeners();
      }
      if (subPopupOnOff) toggleSubPopup();
    }

    // 2. 残存タイマー・ハイライトをクリア
    if (mouseTimeoutForHighlight) {
      clearTimeout(mouseTimeoutForHighlight);
      mouseTimeoutForHighlight = null;
    }
    if (stopwatchTimerID) {
      clearInterval(stopwatchTimerID);
      stopwatchTimerID = null;
    }
    stopwatchOnOff = false;
    // ドラッグ用リスナーも削除
    if (isDragging) {
      isDragging = false;
      currentDraggingPopup = null;
    }
    clearCurrentHighlight();

    // 3. ポップアップ削除
    existingPopupMain.remove();

    // 4. 手動クローズ時はリロード復元フラグをクリア（§20）
    if (!preserveModes) {
      localStorage.removeItem(LOCALSTRG_YOMUP_REDISP);
    }
  }
} //end hideYomuPPopup


// === ハイライト処理モードをトグルON/OFFする関数 ===============================
function toggleHighlightMode() {
  setHighlightModeEnabled(!highLightOnOff);
  if (highLightOnOff) {
    debugLog('Highlightモードが有効になりました');
  } else {
    debugLog('Highlightモードが無効になりました');
  }
}


// === マウス移動時の処理 ======================================================
function handleMouseMove(event) {
  if (!highLightOnOff) return;

  // テキスト入力可能な要素の場合は処理をスキップ
  if (isEditableElement(event.target)) {
    return;
  }

  lastHighlightClientX = event.clientX;
  lastHighlightClientY = event.clientY;

  if (!isRubyBrBlockHost() && isPointInCurrentHighlight(event.clientX, event.clientY)) {
    return;
  }

  // §19: ライン進行中は下線オーバーレイ上の移動で再描画しない
  if (highlightProgressSession) {
    if (isPointInCurrentHighlightOverlay(event.clientX, event.clientY)) {
      return;
    }
  }

  // マウスが動く度に既存のタイマーをキャンセル
  if (mouseTimeoutForHighlight) {
    clearTimeout(mouseTimeoutForHighlight);
  }

  // 新しいタイマーを設定（#ms後にハイライト）
  try {
    mouseTimeoutForHighlight = setTimeout(() => {
      try {
        if (tryHighlightLogicalBlockAtPoint(lastHighlightClientX, lastHighlightClientY)) {
          return;
        }
        highlightElement(event.target, lastHighlightClientX, lastHighlightClientY);
      } catch (error) {
        debugError('ハイライト処理中にエラーが発生:', error);
      }
    }, 250);
  } catch (error) {
    debugError('タイマー設定中にエラーが発生:', error);
  }
} //end handleMouseMove


// === マウスが要素から出た時の処理 =============================================
function handleMouseOut() {
  if (!highLightOnOff) return;

  // タイマーをクリア
  if (mouseTimeoutForHighlight) {
    clearTimeout(mouseTimeoutForHighlight);
    mouseTimeoutForHighlight = null;
  }

  // ハイライトをクリア
  clearCurrentHighlight();
}

// === スクロール・リサイズ時（固定オーバーレイの残像防止）====================
function handleHighlightViewportChange() {
  if (!highLightOnOff) return;

  if (mouseTimeoutForHighlight) {
    clearTimeout(mouseTimeoutForHighlight);
    mouseTimeoutForHighlight = null;
  }

  clearCurrentHighlight();
}

// === タグ名判定用のヘルパー関数 ============================================
function isHighlightTargetTag(tagName) {
  return HIGHLIGHT_TARGET_TAGS.includes(tagName);
}

function isConsecutiveGroupTag(tagName) {
  return CONSECUTIVE_GROUP_TAGS.includes(tagName);
}

// === キャレット位置取得（Chrome / Firefox 互換）==============================
function caretRangeFromClientXY(clientX, clientY) {
  if (typeof document.caretRangeFromPoint === 'function') {
    return document.caretRangeFromPoint(clientX, clientY);
  }
  if (typeof document.caretPositionFromPoint === 'function') {
    const pos = document.caretPositionFromPoint(clientX, clientY);
    if (!pos || !pos.offsetNode) return null;
    const range = document.createRange();
    try {
      range.setStart(pos.offsetNode, Math.min(pos.offset, (pos.offsetNode.textContent || '').length));
      range.collapse(true);
      return range;
    } catch (_e) {
      return null;
    }
  }
  return null;
}

function isYomupUiElement(el) {
  if (!el || typeof el.closest !== 'function') return false;
  return !!(el.closest('#' + ID_YOMUP_POPUP_CONTAINER) || el.closest('#' + ID_SUBPOPUP_CONTAINER));
}

// === フェーズ B: 英文論理分割（DOM 非変更）====================================
function getEnglishWordBoundaries(text) {
  const bounds = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    bounds.push({ start: m.index, end: m.index + m[0].length });
  }
  return bounds;
}

function isSentenceEndingPeriod(text, periodIndex) {
  if (text[periodIndex] !== '.') return false;
  if (periodIndex > 0 && periodIndex < text.length - 1) {
    if (/\d/.test(text[periodIndex - 1]) && /\d/.test(text[periodIndex + 1])) return false;
  }
  const before = text.slice(Math.max(0, periodIndex - 12), periodIndex + 1);
  if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e)\.$/i.test(before)) return false;
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text.slice(Math.max(0, periodIndex - 40), periodIndex + 20))) {
    return false;
  }
  if (/https?:\/\/\S*/i.test(text.slice(Math.max(0, periodIndex - 8), periodIndex + 30))) {
    return false;
  }
  return true;
}

function classifyEnglishBoundary(text, cutAfter, allowComma) {
  if (cutAfter <= 0 || cutAfter > text.length) return null;

  const prev = text[cutAfter - 1];
  if (prev === '!' || prev === '?') {
    return { cutAfter, priority: 1, kind: prev };
  }
  if (prev === '.') {
    if (isSentenceEndingPeriod(text, cutAfter - 1)) {
      return { cutAfter, priority: 1, kind: '.' };
    }
    return null;
  }
  if (prev === ';') return { cutAfter, priority: 2, kind: ';' };
  if (prev === ':') return { cutAfter, priority: 3, kind: ':' };
  if (prev === ')' || prev === '—' || prev === '–') {
    return { cutAfter, priority: 4, kind: prev };
  }
  if (allowComma && prev === ',') {
    const tail = text.slice(cutAfter, cutAfter + 6).toLowerCase();
    const kind = tail.startsWith(' but') ? ',but' : ',';
    return { cutAfter, priority: 5, kind };
  }
  return null;
}

function findBestEnglishBoundary(text, wordBounds, wordStartIdx, targetEndWordIdx, maxWords) {
  const windowStart = Math.max(wordStartIdx + 1, targetEndWordIdx - EN_BOUNDARY_SEARCH_WINDOW_WORDS);
  const windowEnd = Math.min(wordBounds.length, targetEndWordIdx + EN_BOUNDARY_SEARCH_WINDOW_WORDS);
  const chunkWordCount = targetEndWordIdx - wordStartIdx;
  const allowComma = chunkWordCount > maxWords * 1.2;

  let best = null;
  let bestPriority = 999;

  for (let wi = windowEnd; wi >= windowStart; wi--) {
    const cutAfter = wordBounds[wi - 1]?.end;
    if (cutAfter === undefined) continue;
    const boundary = classifyEnglishBoundary(text, cutAfter, allowComma);
    if (boundary && boundary.priority < bestPriority) {
      best = { cutAfter: boundary.cutAfter, nextWordIdx: wi, kind: boundary.kind };
      bestPriority = boundary.priority;
      if (bestPriority === 1) break;
    }
  }
  return best;
}

function splitEnglishTextByBoundary(text, maxWords = MAX_WORDS_FOR_HIGHLIGHT) {
  if (!text || !text.trim()) return [];

  const wordBounds = getEnglishWordBoundaries(text);
  if (wordBounds.length === 0) return [];

  const chunks = [];
  let wordStartIdx = 0;

  while (wordStartIdx < wordBounds.length) {
    const targetEndWordIdx = Math.min(wordStartIdx + maxWords, wordBounds.length);
    if (targetEndWordIdx >= wordBounds.length) {
      chunks.push(text.slice(wordBounds[wordStartIdx].start));
      break;
    }

    const boundary = findBestEnglishBoundary(text, wordBounds, wordStartIdx, targetEndWordIdx, maxWords);
    if (boundary) {
      chunks.push(text.slice(wordBounds[wordStartIdx].start, boundary.cutAfter));
      wordStartIdx = boundary.nextWordIdx;
    } else {
      const cutAfter = wordBounds[targetEndWordIdx - 1].end;
      chunks.push(text.slice(wordBounds[wordStartIdx].start, cutAfter));
      wordStartIdx = targetEndWordIdx;
    }
  }

  return chunks.filter((c) => c.trim().length > 0);
}

function isOpeningJapaneseQuote(ch) {
  return ch === '「' || ch === '『';
}

function isClosingJapaneseQuote(ch) {
  return ch === '」' || ch === '』';
}

function isJapaneseSentenceTerminatorChar(ch) {
  return ch === '。' || ch === '！' || ch === '？' || ch === '．';
}

/**
 * text[index] が文末終止として切ってよいか。
 * §51 AL-8: 「できた！」のように鉤括弧内／閉じ括弧直前の！？は文中扱い。
 */
function isJapaneseSentenceEndAt(text, index) {
  if (!text || index < 0 || index >= text.length) return false;
  const ch = text[index];
  if (!isJapaneseSentenceTerminatorChar(ch)) return false;

  let depth = 0;
  for (let i = 0; i < index; i++) {
    const c = text[i];
    if (isOpeningJapaneseQuote(c)) depth++;
    else if (isClosingJapaneseQuote(c) && depth > 0) depth--;
  }

  if ((ch === '！' || ch === '？') && depth > 0) {
    return false;
  }

  let j = index + 1;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (
    (ch === '！' || ch === '？') &&
    j < text.length &&
    isClosingJapaneseQuote(text[j])
  ) {
    return false;
  }

  return true;
}

function classifyJapaneseBoundary(text, cutAfter, allowComma) {
  if (cutAfter <= 0 || cutAfter > text.length) return null;

  const prev = text[cutAfter - 1];
  if (prev === '。' || prev === '！' || prev === '？' || prev === '．') {
    if (!isJapaneseSentenceEndAt(text, cutAfter - 1)) return null;
    return { cutAfter, priority: 1, kind: prev };
  }
  if (prev === '」' || prev === '』' || prev === '）' || prev === ')' || prev === ']') {
    return { cutAfter, priority: 2, kind: prev };
  }
  if (allowComma && (prev === '、' || prev === '，')) {
    return { cutAfter, priority: 3, kind: prev };
  }
  return null;
}

function findBestJapaneseBoundary(text, start, targetEnd, maxLength) {
  const searchStart = start + 1;
  const searchEnd = Math.min(text.length, targetEnd + JA_BOUNDARY_SEARCH_WINDOW_FORWARD);
  const chunkLength = targetEnd - start;
  let allowComma = chunkLength > maxLength * 1.2;
  const maxChunkEnd = start + maxLength + HIGHLIGHT_UNIT_SLACK_JA;
  // 句点（priority 1）は括弧より先に、探索窓ぶんだけ上限を緩めて採用（§39 AI-1）
  // §48 MS-3: 閉じ引用（priority 2）も同上限まで許可し、引用途中切断を避ける
  const maxSentenceEnd = Math.min(
    text.length,
    start + maxLength + HIGHLIGHT_UNIT_SLACK_JA + JA_BOUNDARY_SEARCH_WINDOW_FORWARD
  );

  function search(allowCommaFlag) {
    let best = null;
    let bestPriority = 999;
    let bestDistance = Infinity;
    for (let i = searchEnd; i >= searchStart; i--) {
      const boundary = classifyJapaneseBoundary(text, i, allowCommaFlag);
      if (!boundary) continue;
      const limit = boundary.priority <= 2 ? maxSentenceEnd : maxChunkEnd;
      if (boundary.cutAfter > limit) continue;
      // §48 MS-3: maxChunkEnd を超える句点より、手前の閉じ引用（priority 2）を優先
      const effectivePriority =
        boundary.priority === 1 && boundary.cutAfter > maxChunkEnd
          ? 2.5
          : boundary.priority;
      const distance = Math.abs(i - targetEnd);
      if (
        effectivePriority < bestPriority ||
        (effectivePriority === bestPriority && distance < bestDistance)
      ) {
        best = { cutAfter: boundary.cutAfter, kind: boundary.kind };
        bestPriority = effectivePriority;
        bestDistance = distance;
      }
    }
    return best;
  }

  let best = search(allowComma);
  // §48 MS-3: 句点・引用が見つからないとき読点を再探索（硬切断回避）
  if (!best && !allowComma) {
    best = search(true);
  }
  return best;
}

function splitJapaneseTextByBoundary(text, maxLength = MAX_TEXT_LENGTH_FOR_HIGHLIGHT) {
  if (!text || !text.trim()) return [];
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const remaining = text.length - start;
    if (remaining <= maxLength) {
      chunks.push(text.slice(start));
      break;
    }

    const targetEnd = start + maxLength;
    const boundary = findBestJapaneseBoundary(text, start, targetEnd, maxLength);
    if (boundary) {
      chunks.push(text.slice(start, boundary.cutAfter));
      start = boundary.cutAfter;
    } else {
      chunks.push(text.slice(start, targetEnd));
      start = targetEnd;
    }
  }

  return chunks.filter((c) => c.trim().length > 0);
}

// §40 ZN-N2b / §42 JA-1: 句点区切りは文ごとに 1 チャンク（短い複数文を連結しない）
// §51 AL-8: 鉤括弧内／閉じ直前の！？は文末にしない
function splitJapaneseLogicalParts(blockText, maxLength = MAX_TEXT_LENGTH_FOR_HIGHLIGHT) {
  if (!blockText || !blockText.trim()) return [];

  const sentenceParts = [];
  let start = 0;
  for (let i = 0; i < blockText.length; i++) {
    if (isJapaneseSentenceEndAt(blockText, i)) {
      sentenceParts.push(blockText.slice(start, i + 1));
      start = i + 1;
    }
  }
  const tail = blockText.slice(start);
  if (tail.trim()) sentenceParts.push(tail);

  if (sentenceParts.length <= 1) {
    return splitJapaneseTextByBoundary(blockText, maxLength);
  }

  const merged = [];
  for (const part of sentenceParts) {
    if (!part.trim()) continue;
    if (part.trim().length <= maxLength) {
      merged.push(part);
    } else {
      merged.push(...splitJapaneseTextByBoundary(part, maxLength));
    }
  }
  return merged.filter((c) => c.trim().length > 0);
}

function buildLogicalChunks(blockText, languageMode) {
  const maxUnits = languageMode === LANGUAGE_MODE_EN
    ? MAX_WORDS_FOR_HIGHLIGHT
    : MAX_TEXT_LENGTH_FOR_HIGHLIGHT;
  const parts = languageMode === LANGUAGE_MODE_EN
    ? splitEnglishTextByBoundary(blockText, maxUnits)
    : splitJapaneseLogicalParts(blockText, maxUnits);

  const chunks = [];
  let pos = 0;
  for (const part of parts) {
    if (!part) continue;
    const idx = blockText.indexOf(part, pos);
    const start = idx >= 0 ? idx : pos;
    const end = start + part.length;
    chunks.push({ start, end, text: blockText.slice(start, end) });
    pos = end;
  }
  return coalesceLogicalChunks(chunks, languageMode, maxUnits, blockText);
}

function coalesceLogicalChunks(chunks, languageMode, maxUnits, blockText) {
  if (chunks.length < 2) return chunks;

  const last = chunks[chunks.length - 1];
  const lastUnits = languageMode === LANGUAGE_MODE_EN
    ? countWords(last.text)
    : last.text.trim().length;
  const minUnits = languageMode === LANGUAGE_MODE_EN
    ? COALESCE_MIN_WORDS_EN
    : COALESCE_MIN_CHARS_JA;
  if (lastUnits >= minUnits) return chunks;

  const prev = chunks[chunks.length - 2];
  // §40 ZN-N2b: 句点で区切られた文は coalesce しない（同一 <p> 内の隣接文）
  if (languageMode === LANGUAGE_MODE_JA && isJapaneseSentenceEndChunk(prev.text)) {
    return chunks;
  }
  const mergedText = blockText.slice(prev.start, last.end);
  const mergedUnits = languageMode === LANGUAGE_MODE_EN
    ? countWords(mergedText)
    : mergedText.trim().length;
  const slack = languageMode === LANGUAGE_MODE_EN
    ? HIGHLIGHT_UNIT_SLACK_EN
    : HIGHLIGHT_UNIT_SLACK_JA;
  if (mergedUnits <= maxUnits + slack) {
    const merged = {
      start: prev.start,
      end: last.end,
      text: mergedText
    };
    return chunks.slice(0, -2).concat(merged);
  }
  return chunks;
}

function isJapaneseSentenceEndChunk(text) {
  const t = (text || '').trim();
  return t.length > 0 && /[。！？．]$/.test(t);
}

// §48 MS-3: 閉じ引用・括弧で終わるチャンクも句点同様に上限余裕を付与
function isJapaneseSoftEndChunk(text) {
  const t = (text || '').trim();
  return t.length > 0 && /[。！？．」』）)\]]$/.test(t);
}

function getJapaneseHighlightMaxLength(text) {
  const base = MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA;
  if (isJapaneseSoftEndChunk(text)) {
    return base + JA_BOUNDARY_SEARCH_WINDOW_FORWARD;
  }
  return base;
}

function withinHighlightLimit(text, languageMode) {
  if (languageMode === LANGUAGE_MODE_EN) {
    return countWords(text) <= MAX_WORDS_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_EN;
  }
  return text.trim().length <= getJapaneseHighlightMaxLength(text);
}

function findChunkContainingOffset(chunks, offset) {
  for (const chunk of chunks) {
    if (offset >= chunk.start && offset < chunk.end) return chunk;
  }
  if (chunks.length > 0) {
    const last = chunks[chunks.length - 1];
    if (offset === last.end) return last;
  }
  return chunks[0] || null;
}

function shouldUseGhostCardLeadChunk(clientX, clientY, highlightBlock) {
  if (!highlightBlock || highlightBlock.mode !== 'element') return false;
  if (!isGhostOverlayAtPoint(clientX, clientY)) return false;
  const el = highlightBlock.element;
  if (!el || isLikelyNikkeiPrAdRoot(el)) return false;
  if (getContainingTextRectsForPoint(el, clientX, clientY).length === 0) return false;
  return true;
}

function buildGhostCardLeadChunk(blockText, languageMode) {
  const chunks = buildLogicalChunks(blockText, languageMode);
  if (chunks.length === 0) return null;
  return chunks[0];
}

// === フェーズ C: ブロック論理塊 + オーバーレイ表示 =============================
function isBlockHighlightContainer(el) {
  return !!(el && el.tagName && BLOCK_ANCESTOR_TAGS.has(el.tagName));
}

// pre 内 code は論理塊対象。pre 外の code は §26 でブロック内 segment に含める
function isInlineCodeElement(el) {
  if (!el || el.tagName !== 'CODE') return false;
  return !(el.closest && el.closest('pre'));
}

function isHighlightExcludedCodeElement(el) {
  if (!el || !el.closest) return false;
  const codeEl = el.closest('code');
  if (!codeEl) return false;
  return isInlineCodeElement(codeEl);
}

function getPointReferenceNode(clientX, clientY) {
  const range = caretRangeFromClientXY(clientX, clientY);
  let node = range ? range.startContainer : null;
  // §69 IK-1c: 広告殻上の caret（script/CDATA）は無視し、下の本文ヒットを使う
  if (node && !isNodeInHighlightIgnoredShell(node)) {
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
      return node;
    }
  }
  return getNonShellElementFromPoint(clientX, clientY);
}

function getNonShellElementFromPoint(clientX, clientY) {
  if (typeof document.elementsFromPoint === 'function') {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (let i = 0; i < stack.length; i++) {
      const el = stack[i];
      if (!el || el === document.documentElement || el === document.body) continue;
      if (isYomupUiElement(el) || isHighlightIgnoredShellElement(el)) continue;
      return el;
    }
  }
  const hit = document.elementFromPoint(clientX, clientY);
  if (hit && !isHighlightIgnoredShellElement(hit)) return hit;
  return null;
}

function isHighlightIgnoredShellElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE || !el.closest) return false;
  if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') {
    return true;
  }
  if (
    el.closest(
      '.c-ad-information, .c-ad_container, [id^="div-gpt-"], [id*="google_ads_iframe"]'
    )
  ) {
    return true;
  }
  // いこーよ情報枠: class が c-information のみでも GPT/script 殻なら除外
  if (el.classList && el.classList.contains('c-information')) {
    if (
      el.querySelector('[id^="div-gpt-"], iframe[src*="googlesyndication"], iframe[src*="doubleclick"]') ||
      /googletag|google_ads|<\!\[CDATA\[/i.test(el.textContent || '')
    ) {
      return true;
    }
  }
  if (el.tagName === 'IFRAME') {
    const src = el.getAttribute('src') || '';
    if (/googlesyndication|doubleclick|googletag|safeframe/i.test(src)) return true;
  }
  // script/CDATA 本文だけの殻（class 揺れ・未ロード広告）
  const headText = (el.textContent || '').trim().slice(0, 120);
  if (
    /^\/\/\s*<!\[CDATA\[/.test(headText) ||
    /googletag\.cmd\.push/.test(headText) ||
    /^[\s\/]*googletag\b/.test(headText)
  ) {
    return true;
  }
  return false;
}

function isNodeInHighlightIgnoredShell(node) {
  if (!node) return false;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return !!(el && isHighlightIgnoredShellElement(el));
}

function recoverHighlightBlockFromHitStack(clientX, clientY) {
  if (typeof document.elementsFromPoint !== 'function') return null;
  const stack = document.elementsFromPoint(clientX, clientY);
  for (let i = 0; i < stack.length; i++) {
    let node = stack[i];
    if (!node || isYomupUiElement(node) || isHighlightIgnoredShellElement(node)) continue;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isHighlightIgnoredShellElement(node)) break;
      if (isYomupUiElement(node) || isEditableElement(node)) break;
      if (
        node.tagName === 'DIV' &&
        isLeafTextDivElement(node) &&
        !isLeafTextDivExcludedContext(node) &&
        inlineTextHostAcceptsHoverPoint(node, clientX, clientY)
      ) {
        return { mode: 'inline-text', element: node };
      }
      if (node.tagName && isHeadingSectionTag(node.tagName) && (node.textContent || '').trim()) {
        return { mode: 'element', element: node };
      }
      if (isBlockHighlightContainer(node) && (node.textContent || '').trim()) {
        if (!(node.tagName === 'LI' && isRichMultiUnitListItem(node))) {
          return { mode: 'element', element: node };
        }
      }
      node = node.parentElement;
    }
  }
  return null;
}

function isNodeInsideTable(node) {
  if (!node) return false;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return !!(el && el.closest && el.closest('table'));
}

function findTableCellFromNode(node) {
  if (!node) return null;
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== document.body && el !== document.documentElement) {
    if (isYomupUiElement(el) || isEditableElement(el)) return null;
    if (el.closest && el.closest('code')) return null;
    if (el.tagName === 'TD' || el.tagName === 'TH') return el;
    if (el.tagName === 'TABLE') break;
    el = el.parentElement;
  }
  return null;
}

function findNearestTableCell(table, clientX, clientY) {
  const cells = table.querySelectorAll('td, th');
  let best = null;
  let bestDist = Infinity;

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (isYomupUiElement(cell) || cell.closest('code,script,style,noscript')) continue;

    const rect = cell.getBoundingClientRect();
    if (
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom
    ) {
      return cell;
    }

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = (cx - clientX) ** 2 + (cy - clientY) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = cell;
    }
  }
  return best;
}

// 表内は TD/TH をブロックとする（セル隙間は最近傍セル）
// §64 AS-3: CAPTION 上はセルに奪われない（findHighlightBlock で CAPTION を先に返す）
function findTableCaptionFromNode(node) {
  if (!node) return null;
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== document.body && el !== document.documentElement) {
    if (isYomupUiElement(el) || isEditableElement(el)) return null;
    if (el.tagName === 'CAPTION') return el;
    // セル／表本体に入ったら caption 外
    if (el.tagName === 'TD' || el.tagName === 'TH' || el.tagName === 'TABLE') break;
    el = el.parentElement;
  }
  return null;
}

function findTableCaptionBlockFromPoint(clientX, clientY) {
  const caretNode = getPointReferenceNode(clientX, clientY);
  const hitEl = document.elementFromPoint(clientX, clientY);
  return findTableCaptionFromNode(caretNode) || findTableCaptionFromNode(hitEl);
}

function findTableCellBlockFromPoint(clientX, clientY) {
  const caretNode = getPointReferenceNode(clientX, clientY);
  const hitEl = document.elementFromPoint(clientX, clientY);

  // caption 上では最近傍セルへフォールバックしない
  if (findTableCaptionFromNode(caretNode) || findTableCaptionFromNode(hitEl)) {
    return null;
  }

  let cell = findTableCellFromNode(caretNode) || findTableCellFromNode(hitEl);
  if (cell) return cell;

  let table = hitEl && hitEl.closest ? hitEl.closest('table') : null;
  if (!table && caretNode) {
    const el = caretNode.nodeType === Node.TEXT_NODE ? caretNode.parentElement : caretNode;
    if (el && el.closest) table = el.closest('table');
  }

  if (!table || isYomupUiElement(table) || isEditableElement(table)) return null;
  return findNearestTableCell(table, clientX, clientY);
}

// 表レイアウトの目次型セル（見出し+リンク列）。通常のデータ表は除外する
function isLayoutTableCell(cell) {
  if (!cell || (cell.tagName !== 'TD' && cell.tagName !== 'TH')) return false;
  if (isYomupUiElement(cell) || isEditableElement(cell)) return false;
  if (cell.querySelectorAll('h1,h2,h3').length < LAYOUT_TABLE_CELL_MIN_HEADINGS) return false;
  if (cell.querySelectorAll('a[href]').length < LAYOUT_TABLE_CELL_MIN_LINKS) return false;
  if (cell.querySelectorAll('br').length < LAYOUT_TABLE_CELL_MIN_BRS) return false;
  return true;
}

function isTableCellHighlightHost(element) {
  return !!(element && (element.tagName === 'TD' || element.tagName === 'TH'));
}

// §40 ZN-N2a: br / H1–H3 / p 等があり論理行分割する表セル（素の折り返しのみ td は除く）
function isStructuredTableCellForLineSplit(cell) {
  if (!cell || !isTableCellHighlightHost(cell)) return false;
  if (isYomupUiElement(cell) || isEditableElement(cell)) return false;
  if (isLayoutTableCell(cell)) return true;
  for (let i = 0; i < cell.children.length; i++) {
    const child = cell.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE || !child.tagName) continue;
    if (TD_CHILD_LINE_BREAK_TAGS.has(child.tagName)) return true;
    if (child.tagName === 'BR' || child.tagName === 'P' || child.tagName === 'UL' || child.tagName === 'OL') {
      return true;
    }
  }
  return false;
}

// §40 ZN-N2a / §46 AL-7 / §47 AR-1:
// 表セルの overlay は pointer 視覚行に絞らない（ソフト折り返しで文中切れ・応答悪化するため）。
// スコープは br/見出し論理行分割と句点チャンクに任せる。
function shouldFilterTableCellOverlayToPointerLine(cell) {
  return false;
}

// §40 ZN-N2a: 素の td は句点分割せずセル全文を 1 チャンク（折り返し全行に下線）
// §46 AL-7: 目次型は論理行＋句点分割するため除外
// §47 AR-1: br 構造セルも全文1チャンクにしない（isStructured… で除外）
function shouldUseFullTableCellChunk(highlightBlock) {
  return (
    isElementHighlightBlock(highlightBlock) &&
    highlightBlock.element &&
    isTableCellHighlightHost(highlightBlock.element) &&
    !isStructuredTableCellForLineSplit(highlightBlock.element)
  );
}

function isHeadingHighlightHost(element) {
  return !!(element && element.tagName && isHeadingSectionTag(element.tagName));
}

// §53 CP-3: 見出し内の UI（custom element / data-nosnippet 等）はタイトル扱いにしない
function isHeadingChromeSubtreeElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE || !el.tagName) return false;
  if (el.hasAttribute && (el.hasAttribute('data-nosnippet') || el.hasAttribute('hidden'))) {
    return true;
  }
  if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
  // Web Components（devsite-actions 等）
  if (el.tagName.includes('-')) return true;
  return false;
}

// §53 CP-3 / §67 SV-3: 見出しタイトルは phrasing と単純 <a>。
// isPhrasingHighlightElement はネスト a を拒否するため、見出し専用に a ラップを許す（Wix h5>span>a 等）。
function isHeadingTitlePhrasingAncestor(el) {
  if (!el || !el.tagName) return false;
  if (el.tagName === 'A') {
    return !(
      el.querySelector &&
      el.querySelector('div, p, li, ul, ol, dl, dt, dd, table, h1, h2, h3, h4, h5, h6, img, picture, svg')
    );
  }
  if (!PHRASING_HIGHLIGHT_TAGS.has(el.tagName)) return false;
  if (
    el.querySelector &&
    el.querySelector('div, p, li, ul, ol, dl, dt, dd, table, h1, h2, h3, h4, h5, h6, img, picture, svg')
  ) {
    return false;
  }
  if (!el.querySelectorAll) return true;
  const anchors = el.querySelectorAll('a');
  for (let i = 0; i < anchors.length; i++) {
    if (!isHeadingTitlePhrasingAncestor(anchors[i])) return false;
  }
  return true;
}

function isHeadingTitleTextNode(node, headingEl) {
  if (!node || node.nodeType !== Node.TEXT_NODE || !headingEl) return false;
  let el = node.parentElement;
  while (el && el !== headingEl) {
    if (isHeadingChromeSubtreeElement(el)) return false;
    if (!isHeadingTitlePhrasingAncestor(el)) return false;
    el = el.parentElement;
  }
  return el === headingEl;
}

// §33 CW-1: h1 + span.subtitle 等 — 子要素で複数視覚行になる見出しのみ pointer 行に絞る
// §58 AT-5: <br>/<wbr> だけの見出しはソフト折り返し全文を光らせる（BR を「装飾子」とみなさない）
function shouldFilterHeadingOverlayToPointerLine(headingElement, chunkRects) {
  if (!isHeadingHighlightHost(headingElement) || !chunkRects || chunkRects.length <= 1) {
    return false;
  }
  let hasElementChild = false;
  for (let i = 0; i < headingElement.children.length; i++) {
    const child = headingElement.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName;
    if (tag === 'BR' || tag === 'WBR') continue;
    hasElementChild = true;
    break;
  }
  if (!hasElementChild) return false;
  const lineTolerance = getHighlightUnderlineLineTolerancePx();
  return getVisualLineTopsFromClientRects(chunkRects, lineTolerance).length > 1;
}

// §45 JL-1: h3>span.stepLabel+span.heading 等 — 複数直下要素がある見出しは hover 子を inline-text に
function countDirectElementChildren(el) {
  if (!el || !el.children) return 0;
  let count = 0;
  for (let i = 0; i < el.children.length; i++) {
    if (el.children[i].nodeType === Node.ELEMENT_NODE) count++;
  }
  return count;
}

function resolveHeadingChildTextHostAtPoint(headingEl, clientX, clientY) {
  if (!headingEl || !isHeadingHighlightHost(headingEl)) return null;
  if (countDirectElementChildren(headingEl) < 2) return null;

  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = getNonShellElementFromPoint(clientX, clientY) || document.elementFromPoint(clientX, clientY);
  }

  while (node && node !== headingEl) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (isHighlightIgnoredShellElement(node)) {
      node = node.parentElement;
      continue;
    }
    if (node.parentElement === headingEl && (node.textContent || '').trim()) {
      const accepts =
        getContainingTextRectsForPoint(node, clientX, clientY).length > 0 ||
        inlineTextHostAcceptsHoverPoint(node, clientX, clientY) ||
        (typeof elementVisuallyContainsPoint === 'function' &&
          elementVisuallyContainsPoint(node, clientX, clientY));
      if (!accepts) {
        node = node.parentElement;
        continue;
      }
      if (node.tagName === 'SPAN' || isInlineTextHostElement(node)) {
        return node;
      }
      // §69: 天気 H4 等 — 直下 div（予報地点・日付）を見出し全体より優先
      if (node.tagName === 'DIV') {
        return node;
      }
    }
    node = node.parentElement;
  }
  return null;
}

function isDefinitionListItemHighlightHost(element) {
  return !!(element && (element.tagName === 'DT' || element.tagName === 'DD'));
}

// §39 AI-1: br-flow 容器より <p> を優先（県 CMS 等の連続段落）
function preferParagraphHighlightBlockAtPoint(highlightBlock, clientX, clientY) {
  // §40 CK-1: <p> 内 strong ラベル（inline-text）は P 全体へ昇格しない
  if (isInlineTextHighlightBlock(highlightBlock)) {
    const host = highlightBlock.element;
    if (host && host.tagName && BLOCK_LABEL_TAGS.has(host.tagName) && isBlockLabelElement(host)) {
      return highlightBlock;
    }
  }

  const caretNode = getPointReferenceNode(clientX, clientY);
  if (!caretNode) return highlightBlock;
  let el = caretNode.nodeType === Node.TEXT_NODE ? caretNode.parentElement : caretNode;
  while (el && el !== document.body && el !== document.documentElement) {
    if (isYomupUiElement(el) || isEditableElement(el)) return highlightBlock;
    if (el.tagName === 'P' && isBlockHighlightContainer(el)) {
      if (isElementHighlightBlock(highlightBlock) && highlightBlock.element === el) {
        return highlightBlock;
      }
      return { mode: 'element', element: el };
    }
    el = el.parentElement;
  }
  return highlightBlock;
}

function getTightenedParagraphClipBounds(hostElement, clipBounds, clientX, clientY) {
  if (!hostElement || hostElement.tagName !== 'P' || !clipBounds) return clipBounds;
  let top = clipBounds.top;
  let ceiling = clipBounds.bottom;
  const hostRect = hostElement.getBoundingClientRect();
  const lineTol = getHighlightUnderlineLineTolerancePx();

  if (typeof clientX === 'number' && typeof clientY === 'number') {
    const split = getParagraphBrLabelSplit(hostElement);
    if (split && isPointerBelowParagraphBrLabel(hostElement, clientX, clientY)) {
      const brRect = split.br.getBoundingClientRect();
      if (brRect.top > 0) {
        top = Math.max(top, brRect.top - 2);
      }
    }
  }

  let sib = hostElement.nextElementSibling;
  while (sib) {
    if (sib.nodeType !== Node.ELEMENT_NODE) {
      sib = sib.nextElementSibling;
      continue;
    }
    const tag = sib.tagName;
    if (
      BLOCK_ANCESTOR_TAGS.has(tag) ||
      HEADING_SECTION_TAGS.has(tag) ||
      tag === 'DIV' ||
      tag === 'IMG'
    ) {
      const sibTop = sib.getBoundingClientRect().top;
      // §49 MS-4: option-item 横並び（同一行の次兄弟 P）を天井にすると下線が全クリップされる
      if (sibTop > 0 && sibTop > hostRect.top + lineTol) {
        ceiling = Math.min(ceiling, sibTop - 6);
        break;
      }
    }
    sib = sib.nextElementSibling;
  }
  if (!(ceiling < clipBounds.bottom) && !(top > clipBounds.top)) return clipBounds;
  return {
    left: clipBounds.left,
    top,
    right: clipBounds.right,
    bottom: ceiling,
    width: clipBounds.right - clipBounds.left,
    height: ceiling - top
  };
}

// §36 CW-2: dt/dd・SVG+テキスト行 — 複数 chunk rect / 折り返し時は pointer 視覚行に絞る
// §50 AT-2: 見出し+本文 div など構造化 dd は絞らない（抜粋折り返しの細切れ・進行遅さを防ぐ）
function definitionListItemHasStructuredBlockChildren(el) {
  if (!el) return false;
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName;
    if (
      HEADING_SECTION_TAGS.has(tag) ||
      tag === 'DIV' ||
      tag === 'P' ||
      tag === 'UL' ||
      tag === 'OL' ||
      tag === 'SECTION' ||
      tag === 'ARTICLE'
    ) {
      return true;
    }
  }
  return false;
}

function shouldFilterDecoratedBlockOverlayToPointerLine(hostElement, chunkRects) {
  if (shouldFilterHeadingOverlayToPointerLine(hostElement, chunkRects)) {
    return true;
  }
  if (!hostElement || !chunkRects || chunkRects.length === 0) return false;

  const isDecoratedRow =
    isDefinitionListItemHighlightHost(hostElement) ||
    (hostElement.tagName === 'DIV' && isIconTextRowDiv(hostElement));
  if (!isDecoratedRow) return false;

  if (
    isDefinitionListItemHighlightHost(hostElement) &&
    definitionListItemHasStructuredBlockChildren(hostElement)
  ) {
    return false;
  }

  // §55 JS-1: 素の dt/dd（直テキストのみ）はソフト折り返しでも文全体を光らせる。
  // §36 の pointer 行絞りは SVG+テキスト等の装飾行向け。AT-2 は子ブロックありのみ除外していた。
  if (
    isDefinitionListItemHighlightHost(hostElement) &&
    !hasDirectElementChild(hostElement)
  ) {
    return false;
  }

  const lineTolerance = getHighlightUnderlineLineTolerancePx();
  if (getVisualLineTopsFromClientRects(chunkRects, lineTolerance).length > 1) {
    return true;
  }
  if (chunkRects.length <= 1) return false;

  for (let i = 0; i < hostElement.children.length; i++) {
    if (hostElement.children[i].nodeType === Node.ELEMENT_NODE) {
      return true;
    }
  }
  return false;
}

function isCompactStatRowHighlightHost(element) {
  if (isDefinitionListItemHighlightHost(element)) return true;
  return !!(element && element.tagName === 'DIV' && isIconTextRowDiv(element));
}

function findLayoutTableCellInnerBlockFromPoint(clientX, clientY, tableCell) {
  if (!tableCell || !isLayoutTableCell(tableCell)) return null;

  const heading = findHeadingBlockFromPoint(clientX, clientY);
  if (heading && tableCell.contains(heading)) {
    return { mode: 'element', element: heading };
  }

  const inlineHost = findBestInlineTextHostFromPoint(clientX, clientY);
  if (inlineHost && tableCell.contains(inlineHost)) {
    return { mode: 'inline-text', element: inlineHost };
  }

  return null;
}

// §49 MS-4: 長文条件 TD（直下 DIV のみ）はセル全文が上限超過で不発 → 内側 LI / P を優先
// §70 RK-1: 画像+タイトル型トピックス等 — セル全文1チャンク上限超過を避けるため inline を先に
function findContentTableCellInnerBlockFromPoint(clientX, clientY, tableCell) {
  if (!tableCell || !isTableCellHighlightHost(tableCell)) return null;
  if (isLayoutTableCell(tableCell)) return null;

  // ヒット要素の祖先を優先（option-item 上で下層 LI を elementsFromPoint 誤拾いしない）
  let node = getPointReferenceNode(clientX, clientY) || getNonShellElementFromPoint(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  while (node && node !== tableCell && tableCell.contains(node)) {
    if (node.tagName === 'P' && isBlockHighlightContainer(node)) {
      return { mode: 'element', element: node };
    }
    if (
      node.tagName === 'LI' &&
      !isFlowStepListItemStructure(node) &&
      !liContainsInnerCardCellAtPoint(node, clientX, clientY)
    ) {
      return { mode: 'element', element: node };
    }
    // 楽天トピックス等: タイトル／日付 span を TD 全文より先に採用
    if (
      isInlineTextHostElement(node) &&
      scoreInlineTextHostCandidate(node, clientX, clientY)
    ) {
      return { mode: 'inline-text', element: node };
    }
    node = node.parentElement;
  }

  // 余白 hover 等: テキスト矩形に載る LI のみ
  const deepestLi = findDeepestListItemFromPoint(clientX, clientY);
  if (
    deepestLi &&
    tableCell.contains(deepestLi) &&
    !isFlowStepListItemStructure(deepestLi) &&
    !liContainsInnerCardCellAtPoint(deepestLi, clientX, clientY) &&
    getContainingTextRectsForPoint(deepestLi, clientX, clientY).length > 0
  ) {
    return { mode: 'element', element: deepestLi };
  }

  const inlineHost = findBestInlineTextHostFromPoint(clientX, clientY);
  if (inlineHost && tableCell.contains(inlineHost)) {
    return { mode: 'inline-text', element: inlineHost };
  }

  return null;
}

function getLayoutTableCellDirectHeadings(cell) {
  const headings = [];
  if (!cell || !cell.children) return headings;
  for (let i = 0; i < cell.children.length; i++) {
    const child = cell.children[i];
    if (child.nodeType === Node.ELEMENT_NODE && TD_CHILD_LINE_BREAK_TAGS.has(child.tagName)) {
      headings.push(child);
    }
  }
  return headings;
}

// §46 AL-7: 目次型 TD はセル全体を走査せず、前後 H1–H3 区間だけ行分割する
function collectLayoutTableCellIntervalLines(cell, startHeading, endHeading) {
  const lines = [];
  let current = { blockText: '', segments: [] };

  const flushLine = () => {
    if (current.segments.length > 0) {
      lines.push(current);
    }
    current = { blockText: '', segments: [] };
  };

  const appendTextNode = (node) => {
    const text = node.textContent || '';
    if (!text) return;
    const start = current.blockText.length;
    current.blockText += text;
    current.segments.push({ node, start, end: current.blockText.length, text });
  };

  const walkNodes = (parent) => {
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') {
        flushLine();
      } else if (child.nodeType === Node.TEXT_NODE) {
        if (shouldIncludeTextNodeInBlock(child, cell)) {
          appendTextNode(child);
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (isYomupUiElement(child) || isEditableElement(child)) continue;
        if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'NOSCRIPT') {
          continue;
        }
        walkNodes(child);
      }
    }
  };

  let started = false;
  for (let i = 0; i < cell.childNodes.length; i++) {
    const child = cell.childNodes[i];
    if (child === startHeading) {
      started = true;
      continue;
    }
    if (!started) continue;
    if (child === endHeading) break;

    if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') {
      flushLine();
    } else if (child.nodeType === Node.TEXT_NODE) {
      if (shouldIncludeTextNodeInBlock(child, cell)) {
        appendTextNode(child);
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (isYomupUiElement(child) || isEditableElement(child)) continue;
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'NOSCRIPT') {
        continue;
      }
      walkNodes(child);
    }
  }
  flushLine();
  return mergeShortJapaneseParenLogicalLines(lines);
}

function resolveLayoutTableCellTextContextAtPoint(cell, clientX, clientY) {
  if (!cell || !isLayoutTableCell(cell)) return null;
  if (typeof clientX !== 'number' || typeof clientY !== 'number') return null;

  const caretNode = getPointReferenceNode(clientX, clientY);
  if (!caretNode || !cell.contains(caretNode)) return null;

  const headings = getLayoutTableCellDirectHeadings(cell);
  const bounds = findHeadingIntervalBoundaries(headings, caretNode);
  if (!bounds) return null;

  const lines = collectLayoutTableCellIntervalLines(
    cell,
    bounds.startHeading,
    bounds.endHeading
  ).filter((line) => line.segments.length > 0 && line.blockText.trim());
  if (lines.length === 0) return null;
  if (lines.length === 1) return lines[0];
  return lines[findLineIndexAtCaret(lines, clientX, clientY)];
}

function findDeepestListItemFromPoint(clientX, clientY) {
  const stack = document.elementsFromPoint(clientX, clientY);
  const lis = [];
  for (let i = 0; i < stack.length; i++) {
    const el = stack[i];
    if (!el || isYomupUiElement(el) || isEditableElement(el)) continue;
    if (isHighlightExcludedCodeElement(el)) continue;
    const li = el.tagName === 'LI' ? el : (el.closest ? el.closest('li') : null);
    if (!li || lis.indexOf(li) >= 0) continue;
    lis.push(li);
  }
  if (lis.length === 0) return null;
  for (let i = 0; i < lis.length; i++) {
    const li = lis[i];
    let hasDescendantLi = false;
    for (let j = 0; j < lis.length; j++) {
      if (lis[j] !== li && li.contains(lis[j])) {
        hasDescendantLi = true;
        break;
      }
    }
    if (!hasDescendantLi) return li;
  }
  return lis[lis.length - 1];
}

function findBlockAncestorFromPoint(clientX, clientY) {
  const pointNode = getPointReferenceNode(clientX, clientY) || getNonShellElementFromPoint(clientX, clientY);
  if (isLikelyNikkeiPrAdRoot(pointNode)) return null;
  // §4.5.2: FAQ 内は findFaqAnswerBlockFromPoint に委ねる（P 祖先より先）
  if (isWithinFaqAnswerRegion(pointNode)) return null;

  const deepestLi = findDeepestListItemFromPoint(clientX, clientY);
  // §69 IK-2: 複合一覧カード LI は丸ごと block にしない（leaf/inline に委譲）
  if (deepestLi && !isRichMultiUnitListItem(deepestLi)) return deepestLi;

  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (isHighlightExcludedCodeElement(node)) return null;
    if (isGhostOverlayLink(node)) {
      node = node.parentElement;
      continue;
    }
    if (isBlockHighlightContainer(node)) {
      // §69 IK-2: 複合一覧カード LI は block 祖先として採用しない
      if (node.tagName === 'LI' && isRichMultiUnitListItem(node)) {
        node = node.parentElement;
        continue;
      }
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function isHitStackBlockCandidate(el) {
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  if (isHighlightIgnoredShellElement(el)) return false;
  if (isGhostOverlayLink(el)) return false;
  if (isLikelyNikkeiPrAdRoot(el)) return false;
  if (isNodeInsideTable(el) && el.tagName !== 'TD' && el.tagName !== 'TH') return false;

  const isBlock = BLOCK_ANCESTOR_TAGS.has(el.tagName);
  const isHeading = el.tagName && isHeadingSectionTag(el.tagName);
  if (!isBlock && !isHeading) return false;

  const text = (el.textContent || '').trim();
  return !!text;
}

// 祖先探索で拾えないブロック（大きな <a> ラップ内の P 等）をヒットスタックから補完
function findBlockInHitStackFromPoint(clientX, clientY) {
  const pointNode = getPointReferenceNode(clientX, clientY) || getNonShellElementFromPoint(clientX, clientY);
  if (isWithinUiChromeRegion(pointNode)) return null;
  if (isLikelyNikkeiPrAdRoot(pointNode)) return null;

  const stack = document.elementsFromPoint(clientX, clientY);
  const bestEl = pickBestHitStackBlockFromPoint(clientX, clientY, stack);
  if (bestEl) {
    return { mode: 'element', element: bestEl };
  }
  return null;
}

function findHeadingBlockFromPoint(clientX, clientY) {
  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (node.closest && node.closest('code')) return null;
    if (isGhostOverlayLink(node)) {
      node = node.parentElement;
      continue;
    }
    if (node.tagName && isHeadingSectionTag(node.tagName)) return node;
    node = node.parentElement;
  }

  if (isGhostOverlayAtPoint(clientX, clientY)) {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (let i = 0; i < stack.length; i++) {
      const el = stack[i];
      if (!el.tagName || !isHeadingSectionTag(el.tagName)) continue;
      if (isYomupUiElement(el) || isEditableElement(el)) continue;
      if (isGhostOverlayLink(el)) continue;
      if (isLikelyNikkeiPrAdRoot(el)) continue;
      if (getContainingTextRectsForPoint(el, clientX, clientY).length === 0) continue;
      if (elementVisuallyContainsPoint(el, clientX, clientY)) return el;
    }
  }

  return null;
}

function isHeadingSectionTag(tagName) {
  return !!(tagName && HEADING_SECTION_TAGS.has(tagName));
}

function getFirstSignificantChild(parent) {
  if (!parent) return null;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent || '').trim()) return child;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      return child;
    }
  }
  return null;
}

function getFollowingSiblingTextLength(parent, afterNode) {
  if (!parent || !afterNode) return 0;
  let found = false;
  let length = 0;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child === afterNode) {
      found = true;
      continue;
    }
    if (!found) continue;
    length += (child.textContent || '').trim().length;
  }
  return length;
}

function isLeadingBlockLabelPosition(parent, el) {
  if (!parent || !el) return false;
  if (getFirstSignificantChild(parent) === el) return true;
  if (!el.tagName || !BLOCK_LABEL_TAGS.has(el.tagName)) return false;

  let prefixChars = 0;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child === el) {
      return prefixChars <= BLOCK_LABEL_MAX_LEADING_PREFIX_CHARS;
    }
    if (child.nodeType === Node.TEXT_NODE) {
      const trimmed = (child.textContent || '').trim();
      if (!trimmed) continue;
      prefixChars += trimmed.length;
      if (prefixChars > BLOCK_LABEL_MAX_LEADING_PREFIX_CHARS) return false;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      return false;
    }
  }
  return false;
}

function isColonEndingBlockLabelText(text) {
  if (!text || text.length > BLOCK_LABEL_MAX_COLON_CHARS) return false;
  return text.endsWith('：') || text.endsWith(':');
}

function isListItemParagraphBlockLabel(el) {
  const parent = el.parentElement;
  if (!parent || parent.tagName !== 'P') return false;
  const li = parent.parentElement;
  if (!li || li.tagName !== 'LI') return false;
  const list = li.parentElement;
  return !!(list && (list.tagName === 'UL' || list.tagName === 'OL'));
}

function isStructuralColonBlockLabel(el, parent, text) {
  if (!isColonEndingBlockLabelText(text)) return false;
  if (isListItemParagraphBlockLabel(el)) return true;
  if (parent.tagName === 'P' || parent.tagName === 'LI' || parent.tagName === 'DD') return true;
  return false;
}

function isStructuralListItemParagraphBlockLabel(el, text) {
  if (!isListItemParagraphBlockLabel(el)) return false;
  if (!text || text.length > BLOCK_LABEL_MAX_COLON_CHARS) return false;
  return true;
}

function isStructuralParagraphLeadingBlockLabel(el, parent, text) {
  if (!parent || parent.tagName !== 'P') return false;
  if (!isLeadingBlockLabelPosition(parent, el)) return false;
  if (!text || text.length > BLOCK_LABEL_MAX_COLON_CHARS) return false;
  return true;
}

// 文中強調: <strong>読むプ</strong>は、… のように直後が助詞等で続く場合は構造ラベルにしない
function isInlineEmphasisContinuingSentence(el) {
  if (!el) return false;
  let n = el.nextSibling;
  while (n) {
    if (n.nodeType === Node.TEXT_NODE) {
      const raw = n.textContent || '';
      if (!raw.trim()) {
        n = n.nextSibling;
        continue;
      }
      const t = raw.replace(/^\s+/, '');
      return /^(は|が|を|に|と|も|や|の|で|へ|から|まで|より|って|という|とは|について|において|として|により|による)/.test(
        t
      );
    }
    if (n.nodeType === Node.ELEMENT_NODE) {
      return false;
    }
    n = n.nextSibling;
  }
  return false;
}

// label〜br のあいだに有意テキストがあるか（MS-2: strong+本文+br を CK-3 誤判定しない）
function hasSignificantContentBetweenNodes(fromNode, toNode) {
  if (!fromNode || !toNode) return false;
  let n = fromNode.nextSibling;
  while (n && n !== toNode) {
    if (n.nodeType === Node.TEXT_NODE) {
      if ((n.textContent || '').trim()) return true;
    } else if (n.nodeType === Node.ELEMENT_NODE && n.tagName !== 'BR') {
      if ((n.textContent || '').trim()) return true;
    }
    n = n.nextSibling;
  }
  return false;
}

// §40 CK-1: <p><strong>ラベル</strong><br>本文…</p> — strong のみ光らせる
// §48 MS-2: strong と br の間に本文がある DOM は対象外
function isParagraphBrSeparatedBlockLabel(el, parent) {
  if (!parent || parent.tagName !== 'P') return false;
  if (!el || !el.tagName || !BLOCK_LABEL_TAGS.has(el.tagName)) return false;
  if (!isLeadingBlockLabelPosition(parent, el)) return false;
  const br = el.nextElementSibling;
  if (!br || br.tagName !== 'BR') return false;
  if (hasSignificantContentBetweenNodes(el, br)) return false;
  return getFollowingSiblingTextLength(parent, el) >= BLOCK_LABEL_MIN_FOLLOWING_CHARS;
}

function blockLabelAcceptsPointerHit(labelEl, clientX, clientY) {
  if (getContainingTextRectsForPoint(labelEl, clientX, clientY).length > 0) {
    return true;
  }
  const parent = labelEl.parentElement;
  if (!isParagraphBrSeparatedBlockLabel(labelEl, parent)) return false;
  const rect = labelEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return (
    clientX >= rect.left && clientX <= rect.right &&
    clientY >= rect.top && clientY <= rect.bottom
  );
}

function getParagraphBrLabelSplit(p) {
  if (!p || p.tagName !== 'P') return null;
  const label = getFirstSignificantChild(p);
  if (!label || label.nodeType !== Node.ELEMENT_NODE || !BLOCK_LABEL_TAGS.has(label.tagName)) {
    return null;
  }
  if (!isParagraphBrSeparatedBlockLabel(label, p)) return null;
  const br = label.nextElementSibling;
  if (!br || br.tagName !== 'BR') return null;
  return { label, br };
}

function isNodeAfterParagraphBrLabel(node, br) {
  if (!node || !br) return false;
  return !!(br.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
}

// §42 CK-3: <br> 直下本文 hover では strong ラベル行を塊に含めない
function isPointerBelowParagraphBrLabel(p, clientX, clientY) {
  const split = getParagraphBrLabelSplit(p);
  if (!split) return false;
  const { label, br } = split;
  if (blockLabelAcceptsPointerHit(label, clientX, clientY)) return false;
  const caretNode = getPointReferenceNode(clientX, clientY);
  if (caretNode && (label === caretNode || label.contains(caretNode))) return false;
  const brRect = br.getBoundingClientRect();
  if (brRect.height > 0) {
    return clientY >= brRect.top - getHighlightUnderlineLineTolerancePx();
  }
  return isNodeAfterParagraphBrLabel(caretNode, br);
}

function collectParagraphBodyAfterBrLabelSegments(p) {
  const split = getParagraphBrLabelSplit(p);
  if (!split) return null;
  const { br } = split;
  const segments = [];
  let blockText = '';
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!shouldIncludeTextNodeInBlock(node, p)) return NodeFilter.FILTER_REJECT;
      if (!isNodeAfterParagraphBrLabel(node, br)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent || '';
    if (!text) continue;
    const start = blockText.length;
    blockText += text;
    segments.push({ node, start, end: blockText.length, text });
  }
  if (segments.length === 0) return null;
  return { blockText, segments };
}

function resolveParagraphBrLabelBodyTextContext(p, clientX, clientY) {
  if (!isPointerBelowParagraphBrLabel(p, clientX, clientY)) return null;
  return collectParagraphBodyAfterBrLabelSegments(p);
}

// §59 DG-1: マーカー無しの短行 br 一覧（実績リスト等）
// §65 SV-1: 下限を 4→3（採用ページの休日3行など）。句点半数ルールで AI-1 散文は除外
function isUnmarkedBrItemListLines(lines) {
  if (!lines || lines.length < 3) return false;
  let withPeriod = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i].blockText || '').trim();
    if (!t) return false;
    if (t.length > MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA) return false;
    if (/。/.test(t)) withPeriod++;
  }
  // 句点付き行が半数超なら散文寄り（AI-1）として不採用
  return withPeriod * 2 < lines.length;
}

// §66 SV-2: 2行 br の「：」付き。無マーカー2行は AI-1 のため採用しない
// §66.4 SV-2b: 短い「ラベル：」行 + 本文（本文に句点可）。両方「：」かつ双方無句点の項目ペアも可
const COLON_LABEL_LINE_MAX_CHARS = 40;

function isColonSeparatedTwoLineBrList(lines) {
  if (!lines || lines.length !== 2) return false;
  const a = stripLeadingFormatChars((lines[0].blockText || '').trim());
  const b = stripLeadingFormatChars((lines[1].blockText || '').trim());
  if (!a || !b) return false;
  const maxLen = MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA;
  if (a.length > maxLen || b.length > maxLen) return false;

  const aColon = /：/.test(a);
  const bColon = /：/.test(b);
  const aPeriod = /。/.test(a);
  const bPeriod = /。/.test(b);

  // 項目ペア: 両行方に「：」、どちらも句点なし（メカニック：/エンジニア：）
  if (aColon && bColon && !aPeriod && !bPeriod) return true;

  // ラベル＋本文: 先頭が短い「…：…」（句点なし）、2行目は本文（句点可・「：」ラベルではない）
  if (
    aColon &&
    !aPeriod &&
    a.length <= COLON_LABEL_LINE_MAX_CHARS &&
    !bColon
  ) {
    return true;
  }
  return false;
}

function stripLeadingFormatChars(text) {
  return String(text || '').replace(/^[\u200b\uFEFF\u00a0]+/, '');
}

function countBrListMarkerLines(lines) {
  let markers = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = stripLeadingFormatChars((lines[i].blockText || '').trim());
    if (isIndependentJapaneseLogicalLine(t) || /^※/.test(t)) markers++;
  }
  return markers;
}

// §44 MS-1 / §50 AT-1: FAQ・学校 CMS 等 — <br> 区切りの箇条書き型 <p>（・/※/〇 等）は caret 行単位（AI-1 の通常散文は対象外）
// §59 DG-1 / §65 SV-1: 無マーカー短行一覧（≥3行）
// §66 SV-2: 2行はマーカー/※ または「：」項目ペア／短いラベル：＋本文（散文2行は割らない）
function shouldSplitParagraphByBrListLines(p) {
  if (!p || p.tagName !== 'P') return false;
  if (p.querySelectorAll('br').length < 1) return false;
  const lines = collectBlockTextSegmentLines(p).filter(
    (line) => line.segments.length > 0 && (line.blockText || '').trim()
  );
  if (lines.length < 2) return false;

  const markers = countBrListMarkerLines(lines);

  if (lines.length >= 3) {
    // 3行以上は従来どおり br が実質複数ある想定（空行用の余剰 br は許容）
    if (p.querySelectorAll('br').length < 1) return false;
    if (markers >= 1) return true;
    return isUnmarkedBrItemListLines(lines);
  }

  // ちょうど2行
  if (markers >= 1) return true;
  return isColonSeparatedTwoLineBrList(lines);
}

function resolveParagraphBrListLineTextContext(p, clientX, clientY) {
  if (!shouldSplitParagraphByBrListLines(p)) return null;
  const lines = collectBlockTextSegmentLines(p).filter(
    (line) => line.segments.length > 0 && (line.blockText || '').trim()
  );
  if (lines.length <= 1) return lines[0] || null;
  return lines[findLineIndexAtCaret(lines, clientX, clientY)];
}

// §15.2 / G-1b: 先頭 b/strong ラベル付き <p> — AI-1 全文句点分割より先にラベル行／本文行を分離
function paragraphHasLeadingBlockLabel(p) {
  if (!p || p.tagName !== 'P') return false;
  for (let i = 0; i < p.childNodes.length; i++) {
    const child = p.childNodes[i];
    if (child.nodeType === Node.ELEMENT_NODE && isBlockLabelElement(child)) {
      return true;
    }
  }
  return false;
}

function resolveParagraphBlockLabelLineTextContext(p, clientX, clientY) {
  if (!paragraphHasLeadingBlockLabel(p)) return null;
  if (typeof clientX !== 'number' || typeof clientY !== 'number') return null;
  const lines = collectBlockTextSegmentLines(p).filter(
    (line) => line.segments.length > 0 && (line.blockText || '').trim()
  );
  if (lines.length <= 1) return null;
  return lines[findLineIndexAtCaret(lines, clientX, clientY)];
}

// §4.7 / Y-1b: <p> 内 \n\n 空行分割 — AI-1 全文句点分割より先に caret 行を採用
function paragraphHasSourceBlankLineSplits(p) {
  if (!p || p.tagName !== 'P') return false;
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (/\n{2,}/.test(walker.currentNode.textContent || '')) return true;
  }
  return false;
}

function resolveParagraphBlankLineTextContext(p, clientX, clientY) {
  if (!paragraphHasSourceBlankLineSplits(p)) return null;
  if (typeof clientX !== 'number' || typeof clientY !== 'number') return null;
  const lines = collectBlockTextSegmentLines(p).filter(
    (line) => line.segments.length > 0 && (line.blockText || '').trim()
  );
  if (lines.length <= 1) return null;
  return lines[findLineIndexAtCaret(lines, clientX, clientY)];
}

function isBlockDisplayLabel(el) {
  const display = window.getComputedStyle(el).display;
  return display === 'block' || display === 'flex' || display === 'list-item' || display === 'grid';
}

function isLabelVisuallySeparatedFromFollowing(labelEl, parent) {
  const labelRects = collectTextClientRects(labelEl);
  if (labelRects.length === 0) return false;

  let labelBottom = -Infinity;
  for (let i = 0; i < labelRects.length; i++) {
    labelBottom = Math.max(labelBottom, labelRects[i].bottom);
  }

  let found = false;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child === labelEl) {
      found = true;
      continue;
    }
    if (!found) continue;

    let rects = [];
    if (child.nodeType === Node.TEXT_NODE) {
      if (!(child.textContent || '').trim()) continue;
      const range = document.createRange();
      try {
        range.selectNodeContents(child);
        rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      } catch (_e) {
        // ignore
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      rects = collectTextClientRects(child);
    }
    if (rects.length === 0) continue;

    let followingTop = Infinity;
    for (let j = 0; j < rects.length; j++) {
      followingTop = Math.min(followingTop, rects[j].top);
    }
    return followingTop > labelBottom + HIGHLIGHT_RECT_MERGE_LINE_TOLERANCE_PX;
  }
  return false;
}

function isDivLeadingLabelWithFollowingBlock(el, parent) {
  if (!BLOCK_LABEL_DIV_PARENT_OK || !parent || parent.tagName !== 'DIV') return false;
  if (!isLeadingBlockLabelPosition(parent, el)) return false;
  if (getFollowingSiblingTextLength(parent, el) < BLOCK_LABEL_MIN_FOLLOWING_CHARS) return false;

  let foundLabel = false;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child === el) {
      foundLabel = true;
      continue;
    }
    if (!foundLabel) continue;
    if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'P') {
      return true;
    }
  }
  // 続く p が無くても、視覚的に分離していれば intro 見出し扱いにする
  return isBlockDisplayLabel(el) || isLabelVisuallySeparatedFromFollowing(el, parent);
}

function isBlockLabelElement(el) {
  if (!el || !el.tagName || !BLOCK_LABEL_TAGS.has(el.tagName)) return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  if (el.closest && el.closest('pre')) return false;
  if (isNodeInsideTable(el)) return false;

  const parent = el.parentElement;
  if (!parent) return false;

  const parentOk =
    BLOCK_LABEL_PARENT_TAGS.has(parent.tagName) ||
    (parent.tagName === 'DIV' && isDivLeadingLabelWithFollowingBlock(el, parent)) ||
    (parent.tagName === 'A' && isTitleBodyPhrasingAnchor(parent));
  if (!parentOk) return false;

  if (!isLeadingBlockLabelPosition(parent, el)) return false;

  const text = (el.textContent || '').trim();
  if (!text) return false;

  if (getFollowingSiblingTextLength(parent, el) < BLOCK_LABEL_MIN_FOLLOWING_CHARS) return false;

  // デモ等: 文の途中の強調（「読むプは、…」）をラベル分割しない
  if (isInlineEmphasisContinuingSentence(el)) return false;

  // Gemini ul>li>p>b「仕組み：」型 — コロン付き先頭ラベルは構造のみで採用（layout 不要）
  if (isStructuralColonBlockLabel(el, parent, text)) {
    return true;
  }

  // Gemini ol/ul>li>p 先頭 b — コロンなし短文見出し（layout 不要）
  if (isStructuralListItemParagraphBlockLabel(el, text)) {
    return true;
  }

  // blockquote 等 p 先頭 b（💡 プレフィックス可）— コロンなし短文（layout 不要）
  if (isStructuralParagraphLeadingBlockLabel(el, parent, text)) {
    return true;
  }

  if (isParagraphBrSeparatedBlockLabel(el, parent)) {
    return true;
  }

  // §43 AL-1: div 先頭 strong + 続く p（Arduino intro-box 等）
  if (parent.tagName === 'DIV' && isDivLeadingLabelWithFollowingBlock(el, parent)) {
    if (text.length > MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA) return false;
    return true;
  }

  // §43 AL-2b: <a><strong>見出し</strong>本文</a>（guide-card 等）
  if (parent.tagName === 'A' && isTitleBodyPhrasingAnchor(parent)) {
    if (text.length > MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA) return false;
    return true;
  }

  if (text.length > MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA) return false;

  if (!isBlockDisplayLabel(el) && !isLabelVisuallySeparatedFromFollowing(el, parent)) {
    return false;
  }
  return true;
}

function findBlockLabelFromPoint(clientX, clientY) {
  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (node.closest && node.closest('code')) return null;
    if (isGhostOverlayLink(node)) {
      node = node.parentElement;
      continue;
    }
    if (node.tagName && BLOCK_LABEL_TAGS.has(node.tagName) && isBlockLabelElement(node)) {
      if (blockLabelAcceptsPointerHit(node, clientX, clientY)) {
        return node;
      }
      return null;
    }
    node = node.parentElement;
  }
  return null;
}

function findHeadingSectionRoot(fromNode) {
  let el = fromNode && fromNode.nodeType === Node.TEXT_NODE ? fromNode.parentElement : fromNode;
  while (el && el !== document.body && el !== document.documentElement) {
    if (isYomupUiElement(el) || isEditableElement(el)) return null;
    if (el.closest && el.closest('code')) return null;
    const headings = el.querySelectorAll('h2,h3,h4,h5,h6');
    if (headings.length > 0) return el;
    el = el.parentElement;
  }
  return null;
}

function getOrderedHeadingSections(root) {
  const list = root.querySelectorAll('h2,h3,h4,h5,h6');
  const headings = [];
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    if (!h.tagName || !isHeadingSectionTag(h.tagName)) continue;
    if (isYomupUiElement(h) || h.closest('code,script,style,noscript')) continue;
    headings.push(h);
  }
  return headings;
}

function isCaretOnHeadingElement(caretNode, headings) {
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h === caretNode || h.contains(caretNode)) return true;
  }
  return false;
}

function findHeadingIntervalBoundaries(headings, caretNode) {
  if (!caretNode || headings.length === 0) return null;
  if (isCaretOnHeadingElement(caretNode, headings)) return null;

  let startHeading = null;
  let endHeading = null;

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h.compareDocumentPosition(caretNode) & Node.DOCUMENT_POSITION_FOLLOWING) {
      startHeading = h;
    }
  }
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (caretNode.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) {
      endHeading = h;
      break;
    }
  }

  if (!startHeading || !endHeading) return null;
  return { startHeading, endHeading };
}

function isWithinUiChromeRegion(node) {
  const el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return !!(el && el.closest && el.closest('header, footer, nav'));
}

// §52 CO-2: header/footer/nav 直テキスト（§3.7.1 ホストタグ外）を chrome 内のみ救済
function isChromeRegionPlainTextHost(el) {
  if (!el || !el.tagName) return false;
  if (el.tagName !== 'HEADER' && el.tagName !== 'FOOTER' && el.tagName !== 'NAV') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (!isPhrasingHighlightElement(child)) return false;
  }
  const text = (el.textContent || '').trim();
  if (!text) return false;
  return text.length <= MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA;
}

function findChromeRegionPlainTextHostFromPoint(clientX, clientY) {
  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (isChromeRegionPlainTextHost(node)) {
      if (inlineTextHostAcceptsHoverPoint(node, clientX, clientY)) {
        return node;
      }
      return null;
    }
    node = node.parentElement;
  }
  return null;
}

function isWithinFaqAnswerRegion(node) {
  const el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return !!(el && el.closest && el.closest('.faq-answer'));
}

function isPhrasingHighlightElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE || !el.tagName) return false;
  if (!PHRASING_HIGHLIGHT_TAGS.has(el.tagName)) return false;
  // ネストした塊・メディア・リンクは phrasing 扱いにしない（複合バナー等の誤採用防止）
  if (el.querySelector && el.querySelector('div, p, li, ul, ol, dl, dt, dd, table, h1, h2, h3, h4, h5, h6, img, picture, svg, a')) {
    return false;
  }
  return true;
}

// §43 AL-2: strong 等だけの案内カード <a> は許可。img/div 付き複合 <a> は従来どおり除外
function hasNonPhrasingDirectElementChild(el) {
  if (!el) return false;
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (!isPhrasingHighlightElement(child)) return true;
  }
  return false;
}

// §43 AL-2b: <a><strong>見出し</strong>本文…</a> — 見出しと本文を分けて光らせる
function isTitleBodyPhrasingAnchor(a) {
  if (!a || a.tagName !== 'A') return false;
  if (isYomupUiElement(a) || isEditableElement(a)) return false;
  if (hasNonPhrasingDirectElementChild(a)) return false;
  const label = getFirstSignificantChild(a);
  if (
    !label ||
    label.nodeType !== Node.ELEMENT_NODE ||
    !BLOCK_LABEL_TAGS.has(label.tagName)
  ) {
    return false;
  }
  if (!isLeadingBlockLabelPosition(a, label)) return false;
  return getFollowingSiblingTextLength(a, label) >= BLOCK_LABEL_MIN_FOLLOWING_CHARS;
}

function isNodeAfterSiblingInParent(parent, afterNode, node) {
  if (!parent || !afterNode || !node || !parent.contains(node)) return false;
  return !!(afterNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function findTitleBodyPhrasingAnchorBodyFromPoint(clientX, clientY) {
  const caretNode = getPointReferenceNode(clientX, clientY);
  let node = caretNode;
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  if (!node || !node.closest) return null;

  const anchor = node.closest('a');
  if (!anchor || !isTitleBodyPhrasingAnchor(anchor)) return null;
  const label = getFirstSignificantChild(anchor);
  if (!label || label.nodeType !== Node.ELEMENT_NODE) return null;

  // 見出し上は blockLabel 経路に任せる
  if (label === node || label.contains(node)) return null;
  if (getContainingTextRectsForPoint(label, clientX, clientY).length > 0) return null;

  if (caretNode && caretNode.nodeType === Node.TEXT_NODE) {
    if (!isNodeAfterSiblingInParent(anchor, label, caretNode)) return null;
    if (!shouldIncludeTextNodeInBlock(caretNode, anchor)) return null;
    const text = (caretNode.textContent || '').trim();
    if (!text) return null;
    if (text.length > MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA) return null;
    return {
      mode: 'element',
      element: anchor,
      scopedTextNode: caretNode
    };
  }

  // 本文側の <code> 等（見出しの後）
  let el = node;
  while (el && el !== anchor) {
    if (
      isPhrasingHighlightElement(el) &&
      isNodeAfterSiblingInParent(anchor, label, el) &&
      isInlineTextHostElement(el)
    ) {
      if (scoreInlineTextHostCandidate(el, clientX, clientY)) {
        return { mode: 'inline-text', element: el };
      }
    }
    el = el.parentElement;
  }
  return null;
}

function isInlineTextHostElement(el) {
  if (!el || !el.tagName || !INLINE_TEXT_HOST_TAGS.has(el.tagName)) return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  // §4.5.2: FAQ 回答は faq-answer 経路（直下 div）を優先 — 内側 span 等を inline-text にしない
  if (el.closest && el.closest('.faq-answer')) return false;
  // アイコン等を含む複合 <a> は inline-text 対象外（日経 PR バナー等）
  if (el.tagName === 'A' && hasNonPhrasingDirectElementChild(el)) return false;
  // §43 AL-2b: 見出し+本文型 <a> はカード全体を1塊にしない
  if (el.tagName === 'A' && isTitleBodyPhrasingAnchor(el)) return false;
  // pre 外の短文 code のみ inline-text 対象（pre 内は findPreBlockFromPoint に任せる）
  if (el.tagName === 'CODE') {
    if (el.closest && el.closest('pre')) return false;
  } else if (isHighlightExcludedCodeElement(el)) {
    return false;
  }
  const text = (el.textContent || '').trim();
  if (!text) return false;
  return text.length <= MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA;
}

// §36 A': <a> 直下がラッパー span のみ（日経 PR 等の複合 <a> は除外）
function isAnchorWithTextWrapperChildrenOnly(a) {
  if (!a || a.tagName !== 'A') return false;
  if (isYomupUiElement(a) || isEditableElement(a)) return false;
  if (isLikelyNikkeiPrAdRoot(a)) return false;
  if (isGhostOverlayLink(a)) return false;

  let hasWrapperSpan = false;
  for (let i = 0; i < a.childNodes.length; i++) {
    const child = a.childNodes[i];
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent || '').trim()) return false;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return false;
    if (child.tagName !== 'SPAN') return false;
    if (child.querySelector('a, div, p, li, dl, dt, dd, table, h1, h2, h3, h4, img, picture')) {
      return false;
    }
    hasWrapperSpan = true;
  }
  return hasWrapperSpan;
}

function isAnchorTextWrapperSpan(el) {
  if (!el || el.tagName !== 'SPAN') return false;
  const parent = el.parentElement;
  if (!parent || parent.tagName !== 'A') return false;
  return isAnchorWithTextWrapperChildrenOnly(parent);
}

function countDirectSpanChildrenOfAnchor(anchor) {
  if (!anchor || anchor.tagName !== 'A') return 0;
  let count = 0;
  for (let i = 0; i < anchor.children.length; i++) {
    if (anchor.children[i].tagName === 'SPAN') count++;
  }
  return count;
}

// §38 N-N1: 日付・カテゴリ・タイトル等、複数 span 列の複合 <a>
function isMultiSpanCompositeAnchor(anchor) {
  return countDirectSpanChildrenOfAnchor(anchor) >= 2;
}

function findCompositeAnchorFromNode(node) {
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.tagName === 'A' && isAnchorWithTextWrapperChildrenOnly(el)) return el;
    el = el.parentElement;
  }
  return null;
}

function isPointInsideCompositeAnchorWrapper(clientX, clientY) {
  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  return !!findCompositeAnchorFromNode(node);
}

function isAnchorTextWrapperSpanInMultiSpanAnchor(el) {
  if (!isAnchorTextWrapperSpan(el)) return false;
  return isMultiSpanCompositeAnchor(el.parentElement);
}

function resolveAnchorWrapperInlineTextHost(el, clientX, clientY) {
  if (!el) return null;

  if (el.tagName === 'SPAN' && isAnchorTextWrapperSpan(el) && isInlineTextHostElement(el)) {
    if (scoreInlineTextHostCandidate(el, clientX, clientY)) return el;
  }

  const anchor = el.tagName === 'A' ? el : (el.closest && el.closest('a'));
  if (!anchor || !isAnchorWithTextWrapperChildrenOnly(anchor)) return null;

  if (typeof document.elementsFromPoint === 'function') {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (let i = 0; i < stack.length; i++) {
      const hit = stack[i];
      if (!anchor.contains(hit)) continue;
      if (hit.tagName !== 'SPAN' || !isAnchorTextWrapperSpan(hit)) continue;
      if (!isInlineTextHostElement(hit)) continue;
      if (scoreInlineTextHostCandidate(hit, clientX, clientY)) return hit;
    }
  }

  for (let i = 0; i < anchor.children.length; i++) {
    const span = anchor.children[i];
    if (span.tagName !== 'SPAN' || !isAnchorTextWrapperSpan(span)) continue;
    if (!isInlineTextHostElement(span)) continue;
    if (scoreInlineTextHostCandidate(span, clientX, clientY)) return span;
  }
  return null;
}

function collectTextClientRects(el) {
  const rects = [];
  if (!el) return rects;

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!(node.textContent || '').trim()) continue;
    const range = document.createRange();
    try {
      range.selectNodeContents(node);
      const clientRects = range.getClientRects();
      for (let i = 0; i < clientRects.length; i++) {
        const rect = clientRects[i];
        if (rect.width > 0 && rect.height > 0) {
          rects.push(rect);
        }
      }
    } catch (_err) {
      // ignore invalid ranges
    }
  }
  return rects;
}

function getContainingTextRectsForPoint(el, clientX, clientY) {
  const containing = [];
  const rects = collectTextClientRects(el);
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom
    ) {
      containing.push(rect);
    }
  }
  return containing;
}

function isLikelyNikkeiPrAdRoot(el) {
  if (!el || !el.closest) return false;
  if (el.closest('[class*="prContainer"]')) return true;
  return !!el.closest('a[href*="pub_click"]');
}

function clientPointInClientRects(rects, clientX, clientY, options) {
  if (!rects || rects.length === 0) return false;
  const opts = options || {};
  const rightPad = opts.rightPad || 0;
  const lineTolerance = opts.lineTolerance || 0;
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (
      clientX >= rect.left &&
      clientX <= rect.right + rightPad &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return true;
    }
    if (
      lineTolerance > 0 &&
      clientY >= rect.top - lineTolerance &&
      clientY <= rect.bottom + lineTolerance
    ) {
      return true;
    }
  }
  return false;
}

function clientPointInRangeClientRects(range, clientX, clientY) {
  if (!range) return false;
  return clientPointInClientRects(
    Array.from(range.getClientRects()),
    clientX,
    clientY,
    { lineTolerance: HIGHLIGHT_RECT_MERGE_LINE_TOLERANCE_PX }
  );
}

function clientPointInStickyHighlightRects(range, clientX, clientY) {
  if (!range) return false;
  const rightPad = typeof HIGHLIGHT_STICKY_RIGHT_PADDING_PX !== 'undefined'
    ? HIGHLIGHT_STICKY_RIGHT_PADDING_PX
    : 0;
  const rects = range.getClientRects();
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (
      clientX >= rect.left &&
      clientX <= rect.right + rightPad &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return true;
    }
  }
  return false;
}

function pickBestHitStackBlockFromPoint(clientX, clientY, stack) {
  let bestEl = null;
  let bestMinWidth = Infinity;
  let bestStackIndex = Infinity;

  for (let i = 0; i < stack.length; i++) {
    const el = stack[i];
    if (!isHitStackBlockCandidate(el)) continue;
    if (!elementVisuallyContainsPoint(el, clientX, clientY)) continue;

    const containing = getContainingTextRectsForPoint(el, clientX, clientY);
    if (containing.length === 0) continue;

    let minWidth = Infinity;
    for (let j = 0; j < containing.length; j++) {
      if (containing[j].width < minWidth) minWidth = containing[j].width;
    }

    if (
      minWidth < bestMinWidth ||
      (minWidth === bestMinWidth && i < bestStackIndex)
    ) {
      bestEl = el;
      bestMinWidth = minWidth;
      bestStackIndex = i;
    }
  }
  return bestEl;
}

function getDirectTextClientRects(el) {
  const rects = [];
  if (!el) return rects;

  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType !== Node.TEXT_NODE) continue;
    const text = child.textContent || '';
    if (!text.trim()) continue;
    const range = document.createRange();
    try {
      range.setStart(child, 0);
      range.setEnd(child, text.length);
      const clientRects = range.getClientRects();
      for (let j = 0; j < clientRects.length; j++) {
        const rect = clientRects[j];
        if (rect.width > 0 && rect.height > 0) {
          rects.push(rect);
        }
      }
    } catch (_err) {
      // ignore invalid ranges
    }
  }
  return rects;
}

function unionClientRects(rects) {
  if (!rects || rects.length === 0) return null;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { left, top, right, bottom, width, height };
}

function isInPageAnchorListLink(el) {
  if (!el || el.tagName !== 'A') return false;
  const href = el.getAttribute('href') || '';
  if (!href.startsWith('#')) return false;
  return !!(el.closest && el.closest('li'));
}

function isGhostOverlayLinkStructure(el) {
  if (!el || el.tagName !== 'A') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;

  let hasDirectText = false;
  let hasDirectElement = false;
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent || '').trim()) hasDirectText = true;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      hasDirectElement = true;
      break;
    }
  }
  if (!hasDirectText || hasDirectElement) return false;

  const text = (el.textContent || '').trim();
  if (!text) return false;
  return text.length <= MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA;
}

function hasGhostOverlayHitAreaMismatch(el) {
  const linkRect = el.getBoundingClientRect();
  if (linkRect.width <= 0 || linkRect.height <= 0) return false;

  const textBounds = unionClientRects(getDirectTextClientRects(el));
  if (!textBounds) return true;

  const linkArea = linkRect.width * linkRect.height;
  const textArea = textBounds.width * textBounds.height;
  if (textArea <= 0) return true;

  if (linkArea / textArea >= GHOST_OVERLAY_MIN_AREA_RATIO) return true;
  if (linkRect.width / textBounds.width >= GHOST_OVERLAY_MIN_WIDTH_RATIO) return true;
  if (linkRect.height / textBounds.height >= GHOST_OVERLAY_MIN_HEIGHT_RATIO) return true;
  return false;
}

// ゴーストテキスト主体の全面 <a>（日経型カードリンク等）
function isGhostOverlayLink(el) {
  if (!isGhostOverlayLinkStructure(el)) return false;
  if (isInPageAnchorListLink(el)) return false;
  return hasGhostOverlayHitAreaMismatch(el);
}

function getCaretAnchorElement(clientX, clientY) {
  const range = caretRangeFromClientXY(clientX, clientY);
  let node = range ? range.startContainer : null;
  if (node && node.nodeType === Node.TEXT_NODE) {
    return node.parentElement;
  }
  if (node && node.nodeType === Node.ELEMENT_NODE) {
    return node;
  }
  return document.elementFromPoint(clientX, clientY);
}

function isGhostOverlayAtPoint(clientX, clientY, stack) {
  const elements = stack || document.elementsFromPoint(clientX, clientY);
  if (elements.length > 0 && isGhostOverlayLink(elements[0])) return true;
  return isGhostOverlayLink(getCaretAnchorElement(clientX, clientY));
}

function isCaretOnGhostOverlayLink(clientX, clientY) {
  return isGhostOverlayLink(getCaretAnchorElement(clientX, clientY));
}

function elementVisuallyContainsPoint(el, clientX, clientY) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (
    clientX >= rect.left && clientX <= rect.right &&
    clientY >= rect.top && clientY <= rect.bottom
  ) {
    return true;
  }
  return getContainingTextRectsForPoint(el, clientX, clientY).length > 0;
}

function scoreInlineTextHostCandidate(el, clientX, clientY) {
  let containing = getContainingTextRectsForPoint(el, clientX, clientY);
  // §43 AL-2: phrasing のみの案内 <a> は余白ホバーもカード矩形で採用
  // 見出し+本文型（AL-2b）は全体採用しない
  if (
    containing.length === 0 &&
    el &&
    el.tagName === 'A' &&
    !hasNonPhrasingDirectElementChild(el) &&
    !isTitleBodyPhrasingAnchor(el)
  ) {
    const rect = el.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      containing = [rect];
    }
  }
  if (containing.length === 0) return null;

  let minWidth = Infinity;
  let minArea = Infinity;
  for (let i = 0; i < containing.length; i++) {
    const rect = containing[i];
    if (rect.width < minWidth) minWidth = rect.width;
    const area = rect.width * rect.height;
    if (area < minArea) minArea = area;
  }
  return { minWidth, minArea };
}

function isBetterInlineTextHostCandidate(score, stackIndex, bestScore, bestStackIndex) {
  if (!bestScore) return true;
  if (score.minWidth < bestScore.minWidth) return true;
  if (score.minWidth > bestScore.minWidth) return false;
  if (score.minArea < bestScore.minArea) return true;
  if (score.minArea > bestScore.minArea) return false;
  return stackIndex < bestStackIndex;
}

function considerInlineTextHostCandidate(el, clientX, clientY, stackIndex, state) {
  if (!el || isYomupUiElement(el) || isEditableElement(el)) return;
  if (isGhostOverlayLink(el)) return;

  const resolved = resolveAnchorWrapperInlineTextHost(el, clientX, clientY);
  if (resolved) {
    el = resolved;
  } else if (el.tagName === 'A' && isAnchorWithTextWrapperChildrenOnly(el)) {
    return;
  }

  if (!isInlineTextHostElement(el)) return;

  const score = scoreInlineTextHostCandidate(el, clientX, clientY);
  if (!score) return;

  if (isBetterInlineTextHostCandidate(score, stackIndex, state.bestScore, state.bestStackIndex)) {
    state.bestEl = el;
    state.bestScore = score;
    state.bestStackIndex = stackIndex;
  }
}

function findBestInlineTextHostFromPoint(clientX, clientY) {
  const state = {
    bestEl: null,
    bestScore: null,
    bestStackIndex: Infinity
  };

  const stack = document.elementsFromPoint(clientX, clientY);
  for (let i = 0; i < stack.length; i++) {
    considerInlineTextHostCandidate(stack[i], clientX, clientY, i, state);
  }
  if (state.bestEl) return state.bestEl;

  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    considerInlineTextHostCandidate(node, clientX, clientY, stack.length, state);
    if (isHighlightExcludedCodeElement(node)) {
      node = node.parentElement;
      continue;
    }
    node = node.parentElement;
  }
  return state.bestEl;
}

function findInlineTextHostFromPoint(clientX, clientY) {
  return findBestInlineTextHostFromPoint(clientX, clientY);
}

function isGeminiSequenceTextUnit(el) {
  if (!el || el.tagName !== 'DIV' || !el.classList) return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  let matched = false;
  for (const cls of GEMINI_SEQUENCE_TEXT_UNIT_CLASSES) {
    if (el.classList.contains(cls)) {
      matched = true;
      break;
    }
  }
  if (!matched) return false;
  const text = (el.textContent || '').trim();
  if (!text) return false;
  return text.length <= MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA;
}

function inlineTextHostAcceptsHoverPoint(el, clientX, clientY) {
  if (getContainingTextRectsForPoint(el, clientX, clientY).length > 0) {
    return true;
  }
  // §38 N-N1: 複数列 composite <a> の span はテキスト rect のみ（列間 gap で bbox 誤反応しない）
  if (isAnchorTextWrapperSpanInMultiSpanAnchor(el)) {
    return false;
  }
  // Gemini sequence / leaf-text-div / chrome 直テキスト: 行幅内のテキスト右空白（NK-4 相当・領域限定）
  if (
    isGeminiSequenceTextUnit(el) ||
    isLeafTextDivElement(el) ||
    isAnchorTextWrapperSpan(el) ||
    isChromeRegionPlainTextHost(el)
  ) {
    const rect = el.getBoundingClientRect();
    if (
      rect.width > 0 && rect.height > 0 &&
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom
    ) {
      return true;
    }
  }
  // §43 AL-4: 積み上げ span 行（display:block 等）は行ボックス内の右空白も許容
  if (
    isStackedVisualLineSpan(el) &&
    isStackedVisualLineSpanCard(el.parentElement)
  ) {
    const rect = el.getBoundingClientRect();
    if (
      rect.width > 0 && rect.height > 0 &&
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom
    ) {
      return true;
    }
  }
  return false;
}

function findGeminiSequenceTextUnitFromPoint(clientX, clientY) {
  const stack = document.elementsFromPoint(clientX, clientY);
  for (let i = 0; i < stack.length; i++) {
    const el = stack[i];
    if (isGeminiSequenceTextUnit(el)) {
      return el;
    }
  }

  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (isGeminiSequenceTextUnit(node)) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function countDirectTextDivChildren(el) {
  let count = 0;
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType !== Node.ELEMENT_NODE || child.tagName !== 'DIV') continue;
    if ((child.textContent || '').trim()) count++;
  }
  return count;
}

function countSiblingDivsWithText(el) {
  const parent = el.parentElement;
  if (!parent) return 0;
  let count = 0;
  for (let i = 0; i < parent.children.length; i++) {
    const sib = parent.children[i];
    if (sib.tagName === 'DIV' && (sib.textContent || '').trim()) count++;
  }
  return count;
}

function hasDirectHeadingChild(el) {
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE || !child.tagName) continue;
    if (HEADING_SECTION_TAGS.has(child.tagName)) return true;
  }
  return false;
}

function getDirectTextDivChildren(el) {
  const list = [];
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.tagName === 'DIV' && (child.textContent || '').trim()) {
      list.push(child);
    }
  }
  return list;
}

function isCardCellTextUnit(el) {
  if (!el || el.tagName !== 'DIV') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  // §32: feature 列 / 料金行 / 複数 feature 卡は card-cell unit にしない
  if (isAggregateFeatureColumnElement(el)) return false;
  if (containsNestedFeatureIconCardBlocks(el)) return false;
  if (isCardCellPricingRow(el)) return false;
  const text = (el.textContent || '').trim();
  if (!text) return false;
  if (text.length > MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA) return false;
  if (countWords(text) > MAX_WORDS_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_EN) return false;
  return true;
}

// §29/§30: 構造判定用（字数上限は chunk 分割時に適用）
function isInnerCardCellTextDiv(el) {
  if (!el || el.tagName !== 'DIV') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  if (!(el.textContent || '').trim()) return false;
  // §69 IK-2: 施設カード content 等 — 入れ子の葉テキストが複数なら「本文1枚」ではない
  let nestedLeaf = 0;
  const divs = el.getElementsByTagName('div');
  for (let i = 0; i < divs.length; i++) {
    if (!isLeafTextDivStructure(divs[i])) continue;
    nestedLeaf++;
    if (nestedLeaf >= 2) return false;
  }
  return true;
}

function hasOnlyInnerCardCellAllowedExtraDirectChildren(el) {
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName;
    if (tag === 'DIV' && (child.textContent || '').trim()) continue;
    if (tag === 'A') continue;
    if (!(child.textContent || '').trim()) continue;
    return false;
  }
  return true;
}

// §43 AL-4: display:block/inline-block の直下 span が複数行スタックしたカード行
function isStackedVisualLineSpan(el) {
  if (!el || el.tagName !== 'SPAN') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  const text = (el.textContent || '').trim();
  if (!text) return false;
  if (text.length > MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA) return false;
  const display = window.getComputedStyle(el).display;
  return (
    display === 'block' ||
    display === 'flex' ||
    display === 'grid' ||
    display === 'list-item' ||
    display === 'inline-block'
  );
}

function isStackedVisualLineSpanCard(parent) {
  if (!parent || (parent.tagName !== 'DIV' && parent.tagName !== 'A')) return false;
  if (isYomupUiElement(parent) || isEditableElement(parent)) return false;
  let stacked = 0;
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (child.tagName === 'SPAN' && isStackedVisualLineSpan(child)) {
      stacked++;
      continue;
    }
    if ((child.textContent || '').trim()) return false;
  }
  return stacked >= 2;
}

function findStackedVisualLineSpanFromPoint(clientX, clientY) {
  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }

  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (
      node.tagName === 'SPAN' &&
      isStackedVisualLineSpan(node) &&
      isStackedVisualLineSpanCard(node.parentElement)
    ) {
      if (inlineTextHostAcceptsHoverPoint(node, clientX, clientY)) {
        return { mode: 'inline-text', element: node };
      }
      return null;
    }
    node = node.parentElement;
  }
  return null;
}

// §43 AL-5: step-item 型（badge span + 題名 leaf-div + p）を行ごとに光らせる
function isMultiLineStepCardLineChild(el) {
  if (!el || !el.tagName) return false;
  if (!(el.textContent || '').trim()) return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (el.tagName === 'P' && isBlockHighlightContainer(el)) return true;
  if (el.tagName === 'DIV' && isLeafTextDivElement(el)) return true;
  if (el.tagName === 'SPAN' && isStackedVisualLineSpan(el)) return true;
  return false;
}

function isMultiLineStepCard(el) {
  if (!el || el.tagName !== 'DIV') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  let lines = 0;
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (!(child.textContent || '').trim()) continue;
    if (!isMultiLineStepCardLineChild(child)) return false;
    lines++;
  }
  return lines >= 2;
}

function buildMultiLineStepCardLineBlock(lineEl) {
  if (!lineEl) return null;
  if (lineEl.tagName === 'P') {
    return { mode: 'element', element: lineEl };
  }
  return { mode: 'inline-text', element: lineEl };
}

function resolveMultiLineStepCardLine(cardEl, clientX, clientY) {
  if (!isMultiLineStepCard(cardEl)) return null;

  if (typeof document.elementsFromPoint === 'function') {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (let i = 0; i < stack.length; i++) {
      const el = stack[i];
      if (!el || el === cardEl || !cardEl.contains(el)) continue;
      let n = el;
      while (n && n.parentElement && n.parentElement !== cardEl) {
        n = n.parentElement;
      }
      if (n && n.parentElement === cardEl && isMultiLineStepCardLineChild(n)) {
        if (
          n.tagName === 'P' ||
          getContainingTextRectsForPoint(n, clientX, clientY).length > 0 ||
          inlineTextHostAcceptsHoverPoint(n, clientX, clientY)
        ) {
          return buildMultiLineStepCardLineBlock(n);
        }
      }
    }
  }

  for (let i = 0; i < cardEl.children.length; i++) {
    const child = cardEl.children[i];
    if (!isMultiLineStepCardLineChild(child)) continue;
    const rect = child.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return buildMultiLineStepCardLineBlock(child);
    }
  }
  return null;
}

function findMultiLineStepCardLineFromPoint(clientX, clientY) {
  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }

  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (isMultiLineStepCard(node)) {
      return resolveMultiLineStepCardLine(node, clientX, clientY);
    }
    node = node.parentElement;
  }
  return null;
}

// §57 AT-4: WordPress 等の primary/sidebar 2カラム枠を §29 見出し+本文と誤認しない
function isPageLayoutColumnDiv(el) {
  if (!el || el.tagName !== 'DIV') return false;
  const id = el.id || '';
  if (id === 'primary' || id === 'secondary' || id === 'content' || id === 'main') {
    return true;
  }
  const cls = String(el.className || '');
  if (
    cls.includes('content-area') ||
    cls.includes('sidebar-area') ||
    cls.includes('widget-area') ||
    cls.includes('site-content') ||
    cls.includes('site-main')
  ) {
    return true;
  }
  // カード部品想定を超えるネスト（entry-content 等の多数ブロック子）
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (
      child.nodeType === Node.ELEMENT_NODE &&
      child.tagName === 'DIV' &&
      child.children.length > CARD_CELL_MAX_DIRECT_CHILDREN
    ) {
      return true;
    }
  }
  return false;
}

// §29: 内側2段カード（見出し div + 本文 div）
function isInnerCardCellStructure(el) {
  if (!el || el.tagName !== 'DIV') return false;
  if (isHighlightIgnoredShellElement(el)) return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  if (hasDirectHeadingChild(el)) return false;
  if (el.children.length > CARD_CELL_MAX_DIRECT_CHILDREN) return false;
  // §32: Ko-fi mb-8 等 — feature 列 + 料金 grid の複合容器は inner-card にしない
  if (containsNestedFeatureIconCardBlocks(el)) return false;
  // §57 AT-4: site-content > primary + secondary 等
  if (isPageLayoutColumnDiv(el)) return false;
  const textDivChildren = getDirectTextDivChildren(el);
  if (textDivChildren.length !== INNER_CARD_CELL_TEXT_DIV_COUNT) return false;
  if (!hasOnlyInnerCardCellAllowedExtraDirectChildren(el)) return false;
  for (let i = 0; i < textDivChildren.length; i++) {
    const child = textDivChildren[i];
    if (!isInnerCardCellTextDiv(child)) return false;
    if (isPageLayoutColumnDiv(child)) return false;
    if (isAggregateFeatureColumnElement(child)) return false;
    if (containsNestedFeatureIconCardBlocks(child)) return false;
    if (containsCardCellPricingRows(child)) return false;
    // §43 AL-4: 同型 lesson-card 複数の grid を見出し+本文と誤認しない
    if (isStackedVisualLineSpanCard(child)) return false;
  }
  return true;
}

function resolveInnerCardCellTextUnit(cardEl, caretNode, clientX, clientY) {
  const textDivs = getDirectTextDivChildren(cardEl).filter(isInnerCardCellTextDiv);
  if (textDivs.length !== INNER_CARD_CELL_TEXT_DIV_COUNT) return null;

  let ref = caretNode;
  if (ref && ref.nodeType === Node.TEXT_NODE) {
    ref = ref.parentElement;
  }
  if (!ref) {
    ref = document.elementFromPoint(clientX, clientY);
  }

  if (ref) {
    for (let i = 0; i < textDivs.length; i++) {
      const div = textDivs[i];
      if (div === ref || div.contains(ref)) {
        return div;
      }
    }
  }

  return pickNearestCardTextUnit(textDivs, clientX, clientY);
}

function findInnerCardCellBlockFromPoint(clientX, clientY) {
  // §14 NK-1R: 日経 blockLink ゴーストカードでは hit-stack を優先（§29 inner-card 誤判定防止）
  if (isGhostOverlayAtPoint(clientX, clientY)) return null;

  const caretNode = getPointReferenceNode(clientX, clientY);
  let node = caretNode;
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  if (isNodeInsideTable(node)) return null;

  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (isHighlightIgnoredShellElement(node)) {
      node = node.parentElement;
      continue;
    }
    if (isInnerCardCellStructure(node)) {
      const unit = resolveInnerCardCellTextUnit(node, caretNode || node, clientX, clientY);
      if (unit) {
        // AS-2: ページ枠（見出し div + 本文 div）の inner-card 誤認時、
        // 点下の通常 LI があれば LI を優先（overlapRhythm が容器 lh で文字中央に寄るのを防ぐ）
        const deepestLi = findDeepestListItemFromPoint(clientX, clientY);
        if (
          deepestLi &&
          unit.contains(deepestLi) &&
          !isFlowStepListItemStructure(deepestLi) &&
          !liContainsInnerCardCellAtPoint(deepestLi, clientX, clientY)
        ) {
          return { mode: 'element', element: deepestLi };
        }
        return { mode: 'element', element: unit };
      }
    }
    node = node.parentElement;
  }
  return null;
}

function countDirectChildDivsWithText(el) {
  let count = 0;
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.tagName === 'DIV' && (child.textContent || '').trim()) count++;
  }
  return count;
}

// §30: 入学フロー Step リスト（見出し div + 本文 div）
function isFlowStepListItemStructure(el) {
  if (!el || el.tagName !== 'LI') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (!el.closest || !el.closest('#page.flow, .flow')) return false;

  const textDivs = getDirectTextDivChildren(el);
  if (textDivs.length !== INNER_CARD_CELL_TEXT_DIV_COUNT) return false;

  const headerDiv = textDivs[0];
  const bodyDiv = textDivs[1];
  if (!isInnerCardCellTextDiv(headerDiv) || !isInnerCardCellTextDiv(bodyDiv)) return false;
  if (countDirectChildDivsWithText(headerDiv) < FLOW_STEP_MIN_HEADER_CHILD_DIVS) return false;
  return true;
}

function isFlowStepListItem(el) {
  return isFlowStepListItemStructure(el);
}

function resolveFlowStepUnit(liEl, caretNode, clientX, clientY) {
  const textDivs = getDirectTextDivChildren(liEl);
  if (textDivs.length !== INNER_CARD_CELL_TEXT_DIV_COUNT) return null;
  const headerDiv = textDivs[0];
  const bodyDiv = textDivs[1];

  let ref = caretNode;
  if (ref && ref.nodeType === Node.TEXT_NODE) {
    ref = ref.parentElement;
  }
  if (!ref) {
    ref = document.elementFromPoint(clientX, clientY);
  }
  if (!ref) return null;

  if (headerDiv === ref || headerDiv.contains(ref)) return headerDiv;
  if (bodyDiv === ref || bodyDiv.contains(ref)) return bodyDiv;
  return null;
}

function findFlowStepBlockFromPoint(clientX, clientY) {
  const deepestLi = findDeepestListItemFromPoint(clientX, clientY);
  if (!deepestLi || !isFlowStepListItemStructure(deepestLi)) return null;
  const caretNode = getPointReferenceNode(clientX, clientY);
  const unit = resolveFlowStepUnit(deepestLi, caretNode, clientX, clientY);
  if (!unit) return null;
  return { mode: 'element', element: unit };
}

function liContainsInnerCardCellAtPoint(liEl, clientX, clientY) {
  if (!liEl) return false;
  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  while (node && node !== liEl) {
    if (isInnerCardCellStructure(node)) return true;
    node = node.parentElement;
  }
  return false;
}

// grid 内カード親: 構造のみ（全文の字数上限は子 div で判定）
function isCardCellStructure(el) {
  if (!el || el.tagName !== 'DIV') return false;
  if (isHighlightIgnoredShellElement(el)) return false;
  if (isInnerCardCellStructure(el)) return false;
  if (isFeatureIconCardBlock(el)) return false;
  if (isAggregateFeatureColumnElement(el)) return false;
  if (containsNestedFeatureIconCardBlocks(el)) return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  if (hasDirectHeadingChild(el)) return false;
  // §36 CW-2: 実績 grid（直下 dl 混在）は card-cell にしない
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'DL') return false;
  }
  const textDivChildren = getDirectTextDivChildren(el);
  for (let i = 0; i < textDivChildren.length; i++) {
    if (isBrOnlyDivElement(textDivChildren[i])) return false;
    const cls = String(textDivChildren[i].className || '');
    if (cls.includes('col-span') || cls.includes('space-y-')) return false;
    if (isAggregateFeatureColumnElement(textDivChildren[i])) return false;
  }
  // §69 IK-1b: レイアウト殻（l-page 等）は長文子 div を含むため
  // 「テキスト付き直下 div≥2」だけでは誤認する。短文 unit が実際に2つ以上あること。
  let unitDivCount = 0;
  for (let i = 0; i < textDivChildren.length; i++) {
    if (isCardCellTextUnit(textDivChildren[i])) unitDivCount++;
  }
  if (unitDivCount < CARD_CELL_MIN_TEXT_DIVS) return false;
  if (el.children.length > CARD_CELL_MAX_DIRECT_CHILDREN) return false;
  return countSiblingDivsWithText(el) >= CARD_CELL_MIN_SIBLING_DIVS;
}

function isFeatureIconCardMediaElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE || !el.tagName) return false;
  return FEATURE_ICON_CARD_MEDIA_TAGS.has(el.tagName);
}

// Ko-fi pricing feature grid: div > img + h3 + p
function isFeatureIconCardTextBlock(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (HEADING_SECTION_TAGS.has(el.tagName)) return false;
  if (!(el.textContent || '').trim()) return false;
  if (el.tagName === 'P') return true;
  if (el.tagName === 'DIV' && !hasDirectHeadingChild(el)) {
    return !el.querySelector('div');
  }
  return false;
}

function isFeatureIconCardBlock(el) {
  if (!el || el.tagName !== 'DIV') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  if (el.children.length < 2 || el.children.length > CARD_CELL_MAX_DIRECT_CHILDREN) return false;

  let headingCount = 0;
  let textBlockCount = 0;
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (isFeatureIconCardMediaElement(child)) continue;
    if (HEADING_SECTION_TAGS.has(child.tagName)) {
      headingCount++;
      continue;
    }
    if (isFeatureIconCardTextBlock(child)) {
      textBlockCount++;
      continue;
    }
    if (!(child.textContent || '').trim()) continue;
    return false;
  }
  return headingCount === 1 && textBlockCount === 1;
}

function isAggregateFeatureColumnElement(el) {
  if (!el || el.tagName !== 'DIV') return false;
  const cls = String(el.className || '');
  if (cls.includes('col-span') && cls.includes('space-y')) return true;
  if (containsNestedFeatureIconCardBlocks(el)) return true;
  let cardLikeChildCount = 0;
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE || child.tagName !== 'DIV') continue;
    if (isFeatureIconCardBlock(child)) {
      cardLikeChildCount++;
      continue;
    }
    if (child.querySelector && child.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4')) {
      cardLikeChildCount++;
    }
  }
  return cardLikeChildCount >= 2;
}

function findDeepestHighlightTextBlockWithin(containerEl, clientX, clientY) {
  if (!containerEl || typeof containerEl.contains !== 'function') return null;

  const range = caretRangeFromClientXY(clientX, clientY);
  if (range) {
    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      node = node.parentElement;
    } else if (node.nodeType !== Node.ELEMENT_NODE) {
      node = null;
    }
    if (node && containerEl.contains(node)) {
      let bestBlock = null;
      let bestHeading = null;
      let n = node;
      while (n && n !== containerEl) {
        if (isBlockHighlightContainer(n)) {
          bestBlock = n;
        }
        if (HEADING_SECTION_TAGS.has(n.tagName)) {
          bestHeading = n;
        }
        n = n.parentElement;
      }
      if (bestBlock || bestHeading) {
        return bestBlock || bestHeading;
      }
    }
  }

  if (typeof document.elementsFromPoint === 'function') {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (let i = 0; i < stack.length; i++) {
      const hit = stack[i];
      if (!hit || hit === containerEl || !containerEl.contains(hit)) continue;
      if (isBlockHighlightContainer(hit)) return hit;
      if (HEADING_SECTION_TAGS.has(hit.tagName)) return hit;
    }
  }

  let hit = document.elementFromPoint(clientX, clientY);
  while (hit && hit !== containerEl && containerEl.contains(hit)) {
    if (isBlockHighlightContainer(hit)) return hit;
    if (HEADING_SECTION_TAGS.has(hit.tagName)) return hit;
    hit = hit.parentElement;
  }
  return null;
}

function collectFeatureColumnTextUnits(columnEl) {
  const units = [];
  if (!columnEl) return units;
  for (let i = 0; i < columnEl.children.length; i++) {
    const wrapper = columnEl.children[i];
    if (!wrapper || wrapper.nodeType !== Node.ELEMENT_NODE) continue;
    for (let j = 0; j < wrapper.children.length; j++) {
      const child = wrapper.children[j];
      if (!child || child.nodeType !== Node.ELEMENT_NODE) continue;
      if (HEADING_SECTION_TAGS.has(child.tagName) || isFeatureIconCardTextBlock(child)) {
        units.push(child);
      }
    }
  }
  if (units.length === 0 && columnEl.querySelectorAll) {
    const nodes = columnEl.querySelectorAll('h1,h2,h3,h4,p');
    for (let k = 0; k < nodes.length; k++) {
      const node = nodes[k];
      if (node && columnEl.contains(node)) {
        units.push(node);
      }
    }
  }
  return units;
}

function findNearestFeatureColumnTextUnit(columnEl, clientX, clientY) {
  const units = collectFeatureColumnTextUnits(columnEl);
  if (units.length === 0) return null;
  return pickNearestCardTextUnit(units, clientX, clientY);
}

function isKoFiFeatureColumnElement(el) {
  if (!el || el.tagName !== 'DIV') return false;
  return String(el.className || '').includes('col-span');
}

function normalizeAggregateHighlightBlock(highlightBlock, clientX, clientY) {
  if (!highlightBlock || !isElementHighlightBlock(highlightBlock)) return highlightBlock;
  const el = highlightBlock.element;
  if (!el) return highlightBlock;

  // §16 AZ-1R: 青空 ruby-br / orphan は子要素へ縮小しない（H4 章題誤正規化防止）
  if (isAozoraSpecialHighlightBlock(highlightBlock)) return highlightBlock;

  const caretNode = getPointReferenceNode(clientX, clientY);
  const isFeatureColumn = isKoFiFeatureColumnElement(el) || isAggregateFeatureColumnElement(el);

  if (isFeatureColumn) {
    const replacement =
      findNearestFeatureColumnTextUnit(el, clientX, clientY) ||
      resolveFeatureIconCardUnitUnderAggregate(el, caretNode, clientX, clientY) ||
      findDeepestHighlightTextBlockWithin(el, clientX, clientY);
    if (replacement && replacement !== el) {
      logUnderlineTrace('normalize', {
        from: String(el.className || '').slice(0, 60),
        to: replacement.tagName + ':' + String(replacement.textContent || '').trim().slice(0, 40)
      });
      return { mode: 'element', element: replacement };
    }
    logUnderlineTrace('normalize-failed', {
      cls: String(el.className || '').slice(0, 80),
      x: clientX,
      y: clientY,
      unitCount: collectFeatureColumnTextUnits(el).length
    });
    return highlightBlock;
  }

  const featureUnit = resolveFeatureIconCardUnitUnderAggregate(el, caretNode, clientX, clientY);
  if (featureUnit && featureUnit !== el) {
    return { mode: 'element', element: featureUnit };
  }
  return highlightBlock;
}

function containsNestedFeatureIconCardBlocks(el) {
  const cards = [];
  collectFeatureIconCardBlocks(el, cards);
  return cards.length > 0;
}

function collectFeatureIconCardBlocks(root, out) {
  if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
  if (isFeatureIconCardBlock(root)) {
    out.push(root);
    return;
  }
  for (let i = 0; i < root.children.length; i++) {
    collectFeatureIconCardBlocks(root.children[i], out);
  }
}

function findFeatureIconCardContainingPoint(root, clientX, clientY) {
  if (!root || typeof clientX !== 'number' || typeof clientY !== 'number') return null;
  const cards = [];
  collectFeatureIconCardBlocks(root, cards);
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    if (
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom
    ) {
      return cards[i];
    }
  }
  return null;
}

function findNearestFeatureIconCardUnder(root, clientX, clientY) {
  const cards = [];
  collectFeatureIconCardBlocks(root, cards);
  if (cards.length === 0) return null;
  return pickNearestCardTextUnit(cards, clientX, clientY);
}

function resolveFeatureIconCardUnitUnderAggregate(containerEl, caretNode, clientX, clientY) {
  if (!containerEl) return null;
  if (isFeatureIconCardBlock(containerEl)) {
    return resolveFeatureIconCardBlockUnit(containerEl, caretNode, clientX, clientY);
  }
  const innerCard = findFeatureIconCardContainingPoint(containerEl, clientX, clientY)
    || findNearestFeatureIconCardUnder(containerEl, clientX, clientY);
  if (!innerCard) return null;
  return resolveFeatureIconCardBlockUnit(innerCard, caretNode, clientX, clientY);
}

function resolveCardCellUnitOrFeatureDrill(unit, caretNode, clientX, clientY) {
  if (!unit) return null;
  const featureUnit = resolveFeatureIconCardUnitUnderAggregate(unit, caretNode, clientX, clientY);
  if (featureUnit) return featureUnit;
  return unit;
}

function resolveFeatureIconCardBlockUnit(cardEl, caretNode, clientX, clientY) {
  let ref = caretNode;
  if (ref && ref.nodeType === Node.TEXT_NODE) {
    ref = ref.parentElement;
  }
  if (!ref) {
    ref = document.elementFromPoint(clientX, clientY);
  }

  const textUnits = [];
  for (let i = 0; i < cardEl.children.length; i++) {
    const child = cardEl.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (HEADING_SECTION_TAGS.has(child.tagName) || isFeatureIconCardTextBlock(child)) {
      textUnits.push(child);
    }
  }
  if (textUnits.length === 0) return null;

  if (ref) {
    for (let i = 0; i < textUnits.length; i++) {
      const unit = textUnits[i];
      if (unit === ref || unit.contains(ref)) {
        return unit;
      }
    }
  }

  return pickNearestCardTextUnit(textUnits, clientX, clientY);
}

function findFeatureIconCardBlockFromPoint(clientX, clientY) {
  const caretNode = getPointReferenceNode(clientX, clientY);
  let node = caretNode;
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  if (!node || isNodeInsideTable(node)) return null;

  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;

    const innerCard = findFeatureIconCardContainingPoint(node, clientX, clientY)
      || (isFeatureIconCardBlock(node) ? node : null);
    if (innerCard) {
      const unit = resolveFeatureIconCardBlockUnit(innerCard, caretNode || node, clientX, clientY);
      if (unit) {
        return { mode: 'element', element: unit };
      }
    }

    node = node.parentElement;
  }
  return null;
}

function hasOnlyCardCellPricingRowDirectChildren(el) {
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName;
    if (CARD_CELL_PRICING_ROW_HEADING_TAGS.has(tag)) continue;
    if (tag === 'DIV' && (child.textContent || '').trim()) continue;
    if (!(child.textContent || '').trim()) continue;
    return false;
  }
  return true;
}

// H2/H3 + 直下テキスト div 1 つ以上（例: Ko-fi pricing の $12/month + fee 行）
function isCardCellPricingRow(el) {
  if (!el || el.tagName !== 'DIV') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  if (el.children.length > CARD_CELL_MAX_DIRECT_CHILDREN) return false;

  let headingCount = 0;
  let textDivCount = 0;
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (CARD_CELL_PRICING_ROW_HEADING_TAGS.has(child.tagName)) {
      headingCount++;
    } else if (child.tagName === 'DIV' && (child.textContent || '').trim()) {
      textDivCount++;
    }
  }
  if (headingCount < 1 || textDivCount < 1) return false;
  return hasOnlyCardCellPricingRowDirectChildren(el);
}

function containsCardCellPricingRows(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (isCardCellPricingRow(el)) return true;
  for (let i = 0; i < el.children.length; i++) {
    if (containsCardCellPricingRows(el.children[i])) return true;
  }
  return false;
}

function resolveCardCellPricingRowUnit(rowEl, caretNode, clientX, clientY) {
  let ref = caretNode;
  if (ref && ref.nodeType === Node.TEXT_NODE) {
    ref = ref.parentElement;
  }
  if (!ref) {
    ref = document.elementFromPoint(clientX, clientY);
  }

  if (ref) {
    for (let i = 0; i < rowEl.children.length; i++) {
      const child = rowEl.children[i];
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (!CARD_CELL_PRICING_ROW_HEADING_TAGS.has(child.tagName)) continue;
      if (child === ref || child.contains(ref)) {
        return child;
      }
    }
  }

  const textDivs = getDirectTextDivChildren(rowEl).filter(isCardCellTextUnit);
  if (textDivs.length === 0) return null;

  if (ref) {
    for (let i = 0; i < textDivs.length; i++) {
      const div = textDivs[i];
      if (div === ref || div.contains(ref)) {
        return div;
      }
    }
  }

  return pickNearestCardTextUnit(textDivs, clientX, clientY);
}

function pickNearestCardTextUnit(textDivs, clientX, clientY) {
  if (textDivs.length === 0) return null;
  if (textDivs.length === 1) return textDivs[0];
  if (typeof clientX !== 'number' || typeof clientY !== 'number') {
    return textDivs[0];
  }

  for (let i = 0; i < textDivs.length; i++) {
    const rect = textDivs[i].getBoundingClientRect();
    if (
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom
    ) {
      return textDivs[i];
    }
  }

  let best = textDivs[0];
  let bestDist = Infinity;
  for (let i = 0; i < textDivs.length; i++) {
    const rect = textDivs[i].getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const d = (cx - clientX) ** 2 + (cy - clientY) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = textDivs[i];
    }
  }
  return best;
}

function resolveCardCellTextUnit(cardEl, caretNode, clientX, clientY) {
  const textDivs = getDirectTextDivChildren(cardEl).filter(isCardCellTextUnit);
  if (textDivs.length === 0) return null;

  let ref = caretNode;
  if (ref && ref.nodeType === Node.TEXT_NODE) {
    ref = ref.parentElement;
  }
  if (!ref) {
    ref = document.elementFromPoint(clientX, clientY);
  }

  if (ref) {
    for (let i = 0; i < textDivs.length; i++) {
      const div = textDivs[i];
      if (div === ref || div.contains(ref)) {
        return resolveCardCellUnitOrFeatureDrill(div, caretNode, clientX, clientY);
      }
    }

    const allDirectDivs = getDirectTextDivChildren(cardEl);
    for (let i = 0; i < allDirectDivs.length; i++) {
      const child = allDirectDivs[i];
      if (!child.contains(ref)) continue;
      const featureUnit = resolveFeatureIconCardUnitUnderAggregate(child, caretNode, clientX, clientY);
      if (featureUnit) return featureUnit;
      if (isCardCellPricingRow(child)) {
        const unit = resolveCardCellPricingRowUnit(child, caretNode, clientX, clientY);
        if (unit) return unit;
      }
    }
  }

  return resolveCardCellUnitOrFeatureDrill(
    pickNearestCardTextUnit(textDivs, clientX, clientY),
    caretNode,
    clientX,
    clientY
  );
}

function findCardCellPricingRowBlockFromPoint(clientX, clientY) {
  const caretNode = getPointReferenceNode(clientX, clientY);
  let node = caretNode;
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  if (isNodeInsideTable(node)) return null;

  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (isCardCellPricingRow(node)) {
      const unit = resolveCardCellPricingRowUnit(node, caretNode || node, clientX, clientY);
      if (unit) {
        return { mode: 'element', element: unit };
      }
    }
    node = node.parentElement;
  }
  return null;
}

function findCardCellBlockFromPoint(clientX, clientY) {
  const caretNode = getPointReferenceNode(clientX, clientY);
  let node = caretNode;
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  if (isNodeInsideTable(node)) return null;

  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (isHighlightIgnoredShellElement(node)) {
      node = node.parentElement;
      continue;
    }
    if (isCardCellStructure(node)) {
      const unit = resolveCardCellTextUnit(node, caretNode || node, clientX, clientY);
      if (unit) {
        // §43 AL-5: step-item 等の複合行カードは子行へ分解
        const stepLine = resolveMultiLineStepCardLine(unit, clientX, clientY);
        if (stepLine) return stepLine;
        return { mode: 'element', element: unit };
      }
    }
    node = node.parentElement;
  }
  return null;
}

function resolveFaqAnswerTextUnit(blockEl, caretNode, clientX, clientY) {
  if (typeof document.elementsFromPoint === 'function') {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (let i = 0; i < stack.length; i++) {
      const el = stack[i];
      if (!el || !el.tagName || el === blockEl || !blockEl.contains(el)) continue;
      const tag = el.tagName;
      if (tag !== 'SPAN' && tag !== 'P') continue;
      if (!(el.textContent || '').trim()) continue;
      if (isYomupUiElement(el) || isEditableElement(el) || isHighlightExcludedCodeElement(el)) continue;
      if (getContainingTextRectsForPoint(el, clientX, clientY).length > 0) {
        return el;
      }
    }
  }

  const range = caretRangeFromClientXY(clientX, clientY);
  if (range && range.startContainer && blockEl.contains(range.startContainer)) {
    let n = range.startContainer;
    if (n.nodeType === Node.TEXT_NODE) {
      n = n.parentElement;
    }
    while (n && n !== blockEl) {
      const tag = n.tagName;
      if ((tag === 'SPAN' || tag === 'P') && (n.textContent || '').trim()) {
        if (!isYomupUiElement(n) && !isEditableElement(n) && !isHighlightExcludedCodeElement(n)) {
          return n;
        }
      }
      n = n.parentElement;
    }
  }

  let ref = caretNode;
  if (ref && ref.nodeType === Node.TEXT_NODE) {
    ref = ref.parentElement;
  }
  if (!ref) {
    ref = document.elementFromPoint(clientX, clientY);
  }
  if (ref && blockEl.contains(ref)) {
    let n = ref;
    while (n && n !== blockEl) {
      const tag = n.tagName;
      if ((tag === 'SPAN' || tag === 'P') && (n.textContent || '').trim()) {
        if (!isYomupUiElement(n) && !isEditableElement(n) && !isHighlightExcludedCodeElement(n)) {
          return n;
        }
      }
      n = n.parentElement;
    }

    let section = ref;
    while (section && section.parentElement && section.parentElement !== blockEl) {
      section = section.parentElement;
    }
    if (
      section &&
      section !== blockEl &&
      section.parentElement === blockEl &&
      section.tagName === 'DIV' &&
      (section.textContent || '').trim()
    ) {
      return section;
    }
  }
  return blockEl;
}

function findFaqAnswerBlockFromPoint(clientX, clientY) {
  const caretNode = getPointReferenceNode(clientX, clientY);
  let node = caretNode;
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  if (!node || isNodeInsideTable(node)) return null;

  const answer = node.closest && node.closest('.faq-answer');
  if (!answer || isYomupUiElement(answer) || isEditableElement(answer)) return null;

  let block = null;
  for (let i = 0; i < answer.children.length; i++) {
    const child = answer.children[i];
    if (child.tagName !== 'DIV') continue;
    if (child === node || child.contains(node)) {
      block = child;
      break;
    }
  }
  if (!block || isYomupUiElement(block) || isEditableElement(block)) return null;
  if (isHighlightExcludedCodeElement(block)) return null;
  if (!(block.textContent || '').trim()) return null;

  const unit = resolveFaqAnswerTextUnit(block, caretNode || node, clientX, clientY);
  if (!unit || !(unit.textContent || '').trim()) return null;

  return { mode: 'element', element: unit };
}

// §68 TK-1: Froala `fr-view` 等 — 末尾の style/button/短いラベル p は br-only 判定から除外
function isIgnorableBrOnlyDivChromeChild(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
    return true;
  }
  if (tag === 'BUTTON') return true;
  if (tag !== 'P') return false;
  if (
    el.querySelector &&
    el.querySelector(
      'div, p, ul, ol, li, table, h1, h2, h3, h4, h5, h6, section, article, img, picture, svg, button'
    )
  ) {
    return false;
  }
  const text = (el.textContent || '').trim();
  if (!text) return true;
  // 関連リンク行
  if (el.querySelector && el.querySelector('a')) {
    return text.length <= MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA;
  }
  // 「■関連する〜」など phrasing のみの短い見出しラベル
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (child.tagName === 'BR') continue;
    if (!isPhrasingHighlightElement(child)) return false;
  }
  return text.length <= 60;
}

function hasOnlyBrDirectElementChildren(el) {
  if (!el) return false;
  let brCount = 0;
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (isIgnorableBrOnlyDivChromeChild(child)) continue;
    if (child.tagName !== 'BR') return false;
    brCount++;
  }
  return brCount >= 1;
}

// §73 LX-1: br-only / AL-3 用。塊・画像を含まない単純なインライン <a>（tel: 等）
function isSimpleInlineAnchor(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE || el.tagName !== 'A') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (
    el.querySelector &&
    el.querySelector(
      'div, p, li, ul, ol, dl, dt, dd, table, h1, h2, h3, h4, h5, h6, img, picture, svg, video, iframe, a, button'
    )
  ) {
    return false;
  }
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (!isPhrasingHighlightElement(child)) return false;
  }
  return !!(el.textContent || '').trim();
}

function isBrOnlyDivAllowedInlineChild(el) {
  return isPhrasingHighlightElement(el) || isSimpleInlineAnchor(el);
}

// §43 AL-3: text + span/strong + br のみの div（Arduino error-item 等）。純 br-only の拡張
// §73: 単純インライン a（電話番号リンク等）も許可
function hasOnlyPhrasingOrBrDirectElementChildren(el) {
  if (!el) return false;
  let brCount = 0;
  let phrasingCount = 0;
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (isIgnorableBrOnlyDivChromeChild(child)) continue;
    if (child.tagName === 'BR') {
      brCount++;
      continue;
    }
    if (!isBrOnlyDivAllowedInlineChild(child)) return false;
    phrasingCount++;
  }
  // 純 br-only は hasOnlyBrDirectElementChildren 側。こちらは phrasing 混在が必須
  return brCount >= 1 && phrasingCount >= 1;
}

// §52 CO-1: text + strong/span 等のみ（br なし）。leaf-text-div 拡張用。br 混在は §28/AL-3 へ委譲
// §73: 単純インライン a も許可（br なし leaf と同型）
function hasOnlyNonBrPhrasingDirectElementChildren(el) {
  if (!el) return false;
  let phrasingCount = 0;
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (child.tagName === 'BR') return false;
    if (!isBrOnlyDivAllowedInlineChild(child)) return false;
    phrasingCount++;
  }
  return phrasingCount >= 1;
}

function isBrOnlyDivElement(el) {
  if (!el || el.tagName !== 'DIV') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  if (!hasOnlyBrDirectElementChildren(el) && !hasOnlyPhrasingOrBrDirectElementChildren(el)) {
    return false;
  }
  const text = (el.textContent || '').trim();
  if (!text) return false;
  if (isBrFlowContainer(el)) return false;
  return true;
}

function isBrOnlyDivExcludedContext(el) {
  if (!el) return true;
  if (isNodeInsideTable(el)) return true;
  if (isWithinUiChromeRegion(el)) return true;

  let ancestor = el.parentElement;
  while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
    if (isBrFlowContainer(ancestor)) return true;
    ancestor = ancestor.parentElement;
  }

  if (isRubyBrBlockHost()) {
    if (hasRubyBrBlockAozoraStructuralSignature(el)) return true;
    let aozoraAncestor = el.parentElement;
    while (aozoraAncestor && aozoraAncestor !== document.body && aozoraAncestor !== document.documentElement) {
      if (hasRubyBrBlockAozoraStructuralSignature(aozoraAncestor)) return true;
      aozoraAncestor = aozoraAncestor.parentElement;
    }
  }

  if (el.closest && el.closest('.faq-answer')) return true;
  if (isGhostOverlayLink(el)) return true;
  if (isCardCellStructure(el)) return true;
  if (isInnerCardCellStructure(el)) return true;

  let cardAncestor = el.parentElement;
  while (cardAncestor && cardAncestor !== document.body && cardAncestor !== document.documentElement) {
    if (isCardCellStructure(cardAncestor) || isInnerCardCellStructure(cardAncestor)) {
      return !(cardAncestor === el.parentElement && el.tagName === 'DIV');
    }
    cardAncestor = cardAncestor.parentElement;
  }

  return false;
}

function brOnlyDivAcceptsHoverPoint(el, clientX, clientY) {
  if (getContainingTextRectsForPoint(el, clientX, clientY).length > 0) {
    return true;
  }
  const rect = el.getBoundingClientRect();
  return !!(
    rect.width > 0 && rect.height > 0 &&
    clientX >= rect.left && clientX <= rect.right &&
    clientY >= rect.top && clientY <= rect.bottom
  );
}

// §36 C': SVG/img + テキスト行 div（CrowdWorks ステータス行等。class パッチ禁止）
function isIconTextRowDiv(el) {
  if (!el || el.tagName !== 'DIV') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  if (!el.querySelector('svg, img, picture')) return false;
  if (el.querySelector('dl, dt, dd')) return false;
  if (hasDirectHeadingChild(el)) return false;

  const text = (el.textContent || '').trim();
  if (!text) return false;
  if (text.length > MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA) return false;

  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName;
    if (isDecorativeMediaElement(child)) continue;
    if (tag === 'SPAN' || tag === 'A') continue;
    if (tag === 'DIV') return false;
    if (BLOCK_ANCESTOR_TAGS.has(tag) || HEADING_SECTION_TAGS.has(tag)) return false;
  }

  if (countDirectTextDivChildren(el) >= CARD_CELL_MIN_TEXT_DIVS) return false;
  return true;
}

function isIconTextRowExcludedContext(el) {
  if (!el) return true;
  if (isNodeInsideTable(el)) return true;
  if (isWithinUiChromeRegion(el)) return true;
  if (isBrFlowContainer(el)) return true;
  if (isCardCellStructure(el) || isInnerCardCellStructure(el)) return true;
  if (isGhostOverlayLink(el)) return true;
  if (el.closest && el.closest('.faq-answer')) return true;
  return false;
}

function iconTextRowAcceptsHoverPoint(el, clientX, clientY) {
  return brOnlyDivAcceptsHoverPoint(el, clientX, clientY);
}

function findIconTextRowBlockFromPoint(clientX, clientY) {
  if (isGhostOverlayAtPoint(clientX, clientY)) return null;

  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }

  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (isHighlightExcludedCodeElement(node)) {
      node = node.parentElement;
      continue;
    }
    if (node.tagName === 'DIV') {
      if (isIconTextRowDiv(node) && !isIconTextRowExcludedContext(node)) {
        if (iconTextRowAcceptsHoverPoint(node, clientX, clientY)) {
          return { mode: 'element', element: node };
        }
        return null;
      }
    }
    node = node.parentElement;
  }
  return null;
}

// §36 B: dt/dd 行 — SVG 上 hover も行矩形で許容（§34 EH-1 と同型）
function countStatDlUnitsInContainer(container) {
  if (!container || !container.children) return 0;
  let count = 0;
  for (let i = 0; i < container.children.length; i++) {
    const child = container.children[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (child.tagName === 'DL' && child.querySelector('dt')) {
      count++;
    } else if (child.tagName === 'DIV' && child.querySelector(':scope > dl')) {
      count++;
    }
  }
  return count;
}

function isStatDlGridDirectChildUnit(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (el.tagName === 'DL' && el.querySelector('dt')) return true;
  return !!(el.tagName === 'DIV' && el.querySelector(':scope > dl'));
}

function findMultiColumnStatDlGridFromNode(node) {
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== document.body && el !== document.documentElement) {
    if (countStatDlUnitsInContainer(el) >= 2) return el;
    el = el.parentElement;
  }
  return null;
}

function isPointInsideMultiColumnStatDlGrid(clientX, clientY) {
  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  const grid = findMultiColumnStatDlGridFromNode(node);
  if (!grid) return false;

  if (node === grid) return true;

  let cur = node;
  while (cur && cur !== grid) {
    if (cur.parentElement === grid && !isStatDlGridDirectChildUnit(cur)) {
      return false;
    }
    cur = cur.parentElement;
  }
  return true;
}

function isPointInRubyBrBlockRegion(node) {
  if (!isRubyBrBlockHost()) return false;
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return !!findRubyBrContainerFromNode(el);
}

function isPointerOnDecorativeMediaInElement(el, clientX, clientY) {
  if (!el || typeof document.elementsFromPoint !== 'function') return false;
  const stack = document.elementsFromPoint(clientX, clientY);
  for (let i = 0; i < stack.length; i++) {
    const hit = stack[i];
    if (!el.contains(hit)) continue;
    if (isDecorativeMediaElement(hit)) return true;
    const svg = hit.closest && hit.closest('svg');
    if (svg && el.contains(svg)) return true;
  }
  return false;
}

function definitionListItemAcceptsHoverPoint(el, clientX, clientY) {
  if (getContainingTextRectsForPoint(el, clientX, clientY).length > 0) {
    return true;
  }
  if (findMultiColumnStatDlGridFromNode(el)) {
    return isPointerOnDecorativeMediaInElement(el, clientX, clientY);
  }
  const rect = el.getBoundingClientRect();
  return !!(
    rect.width > 0 && rect.height > 0 &&
    clientX >= rect.left && clientX <= rect.right &&
    clientY >= rect.top && clientY <= rect.bottom
  );
}

function resolveCompactStatDlUnitAtPoint(clientX, clientY) {
  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  const grid = findMultiColumnStatDlGridFromNode(node);
  if (!grid) return null;

  if (typeof document.elementsFromPoint === 'function') {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (let i = 0; i < stack.length; i++) {
      const el = stack[i];
      if (!grid.contains(el)) continue;
      if (el.tagName !== 'DT' && el.tagName !== 'DD') continue;
      if (!(el.textContent || '').trim()) continue;
      if (definitionListItemAcceptsHoverPoint(el, clientX, clientY)) {
        return el;
      }
    }
  }

  let cur = node;
  while (cur && grid.contains(cur)) {
    if (cur.tagName === 'DT' || cur.tagName === 'DD') {
      if (
        (cur.textContent || '').trim() &&
        definitionListItemAcceptsHoverPoint(cur, clientX, clientY)
      ) {
        return cur;
      }
    }
    cur = cur.parentElement;
  }
  return null;
}

// §34 EH-1: Enjoy Honda `div.info-box` > `dl.desc` + `p.note`
function isDlDescCompanionNote(el) {
  if (!el || el.tagName !== 'P') return false;
  const prev = el.previousElementSibling;
  return !!(prev && prev.tagName === 'DL' && prev.querySelector('dt'));
}

function isPointInsideDlDescInfoBox(clientX, clientY) {
  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  if (!node || !node.closest) return false;
  const box = node.closest('.info-box');
  if (!box) return false;
  const dl = box.querySelector(':scope > dl.desc, :scope > dl');
  return !!(dl && dl.querySelector('dt'));
}

function isDlDescAggregateDiv(el) {
  if (!el || el.tagName !== 'DIV') return false;
  if (!el.classList || !el.classList.contains('info-box')) return false;
  const dl = el.querySelector(':scope > dl.desc, :scope > dl');
  return !!(dl && dl.querySelector('dt'));
}

function resolveDlDescUnitAtPoint(clientX, clientY) {
  if (!isPointInsideDlDescInfoBox(clientX, clientY)) return null;

  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }

  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (isHighlightExcludedCodeElement(node)) {
      node = node.parentElement;
      continue;
    }
    if (node.tagName === 'DT' || node.tagName === 'DD') {
      if (!(node.textContent || '').trim()) {
        node = node.parentElement;
        continue;
      }
      if (definitionListItemAcceptsHoverPoint(node, clientX, clientY)) {
        return node;
      }
      node = node.parentElement;
      continue;
    }
    if (node.tagName === 'P' && isDlDescCompanionNote(node)) {
      if (definitionListItemAcceptsHoverPoint(node, clientX, clientY)) {
        return node;
      }
    }
    node = node.parentElement;
  }
  return null;
}

// §50 AT-2: dd/dt 内の本文専用 div（except 等）を dd 全体より優先する。
// dd ホストだと §36 の pointer 視覚行絞りが発火し、折り返し文で
// 「行途中切れ」に見え、かつ進行時間が論理塊全文のまま遅くなる。
function isPlainTextOnlyDivElement(el) {
  if (!el || el.tagName !== 'DIV') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  if (hasDirectElementChild(el) && !hasOnlyDecorativeMediaElementChildren(el)) return false;
  return !!(el.textContent || '').trim();
}

function findPreferredInnerBlockInDefinitionListItem(listItem, clientX, clientY) {
  if (!listItem || (listItem.tagName !== 'DT' && listItem.tagName !== 'DD')) return null;

  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  if (!node || !listItem.contains(node)) return null;

  while (node && node !== listItem) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (node.tagName === 'P' && isBlockHighlightContainer(node)) {
      return { mode: 'element', element: node };
    }
    if (
      node.tagName === 'DIV' &&
      isPlainTextOnlyDivElement(node) &&
      inlineTextHostAcceptsHoverPoint(node, clientX, clientY)
    ) {
      // §50 AT-2: leaf 除外コンテキスト（card-cell 祖先等）は見ない。
      // 除外すると dd ホストに戻り pointer 行絞りで折り返し細切れになる。
      return { mode: 'inline-text', element: node };
    }
    node = node.parentElement;
  }
  return null;
}

function findDefinitionListItemBlockFromPoint(clientX, clientY) {
  if (isGhostOverlayAtPoint(clientX, clientY)) return null;

  const dlDescUnit = resolveDlDescUnitAtPoint(clientX, clientY);
  if (dlDescUnit) {
    return { mode: 'element', element: dlDescUnit };
  }

  if (isPointInsideMultiColumnStatDlGrid(clientX, clientY)) {
    const compactUnit = resolveCompactStatDlUnitAtPoint(clientX, clientY);
    if (compactUnit) {
      return { mode: 'element', element: compactUnit };
    }
    return null;
  }

  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }

  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (isHighlightExcludedCodeElement(node)) {
      node = node.parentElement;
      continue;
    }
    if (node.tagName === 'DT' || node.tagName === 'DD') {
      if (!(node.textContent || '').trim()) {
        node = node.parentElement;
        continue;
      }
      if (definitionListItemAcceptsHoverPoint(node, clientX, clientY)) {
        const inner = findPreferredInnerBlockInDefinitionListItem(node, clientX, clientY);
        if (inner) return inner;
        return { mode: 'element', element: node };
      }
      node = node.parentElement;
      continue;
    }
    node = node.parentElement;
  }
  return null;
}

function findBrOnlyDivBlockFromPoint(clientX, clientY) {
  if (isGhostOverlayAtPoint(clientX, clientY)) return null;

  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }

  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (isHighlightExcludedCodeElement(node)) {
      node = node.parentElement;
      continue;
    }
    if (node.tagName === 'DIV') {
      if (isBrOnlyDivElement(node) && !isBrOnlyDivExcludedContext(node)) {
        if (brOnlyDivAcceptsHoverPoint(node, clientX, clientY)) {
          return { mode: 'element', element: node };
        }
        return null;
      }
    }
    node = node.parentElement;
  }
  return null;
}

// §69 IK-1: 句点分割可能な長文葉 div の絶対上限（レイアウト捨て DOM 誤認防止）
const MAX_LEAF_TEXT_DIV_PROSE_LENGTH = 500;

function isLeafTextDivStructure(el) {
  if (!el || el.tagName !== 'DIV') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (isHighlightExcludedCodeElement(el)) return false;
  // §24 L4: 要素子なし、または装飾メディアのみ、または §52 phrasing のみ（br なし）
  if (hasDirectElementChild(el) && !hasOnlyDecorativeMediaElementChildren(el)) {
    if (!hasOnlyNonBrPhrasingDirectElementChildren(el)) return false;
  }
  return !!(el.textContent || '').trim();
}

function canChunkLeafTextDivProse(text) {
  if (!text) return false;
  if (/[。！？]/.test(text)) return true;
  return countWords(text) > MAX_WORDS_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_EN;
}

function isLeafTextDivElement(el) {
  if (!isLeafTextDivStructure(el)) return false;
  const text = (el.textContent || '').trim();
  const maxJa = MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA;
  const maxEn = MAX_WORDS_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_EN;
  if (text.length <= maxJa && countWords(text) <= maxEn) return true;
  // §69 IK-1: 短文上限超でも句点／語境界で分割できる葉 prose は許可
  if (text.length > MAX_LEAF_TEXT_DIV_PROSE_LENGTH) return false;
  return canChunkLeafTextDivProse(text);
}

// §69 IK-2: 見出し＋複数テキスト塊の一覧カード LI（いこーよ施設カード等）
function isRichMultiUnitListItem(li) {
  if (!li || li.tagName !== 'LI') return false;
  if (isYomupUiElement(li) || isEditableElement(li)) return false;
  if (isFlowStepListItemStructure(li)) return false;

  let hasHeading = false;
  const headingNodes = li.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (let i = 0; i < headingNodes.length; i++) {
    if ((headingNodes[i].textContent || '').trim()) {
      hasHeading = true;
      break;
    }
  }

  let leafCount = 0;
  const divs = li.getElementsByTagName('div');
  for (let i = 0; i < divs.length; i++) {
    if (isLeafTextDivStructure(divs[i])) leafCount++;
  }

  if (hasHeading && leafCount >= 1) return true;
  if (leafCount >= 2) return true;
  return false;
}

function isLeafTextDivExcludedContext(el) {
  if (!el) return true;
  if (isHighlightIgnoredShellElement(el)) return true;
  if (isNodeInsideTable(el)) return true;
  if (isWithinUiChromeRegion(el)) return true;

  let ancestor = el.parentElement;
  while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
    if (isBrFlowContainer(ancestor)) return true;
    ancestor = ancestor.parentElement;
  }

  if (isRubyBrBlockHost()) {
    if (hasRubyBrBlockAozoraStructuralSignature(el)) return true;
    let aozoraAncestor = el.parentElement;
    while (aozoraAncestor && aozoraAncestor !== document.body && aozoraAncestor !== document.documentElement) {
      if (hasRubyBrBlockAozoraStructuralSignature(aozoraAncestor)) return true;
      aozoraAncestor = aozoraAncestor.parentElement;
    }
  }

  if (el.closest && el.closest('.faq-answer')) return true;
  if (isGhostOverlayLink(el)) return true;
  if (isAggregateFeatureColumnElement(el)) return true;
  if (containsNestedFeatureIconCardBlocks(el)) return true;
  if (isCardCellStructure(el)) return true;
  if (isInnerCardCellStructure(el)) return true;

  let cardAncestor = el.parentElement;
  while (cardAncestor && cardAncestor !== document.body && cardAncestor !== document.documentElement) {
    if (isCardCellStructure(cardAncestor) || isInnerCardCellStructure(cardAncestor)) {
      // §69 IK-2: 複合一覧 LI 内の葉は card/inner-card 祖先でも許可（unit 誤認時の不発防止）
      const richLi = el.closest && el.closest('li');
      if (richLi && isRichMultiUnitListItem(richLi)) return false;
      return !(cardAncestor === el.parentElement && el.tagName === 'DIV');
    }
    cardAncestor = cardAncestor.parentElement;
  }

  return false;
}

function findLeafTextDivBlockFromPoint(clientX, clientY) {
  if (isGhostOverlayAtPoint(clientX, clientY)) return null;

  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = getNonShellElementFromPoint(clientX, clientY);
  }
  if (node && isHighlightIgnoredShellElement(node)) {
    node = getNonShellElementFromPoint(clientX, clientY);
  }

  while (node && node !== document.body && node !== document.documentElement) {
    if (isYomupUiElement(node) || isEditableElement(node)) return null;
    if (isHighlightExcludedCodeElement(node)) {
      node = node.parentElement;
      continue;
    }
    if (node.tagName === 'DIV') {
      if (isLeafTextDivElement(node) && !isLeafTextDivExcludedContext(node)) {
        if (inlineTextHostAcceptsHoverPoint(node, clientX, clientY)) {
          return { mode: 'inline-text', element: node };
        }
        return null;
      }
    }
    node = node.parentElement;
  }
  return null;
}

function isRubyBrBlockHost() {
  const host = location.hostname || '';
  return host === RUBY_BR_BLOCK_HOST || host.endsWith('.' + RUBY_BR_BLOCK_HOST);
}

function isRubyBrBlockExcludedContainer(el) {
  if (!el || !el.classList) return false;
  for (const cls of RUBY_BR_BLOCK_EXCLUDED_CLASSES) {
    if (el.classList.contains(cls)) return true;
  }
  return false;
}

function hasRubyBrBlockAozoraStructuralSignature(el) {
  if (!el || el.tagName !== 'DIV') return false;
  if (isRubyBrBlockExcludedContainer(el)) return false;
  if (el.querySelectorAll('br').length < RUBY_BR_BLOCK_MIN_BR_COUNT) return false;
  return (el.textContent || '').trim().length >= RUBY_BR_BLOCK_MIN_TEXT_LENGTH;
}

function isRubyBrBlockContainer(el) {
  if (!el || el.tagName !== 'DIV') return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;
  if (!isRubyBrBlockHost()) return false;
  return hasRubyBrBlockAozoraStructuralSignature(el);
}

function findRubyBrContainerFromNode(node) {
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== document.body && el !== document.documentElement) {
    if (isRubyBrBlockContainer(el)) return el;
    el = el.parentElement;
  }
  return null;
}

function findRubyBrBlockFromPoint(clientX, clientY) {
  const caretNode = getPointReferenceNode(clientX, clientY);
  if (!caretNode) return null;

  if (isNodeInsideTable(caretNode)) return null;
  if (isWithinUiChromeRegion(caretNode)) return null;

  const container = findRubyBrContainerFromNode(caretNode);
  if (!container || !container.contains(caretNode)) return null;
  if (isHighlightExcludedCodeElement(container)) return null;
  if (!(container.textContent || '').trim()) return null;

  return { mode: 'element', element: container };
}

function isAozoraBrSeparatedLineContainer(el) {
  if (!el || !el.classList || !isRubyBrBlockContainer(el)) return false;
  for (const cls of AOZORA_BR_SEPARATED_LINE_CONTAINER_CLASSES) {
    if (el.classList.contains(cls)) return true;
  }
  return false;
}

function findAozoraBrSeparatedTextLineFromPoint(clientX, clientY) {
  if (!isRubyBrBlockHost()) return null;
  const caretNode = getPointReferenceNode(clientX, clientY);
  if (!caretNode || caretNode.nodeType !== Node.TEXT_NODE) return null;
  if (isNodeInsideTable(caretNode)) return null;
  if (isWithinUiChromeRegion(caretNode)) return null;

  const parent = caretNode.parentElement;
  if (!parent || !isAozoraBrSeparatedLineContainer(parent)) return null;
  if (isYomupUiElement(parent) || isEditableElement(parent)) return null;
  if (!shouldIncludeTextNodeInBlock(caretNode, parent)) return null;

  const text = (caretNode.textContent || '').trim();
  if (text.length < AOZORA_BR_LINE_MIN_TEXT_LENGTH) return null;
  if (text.length > MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA) return null;

  return {
    mode: 'element',
    element: parent,
    scopedTextNode: caretNode
  };
}

function findAozoraHighlightBlockFromPoint(clientX, clientY) {
  if (!isRubyBrBlockHost()) return null;
  const brLine = findAozoraBrSeparatedTextLineFromPoint(clientX, clientY);
  if (brLine) return brLine;
  const rubyBrBlock = findRubyBrBlockFromPoint(clientX, clientY);
  if (rubyBrBlock) return rubyBrBlock;
  return findAozoraOrphanTextBlockFromPoint(clientX, clientY);
}

function isAozoraSpecialHighlightBlock(highlightBlock) {
  if (!isRubyBrBlockHost() || !highlightBlock) return false;
  if (highlightBlock.scopedTextNode) return true;
  return !!(
    isElementHighlightBlock(highlightBlock) &&
    highlightBlock.element &&
    isRubyBrBlockContainer(highlightBlock.element)
  );
}

function elementContainsNestedDocumentRoot(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (el.tagName === 'HTML' || el.tagName === 'BODY') return false;
  return !!(el.querySelector('html, head, body'));
}

function collectSingleTextNodeSegments(textNode) {
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    return { blockText: '', segments: [] };
  }
  const raw = textNode.textContent || '';
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  const trimmed = raw.slice(lead, raw.length - trail);
  if (!trimmed) return { blockText: '', segments: [] };
  return {
    blockText: trimmed,
    segments: [{ node: textNode, start: 0, end: trimmed.length, text: trimmed, nodeOffset: lead }]
  };
}

function findAozoraOrphanTextBlockFromPoint(clientX, clientY) {
  if (!isRubyBrBlockHost()) return null;
  const caretNode = getPointReferenceNode(clientX, clientY);
  if (!caretNode || caretNode.nodeType !== Node.TEXT_NODE) return null;
  if (isNodeInsideTable(caretNode)) return null;
  if (isWithinUiChromeRegion(caretNode)) return null;

  const parent = caretNode.parentElement;
  if (!parent || !parent.tagName || !AOZORA_ORPHAN_TEXT_PARENT_TAGS.has(parent.tagName)) {
    return null;
  }
  if (isYomupUiElement(parent) || isEditableElement(parent)) return null;

  const text = (caretNode.textContent || '').trim();
  if (text.length < RUBY_BR_BLOCK_MIN_TEXT_LENGTH) return null;
  if (text.length > MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA) return null;
  if (!shouldIncludeTextNodeInBlock(caretNode, parent)) return null;

  return {
    mode: 'element',
    element: parent,
    scopedTextNode: caretNode
  };
}

function isElementHighlightBlock(block) {
  return block.mode === 'element' || block.mode === 'inline-text';
}

function isInlineTextHighlightBlock(block) {
  return !!(block && block.mode === 'inline-text');
}

function hasDirectElementChild(el) {
  if (!el) return false;
  for (let i = 0; i < el.childNodes.length; i++) {
    if (el.childNodes[i].nodeType === Node.ELEMENT_NODE) return true;
  }
  return false;
}

function isDecorativeMediaElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = el.tagName;
  return tag === 'IMG' || tag === 'SVG' || tag === 'PICTURE';
}

// Ko-fi 大見出し等: テキスト + コイン img のみの div を leaf-text 対象に含める
function hasOnlyDecorativeMediaElementChildren(el) {
  if (!el) return false;
  let hasText = false;
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent || '').trim()) hasText = true;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return false;
    if (!isDecorativeMediaElement(child)) return false;
  }
  return hasText;
}

function getSectionBlockRoot(block) {
  if (block.mode === 'br-flow') return block.container;
  if (block.mode === 'heading-interval') return block.root;
  return null;
}

function isBrFlowContainer(el) {
  if (!el || !el.tagName || !BR_FLOW_CONTAINER_TAGS.has(el.tagName)) return false;
  if (isYomupUiElement(el) || isEditableElement(el)) return false;

  let hasDirectHeading = false;
  let hasDirectBody = false;
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName;
      if (tag && BR_FLOW_BOUNDARY_TAGS.has(tag)) hasDirectHeading = true;
      if (tag === 'BR') hasDirectBody = true;
    } else if (child.nodeType === Node.TEXT_NODE && (child.textContent || '').trim()) {
      hasDirectBody = true;
    }
  }
  return hasDirectHeading && hasDirectBody;
}

// br-flow 本文 vs 目次 `<a>` 等 — SPAN 細切れ（N-S1）を防ぎ list リンクは inline 維持
function shouldPreferInlineTextOverBrFlow(inlineHost) {
  if (!inlineHost || !inlineHost.tagName) return false;
  if (inlineHost.tagName === 'A') {
    return !!(inlineHost.closest && inlineHost.closest('li, nav, header, footer'));
  }
  if (inlineHost.tagName === 'TIME' || inlineHost.tagName === 'BUTTON' || inlineHost.tagName === 'LABEL') {
    return true;
  }
  return false;
}

function getDirectChildBrFlowHeadings(container) {
  const headings = [];
  for (let i = 0; i < container.childNodes.length; i++) {
    const child = container.childNodes[i];
    if (child.nodeType !== Node.ELEMENT_NODE || !child.tagName) continue;
    if (!BR_FLOW_BOUNDARY_TAGS.has(child.tagName)) continue;
    if (isYomupUiElement(child)) continue;
    headings.push(child);
  }
  return headings;
}

function findBrFlowSectionBoundaries(headings, caretNode) {
  if (!caretNode || headings.length === 0) return null;
  if (isCaretOnHeadingElement(caretNode, headings)) return null;

  let startHeading = null;
  let endHeading = null;

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h.compareDocumentPosition(caretNode) & Node.DOCUMENT_POSITION_FOLLOWING) {
      startHeading = h;
    }
  }
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (caretNode.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) {
      endHeading = h;
      break;
    }
  }

  if (!startHeading && !endHeading) return null;
  return { startHeading, endHeading };
}

function findBrFlowContainerFromNode(node) {
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== document.body && el !== document.documentElement) {
    if (isBrFlowContainer(el)) return el;
    el = el.parentElement;
  }
  return null;
}

function findBrFlowBlockFromPoint(clientX, clientY) {
  const caretNode = getPointReferenceNode(clientX, clientY);
  if (!caretNode) return null;

  if (isNodeInsideTable(caretNode)) return null;
  if (isWithinUiChromeRegion(caretNode)) return null;
  if (isPointInRubyBrBlockRegion(caretNode)) return null;
  // §34 EH-1: `dl.desc` info-box は dt/dd/p 専用経路へ
  if (isPointInsideDlDescInfoBox(clientX, clientY)) return null;

  const container = findBrFlowContainerFromNode(caretNode);
  if (!container) return null;

  const headings = getDirectChildBrFlowHeadings(container);
  const bounds = findBrFlowSectionBoundaries(headings, caretNode);
  if (!bounds) return null;

  return {
    mode: 'br-flow',
    container,
    startHeading: bounds.startHeading,
    endHeading: bounds.endHeading
  };
}

function findHeadingIntervalBlockFromPoint(clientX, clientY) {
  const caretNode = getPointReferenceNode(clientX, clientY);
  if (!caretNode) return null;

  // 表内はセル単位（findTableCellBlockFromPoint）に任せ、見出し間ブロックは使わない
  if (isNodeInsideTable(caretNode)) return null;

  // UI クローム（header/footer/nav）内では heading-interval を使わない（§3.7.2）
  if (isWithinUiChromeRegion(caretNode)) return null;
  if (isPointInRubyBrBlockRegion(caretNode)) return null;
  // §34 EH-1: `dl.desc` info-box は dt/dd/p 専用経路へ
  if (isPointInsideDlDescInfoBox(clientX, clientY)) return null;

  const root = findHeadingSectionRoot(caretNode);
  if (!root) return null;

  const headings = getOrderedHeadingSections(root);
  if (headings.length === 0) return null;

  const bounds = findHeadingIntervalBoundaries(headings, caretNode);
  if (!bounds) return null;

  return {
    mode: 'heading-interval',
    root,
    startHeading: bounds.startHeading,
    endHeading: bounds.endHeading
  };
}

function findPreBlockFromPoint(clientX, clientY) {
  let node = getPointReferenceNode(clientX, clientY);
  if (node && node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  if (!node) {
    node = document.elementFromPoint(clientX, clientY);
  }
  if (!node || !node.closest) return null;
  if (isYomupUiElement(node) || isEditableElement(node)) return null;
  if (isHighlightExcludedCodeElement(node)) return null;

  const pre = node.closest('pre');
  if (!pre || isYomupUiElement(pre) || isEditableElement(pre)) return null;
  return pre;
}

function findHighlightBlockFromPoint(clientX, clientY) {
  const block = findHighlightBlockFromPointCore(clientX, clientY);
  if (block && block.element && isHighlightIgnoredShellElement(block.element)) {
    logUnderlineTrace('block-reject-shell', summarizeHighlightBlockForTrace(block));
    return recoverHighlightBlockFromHitStack(clientX, clientY);
  }
  return block;
}

function findHighlightBlockFromPointCore(clientX, clientY) {
  // 表セル内の pre はセル全体ではなく pre 単位で行分割する
  const preBlock = findPreBlockFromPoint(clientX, clientY);
  if (preBlock) {
    return { mode: 'element', element: preBlock };
  }

  // §64 AS-3: <caption> は表セル経路より先（KZ-1 ADDRESS と同型のブロック祖先）
  const tableCaption = findTableCaptionBlockFromPoint(clientX, clientY);
  if (tableCaption) {
    return { mode: 'element', element: tableCaption };
  }

  const tableCell = findTableCellBlockFromPoint(clientX, clientY);
  if (tableCell) {
    const layoutInner = findLayoutTableCellInnerBlockFromPoint(clientX, clientY, tableCell);
    if (layoutInner) return layoutInner;
    // §49 MS-4: ol/li・option-item 等をセル全文より先に採用
    const contentInner = findContentTableCellInnerBlockFromPoint(clientX, clientY, tableCell);
    if (contentInner) return contentInner;
    return { mode: 'element', element: tableCell };
  }

  // §16 AZ-1: 青空は ruby-br / orphan を見出し・dl 系より先（§34〜38 退行防止）
  const aozoraBlock = findAozoraHighlightBlockFromPoint(clientX, clientY);
  if (aozoraBlock) return aozoraBlock;

  const pointNode = getPointReferenceNode(clientX, clientY) || getNonShellElementFromPoint(clientX, clientY);

  // §4.5.2: FAQ — block 祖先（P）より先に faq-answer 経路へ
  if (isWithinFaqAnswerRegion(pointNode)) {
    const faqAnswerEarly = findFaqAnswerBlockFromPoint(clientX, clientY);
    if (faqAnswerEarly) return faqAnswerEarly;
  }

  // header/footer/nav 内では LI よりインライン短文を優先（§3.7.2）
  // §52 CO-2: 直テキスト header/footer/nav は §3.7.1 ホスト外のため chrome 専用救済
  if (isWithinUiChromeRegion(pointNode)) {
    const chromeInlineHost =
      findBestInlineTextHostFromPoint(clientX, clientY) ||
      findChromeRegionPlainTextHostFromPoint(clientX, clientY);
    if (chromeInlineHost) {
      return { mode: 'inline-text', element: chromeInlineHost };
    }
  }

  const geminiSequenceUnit = findGeminiSequenceTextUnitFromPoint(clientX, clientY);
  if (geminiSequenceUnit) {
    return { mode: 'inline-text', element: geminiSequenceUnit };
  }

  // li 内見出しは §3.2 専用 Range を deepestLi より優先（表セル目次型と同型）
  const heading = findHeadingBlockFromPoint(clientX, clientY);
  if (heading) {
    // §45 JL-1: 複数直下要素の見出しは子テキストを優先（下線 Y ずれ・塊の取り違え防止）
    const headingChild = resolveHeadingChildTextHostAtPoint(heading, clientX, clientY);
    if (headingChild) {
      return { mode: 'inline-text', element: headingChild };
    }
    return { mode: 'element', element: heading };
  }

  const blockLabel = findBlockLabelFromPoint(clientX, clientY);
  if (blockLabel) {
    return { mode: 'inline-text', element: blockLabel };
  }

  // §43 AL-2b: guide-card 本文（見出し strong の後）
  const titleBodyAnchorBody = findTitleBodyPhrasingAnchorBodyFromPoint(clientX, clientY);
  if (titleBodyAnchorBody) return titleBodyAnchorBody;

  const flowStep = findFlowStepBlockFromPoint(clientX, clientY);
  if (flowStep) return flowStep;

  // §36 B: dt/dd 実績行 — inner-card / card-cell より先（§34 EH-1 同型）
  const definitionListItemEarly = findDefinitionListItemBlockFromPoint(clientX, clientY);
  if (definitionListItemEarly) return definitionListItemEarly;
  if (isPointInsideMultiColumnStatDlGrid(clientX, clientY)) return null;

  // §43 AL-4: 積み上げ span 行（lesson-card 等）— inner-card 誤認より先
  const stackedSpanLine = findStackedVisualLineSpanFromPoint(clientX, clientY);
  if (stackedSpanLine) return stackedSpanLine;

  // §43 AL-5: step-item 行（badge / 題名 / 本文）— card-cell 全体誤認より先
  const multiLineStepLine = findMultiLineStepCardLineFromPoint(clientX, clientY);
  if (multiLineStepLine) return multiLineStepLine;

  // §38 N-N1: 複合 <a>（直下 span のみ）— span テキスト上のみ。列間 gap は不発
  // §69: rich-list 葉より先（西川 categories G06 退行防止）
  let compositeAnchorNode = pointNode;
  if (compositeAnchorNode && compositeAnchorNode.nodeType === Node.TEXT_NODE) {
    compositeAnchorNode = compositeAnchorNode.parentElement;
  }
  const compositeAnchor = findCompositeAnchorFromNode(compositeAnchorNode);
  if (compositeAnchor) {
    const compositeAnchorInline = resolveAnchorWrapperInlineTextHost(
      compositeAnchorNode,
      clientX,
      clientY
    );
    if (compositeAnchorInline) {
      return { mode: 'inline-text', element: compositeAnchorInline };
    }
    if (isMultiSpanCompositeAnchor(compositeAnchor)) {
      return null;
    }
  }

  // §69: 葉 div は inner-card / deepestLi より先
  // - LI 外（導入文 c-container 等 / IK-1）
  // - 複合一覧カード内（IK-2）
  const earlyLeafText = findLeafTextDivBlockFromPoint(clientX, clientY);
  if (earlyLeafText && earlyLeafText.element) {
    const leafLi =
      earlyLeafText.element.closest && earlyLeafText.element.closest('li');
    if (!leafLi || isRichMultiUnitListItem(leafLi)) {
      return earlyLeafText;
    }
  }

  const innerCardCell = findInnerCardCellBlockFromPoint(clientX, clientY);
  if (innerCardCell) return innerCardCell;

  const deepestLi = findDeepestListItemFromPoint(clientX, clientY);
  if (deepestLi) {
    if (
      !isFlowStepListItemStructure(deepestLi) &&
      !liContainsInnerCardCellAtPoint(deepestLi, clientX, clientY) &&
      // §69 IK-2: 複合一覧カードは LI 丸ごと点灯せず後段の leaf/inline へ
      !isRichMultiUnitListItem(deepestLi)
    ) {
      return { mode: 'element', element: deepestLi };
    }
  }

  if (isGhostOverlayAtPoint(clientX, clientY)) {
    const ghostStackBlock = findBlockInHitStackFromPoint(clientX, clientY);
    if (ghostStackBlock) return ghostStackBlock;
  }

  // §32 P1: Ko-fi 料金プラン（H2 + fee 行）→ feature 単卡 → block 祖先 → card-cell
  const cardCellPricingRow = findCardCellPricingRowBlockFromPoint(clientX, clientY);
  if (cardCellPricingRow) return cardCellPricingRow;

  const featureIconCard = findFeatureIconCardBlockFromPoint(clientX, clientY);
  if (featureIconCard) return featureIconCard;

  // §36 C': SVG + テキスト行 div（ステータス行）
  const iconTextRow = findIconTextRowBlockFromPoint(clientX, clientY);
  if (iconTextRow) return iconTextRow;

  // §39 AI-1: 県 CMS 等の <p> は block 祖先を優先。br-only div は下で継続（N-S1）
  const blockAncestor = findBlockAncestorFromPoint(clientX, clientY);
  if (blockAncestor) {
    return { mode: 'element', element: blockAncestor };
  }

  const brFlow = findBrFlowBlockFromPoint(clientX, clientY);
  const inlineHost = findBestInlineTextHostFromPoint(clientX, clientY);
  if (brFlow && (!inlineHost || !shouldPreferInlineTextOverBrFlow(inlineHost))) {
    return brFlow;
  }

  if (inlineHost) {
    return { mode: 'inline-text', element: inlineHost };
  }

  const brOnlyDiv = findBrOnlyDivBlockFromPoint(clientX, clientY);
  if (brOnlyDiv) return brOnlyDiv;

  const cardCell = findCardCellBlockFromPoint(clientX, clientY);
  if (cardCell) return cardCell;

  const faqAnswer = findFaqAnswerBlockFromPoint(clientX, clientY);
  if (faqAnswer) return faqAnswer;

  const leafTextDiv = findLeafTextDivBlockFromPoint(clientX, clientY);
  if (leafTextDiv) return leafTextDiv;

  const rubyBrBlock = findRubyBrBlockFromPoint(clientX, clientY);
  if (rubyBrBlock) return rubyBrBlock;

  const aozoraOrphanText = findAozoraOrphanTextBlockFromPoint(clientX, clientY);
  if (aozoraOrphanText) return aozoraOrphanText;

  const interval = findHeadingIntervalBlockFromPoint(clientX, clientY);
  if (interval) return interval;

  const stackBlock = findBlockInHitStackFromPoint(clientX, clientY);
  if (stackBlock) return stackBlock;

  return null;
}

function isNodeInHeadingInterval(node, root, startHeading, endHeading) {
  if (!node || !root) return false;
  if (!root.contains(node)) return false;
  // 見出し間ブロックの収集対象から table 配下を除外（表は TD/TH 単位で処理）
  if (isNodeInsideTable(node)) return false;

  if (startHeading && (startHeading === node || startHeading.contains(node))) return false;
  if (endHeading && (endHeading === node || endHeading.contains(node))) return false;

  if (startHeading && !(startHeading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) {
    return false;
  }
  if (endHeading && !(node.compareDocumentPosition(endHeading) & Node.DOCUMENT_POSITION_FOLLOWING)) {
    return false;
  }
  return true;
}

function highlightBlockContains(block, node) {
  if (!block || !node) return false;
  if (block.scopedTextNode) {
    return node === block.scopedTextNode;
  }
  if (isElementHighlightBlock(block)) {
    return block.element.contains(node);
  }
  const sectionRoot = getSectionBlockRoot(block);
  if (sectionRoot) {
    return isNodeInHeadingInterval(node, sectionRoot, block.startHeading, block.endHeading);
  }
  return false;
}

function shouldIncludeTextNodeInBlock(node, blockElement) {
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  const parent = node.parentElement;
  if (!parent || isYomupUiElement(parent)) return false;
  if (parent.closest('script,style,noscript')) return false;
  if (isEditableElement(parent)) return false;
  if (parent.closest('rt,rp')) return false;
  // §53 CP-3: 見出しはタイトル文言のみ（同居 UI ツールバー等を語数・下線から除外）
  if (blockElement && isHeadingHighlightHost(blockElement)) {
    if (!isHeadingTitleTextNode(node, blockElement)) return false;
  }
  if (parent.closest('code')) {
    const codeEl = parent.closest('code');
    if (blockElement && blockElement.tagName === 'PRE' && blockElement.contains(parent)) {
      return true;
    }
    if (blockElement && blockElement.tagName === 'CODE' && blockElement === codeEl) {
      return true;
    }
    // §26: pre 外インライン code — ブロック（P 等）の segment に含める
    if (isInlineCodeElement(codeEl)) {
      if (
        blockElement &&
        blockElement !== codeEl &&
        blockElement.contains(codeEl)
      ) {
        return true;
      }
      // heading-interval 等（blockElement 未指定・preBlock のみ）でも BLOCK_ANCESTOR 内なら含める
      if (!blockElement || blockElement.tagName === 'PRE') {
        let ancestor = codeEl.parentElement;
        while (ancestor && ancestor !== document.body) {
          if (
            ancestor.tagName &&
            BLOCK_ANCESTOR_TAGS.has(ancestor.tagName) &&
            ancestor.tagName !== 'PRE'
          ) {
            return true;
          }
          ancestor = ancestor.parentElement;
        }
      }
    }
    return false;
  }
  return true;
}

function collectBlockTextSegments(block) {
  const segments = [];
  let blockText = '';
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return shouldIncludeTextNodeInBlock(node, block)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent || '';
    if (!text) continue;
    const start = blockText.length;
    blockText += text;
    segments.push({ node, start, end: blockText.length, text });
  }
  return { blockText, segments };
}

function collectSectionTextSegments(sectionRoot, startHeading, endHeading) {
  const segments = [];
  let blockText = '';
  const walker = document.createTreeWalker(sectionRoot, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!shouldIncludeTextNodeInBlock(node)) return NodeFilter.FILTER_REJECT;
      return isNodeInHeadingInterval(node, sectionRoot, startHeading, endHeading)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent || '';
    if (!text) continue;
    const start = blockText.length;
    blockText += text;
    segments.push({ node, start, end: blockText.length, text });
  }
  return { blockText, segments };
}

function collectHeadingIntervalTextSegments(root, startHeading, endHeading) {
  return collectSectionTextSegments(root, startHeading, endHeading);
}

function collectHighlightBlockTextSegments(highlightBlock) {
  if (highlightBlock.scopedTextNode) {
    return collectSingleTextNodeSegments(highlightBlock.scopedTextNode);
  }
  if (isElementHighlightBlock(highlightBlock)) {
    return collectBlockTextSegments(highlightBlock.element);
  }
  const sectionRoot = getSectionBlockRoot(highlightBlock);
  return collectSectionTextSegments(
    sectionRoot,
    highlightBlock.startHeading,
    highlightBlock.endHeading
  );
}

function shouldFlushAfterBlockDirectTextDiv(block, child, parent) {
  if (parent !== block) return false;
  if (!child || child.tagName !== 'DIV') return false;
  if (!(child.textContent || '').trim()) return false;
  if (isInnerCardCellStructure(block)) return false;
  return getDirectTextDivChildren(block).length >= 2;
}

// 日本語: <br> / pre 内 \n / p 内 \n\n+ / リスト境界を論理行としてテキストを連結（DOM は変更しない）
function collectBlockTextSegmentLines(block) {
  const lines = [];
  let current = { blockText: '', segments: [] };
  const isPreBlock = block.tagName === 'PRE';
  const isPBlock = block.tagName === 'P';
  const isDdBlock = block.tagName === 'DD';
  const isLiBlock = block.tagName === 'LI';
  const isTableCellBlock = block.tagName === 'TD' || block.tagName === 'TH';

  const flushLine = () => {
    if (current.segments.length > 0) {
      lines.push(current);
    }
    current = { blockText: '', segments: [] };
  };

  const isCollapsedResponsiveLineBreak = (el) => {
    if (!el || el.tagName !== 'BR') return false;
    const cls = String(el.className || '');
    if (!/(?:^|\s)sp-view(?:\s|$)/.test(cls) && !/(?:^|\s)sp(?:\s|$)/.test(cls)) {
      return false;
    }
    try {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0) return true;
    } catch (_e) {
      return false;
    }
    return false;
  };

  const appendTextNode = (node) => {
    const text = node.textContent || '';
    if (!text) return;
    if (isPreBlock && text.indexOf('\n') >= 0) {
      const parts = text.split('\n');
      let nodeOffset = 0;
      for (let pi = 0; pi < parts.length; pi++) {
        const part = parts[pi];
        if (part) {
          const start = current.blockText.length;
          current.blockText += part;
          current.segments.push({
            node, start, end: current.blockText.length, text: part, nodeOffset
          });
        }
        if (pi < parts.length - 1) {
          flushLine();
          nodeOffset += part.length + 1;
        }
      }
      return;
    }
    // p 内は空行（\n\n 以上）のみ論理行境界（ソース折り返しの単独 \n は連結）
    if (isPBlock && /\n{2,}/.test(text)) {
      const re = /\n{2,}/g;
      let lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        const part = text.slice(lastIndex, match.index);
        if (part) {
          const start = current.blockText.length;
          current.blockText += part;
          current.segments.push({
            node, start, end: current.blockText.length, text: part, nodeOffset: lastIndex
          });
        }
        flushLine();
        lastIndex = match.index + match[0].length;
      }
      const rest = text.slice(lastIndex);
      if (rest) {
        const start = current.blockText.length;
        current.blockText += rest;
        current.segments.push({
          node, start, end: current.blockText.length, text: rest, nodeOffset: lastIndex
        });
      }
      return;
    }
    const start = current.blockText.length;
    current.blockText += text;
    current.segments.push({ node, start, end: current.blockText.length, text });
  };

  const walkNodes = (parent) => {
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') {
        if (!isCollapsedResponsiveLineBreak(child)) {
          flushLine();
        }
      } else if (child.nodeType === Node.ELEMENT_NODE && LIST_LINE_BREAK_TAGS.has(child.tagName)) {
        // li 直下テキストと子 ul/ol 内 li の連結防止（入れ子リスト）
        flushLine();
        walkNodes(child);
        flushLine();
      } else if (
        child.nodeType === Node.ELEMENT_NODE &&
        isDdBlock &&
        parent === block &&
        DD_CHILD_LINE_BREAK_TAGS.has(child.tagName)
      ) {
        walkNodes(child);
        flushLine();
      } else if (
        child.nodeType === Node.ELEMENT_NODE &&
        isLiBlock &&
        parent === block &&
        LI_CHILD_LINE_BREAK_TAGS.has(child.tagName)
      ) {
        walkNodes(child);
        flushLine();
      } else if (
        child.nodeType === Node.ELEMENT_NODE &&
        isTableCellBlock &&
        parent === block &&
        TD_CHILD_LINE_BREAK_TAGS.has(child.tagName)
      ) {
        walkNodes(child);
        flushLine();
      } else if (
        child.nodeType === Node.ELEMENT_NODE &&
        BLOCK_LABEL_PARENT_TAGS.has(parent.tagName) &&
        isBlockLabelElement(child)
      ) {
        walkNodes(child);
        flushLine();
      } else if (
        child.nodeType === Node.ELEMENT_NODE &&
        parent === block &&
        !isPBlock &&
        child.tagName === 'P'
      ) {
        // §39 AI-1: 兄弟 <p> 連結防止（県 CMS 等）
        walkNodes(child);
        flushLine();
      } else if (
        child.nodeType === Node.ELEMENT_NODE &&
        HEADING_SECTION_TAGS.has(child.tagName)
      ) {
        flushLine();
        walkNodes(child);
        flushLine();
      } else if (child.nodeType === Node.TEXT_NODE) {
        if (shouldIncludeTextNodeInBlock(child, block)) {
          appendTextNode(child);
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (isYomupUiElement(child) || isEditableElement(child)) continue;
        if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'NOSCRIPT') {
          continue;
        }
        // §53 CP-3: 見出し直下の UI / 非タイトル要素は走査しない
        if (
          isHeadingHighlightHost(block) &&
          parent === block &&
          (isHeadingChromeSubtreeElement(child) || !isHeadingTitlePhrasingAncestor(child))
        ) {
          continue;
        }
        walkNodes(child);
        if (shouldFlushAfterBlockDirectTextDiv(block, child, parent)) {
          flushLine();
        }
      }
    }
  };

  walkNodes(block);
  flushLine();

  if (lines.length === 0) {
    return [collectBlockTextSegments(block)];
  }
  return mergeShortJapaneseParenLogicalLines(lines);
}

function isIndependentJapaneseLogicalLine(text) {
  const t = stripLeadingFormatChars((text || '').trim());
  // §50 AT-1: 学校 CMS 等の「〇／○」箇条書きも br 行分割対象（MS-1 と同型）
  if (/^[・•\-※■〇○]/.test(t)) return true;
  // §66 SV-2: 丸数字 ①–⑳（採用ページの職種行など）
  if (/^[\u2460-\u2473]/.test(t)) return true;
  // §58 AT-6: 「B　当日動画」「１　導入…」等のセクション／番号ラベル行
  if (/^[A-Za-zＡ-Ｚａ-ｚ][　\s]/.test(t)) return true;
  if (/^[０-９0-9]+[　\s\.．、）)]/.test(t)) return true;
  return false;
}

// 全角括弧の未閉じ深さ（閉じ超過は 0 にクランプ）
function japaneseFullwidthParenDepth(text) {
  let depth = 0;
  const s = text || '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '（') depth++;
    else if (ch === '）') depth = Math.max(0, depth - 1);
  }
  return depth;
}

function mergeShortJapaneseParenLogicalLines(lines) {
  if (!lines || lines.length < 2) return lines;
  const merged = [];
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i];
    const curText = (cur.blockText || '').trim();
    if (
      i + 1 < lines.length &&
      curText.length > 0 &&
      curText.length < COALESCE_MIN_CHARS_JA &&
      // §43 AL-6: 全角 `）` のみ（ASCII `)` は void loop() 等のコード行を誤結合する）
      /）$/.test(curText) &&
      // §56 AT-3: 括弧が閉じ済み（深さ 0）の短行は次行と結合しない（肩書き括弧の短行＋次見出し 等）
      japaneseFullwidthParenDepth(curText) > 0
    ) {
      const next = lines[i + 1];
      const nextText = (next.blockText || '').trim();
      if (
        !isIndependentJapaneseLogicalLine(curText) &&
        !isIndependentJapaneseLogicalLine(nextText)
      ) {
        const combinedLen = cur.blockText.length + next.blockText.length;
        if (combinedLen <= MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA) {
          const offset = cur.blockText.length;
          const nextSegments = next.segments.map((seg) => ({
            node: seg.node,
            start: seg.start + offset,
            end: seg.end + offset,
            text: seg.text,
            nodeOffset: seg.nodeOffset
          }));
          merged.push({
            blockText: cur.blockText + next.blockText,
            segments: cur.segments.concat(nextSegments)
          });
          i += 2;
          continue;
        }
      }
    }
    merged.push(cur);
    i++;
  }
  return merged;
}

function collectSectionTextSegmentLines(sectionRoot, startHeading, endHeading) {
  const lines = [];
  let current = { blockText: '', segments: [] };

  const flushLine = () => {
    if (current.segments.length > 0) {
      lines.push(current);
    }
    current = { blockText: '', segments: [] };
  };

  const appendTextNode = (node) => {
    const text = node.textContent || '';
    if (!text) return;
    const start = current.blockText.length;
    current.blockText += text;
    current.segments.push({ node, start, end: current.blockText.length, text });
  };

  const inSection = (node) =>
    isNodeInHeadingInterval(node, sectionRoot, startHeading, endHeading);

  const walkNodes = (parent, preBlock) => {
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') {
        if (inSection(child)) flushLine();
      } else if (child.nodeType === Node.ELEMENT_NODE && INTERVAL_LINE_BREAK_TAGS.has(child.tagName)) {
        if (inSection(child)) {
          if (child.tagName === 'PRE') {
            flushLine();
            walkNodes(child, child);
            flushLine();
          } else {
            walkNodes(child, preBlock);
            flushLine();
          }
        }
      } else if (child.nodeType === Node.TEXT_NODE) {
        if (shouldIncludeTextNodeInBlock(child, preBlock) && inSection(child)) {
          appendTextNode(child);
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (isYomupUiElement(child) || isEditableElement(child)) continue;
        if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'NOSCRIPT') {
          continue;
        }
        walkNodes(child, preBlock);
      }
    }
  };

  walkNodes(sectionRoot, null);
  flushLine();

  if (lines.length === 0) {
    return [collectSectionTextSegments(sectionRoot, startHeading, endHeading)];
  }
  return lines;
}

function collectHeadingIntervalTextSegmentLines(root, startHeading, endHeading) {
  return collectSectionTextSegmentLines(root, startHeading, endHeading);
}

function collectHighlightBlockTextSegmentLines(highlightBlock) {
  if (highlightBlock.scopedTextNode) {
    const single = collectSingleTextNodeSegments(highlightBlock.scopedTextNode);
    return single.segments.length > 0 ? [single] : [];
  }
  if (isElementHighlightBlock(highlightBlock)) {
    return collectBlockTextSegmentLines(highlightBlock.element);
  }
  const sectionRoot = getSectionBlockRoot(highlightBlock);
  return collectSectionTextSegmentLines(
    sectionRoot,
    highlightBlock.startHeading,
    highlightBlock.endHeading
  );
}

function segmentContainsDomOffset(seg, textNode, domOffset) {
  if (!seg || seg.node !== textNode) return false;
  const lineStart = seg.nodeOffset || 0;
  const lineEnd = lineStart + (seg.text || '').length;
  return domOffset >= lineStart && domOffset <= lineEnd;
}

function getClientRectsForSegment(seg) {
  const r = document.createRange();
  const node = seg.node;
  if (!node || node.nodeType !== Node.TEXT_NODE) return [];
  const start = seg.nodeOffset || 0;
  const end = start + (seg.text || '').length;
  try {
    r.setStart(node, start);
    r.setEnd(node, end);
    return Array.from(r.getClientRects());
  } catch (_e) {
    return [];
  }
}

function getClientRectsForChunkSegments(segments, chunkStart, chunkEnd) {
  const rects = [];
  if (!segments || segments.length === 0) return rects;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.end <= chunkStart || seg.start >= chunkEnd) continue;
    const localStart = Math.max(0, chunkStart - seg.start);
    const localEnd = Math.min(seg.text.length, chunkEnd - seg.start);
    if (localEnd <= localStart) continue;
    const node = seg.node;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    const nodeStart = (seg.nodeOffset || 0) + localStart;
    const nodeEnd = (seg.nodeOffset || 0) + localEnd;
    const r = document.createRange();
    try {
      r.setStart(node, nodeStart);
      r.setEnd(node, nodeEnd);
      const partRects = Array.from(r.getClientRects());
      for (let j = 0; j < partRects.length; j++) {
        rects.push(partRects[j]);
      }
    } catch (_e) {
      // ignore
    }
  }
  return rects;
}

function findLineIndexAtCaret(lines, clientX, clientY) {
  const range = caretRangeFromClientXY(clientX, clientY);
  if (range && range.startContainer) {
    const container = range.startContainer;
    if (container.nodeType === Node.TEXT_NODE) {
      const domOffset = range.startOffset;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].segments.some((seg) => segmentContainsDomOffset(seg, container, domOffset))) {
          return i;
        }
      }
    } else if (
      container.nodeType === Node.ELEMENT_NODE &&
      container.contains &&
      !isBrFlowContainer(container) &&
      !isRubyBrBlockContainer(container)
    ) {
      // 葉要素ラッパーのみ（1 行だけが包含されるときだけ採用）
      let soleIdx = -1;
      let matchCount = 0;
      for (let i = 0; i < lines.length; i++) {
        const segs = lines[i].segments;
        if (
          segs.length > 0 &&
          segs.every((seg) => seg.node && container.contains(seg.node))
        ) {
          soleIdx = i;
          matchCount++;
        }
      }
      if (matchCount === 1) return soleIdx;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    for (const seg of lines[i].segments) {
      const rects = getClientRectsForSegment(seg);
      for (let j = 0; j < rects.length; j++) {
        const rect = rects[j];
        if (
          clientX >= rect.left && clientX <= rect.right &&
          clientY >= rect.top && clientY <= rect.bottom
        ) {
          return i;
        }
      }
    }
  }

  const lineTolerance = getHighlightUnderlineLineTolerancePx();
  const maxYDist = lineTolerance * 4;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < lines.length; i++) {
    for (const seg of lines[i].segments) {
      try {
        const rects = getClientRectsForSegment(seg);
        for (let j = 0; j < rects.length; j++) {
          const rect = rects[j];
          const cy = rect.top + rect.height / 2;
          if (Math.abs(cy - clientY) > maxYDist) continue;
          const d = (cy - clientY) ** 2 + (rect.left - clientX) ** 2;
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }
      } catch (_e) {
        // ignore
      }
    }
  }
  return bestIdx;
}

function shouldUseJaSectionFullLineChunk(highlightBlock, blockText, languageMode, clientX, clientY) {
  if (languageMode !== LANGUAGE_MODE_JA || !blockText) return false;
  if (blockText.trim().length > MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA) return false;
  if (highlightBlock.mode === 'br-flow' || highlightBlock.mode === 'heading-interval') return true;
  if (typeof clientX === 'number' && typeof clientY === 'number') {
    const caretNode = getPointReferenceNode(clientX, clientY);
    if (
      isElementHighlightBlock(highlightBlock) &&
      highlightBlock.element &&
      BLOCK_ANCESTOR_TAGS.has(highlightBlock.element.tagName)
    ) {
      return false;
    }
    if (findBrFlowContainerFromNode(caretNode)) return true;
  }
  return false;
}

// N-S1: br-flow 容器内の `<br>` 論理行（collectBlockTextSegmentLines = h2 境界付き）
function resolveBrFlowContainerLogicalLineAtPoint(container, clientX, clientY) {
  if (!container || !isBrFlowContainer(container)) return null;
  const lines = collectBlockTextSegmentLines(container).filter(
    (line) => line.segments.length > 0 && line.blockText.trim()
  );
  if (lines.length === 0) return null;
  return lines[findLineIndexAtCaret(lines, clientX, clientY)];
}

function isPreHighlightBlock(highlightBlock) {
  return isElementHighlightBlock(highlightBlock) &&
    highlightBlock.element &&
    highlightBlock.element.tagName === 'PRE';
}

function resolveHighlightTextContext(highlightBlock, languageMode, clientX, clientY) {
  // §60 KB-1: EN でも br 箇条書き／コード行型 <p> は行単位（PRE と同趣旨）
  // 英語判定のコード貼り付け <p>+<br> が語数チャンクで複数行同時下線になるのを防ぐ
  if (
    isElementHighlightBlock(highlightBlock) &&
    highlightBlock.element &&
    highlightBlock.element.tagName === 'P' &&
    typeof clientX === 'number' &&
    typeof clientY === 'number'
  ) {
    const brBodyEarly = resolveParagraphBrLabelBodyTextContext(
      highlightBlock.element,
      clientX,
      clientY
    );
    if (brBodyEarly) return brBodyEarly;
    const brListLineEarly = resolveParagraphBrListLineTextContext(
      highlightBlock.element,
      clientX,
      clientY
    );
    if (brListLineEarly) return brListLineEarly;
    // §15.2 G-1b: 先頭 b/strong ラベル行と本文行を分離（preferParagraph→P 昇格後も）
    const blockLabelLineEarly = resolveParagraphBlockLabelLineTextContext(
      highlightBlock.element,
      clientX,
      clientY
    );
    if (blockLabelLineEarly) return blockLabelLineEarly;
    // §4.7 Y-1b: \n\n 空行の見た目塊を AI-1 全文句点分割より先に採用
    const blankLineEarly = resolveParagraphBlankLineTextContext(
      highlightBlock.element,
      clientX,
      clientY
    );
    if (blankLineEarly) return blankLineEarly;
  }

  const useLineSplit = languageMode === LANGUAGE_MODE_JA || isPreHighlightBlock(highlightBlock);
  if (!useLineSplit) {
    return collectHighlightBlockTextSegments(highlightBlock);
  }

  // §16 AZ-1R: 青空は br-flow 迂回なし（d02d369 相当の単純行分割）
  if (isAozoraSpecialHighlightBlock(highlightBlock)) {
    const lines = collectHighlightBlockTextSegmentLines(highlightBlock).filter(
      (line) => line.segments.length > 0 && line.blockText.trim()
    );
    if (lines.length <= 1) {
      return lines[0] || collectHighlightBlockTextSegments(highlightBlock);
    }
    return lines[findLineIndexAtCaret(lines, clientX, clientY)];
  }

  // §40 ZN-N2a: 素の td はセル全文（折り返し全行）。行分割しない
  // §47 AR-1: br/見出し構造セルは下の論理行分割へ（pointer 絞り判定とは分離）
  if (
    isElementHighlightBlock(highlightBlock) &&
    highlightBlock.element &&
    isTableCellHighlightHost(highlightBlock.element)
  ) {
    if (isLayoutTableCell(highlightBlock.element)) {
      const layoutLine = resolveLayoutTableCellTextContextAtPoint(
        highlightBlock.element,
        clientX,
        clientY
      );
      if (layoutLine) return layoutLine;
    } else if (!isStructuredTableCellForLineSplit(highlightBlock.element)) {
      return collectHighlightBlockTextSegments(highlightBlock);
    }
  }

  // §39 AI-1 / §42 JA-1: <p> は段落全文で segment 化し buildLogicalChunks で句点分割
  // （先頭構造 b/strong ラベル付きは §15.2 G-1b で行分割を先に適用）
  if (
    isElementHighlightBlock(highlightBlock) &&
    highlightBlock.element &&
    highlightBlock.element.tagName === 'P'
  ) {
    if (typeof clientX === 'number' && typeof clientY === 'number') {
      const brBody = resolveParagraphBrLabelBodyTextContext(
        highlightBlock.element,
        clientX,
        clientY
      );
      if (brBody) return brBody;
      // §44 MS-1: 箇条書き型 br 行（もしも FAQ 等）
      const brListLine = resolveParagraphBrListLineTextContext(
        highlightBlock.element,
        clientX,
        clientY
      );
      if (brListLine) return brListLine;
      const blockLabelLine = resolveParagraphBlockLabelLineTextContext(
        highlightBlock.element,
        clientX,
        clientY
      );
      if (blockLabelLine) return blockLabelLine;
      const blankLine = resolveParagraphBlankLineTextContext(
        highlightBlock.element,
        clientX,
        clientY
      );
      if (blankLine) return blankLine;
    }
    return collectHighlightBlockTextSegments(highlightBlock);
  }

  if (!highlightBlock.scopedTextNode) {
    const blockEl = isElementHighlightBlock(highlightBlock) ? highlightBlock.element : null;
    const caretNode = getPointReferenceNode(clientX, clientY);
    const brContainer = findBrFlowContainerFromNode(caretNode);
    if (
      brContainer &&
      !(blockEl && BLOCK_ANCESTOR_TAGS.has(blockEl.tagName))
    ) {
      const brLine = resolveBrFlowContainerLogicalLineAtPoint(brContainer, clientX, clientY);
      if (brLine) return brLine;
    }
  }

  // §46 AL-7: 目次型 TD（上記 early 以外の経路）でもセル全体走査を避ける
  if (
    isElementHighlightBlock(highlightBlock) &&
    highlightBlock.element &&
    isLayoutTableCell(highlightBlock.element)
  ) {
    const layoutLine = resolveLayoutTableCellTextContextAtPoint(
      highlightBlock.element,
      clientX,
      clientY
    );
    if (layoutLine) return layoutLine;
  }

  const lines = collectHighlightBlockTextSegmentLines(highlightBlock).filter(
    (line) => line.segments.length > 0 && line.blockText.trim()
  );
  if (lines.length <= 1) {
    if (lines[0]) return lines[0];
    const caretNode = getPointReferenceNode(clientX, clientY);
    const blockEl = isElementHighlightBlock(highlightBlock) ? highlightBlock.element : null;
    const brContainer = findBrFlowContainerFromNode(caretNode);
    if (
      brContainer &&
      !(blockEl && BLOCK_ANCESTOR_TAGS.has(blockEl.tagName))
    ) {
      const brLine = resolveBrFlowContainerLogicalLineAtPoint(brContainer, clientX, clientY);
      if (brLine) return brLine;
    }
    return collectHighlightBlockTextSegments(highlightBlock);
  }

  return lines[findLineIndexAtCaret(lines, clientX, clientY)];
}

function computeOffsetInBlockText(segments, container, offset) {
  if (container.nodeType === Node.TEXT_NODE) {
    for (const seg of segments) {
      if (seg.node === container) {
        const rel = offset - (seg.nodeOffset || 0);
        if (rel >= 0 && rel <= seg.text.length) {
          return seg.start + rel;
        }
      }
    }
    return -1;
  }
  if (container.nodeType === Node.ELEMENT_NODE) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return shouldIncludeTextNodeInBlock(node)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });
    const first = walker.nextNode();
    if (first) return computeOffsetInBlockText(segments, first, 0);
  }
  return -1;
}

function findNearestTextOffsetInBlock(highlightBlock, segments, clientX, clientY) {
  let bestSeg = null;
  let bestDist = Infinity;
  for (const seg of segments) {
    try {
      const rects = getClientRectsForSegment(seg);
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const d = (cx - clientX) ** 2 + (cy - clientY) ** 2;
        if (d < bestDist) {
          bestDist = d;
          bestSeg = seg;
        }
      }
    } catch (_e) {
      // ignore
    }
  }
  if (bestSeg !== null) {
    return bestSeg.start + Math.floor((bestSeg.text || '').length / 2);
  }
  return segments.length > 0 ? Math.floor((segments[segments.length - 1].end) / 2) : -1;
}

function getCaretOffsetInBlock(highlightBlock, segments, clientX, clientY) {
  const caretOnGhost = isCaretOnGhostOverlayLink(clientX, clientY);

  if (!caretOnGhost) {
    const range = caretRangeFromClientXY(clientX, clientY);
    if (range && highlightBlockContains(highlightBlock, range.startContainer)) {
      const off = computeOffsetInBlockText(segments, range.startContainer, range.startOffset);
      if (off >= 0) return off;
    }
    const hit = document.elementFromPoint(clientX, clientY);
    if (hit && highlightBlockContains(highlightBlock, hit)) {
      const off = computeOffsetInBlockText(segments, hit, 0);
      if (off >= 0) return off;
    }
  }

  if (isInlineTextHighlightBlock(highlightBlock)) {
    if (inlineTextHostAcceptsHoverPoint(highlightBlock.element, clientX, clientY)) {
      return findNearestTextOffsetInBlock(highlightBlock, segments, clientX, clientY);
    }
    return -1;
  }

  return findNearestTextOffsetInBlock(highlightBlock, segments, clientX, clientY);
}

function segmentDomOffset(seg, localOffset) {
  return (seg.nodeOffset || 0) + localOffset;
}

function locateSegmentPosition(segments, globalOffset, isEnd) {
  for (const seg of segments) {
    if (isEnd) {
      if (globalOffset > seg.start && globalOffset <= seg.end) {
        return { node: seg.node, offset: segmentDomOffset(seg, globalOffset - seg.start) };
      }
    } else if (globalOffset >= seg.start && globalOffset < seg.end) {
      return { node: seg.node, offset: segmentDomOffset(seg, globalOffset - seg.start) };
    }
  }
  const last = segments[segments.length - 1];
  if (last && isEnd) {
    return { node: last.node, offset: segmentDomOffset(last, last.text.length) };
  }
  if (last && !isEnd) {
    return { node: last.node, offset: segmentDomOffset(last, 0) };
  }
  return null;
}

function createRangeForChunk(segments, chunkStart, chunkEnd) {
  const startPos = locateSegmentPosition(segments, chunkStart, false);
  let endPos = locateSegmentPosition(segments, chunkEnd, true);
  if (!endPos && segments.length) {
    const last = segments[segments.length - 1];
    endPos = { node: last.node, offset: segmentDomOffset(last, last.text.length) };
  }
  if (!startPos || !endPos) return null;

  const range = document.createRange();
  try {
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    return range;
  } catch (err) {
    debugError('createRangeForChunk:', err);
    return null;
  }
}

function ensureHighlightOverlayRoot() {
  if (!highlightOverlayRoot || !highlightOverlayRoot.isConnected) {
    highlightOverlayRoot = document.createElement('div');
    highlightOverlayRoot.id = 'yomup-highlight-overlay-root';
    highlightOverlayRoot.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483646;';
    document.documentElement.appendChild(highlightOverlayRoot);
  }
  return highlightOverlayRoot;
}

function clearHighlightOverlay() {
  stopHighlightUnderlineProgress();
  clearHighlightProgressCountdown();
  resetHighlightProgressSession();
  if (highlightOverlayRoot) {
    highlightOverlayRoot.textContent = '';
  }
  currentHighlightRange = null;
  currentHighlightRects = null;
}

function mergeHighlightClientRects(rectList) {
  const raw = [];
  for (let i = 0; i < rectList.length; i++) {
    const r = rectList[i];
    if (r.width > 0 && r.height > 0) raw.push(r);
  }
  if (raw.length <= 1) return raw;

  const sorted = raw.slice().sort((a, b) => {
    if (Math.abs(a.top - b.top) > HIGHLIGHT_RECT_MERGE_LINE_TOLERANCE_PX) {
      return a.top - b.top;
    }
    return a.left - b.left;
  });

  const lineGroups = [];
  for (const r of sorted) {
    let placed = false;
    for (const line of lineGroups) {
      const ref = line[0];
      if (Math.abs(r.top - ref.top) <= HIGHLIGHT_RECT_MERGE_LINE_TOLERANCE_PX) {
        line.push(r);
        placed = true;
        break;
      }
    }
    if (!placed) lineGroups.push([r]);
  }

  const merged = [];
  for (const line of lineGroups) {
    const sortedLine = line.slice().sort((a, b) => a.left - b.left);
    let group = {
      left: sortedLine[0].left,
      top: sortedLine[0].top,
      right: sortedLine[0].right,
      bottom: sortedLine[0].bottom
    };
    for (let i = 1; i < sortedLine.length; i++) {
      const r = sortedLine[i];
      if (r.left <= group.right + HIGHLIGHT_RECT_MERGE_GAP_TOLERANCE_PX) {
        group.right = Math.max(group.right, r.right);
        group.top = Math.min(group.top, r.top);
        group.bottom = Math.max(group.bottom, r.bottom);
      } else {
        merged.push(group);
        group = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }
    }
    merged.push(group);
  }

  return merged.map((g) => ({
    left: g.left,
    top: g.top,
    width: g.right - g.left,
    height: g.bottom - g.top
  }));
}

function getHighlightBlockClipElement(highlightBlock) {
  if (highlightBlock.scopedTextNode) {
    return highlightBlock.scopedTextNode.parentElement;
  }
  if (isElementHighlightBlock(highlightBlock)) {
    return highlightBlock.element;
  }
  return getSectionBlockRoot(highlightBlock);
}

function getHighlightBlockClipBounds(highlightBlock) {
  const el = getHighlightBlockClipElement(highlightBlock);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return null;
  return rect;
}

function isValidHighlightClientRect(rect) {
  return !!(rect && rect.width > 0 && rect.height > 0);
}

function clipClientRectToBounds(rect, bounds) {
  if (!rect || !bounds) return null;
  const left = Math.max(rect.left, bounds.left);
  const top = Math.max(rect.top, bounds.top);
  const right = Math.min(rect.right, bounds.right);
  const bottom = Math.min(rect.bottom, bounds.bottom);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { left, top, right, bottom, width, height };
}

function filterHighlightClientRects(rectList, clipBounds) {
  const filtered = [];
  for (let i = 0; i < rectList.length; i++) {
    const rect = rectList[i];
    if (!isValidHighlightClientRect(rect)) continue;
    if (clipBounds) {
      const clipped = clipClientRectToBounds(rect, clipBounds);
      if (clipped) filtered.push(clipped);
    } else {
      filtered.push({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      });
    }
  }
  return filtered;
}

function isHighlightUnderlineOverlayStyle() {
  return typeof HIGHLIGHT_OVERLAY_STYLE !== 'undefined' && HIGHLIGHT_OVERLAY_STYLE === 'underline';
}

function usesHighlightUnderlineSegmentLayer() {
  if (!isHighlightUnderlineOverlayStyle()) return false;
  return typeof ENABLE_HIGHLIGHT_UNDERLINE_PROGRESS === 'undefined' || ENABLE_HIGHLIGHT_UNDERLINE_PROGRESS;
}

function isHighlightUnderlineProgressEnabled() {
  return usesHighlightUnderlineSegmentLayer() && isHighlightUnderlineProgressMode();
}

function getHighlightRectBottom(rect) {
  if (typeof rect.bottom === 'number') return rect.bottom;
  return rect.top + rect.height;
}

function shouldPreferRectBottomUnderlineAnchor(hostElement, rects) {
  if (!hostElement || !rects || rects.length === 0) return false;
  try {
    const lineTolerance = getHighlightUnderlineLineTolerancePx();
    if (countVisualLinesInClientRects(rects, lineTolerance) === 1) {
      const lh = parseFloat(getComputedStyle(hostElement).lineHeight);
      const sample = rects.find((r) => r.width > 0 && r.height > 0);
      if (sample && Number.isFinite(lh) && lh > 0 && sample.height < lh * 2) {
        return true;
      }
    }
    const lh = parseFloat(getComputedStyle(hostElement).lineHeight);
    if (!Number.isFinite(lh) || lh <= 0) return false;
    const sample = rects.find((r) => r.width > 0 && r.height > 0);
    return !!(sample && sample.height <= lh * 1.5);
  } catch (_e) {
    return false;
  }
}

function getHighlightUnderlineWrappedLineGapPx() {
  return typeof HIGHLIGHT_UNDERLINE_WRAPPED_LINE_GAP_PX !== 'undefined'
    ? HIGHLIGHT_UNDERLINE_WRAPPED_LINE_GAP_PX
    : 4;
}

function isWrappedVisualLineClientRect(rect, lh) {
  return !!(rect && Number.isFinite(lh) && lh > 0 &&
    rect.height > lh * 1.05 && rect.height <= lh * 2.1);
}

function estimateSingleLineHeightForUnderlineRect(rect, hostLh) {
  if (!rect || !Number.isFinite(hostLh) || hostLh <= 0) return hostLh;
  if (isWrappedVisualLineClientRect(rect, hostLh)) return hostLh;
  if (rect.height > hostLh * 1.5) return rect.height;
  return hostLh;
}

function clientRectsHaveVerticalOverlap(rects) {
  if (!rects || rects.length < 2) return false;
  for (let i = 0; i < rects.length; i++) {
    const aBottom = getHighlightRectBottom(rects[i]);
    for (let j = i + 1; j < rects.length; j++) {
      const bBottom = getHighlightRectBottom(rects[j]);
      if (rects[i].top < bBottom && rects[j].top < aBottom) return true;
    }
  }
  return false;
}

function matchRectToVisualLineTop(rect, lineTops, tolerance) {
  if (!rect || !lineTops || lineTops.length === 0) return null;
  let bestTop = null;
  let bestDist = Infinity;
  for (let i = 0; i < lineTops.length; i++) {
    const dist = Math.abs(rect.top - lineTops[i]);
    if (dist <= tolerance && dist < bestDist) {
      bestDist = dist;
      bestTop = lineTops[i];
    }
  }
  return bestTop;
}

function buildWrappedLineRhythmAnchors(rects, hostElement) {
  if (!rects || rects.length < 2 || !hostElement) return null;
  try {
    const lh = parseFloat(getComputedStyle(hostElement).lineHeight);
    if (!Number.isFinite(lh) || lh <= 0) return null;

    const validRects = [];
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (r.width > 0 && r.height > 0) validRects.push(r);
    }
    if (validRects.length < 2) return null;

    let wrappedCount = 0;
    for (let i = 0; i < validRects.length; i++) {
      if (isWrappedVisualLineClientRect(validRects[i], lh)) wrappedCount++;
    }
    if (wrappedCount < 2 || !clientRectsHaveVerticalOverlap(validRects)) return null;

    const matchTolerance = Math.max(getHighlightUnderlineLineTolerancePx(), lh * 0.35);
    const lineTops = getVisualLineTopsFromClientRects(validRects, matchTolerance);
    if (lineTops.length === 0) return null;
    lineTops.sort((a, b) => a - b);
    const gap = getHighlightUnderlineWrappedLineGapPx();
    const firstTop = lineTops[0];

    // §32.4 B: ClientRect Y 重なり（Ko-fi .bogue-font 等）— top が1つでも centerY で行 index
    if (lineTops.length < 2) {
      return {
        lh,
        lineTops,
        overlapRhythm: true,
        firstTop,
        gap,
        matchTolerance
      };
    }

    const anchorByLineTop = {};
    for (let i = 0; i < lineTops.length; i++) {
      anchorByLineTop[lineTops[i]] = firstTop + (i + 1) * lh + gap;
    }
    return { lh, lineTops, anchorByLineTop, firstTop, gap, matchTolerance };
  } catch (_e) {
    return null;
  }
}

function capUnderlineAnchorAbovePeerRects(rect, anchorBottom, peerRects) {
  if (!rect || !Number.isFinite(anchorBottom) || !peerRects || peerRects.length < 2) {
    return anchorBottom;
  }
  const rectBottom = getHighlightRectBottom(rect);
  let capped = anchorBottom;
  for (let i = 0; i < peerRects.length; i++) {
    const peer = peerRects[i];
    if (!peer || peer === rect || peer.top <= rect.top + 1) continue;
    // §62 AS-1: 横並び（縦に大きく重なる）peer は「次行」ではない → 誤 cap しない
    const peerBottom = getHighlightRectBottom(peer);
    const overlap = Math.min(rectBottom, peerBottom) - Math.max(rect.top, peer.top);
    const minH = Math.min(rect.height || rectBottom - rect.top, peer.height || peerBottom - peer.top);
    if (minH > 0 && overlap > minH * 0.5) continue;
    if (peer.top < capped) {
      capped = peer.top - 1;
    }
  }
  return capped;
}

function enrichHighlightUnderlineOptions(hostElement, rects, underlineOptions) {
  const opts = underlineOptions ? Object.assign({}, underlineOptions) : {};
  if (!isHighlightUnderlineOverlayStyle()) return opts;
  // §32.4 / YT-T1: 表セルは rhythm・peer cap を使わず各 rect.bottom（compact 表の隣接 rect 誤 cap 防止）
  if (isTableCellHighlightHost(hostElement)) {
    opts.tableCellUnderlineAnchor = true;
    opts.preferRectBottomForSingleVisualLine = true;
    return opts;
  }
  // §36 CW-2: dt/dd・SVG+テキスト行 — peer cap / rhythm 無効（rect.bottom のみ）
  if (isCompactStatRowHighlightHost(hostElement)) {
    opts.compactStatRowUnderlineAnchor = true;
    opts.preferRectBottomForSingleVisualLine = true;
    return opts;
  }
  opts.peerRects = rects;
  const rhythm = buildWrappedLineRhythmAnchors(rects, hostElement);
  if (rhythm) opts.lineRhythmAnchors = rhythm;
  return opts;
}

function getUnderlineRhythmAnchorBottom(rect, rhythm, peerRects) {
  if (!rhythm || !rect) return null;
  const gap = rhythm.gap != null ? rhythm.gap : getHighlightUnderlineWrappedLineGapPx();
  if (rhythm.overlapRhythm) {
    const centerY = rect.top + rect.height / 2;
    const lineIndex = Math.max(0, Math.floor((centerY - rhythm.firstTop) / rhythm.lh));
    const anchor = rhythm.firstTop + (lineIndex + 1) * rhythm.lh + gap;
    return capUnderlineAnchorAbovePeerRects(rect, anchor, peerRects);
  }
  const matchedTop = matchRectToVisualLineTop(rect, rhythm.lineTops, rhythm.matchTolerance);
  if (matchedTop != null && rhythm.anchorByLineTop && rhythm.anchorByLineTop[matchedTop] != null) {
    return capUnderlineAnchorAbovePeerRects(rect, rhythm.anchorByLineTop[matchedTop], peerRects);
  }
  return null;
}

function getHighlightUnderlineAnchorBottom(rect, hostElement, options) {
  const bottom = getHighlightRectBottom(rect);
  const opts = options || {};

  if (opts.tableCellUnderlineAnchor || opts.compactStatRowUnderlineAnchor) {
    return bottom;
  }

  const rhythmAnchor = getUnderlineRhythmAnchorBottom(rect, opts.lineRhythmAnchors, opts.peerRects);
  if (rhythmAnchor != null) {
    return rhythmAnchor;
  }

  if (!hostElement || typeof hostElement.getBoundingClientRect !== 'function') {
    return bottom;
  }
  try {
    const hostLh = parseFloat(getComputedStyle(hostElement).lineHeight);
    if (!Number.isFinite(hostLh) || hostLh <= 0) return bottom;
    const gap = getHighlightUnderlineWrappedLineGapPx();
    const lineTolerance = getHighlightUnderlineLineTolerancePx();
    const effectiveLh = estimateSingleLineHeightForUnderlineRect(rect, hostLh);

    // §32.4 A / §31 A2: 単一視覚行 → rect.bottom（MSG nav 等。F1 より先）
    if (
      countVisualLinesInClientRects([rect], lineTolerance) === 1 &&
      rect.height < hostLh * 2
    ) {
      return capUnderlineAnchorAbovePeerRects(rect, bottom, opts.peerRects);
    }

    // §32.4 B: 折り返し各行 rect（Y 非重なり単行箱）→ top + lh + gap
    if (isWrappedVisualLineClientRect(rect, hostLh)) {
      return capUnderlineAnchorAbovePeerRects(rect, rect.top + hostLh + gap, opts.peerRects);
    }

    if (opts.preferRectBottomForSingleVisualLine) {
      return capUnderlineAnchorAbovePeerRects(rect, bottom, opts.peerRects);
    }

    // §32.4 E: 容器 lh ≠ 文字 lh（料金 H2 等）→ 行箱下端 + peer cap
    if (effectiveLh > hostLh * 1.5 && rect.height <= effectiveLh * 1.25) {
      const lineBoxBottom = rect.top + effectiveLh + gap;
      const anchor = Math.min(bottom, lineBoxBottom);
      return capUnderlineAnchorAbovePeerRects(rect, anchor, opts.peerRects);
    }

    if (rect.height > effectiveLh * 1.85 && typeof opts.pointerClientY === 'number') {
      const y = Math.max(rect.top, Math.min(opts.pointerClientY, bottom));
      const lineIndex = Math.max(0, Math.floor((y - rect.top) / effectiveLh));
      return capUnderlineAnchorAbovePeerRects(
        rect,
        Math.min(rect.top + effectiveLh * (lineIndex + 1) + gap, bottom),
        opts.peerRects
      );
    }
  } catch (_e) {
    // ignore
  }
  return capUnderlineAnchorAbovePeerRects(rect, bottom, opts.peerRects);
}

function getHighlightUnderlineTop(rect, hostElement, options) {
  const thickness = typeof HIGHLIGHT_UNDERLINE_THICKNESS_PX !== 'undefined'
    ? HIGHLIGHT_UNDERLINE_THICKNESS_PX
    : 2;
  return getHighlightUnderlineAnchorBottom(rect, hostElement, options) - thickness;
}

function isHighlightUnderlineTraceEnabled() {
  return typeof ENABLE_HIGHLIGHT_UNDERLINE_TRACE !== 'undefined' && ENABLE_HIGHLIGHT_UNDERLINE_TRACE;
}

function summarizeHighlightClientRect(rect) {
  if (!rect) return null;
  return {
    top: Math.round(rect.top * 10) / 10,
    bottom: Math.round(rect.bottom * 10) / 10,
    left: Math.round(rect.left * 10) / 10,
    width: Math.round(rect.width * 10) / 10,
    height: Math.round(rect.height * 10) / 10
  };
}

function summarizeHighlightBlockForTrace(block) {
  if (!block) return null;
  const el = block.element;
  return {
    mode: block.mode,
    tag: el && el.tagName,
    cls: el && String(el.className || '').slice(0, 100),
    text: el && String(el.textContent || '').trim().slice(0, 80)
  };
}

function logUnderlineTrace(phase, payload) {
  try {
    const root =
      (typeof ensureHighlightOverlayRoot === 'function'
        ? ensureHighlightOverlayRoot()
        : document.getElementById('yomup-highlight-overlay-root')) ||
      document.getElementById('yomup-highlight-overlay-root');
    if (root) {
      root.setAttribute(
        'data-yomup-probe',
        JSON.stringify({ phase: phase, payload: payload, t: Date.now() })
      );
    }
  } catch (_e) {
    /* ignore probe mirror errors */
  }
  if (!isHighlightUnderlineTraceEnabled()) return;
  console.log('[YomuP:underline]', phase, payload);
}

function logUnderlineTraceDrawSnapshot(snapshot) {
  if (!isHighlightUnderlineTraceEnabled()) return;
  console.log('[YomuP:underline] draw', snapshot);
}

function filterClientRectsAtPointer(rects, clientX, clientY, options) {
  if (!rects || rects.length <= 1) return rects;
  const opts = options || {};
  const lineTolerance = typeof opts.lineTolerance === 'number'
    ? opts.lineTolerance
    : getHighlightUnderlineLineTolerancePx();
  const rightPad = opts.rightPad || 0;
  const filtered = [];
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (
      clientY >= rect.top - lineTolerance &&
      clientY <= rect.bottom + lineTolerance &&
      clientX >= rect.left &&
      clientX <= rect.right + rightPad
    ) {
      filtered.push(rect);
    }
  }
  return filtered.length > 0 ? filtered : rects;
}

function getVisualLineTopsFromClientRects(rects, lineTolerance) {
  const tol = typeof lineTolerance === 'number'
    ? lineTolerance
    : getHighlightUnderlineLineTolerancePx();
  const lineTops = [];
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (rect.width <= 0 || rect.height <= 0) continue;
    let placed = false;
    for (let j = 0; j < lineTops.length; j++) {
      if (Math.abs(rect.top - lineTops[j]) <= tol) {
        placed = true;
        break;
      }
    }
    if (!placed) lineTops.push(rect.top);
  }
  return lineTops;
}

function pickVisualLineTopForPointer(rects, clientX, clientY, lineTolerance) {
  const tol = typeof lineTolerance === 'number'
    ? lineTolerance
    : getHighlightUnderlineLineTolerancePx();
  let bestTop = null;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.width <= 0 || r.height <= 0) continue;
    if (clientY < r.top - tol || clientY > r.bottom + tol) continue;
    if (clientX >= r.left && clientX <= r.right) {
      if (bestTop === null || r.top > bestTop) {
        bestTop = r.top;
      }
    }
  }
  if (bestTop !== null) return bestTop;

  const lineTops = getVisualLineTopsFromClientRects(rects, tol);
  if (lineTops.length === 0) return null;
  if (lineTops.length === 1) return lineTops[0];

  let bestDist = Infinity;
  for (let i = 0; i < lineTops.length; i++) {
    const lineTop = lineTops[i];
    let lineBottom = lineTop;
    for (let j = 0; j < rects.length; j++) {
      const r = rects[j];
      if (r.width <= 0 || r.height <= 0) continue;
      if (Math.abs(r.top - lineTop) <= tol) {
        lineBottom = Math.max(lineBottom, r.bottom);
      }
    }
    const dist = Math.abs(clientY - (lineTop + (lineBottom - lineTop) / 2));
    if (dist < bestDist) {
      bestDist = dist;
      bestTop = lineTop;
    }
  }
  return bestTop;
}

function filterRectsToVisualLineTop(rects, targetTop, lineTolerance) {
  const tol = typeof lineTolerance === 'number'
    ? lineTolerance
    : getHighlightUnderlineLineTolerancePx();
  const filtered = [];
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (Math.abs(rect.top - targetTop) <= tol) {
      filtered.push(rect);
    }
  }
  return filtered;
}

function clientRectSpansMultipleVisualLines(rect, hostElement) {
  if (!rect || !hostElement) return false;
  try {
    const lh = parseFloat(getComputedStyle(hostElement).lineHeight);
    return Number.isFinite(lh) && lh > 0 && rect.height > lh * 1.85;
  } catch (_e) {
    return false;
  }
}

function synthesizeSingleVisualLineClientRect(tallRect, targetTop, hostElement) {
  if (!tallRect || targetTop == null || !hostElement) return tallRect;
  try {
    const lh = parseFloat(getComputedStyle(hostElement).lineHeight);
    if (!Number.isFinite(lh) || lh <= 0) return tallRect;
    const lineTop = targetTop;
    const lineBottom = Math.min(lineTop + lh, getHighlightRectBottom(tallRect));
    const height = Math.max(0, lineBottom - lineTop);
    if (height <= 0) return tallRect;
    return {
      left: tallRect.left,
      top: lineTop,
      right: tallRect.right,
      bottom: lineBottom,
      width: tallRect.width,
      height
    };
  } catch (_e) {
    return tallRect;
  }
}

function normalizeOverlayRectsToVisualLineTop(rects, targetTop, hostElement, lineTolerance) {
  if (targetTop == null || !rects || rects.length === 0) return rects;
  const filtered = filterRectsToVisualLineTop(rects, targetTop, lineTolerance);
  const source = filtered.length > 0 ? filtered : rects;
  if (source.length === 1 && clientRectSpansMultipleVisualLines(source[0], hostElement)) {
    return [synthesizeSingleVisualLineClientRect(source[0], targetTop, hostElement)];
  }
  return source;
}

function isPlausibleHighlightUnderlineRect(rect, underlineTop) {
  if (!rect || rect.width <= 0) return false;
  if (!Number.isFinite(underlineTop)) return false;
  const vh = typeof window.innerHeight === 'number' ? window.innerHeight : 800;
  const vw = typeof window.innerWidth === 'number' ? window.innerWidth : 1200;
  if (underlineTop < 4 || underlineTop > vh + 40) return false;
  if (rect.right < -20 || rect.left > vw + 20) return false;
  return true;
}

// §28.9 F2 補強: 大フォント折り返しで前後行 rect が Y 範囲重なっても視覚行単位に絞る
function filterClientRectsToPointerVisualLine(rects, clientX, clientY, options) {
  if (!rects || rects.length <= 1) {
    if (!rects || rects.length !== 1) return rects;
    const opts = options || {};
    const hostElement = opts.hostElement || null;
    if (!hostElement || !clientRectSpansMultipleVisualLines(rects[0], hostElement)) {
      return rects;
    }
    const lineTolerance = typeof opts.lineTolerance === 'number'
      ? opts.lineTolerance
      : getHighlightUnderlineLineTolerancePx();
    const targetTop = pickVisualLineTopForPointer(rects, clientX, clientY, lineTolerance);
    if (targetTop == null) return rects;
    return normalizeOverlayRectsToVisualLineTop(rects, targetTop, hostElement, lineTolerance);
  }
  const opts = options || {};
  const lineTolerance = typeof opts.lineTolerance === 'number'
    ? opts.lineTolerance
    : getHighlightUnderlineLineTolerancePx();
  const hostElement = opts.hostElement || null;
  const lineTops = getVisualLineTopsFromClientRects(rects, lineTolerance);
  if (lineTops.length <= 1) {
    const narrowed = filterClientRectsAtPointer(rects, clientX, clientY, options);
    if (lineTops.length === 1 && hostElement) {
      return normalizeOverlayRectsToVisualLineTop(narrowed, lineTops[0], hostElement, lineTolerance);
    }
    return narrowed;
  }
  const targetTop = pickVisualLineTopForPointer(rects, clientX, clientY, lineTolerance);
  if (targetTop == null) {
    return filterClientRectsAtPointer(rects, clientX, clientY, options);
  }
  return normalizeOverlayRectsToVisualLineTop(rects, targetTop, hostElement, lineTolerance);
}

function overlayRectsSpanSingleVisualLine(rects, lineTolerance) {
  return getVisualLineTopsFromClientRects(rects, lineTolerance).length <= 1;
}

function countVisualLinesInClientRects(rects, lineTolerance) {
  if (!rects || rects.length === 0) return 0;
  const tol = typeof lineTolerance === 'number'
    ? lineTolerance
    : getHighlightUnderlineLineTolerancePx();
  const lineTops = [];
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (rect.width <= 0 || rect.height <= 0) continue;
    let placed = false;
    for (let j = 0; j < lineTops.length; j++) {
      if (Math.abs(rect.top - lineTops[j]) <= tol) {
        placed = true;
        break;
      }
    }
    if (!placed) lineTops.push(rect.top);
  }
  return lineTops.length;
}

function getOffsetInBlockTextFromClientPoint(segments, clientX, clientY) {
  const range = caretRangeFromClientXY(clientX, clientY);
  if (!range) return -1;
  return computeOffsetInBlockText(segments, range.startContainer, range.startOffset);
}

function isClientRectOnVisualLine(rect, lineTop, lineBottom, lineTolerance) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const tol = typeof lineTolerance === 'number' ? lineTolerance : getHighlightUnderlineLineTolerancePx();
  const cy = rect.top + rect.height / 2;
  return cy >= lineTop - tol && cy <= lineBottom + tol;
}

function expandChunkOffsetToVisualLine(segments, chunk, offset, lineTop, lineBottom, direction) {
  const tol = getHighlightUnderlineLineTolerancePx();
  const minBound = chunk.start;
  const maxBound = chunk.end;
  let pos = offset;

  if (direction === 'start') {
    while (pos > minBound) {
      const prev = pos - 1;
      const range = createRangeForChunk(segments, prev, pos);
      if (!range) break;
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      if (rects.length === 0) break;
      let onLine = false;
      for (let i = 0; i < rects.length; i++) {
        if (isClientRectOnVisualLine(rects[i], lineTop, lineBottom, tol)) {
          onLine = true;
          break;
        }
      }
      if (!onLine) break;
      pos = prev;
    }
    return pos;
  }

  while (pos < maxBound) {
    const next = pos + 1;
    const range = createRangeForChunk(segments, pos, next);
    if (!range) break;
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) break;
    let onLine = false;
    for (let i = 0; i < rects.length; i++) {
      if (isClientRectOnVisualLine(rects[i], lineTop, lineBottom, tol)) {
        onLine = true;
        break;
      }
    }
    if (!onLine) break;
    pos = next;
  }
  return pos;
}

// 下線をホバー行の rect のみに絞ったとき、語数・タイマーもその行の部分チャンクに合わせる
function narrowChunkToClientRects(segments, blockText, chunk, targetRects) {
  if (!chunk || !targetRects || targetRects.length === 0 || !blockText) return chunk;

  let lineTop = Infinity;
  let lineBottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (let i = 0; i < targetRects.length; i++) {
    const r = targetRects[i];
    if (r.width <= 0 || r.height <= 0) continue;
    lineTop = Math.min(lineTop, r.top);
    lineBottom = Math.max(lineBottom, r.bottom);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  }
  if (!Number.isFinite(left)) return chunk;

  const midY = lineTop + (lineBottom - lineTop) / 2;
  const pad = Math.min(4, Math.max(1, (right - left) * 0.05));
  const xStart = left + pad;
  const xEnd = Math.max(xStart + 1, right - pad);

  let startOff = getOffsetInBlockTextFromClientPoint(segments, xStart, midY);
  let endOff = getOffsetInBlockTextFromClientPoint(segments, xEnd, midY);
  if (startOff < 0 || endOff < 0) return chunk;

  if (startOff < chunk.start) startOff = chunk.start;
  if (endOff > chunk.end) endOff = chunk.end;
  if (endOff <= startOff) return chunk;

  startOff = expandChunkOffsetToVisualLine(segments, chunk, startOff, lineTop, lineBottom, 'start');
  endOff = expandChunkOffsetToVisualLine(segments, chunk, endOff, lineTop, lineBottom, 'end');
  if (endOff <= startOff) return chunk;

  const text = blockText.slice(startOff, endOff);
  if (!text.trim()) return chunk;
  return { start: startOff, end: endOff, text };
}

function getHighlightUnderlineGoalColor() {
  return typeof HIGHLIGHT_UNDERLINE_GOAL_COLOR !== 'undefined'
    ? HIGHLIGHT_UNDERLINE_GOAL_COLOR
    : 'rgba(255, 0, 0, 0.28)';
}

function getHighlightUnderlineProgressColor() {
  return typeof HIGHLIGHT_UNDERLINE_COLOR !== 'undefined'
    ? HIGHLIGHT_UNDERLINE_COLOR
    : 'red';
}

function getHighlightUnderlineProgressEl(segment) {
  return segment.querySelector('.yomup-highlight-underline-progress');
}

function createHighlightOverlayBox(rect, hostElement, underlineOptions) {
  if (isHighlightUnderlineOverlayStyle()) {
    const thickness = typeof HIGHLIGHT_UNDERLINE_THICKNESS_PX !== 'undefined'
      ? HIGHLIGHT_UNDERLINE_THICKNESS_PX
      : 2;
    const underlineTop = getHighlightUnderlineTop(rect, hostElement, underlineOptions);
    if (!isPlausibleHighlightUnderlineRect(rect, underlineTop)) {
      logUnderlineTrace('reject-plausible', {
        rect: summarizeHighlightClientRect(rect),
        underlineTop
      });
      return null;
    }
    const useSegmentLayer = usesHighlightUnderlineSegmentLayer();

    if (!useSegmentLayer) {
      const box = document.createElement('div');
      box.className = 'yomup-highlight-underline';
      box.style.cssText =
        `position:fixed;left:${rect.left}px;top:${underlineTop}px;` +
        `width:${rect.width}px;height:${thickness}px;background:${getHighlightUnderlineProgressColor()};` +
        'pointer-events:none;';
      return box;
    }

    const segment = document.createElement('div');
    segment.className = 'yomup-highlight-underline-segment';
    segment.dataset.fullWidth = String(rect.width);
    segment.style.cssText =
      `position:fixed;left:${rect.left}px;top:${underlineTop}px;` +
      `width:${rect.width}px;height:${thickness}px;pointer-events:none;`;

    const goal = document.createElement('div');
    goal.className = 'yomup-highlight-underline-goal';
    goal.style.cssText =
      `position:absolute;left:0;top:0;width:100%;height:100%;background:${getHighlightUnderlineGoalColor()};`;

    const progress = document.createElement('div');
    progress.className = 'yomup-highlight-underline-progress';
    progress.style.cssText =
      `position:absolute;left:0;top:0;width:0;height:100%;background:${getHighlightUnderlineProgressColor()};`;

    segment.appendChild(goal);
    segment.appendChild(progress);
    logUnderlineTrace('segment', {
      rect: summarizeHighlightClientRect(rect),
      underlineTop,
      thickness
    });
    return segment;
  }

  const box = document.createElement('div');
  box.className = 'yomup-highlight-outline';
  box.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
    'outline:2px solid red;outline-offset:-2px;box-sizing:border-box;pointer-events:none;';
  return box;
}

function stopHighlightUnderlineProgress() {
  if (!highlightOverlayRoot) return;
  const progressEls = highlightOverlayRoot.querySelectorAll('.yomup-highlight-underline-progress');
  for (let i = 0; i < progressEls.length; i++) {
    progressEls[i].style.transition = '';
  }
}

function resetHighlightProgressSession() {
  highlightProgressSession = null;
}

function clearHighlightProgressCountdown() {
  if (highlightProgressCountdownInterval) {
    clearInterval(highlightProgressCountdownInterval);
    highlightProgressCountdownInterval = null;
  }
}

function getHighlightProgressRemainingSeconds() {
  if (!highlightProgressSession) return 0;
  return highlightProgressSession.remainingSeconds || 0;
}

function startHighlightProgressCountdown() {
  clearHighlightProgressCountdown();
  if (!highlightProgressSession) return;

  highlightProgressCountdownInterval = setInterval(() => {
    if (!highlightProgressSession || highlightProgressSession.paused) return;
    highlightProgressSession.remainingSeconds--;
    if (highlightProgressSession.remainingSeconds <= 0) {
      clearHighlightProgressCountdown();
      highlightProgressSession.remainingSeconds = 0;
      highlightProgressSession.paused = false;
    }
  }, 1000);
}

function startHighlightLineProgress(unitCount, languageMode, progressTarget = null) {
  const readTime = calculateReadingTime(unitCount, languageMode);
  clearHighlightProgressCountdown();
  resetHighlightProgressSession();

  if (!isHighlightUnderlineProgressMode()) {
    startHighlightUnderlineProgress(readTime);
    return;
  }

  highlightProgressSession = {
    unitCount,
    readTime,
    languageMode,
    unitLabel: getUnitLabel(languageMode),
    paused: false,
    remainingSeconds: readTime,
    target: progressTarget
  };
  startHighlightUnderlineProgress(readTime);
  startHighlightProgressCountdown();
}

function captureHighlightProgressTarget(highlightBlock, chunk) {
  return {
    mode: highlightBlock.mode,
    element: highlightBlock.element || null,
    scopedTextNode: highlightBlock.scopedTextNode || null,
    container: highlightBlock.container || null,
    root: highlightBlock.root || null,
    startHeading: highlightBlock.startHeading || null,
    endHeading: highlightBlock.endHeading || null,
    chunkStart: chunk.start,
    chunkEnd: chunk.end,
    // §56 AT-3b: 同一 <p> 内の別 br 行が同じ文字数でも衝突しないよう本文も保持
    chunkText: chunk.text || ''
  };
}

function isSameHighlightProgressTarget(highlightBlock, chunk) {
  if (!highlightProgressSession || !highlightProgressSession.target) return false;
  const target = highlightProgressSession.target;
  if (target.chunkStart !== chunk.start || target.chunkEnd !== chunk.end) return false;
  if ((target.chunkText || '') !== (chunk.text || '')) return false;
  if (target.mode !== highlightBlock.mode) return false;
  if (target.scopedTextNode) {
    return highlightBlock.scopedTextNode === target.scopedTextNode;
  }
  if (target.element) {
    return highlightBlock.element === target.element;
  }
  if (target.mode === 'heading-interval') {
    return highlightBlock.root === target.root &&
      highlightBlock.startHeading === target.startHeading &&
      highlightBlock.endHeading === target.endHeading;
  }
  if (target.mode === 'br-flow') {
    return highlightBlock.container === target.container;
  }
  return false;
}

function getHighlightUnderlineLineTolerancePx() {
  return typeof HIGHLIGHT_RECT_MERGE_LINE_TOLERANCE_PX !== 'undefined'
    ? HIGHLIGHT_RECT_MERGE_LINE_TOLERANCE_PX
    : 6;
}

function getHighlightUnderlineProgressMinSeconds() {
  return typeof HIGHLIGHT_UNDERLINE_PROGRESS_MIN_SECONDS !== 'undefined'
    ? HIGHLIGHT_UNDERLINE_PROGRESS_MIN_SECONDS
    : 0.3;
}

function getHighlightProgressElWidthPx(progressEl) {
  const styleWidth = parseFloat(progressEl.style.width);
  if (Number.isFinite(styleWidth) && styleWidth > 0) return styleWidth;
  return parseFloat(getComputedStyle(progressEl).width) || 0;
}

function pauseHighlightUnderlineProgress() {
  if (!highlightOverlayRoot) return;
  const progressEls = highlightOverlayRoot.querySelectorAll('.yomup-highlight-underline-progress');
  for (let i = 0; i < progressEls.length; i++) {
    const el = progressEls[i];
    // transition を先に切ると終了値(100%)へジャンプするため、幅を先に取得する
    const frozenWidth = getComputedStyle(el).width;
    el.style.transition = 'none';
    el.style.width = frozenWidth;
  }
}

function resumeHighlightUnderlineProgress(remainingSeconds) {
  if (!usesHighlightUnderlineSegmentLayer() || !isHighlightUnderlineProgressMode()) return;

  const root = ensureHighlightOverlayRoot();
  const boxes = root.querySelectorAll('.yomup-highlight-underline-segment');
  if (boxes.length === 0) return;

  const duration = Math.max(getHighlightUnderlineProgressMinSeconds(), remainingSeconds || 0);
  const lineTolerance = getHighlightUnderlineLineTolerancePx();

  const sortedBoxes = Array.from(boxes).sort((a, b) =>
    compareHighlightUnderlineReadingOrder(a, b, lineTolerance)
  );

  let totalRemainingWidth = 0;
  for (let i = 0; i < sortedBoxes.length; i++) {
    const segment = sortedBoxes[i];
    const fullWidth = parseFloat(segment.dataset.fullWidth) || 0;
    const progressEl = getHighlightUnderlineProgressEl(segment);
    if (!fullWidth || !progressEl) continue;
    const currentWidth = getHighlightProgressElWidthPx(progressEl);
    totalRemainingWidth += Math.max(0, fullWidth - currentWidth);
  }
  if (totalRemainingWidth <= 0) return;

  void root.offsetHeight;

  const lineGroups = groupHighlightUnderlineBoxesByLine(sortedBoxes, lineTolerance);
  let delay = 0;
  for (let g = 0; g < lineGroups.length; g++) {
    const group = lineGroups[g];
    let lineRemainingWidth = 0;
    for (let i = 0; i < group.length; i++) {
      const segment = group[i];
      const fullWidth = parseFloat(segment.dataset.fullWidth) || 0;
      const progressEl = getHighlightUnderlineProgressEl(segment);
      if (!fullWidth || !progressEl) continue;
      const currentWidth = getHighlightProgressElWidthPx(progressEl);
      lineRemainingWidth += Math.max(0, fullWidth - currentWidth);
    }
    if (lineRemainingWidth <= 0) continue;

    const lineDuration = duration * (lineRemainingWidth / totalRemainingWidth);
    let lineDelay = delay;
    for (let i = 0; i < group.length; i++) {
      const segment = group[i];
      const fullWidth = parseFloat(segment.dataset.fullWidth) || 0;
      const progressEl = getHighlightUnderlineProgressEl(segment);
      if (!fullWidth || !progressEl) continue;
      const currentWidth = getHighlightProgressElWidthPx(progressEl);
      const remainingWidth = Math.max(0, fullWidth - currentWidth);
      if (remainingWidth <= 0.5) {
        progressEl.style.transition = 'none';
        progressEl.style.width = fullWidth + 'px';
        continue;
      }

      const segmentDuration = lineRemainingWidth > 0
        ? lineDuration * (remainingWidth / lineRemainingWidth)
        : lineDuration;
      progressEl.style.transition = `width ${segmentDuration}s linear ${lineDelay}s`;
      progressEl.style.width = fullWidth + 'px';
      lineDelay += segmentDuration;
    }
    delay += lineDuration;
  }
}

function startCountdownSubPopupInterval(unitCount, readTime, unitLabel) {
  if (countDownIntervalForSub) {
    clearInterval(countDownIntervalForSub);
    countDownIntervalForSub = null;
  }

  countDownIntervalForSub = setInterval(() => {
    try {
      countDownTimerForSub--;
      updateSubPopupCharCount(unitCount, readTime, unitLabel);
    } catch (error) {
      debugError('カウントダウン更新中にエラーが発生:', error);
      if (countDownIntervalForSub) {
        clearInterval(countDownIntervalForSub);
        countDownIntervalForSub = null;
      }
    }
  }, 1000);
}

function pauseHighlightProgress() {
  if (!highlightProgressSession || highlightProgressSession.paused) return;
  if (getHighlightProgressRemainingSeconds() <= 0) return;

  clearHighlightProgressCountdown();
  pauseHighlightUnderlineProgress();
  highlightProgressSession.paused = true;
  debugLog('ライン進行を一時停止しました');
}

function resumeHighlightProgress() {
  if (!highlightProgressSession || !highlightProgressSession.paused) return;
  const remaining = highlightProgressSession.remainingSeconds || 0;
  if (remaining <= 0) return;

  resumeHighlightUnderlineProgress(remaining);
  startHighlightProgressCountdown();
  highlightProgressSession.paused = false;
  debugLog('ライン進行を再開しました');
}

function restartHighlightLineProgress() {
  if (!highlightProgressSession || !isHighlightUnderlineProgressMode()) return;
  const readTime = highlightProgressSession.readTime;
  if (!readTime || readTime <= 0) return;

  clearHighlightProgressCountdown();
  highlightProgressSession.paused = false;
  highlightProgressSession.remainingSeconds = readTime;
  startHighlightUnderlineProgress(readTime);
  startHighlightProgressCountdown();
  debugLog('ライン進行を最初から再開しました');
}

function resetHighlightProgressOnSettingsChange() {
  resetHighlightProgressSession();
  clearCurrentHighlight();
}

function handleProgressPauseClick(event) {
  if (!highLightOnOff) return;
  if (!isHighlightUnderlineProgressMode()) return;
  if (!highlightProgressSession) return;
  if (isYomupUiElement(event.target)) return;

  const root = highlightOverlayRoot;
  if (!root || !root.querySelector('.yomup-highlight-underline-segment')) return;

  if (getHighlightProgressRemainingSeconds() <= 0) {
    restartHighlightLineProgress();
    return;
  }

  if (highlightProgressSession.paused) {
    resumeHighlightProgress();
  } else {
    pauseHighlightProgress();
  }
}

function compareHighlightUnderlineReadingOrder(boxA, boxB, lineTolerancePx) {
  const topA = parseFloat(boxA.style.top);
  const topB = parseFloat(boxB.style.top);
  if (Math.abs(topA - topB) > lineTolerancePx) return topA - topB;
  return parseFloat(boxA.style.left) - parseFloat(boxB.style.left);
}

function groupHighlightUnderlineBoxesByLine(sortedBoxes, lineTolerancePx) {
  const lineGroups = [];
  for (let i = 0; i < sortedBoxes.length; i++) {
    const box = sortedBoxes[i];
    const top = parseFloat(box.style.top);
    const lastGroup = lineGroups[lineGroups.length - 1];
    if (
      lastGroup &&
      Math.abs(top - parseFloat(lastGroup[0].style.top)) <= lineTolerancePx
    ) {
      lastGroup.push(box);
    } else {
      lineGroups.push([box]);
    }
  }
  for (let i = 0; i < lineGroups.length; i++) {
    lineGroups[i].sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left));
  }
  return lineGroups;
}

function startHighlightUnderlineProgress(durationSeconds) {
  stopHighlightUnderlineProgress();
  if (!usesHighlightUnderlineSegmentLayer()) return;

  const root = ensureHighlightOverlayRoot();
  const boxes = root.querySelectorAll('.yomup-highlight-underline-segment');
  if (boxes.length === 0) return;

  const progressEls = [];
  for (let i = 0; i < boxes.length; i++) {
    const progressEl = getHighlightUnderlineProgressEl(boxes[i]);
    if (progressEl) progressEls.push(progressEl);
  }
  if (progressEls.length === 0) return;

  if (!isHighlightUnderlineProgressMode()) {
    for (let i = 0; i < progressEls.length; i++) {
      progressEls[i].style.transition = 'none';
      progressEls[i].style.width = '100%';
    }
    return;
  }

  const minSeconds = typeof HIGHLIGHT_UNDERLINE_PROGRESS_MIN_SECONDS !== 'undefined'
    ? HIGHLIGHT_UNDERLINE_PROGRESS_MIN_SECONDS
    : 0.3;
  const duration = Math.max(minSeconds, durationSeconds || 0);
  const lineTolerance = typeof HIGHLIGHT_RECT_MERGE_LINE_TOLERANCE_PX !== 'undefined'
    ? HIGHLIGHT_RECT_MERGE_LINE_TOLERANCE_PX
    : 6;

  const sortedBoxes = Array.from(boxes).sort((a, b) =>
    compareHighlightUnderlineReadingOrder(a, b, lineTolerance)
  );

  let totalWidth = 0;
  for (let i = 0; i < sortedBoxes.length; i++) {
    totalWidth += parseFloat(sortedBoxes[i].dataset.fullWidth) || 0;
  }
  if (totalWidth <= 0) return;

  for (let i = 0; i < sortedBoxes.length; i++) {
    const progressEl = getHighlightUnderlineProgressEl(sortedBoxes[i]);
    if (!progressEl) continue;
    progressEl.style.transition = 'none';
    progressEl.style.width = '0px';
  }

  void root.offsetHeight;

  const lineGroups = groupHighlightUnderlineBoxesByLine(sortedBoxes, lineTolerance);
  let delay = 0;
  for (let g = 0; g < lineGroups.length; g++) {
    const group = lineGroups[g];
    let lineWidth = 0;
    for (let i = 0; i < group.length; i++) {
      lineWidth += parseFloat(group[i].dataset.fullWidth) || 0;
    }
    const lineDuration = duration * (lineWidth / totalWidth);
    let lineDelay = delay;
    for (let i = 0; i < group.length; i++) {
      const segment = group[i];
      const fullWidth = parseFloat(segment.dataset.fullWidth);
      const progressEl = getHighlightUnderlineProgressEl(segment);
      if (!fullWidth || !progressEl) continue;
      const segmentDuration = lineWidth > 0 ? lineDuration * (fullWidth / lineWidth) : lineDuration;
      progressEl.style.transition = `width ${segmentDuration}s linear ${lineDelay}s`;
      progressEl.style.width = '100%';
      lineDelay += segmentDuration;
    }
    delay += lineDuration;
  }
}

function applyHighlightOverlay(range, clipBounds, clientRectsOverride, hostElement, underlineOptions) {
  clearHighlightOverlay();
  const root = ensureHighlightOverlayRoot();
  const rawRects = clientRectsOverride
    ? clientRectsOverride.slice()
    : Array.from(range.getClientRects());
  let rects = filterHighlightClientRects(rawRects, clipBounds);
  if (ENABLE_HIGHLIGHT_OVERLAY_RECT_MERGE && !isTableCellHighlightHost(hostElement)) {
    rects = mergeHighlightClientRects(rects);
  }
  if (rects.length === 0) return false;

  logUnderlineTrace('apply', {
    rawCount: rawRects.length,
    mergedCount: rects.length,
    rects: rects.map(summarizeHighlightClientRect)
  });

  const drawUnderlineOptions = enrichHighlightUnderlineOptions(hostElement, rects, underlineOptions);
  if (drawUnderlineOptions.lineRhythmAnchors) {
    logUnderlineTrace('rhythm', drawUnderlineOptions.lineRhythmAnchors);
  }

  let overlayApplied = false;
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (!isValidHighlightClientRect(rect)) continue;
    const box = createHighlightOverlayBox(rect, hostElement, drawUnderlineOptions);
    if (!box) continue;
    root.appendChild(box);
    overlayApplied = true;
  }
  if (!overlayApplied) return false;
  currentHighlightRange = range;
  currentHighlightRects = rects.slice();
  return true;
}

function isSingleFullBlockLogicalChunk(chunks, blockText, chunk) {
  if (!chunk || !blockText || chunks.length !== 1) return false;
  return chunk.start === 0 && chunk.end === blockText.length;
}

function countValidRangeClientRects(range) {
  if (!range) return 0;
  const rectList = range.getClientRects();
  let count = 0;
  for (let i = 0; i < rectList.length; i++) {
    const r = rectList[i];
    if (r.width > 0 && r.height > 0) count++;
  }
  return count;
}

// 1チャンク全文かつ折り返し複数行のときだけ外接1矩形（表セル等の二重枠防止）
function shouldUseSingleBlockUnionOverlay(chunks, blockText, chunk, range) {
  if (isHighlightUnderlineOverlayStyle()) return false;
  if (!isSingleFullBlockLogicalChunk(chunks, blockText, chunk)) return false;
  return countValidRangeClientRects(range) > 1;
}

function applyHighlightOverlayUnion(range, clipBounds, clientRectsOverride, hostElement, underlineOptions) {
  // 下線は行ごとの矩形が必要なため、union（外接1矩形）は使わない
  if (isHighlightUnderlineOverlayStyle()) {
    return applyHighlightOverlay(range, clipBounds, clientRectsOverride, hostElement, underlineOptions);
  }

  clearHighlightOverlay();
  const root = ensureHighlightOverlayRoot();
  let rect = range.getBoundingClientRect();
  if (clipBounds) {
    const clipped = clipClientRectToBounds(rect, clipBounds);
    if (!clipped) return false;
    rect = clipped;
  } else if (!isValidHighlightClientRect(rect)) {
    return false;
  }

  root.appendChild(createHighlightOverlayBox(rect));
  currentHighlightRange = range;
  return true;
}

function tryHighlightLogicalBlockAtPoint(clientX, clientY) {
  try {
    let highlightBlock = findHighlightBlockFromPoint(clientX, clientY);
    if (!highlightBlock) {
      logUnderlineTrace('block-miss', { x: clientX, y: clientY, reason: 'findHighlightBlockFromPoint' });
      return false;
    }
    logUnderlineTrace('block', summarizeHighlightBlockForTrace(highlightBlock));
    highlightBlock = normalizeAggregateHighlightBlock(highlightBlock, clientX, clientY);
    highlightBlock = preferParagraphHighlightBlockAtPoint(highlightBlock, clientX, clientY);

    if (
      isElementHighlightBlock(highlightBlock) &&
      isDlDescAggregateDiv(highlightBlock.element)
    ) {
      const dlDescUnit = resolveDlDescUnitAtPoint(clientX, clientY);
      if (!dlDescUnit) {
        logUnderlineTrace('block-miss', { x: clientX, y: clientY, reason: 'dl-desc-unit-null' });
        return false;
      }
      highlightBlock = { mode: 'element', element: dlDescUnit };
    }

    if (
      isInlineTextHighlightBlock(highlightBlock) &&
      !inlineTextHostAcceptsHoverPoint(highlightBlock.element, clientX, clientY)
    ) {
      logUnderlineTrace('block-miss', {
        x: clientX,
        y: clientY,
        reason: 'inline-text-rejects-point',
        host: summarizeHighlightBlockForTrace(highlightBlock)
      });
      return false;
    }

    let layoutLineContext = null;
    if (
      isElementHighlightBlock(highlightBlock) &&
      highlightBlock.element &&
      isLayoutTableCell(highlightBlock.element)
    ) {
      layoutLineContext = resolveLayoutTableCellTextContextAtPoint(
        highlightBlock.element,
        clientX,
        clientY
      );
    }

    let whole =
      layoutLineContext && layoutLineContext.blockText.trim() && layoutLineContext.segments.length > 0
        ? layoutLineContext
        : collectHighlightBlockTextSegments(highlightBlock);
    if (!whole.blockText.trim() || whole.segments.length === 0) {
      const recovered = recoverHighlightBlockFromHitStack(clientX, clientY);
      if (
        recovered &&
        recovered.element &&
        (!highlightBlock.element || recovered.element !== highlightBlock.element)
      ) {
        logUnderlineTrace('block-recover-empty', {
          from: summarizeHighlightBlockForTrace(highlightBlock),
          to: summarizeHighlightBlockForTrace(recovered)
        });
        highlightBlock = recovered;
        layoutLineContext = null;
        whole = collectHighlightBlockTextSegments(highlightBlock);
      }
    }
    if (!whole.blockText.trim() || whole.segments.length === 0) {
      logUnderlineTrace('block-miss', {
        x: clientX,
        y: clientY,
        reason: 'empty-blockText-or-segments',
        host: summarizeHighlightBlockForTrace(highlightBlock)
      });
      return false;
    }

    const langContextNode = isElementHighlightBlock(highlightBlock)
      ? highlightBlock.element
      : getSectionBlockRoot(highlightBlock);
    const languageMode = detectLanguageMode(whole.blockText, langContextNode);
    const useGhostCardLeadChunk = shouldUseGhostCardLeadChunk(clientX, clientY, highlightBlock);
    const { blockText, segments } = useGhostCardLeadChunk
      ? whole
      : layoutLineContext && layoutLineContext.blockText.trim() && layoutLineContext.segments.length > 0
        ? layoutLineContext
        : resolveHighlightTextContext(highlightBlock, languageMode, clientX, clientY);
    if (!blockText.trim() || segments.length === 0) {
      logUnderlineTrace('block-miss', {
        x: clientX,
        y: clientY,
        reason: 'empty-resolved-text-context',
        host: summarizeHighlightBlockForTrace(highlightBlock)
      });
      return false;
    }

    let chunk;
    let chunks;
    if (useGhostCardLeadChunk) {
      if (isPreHighlightBlock(highlightBlock)) {
        chunks = [{ start: 0, end: blockText.length, text: blockText }];
        chunk = chunks[0];
      } else {
        chunk = buildGhostCardLeadChunk(blockText, languageMode);
        if (!chunk) {
          logUnderlineTrace('block-miss', { x: clientX, y: clientY, reason: 'ghost-lead-chunk-null' });
          return false;
        }
        chunks = buildLogicalChunks(blockText, languageMode);
      }
    } else {
      let offset = getCaretOffsetInBlock(highlightBlock, segments, clientX, clientY);
      if (offset < 0) {
        if (isInlineTextHighlightBlock(highlightBlock)) {
          logUnderlineTrace('block-miss', {
            x: clientX,
            y: clientY,
            reason: 'caret-offset-inline',
            host: summarizeHighlightBlockForTrace(highlightBlock)
          });
          return false;
        }
        offset = Math.floor(blockText.length / 2);
      }

      chunks =
        isPreHighlightBlock(highlightBlock) || shouldUseFullTableCellChunk(highlightBlock)
          ? [{ start: 0, end: blockText.length, text: blockText }]
          : buildLogicalChunks(blockText, languageMode);
      chunk = findChunkContainingOffset(chunks, offset);
      if (
        !isAozoraSpecialHighlightBlock(highlightBlock) &&
        shouldUseJaSectionFullLineChunk(highlightBlock, blockText, languageMode, clientX, clientY)
      ) {
        chunk = { start: 0, end: blockText.length, text: blockText };
        chunks = [chunk];
      }
    }

    if (!chunk || !chunk.text.trim()) {
      logUnderlineTrace('block-miss', { x: clientX, y: clientY, reason: 'chunk-empty' });
      return false;
    }
    if (!withinHighlightLimit(chunk.text, languageMode)) {
      logUnderlineTrace('block-miss', {
        x: clientX,
        y: clientY,
        reason: 'over-highlight-limit',
        chunk: chunk.text.slice(0, 80),
        len: chunk.text.trim().length
      });
      return false;
    }

    const range = createRangeForChunk(segments, chunk.start, chunk.end);
    if (!range) {
      logUnderlineTrace('block-miss', { x: clientX, y: clientY, reason: 'range-null' });
      return false;
    }
    const chunkRects = getClientRectsForChunkSegments(segments, chunk.start, chunk.end);
    if (
      !useGhostCardLeadChunk &&
      !isAozoraSpecialHighlightBlock(highlightBlock) &&
      !clientPointInClientRects(chunkRects, clientX, clientY, {
        lineTolerance: HIGHLIGHT_RECT_MERGE_LINE_TOLERANCE_PX
      })
    ) {
      logUnderlineTrace('block-miss', {
        x: clientX,
        y: clientY,
        reason: 'pointer-outside-chunkRects',
        host: summarizeHighlightBlockForTrace(highlightBlock),
        chunk: chunk.text.slice(0, 80),
        chunkRectCount: chunkRects.length
      });
      return false;
    }

    const clipBounds = getTightenedParagraphClipBounds(
      getHighlightBlockClipElement(highlightBlock),
      getHighlightBlockClipBounds(highlightBlock),
      clientX,
      clientY
    );
    const overlayHostElement = getHighlightBlockClipElement(highlightBlock);
    let overlayRects = chunkRects;
    if (isElementHighlightBlock(highlightBlock)) {
      const hostEl = highlightBlock.element;
      // §14 NK-1R: ゴースト lead chunk 時は §33 pointer 行絞りを使わない（日経 H2 折り返し全行）
      const filterToPointerLine =
        !useGhostCardLeadChunk &&
        ((isTableCellHighlightHost(hostEl) && shouldFilterTableCellOverlayToPointerLine(hostEl)) ||
          shouldFilterDecoratedBlockOverlayToPointerLine(hostEl, chunkRects));
      if (filterToPointerLine) {
        overlayRects = filterClientRectsToPointerVisualLine(chunkRects, clientX, clientY, {
          hostElement: overlayHostElement,
          lineTolerance: HIGHLIGHT_RECT_MERGE_LINE_TOLERANCE_PX
        });
      }
    }

    if (isPointInCurrentHighlight(clientX, clientY)) {
      if (!isRubyBrBlockHost()) {
        logUnderlineTrace('skip-sticky', { x: clientX, y: clientY });
        return true;
      }
    }

    if (highlightProgressSession && isSameHighlightProgressTarget(highlightBlock, chunk)) {
      logUnderlineTrace('skip-progress-session', {
        chunk: chunk.text.slice(0, 60)
      });
      return true;
    }
    const underlineOptions = enrichHighlightUnderlineOptions(overlayHostElement, overlayRects, {
      pointerClientY: clientY,
      preferRectBottomForSingleVisualLine: shouldPreferRectBottomUnderlineAnchor(
        overlayHostElement,
        overlayRects
      )
    });

    let hostLineHeight = null;
    if (isHighlightUnderlineTraceEnabled() && overlayHostElement) {
      try {
        hostLineHeight = parseFloat(getComputedStyle(overlayHostElement).lineHeight);
      } catch (_e) {
        hostLineHeight = null;
      }
    }
    logUnderlineTraceDrawSnapshot({
      host: summarizeHighlightBlockForTrace(highlightBlock),
      chunk: {
        start: chunk.start,
        end: chunk.end,
        text: chunk.text,
        units: countUnits(chunk.text, languageMode)
      },
      chunkRects: chunkRects.map(summarizeHighlightClientRect),
      overlayRects: overlayRects.map(summarizeHighlightClientRect),
      lh: hostLineHeight,
      underlineOptions,
      anchors: overlayRects.map((r) => ({
        rect: summarizeHighlightClientRect(r),
        wrapped: hostLineHeight != null && isWrappedVisualLineClientRect(r, hostLineHeight),
        rhythmLineTop: underlineOptions.lineRhythmAnchors
          ? matchRectToVisualLineTop(
            r,
            underlineOptions.lineRhythmAnchors.lineTops,
            underlineOptions.lineRhythmAnchors.matchTolerance
          )
          : null,
        anchorBottom: getHighlightUnderlineAnchorBottom(r, overlayHostElement, underlineOptions),
        underlineTop: getHighlightUnderlineTop(r, overlayHostElement, underlineOptions)
      })),
      pointer: { x: clientX, y: clientY },
      viewport: { w: window.innerWidth, h: window.innerHeight }
    });

    clearCurrentHighlight();
    let overlayApplied = false;
    if (
      !useGhostCardLeadChunk &&
      shouldUseSingleBlockUnionOverlay(chunks, blockText, chunk, range)
    ) {
      overlayApplied = applyHighlightOverlayUnion(range, clipBounds, overlayRects, overlayHostElement, underlineOptions);
    } else {
      overlayApplied = applyHighlightOverlay(range, clipBounds, overlayRects, overlayHostElement, underlineOptions);
    }
    if (!overlayApplied) {
      logUnderlineTrace('block-miss', {
        x: clientX,
        y: clientY,
        reason: 'overlay-not-applied',
        host: summarizeHighlightBlockForTrace(highlightBlock)
      });
      return false;
    }

    const units = countUnits(chunk.text, languageMode);
    const progressTarget = captureHighlightProgressTarget(highlightBlock, chunk);
    if (subPopupOnOff) {
      startCountdownSubPopup(units, languageMode);
    }
    startHighlightLineProgress(units, languageMode, progressTarget);
    debugLog(
      'logical chunk',
      highlightBlock.mode,
      languageMode,
      chunk.start,
      chunk.end,
      units
    );
    logUnderlineTrace('applied', {
      x: clientX,
      y: clientY,
      host: summarizeHighlightBlockForTrace(highlightBlock),
      chunk: chunk.text.slice(0, 80)
    });
    return true;
  } catch (err) {
    debugError('tryHighlightLogicalBlockAtPoint:', err);
    logUnderlineTrace('block-miss', { x: clientX, y: clientY, reason: 'exception', message: String(err && err.message || err) });
    return false;
  }
}

// === 連続するspan要素を含む親要素を検出する関数 ============================
function findParentWithConsecutiveSpans(element) {
  if (!element || !isHighlightTargetTag(element.tagName)) {
    return null;
  }

  const parent = element.parentElement;
  if (!parent) {
    return null;
  }

  // 親要素の直接の子要素を取得
  const children = Array.from(parent.childNodes);

  // 連続するspan要素のグループを検出
  let consecutiveSpans = [];
  let currentGroup = [];

  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    // span要素、a要素、strong要素、またはテキストノード（空白のみでない）の場合
    if ((child.nodeType === Node.ELEMENT_NODE && isConsecutiveGroupTag(child.tagName)) ||
      (child.nodeType === Node.TEXT_NODE && child.textContent.trim() !== '')) {
      currentGroup.push(child);
    } else {
      // 連続が途切れた場合、現在のグループを評価
      if (currentGroup.length >= 2) {
        // グループ内にspan要素、a要素、またはstrong要素が2つ以上あるかチェック
        const textElementCount = currentGroup.filter(node =>
          node.nodeType === Node.ELEMENT_NODE && isConsecutiveGroupTag(node.tagName)
        ).length;

        if (textElementCount >= 2) {
          consecutiveSpans = currentGroup;
          break;
        }
      }
      currentGroup = [];
    }
  }

  // 最後のグループもチェック
  if (currentGroup.length >= 2) {
    const textElementCount = currentGroup.filter(node =>
      node.nodeType === Node.ELEMENT_NODE && isConsecutiveGroupTag(node.tagName)
    ).length;

    if (textElementCount >= 2) {
      consecutiveSpans = currentGroup;
    }
  }

  // 連続するspan要素が2つ以上ある場合、親要素を返す
  if (consecutiveSpans.length >= 2) {
    // マウスオーバーした要素が連続グループに含まれているかチェック
    const isElementInGroup = consecutiveSpans.some(node =>
      node === element || (node.nodeType === Node.ELEMENT_NODE && node.contains && node.contains(element))
    );

    if (isElementInGroup) {
      // 親要素のテキスト長をチェック
      const parentTextLength = parent.textContent.trim().length;
      if (parentTextLength <= MAX_TEXT_LENGTH_FOR_HIGHLIGHT + 5) {
        return parent;
      }
    }
  }

  return null;
}  // findParentWithConsecutiveSpans


// === 要素をハイライトする関数 ===============================================
function highlightElement(element, clientX, clientY) {
  try {
    // テキスト入力可能な要素の場合は処理をスキップ
    if (isEditableElement(element)) {
      return;
    }

    // 要素下に html/head/body がある場合は処理しない（自身の body/html は除外）
    if (elementContainsNestedDocumentRoot(element)) {
      debugLog('要素下にhtml,head,bodyがある場合');
      return;
    }

    // 要素下にテキストノードがない場合は処理しない
    if (getFirstTextNodeDepth(element) === -1) {
      debugLog('要素下にテキストノードがない場合');
      return;
    }

    if (typeof clientX === 'number' && typeof clientY === 'number') {
      if (tryHighlightLogicalBlockAtPoint(clientX, clientY)) {
        return;
      }
      return;
    }

    if (getFirstTextNodeDepth(element) === -1) {
      return;
    }

    let preHilightSts = 0; //init:0
    let textContent = element.textContent || '';
    let textLength = textContent.trim().length;
    const cstChildsiblingCounts = getChildSiblingCounts(element); //同一階層の子要素数(br等除く)

    //code要素がまとまって存在する場合の処理（親要素にcodeがある場合）
    if (element.closest('code')
      && (element.children.length >= 1) //要素ノードがある場合
      && !element.classList.contains(CODE_WRAP_CLASS_NAME) //自分がラップ済か
      && !element.closest('.' + CODE_WRAP_CLASS_NAME)) { //先祖がラップ済か
      preHilightSts = 1; //code
      debugLog('CODEの要素:', element);
      if (!processedElementCache.has(element)) {
        processedElementCache.add(element);
        //code要素内において、改行を基準にテキストを分割し、改行文字を単独ノードにする。
        splitTextNodesByNewline(element);
        //改行以外のテキストノードを1つずつspanで包む
        addSpanToNonNewlineText(element);
        //改行ノード('\n')を境に行単位グルーピング(code_line_wrapクラス)
        wrapCodeLines(element);
        //inline-blockでラッピングし行ラップ、ハイライト枠の表示を安定化
        wrapAllChildElements(element);
      }
    }

    //code が単独で存在する場合の処理（上記は子要素が存在する場合のため上記と重複しない）
    if (element.closest('code')) {
      if (!processedElementCache.has(element)) {
        processedElementCache.add(element);
        preHilightSts = 2; //code2
        //code要素内の改行を分割する
        splitTextNodesByNewline(element);
        //単独のテキストノードにspanを付けて要素化しハイライト可能にする
        splitLongTextNodes(element);
      }
    }


    //ruby要素がある場合の処理
    if (element.querySelector('ruby')) {
      if (!processedElementCache.has(element)) {
        preHilightSts = 3; //ruby
        debugLog('RUBYの要素:', element);
        processedElementCache.add(element);
        //ruby・rb・rt要素を分割テキスト化し、以降の分割に備える
        replaceRubyWithText(element);
        // 上記の分割テキスト化後に残る\nを削除し以降の分割に備える(◆注意◆ruby削除後しか使えない処理)
        removeEnNAfterRuby(element);
        //長文テキストを分割しハイライト可能な長さに整える
        splitAllTextNodesByLength(element);
      }
    } else {
    }

    //GMAIL向け
    if (element.querySelector('wbr') &&
      element.textContent &&
      element.textContent.includes('\n') &&
      (element.textContent.match(/\n/g) || []).length <= 1) {
      preHilightSts = 4; //gmail
      removeWbrTags(element); //wbrを削除
      splitLongTextNodes(element); //単独テキストにspan
      wrapBrLines(element); //br境界でspan
    }

    if (textLength <= MAX_TEXT_LENGTH_FOR_HIGHLIGHT + 5) {
      // 連続するspan要素を含む親要素を検出（span要素またはstrong要素の場合）
      let highlightTarget = element;

      // processed-span要素の場合、wrapBrLineGroups()で作成されたグループを探す
      if (element.classList && element.classList.contains(CLASS_PROCESSED_SPAN)) {
        // 親要素がpadding-rightのspan（wrapBrLineGroups()で作成されたグループ）かチェック
        let parent = element.parentElement;
        let depth = 0;
        const maxDepth = 5; // 無限ループ防止

        while (parent && depth < maxDepth) {
          // インラインスタイルでpaddingRightが設定されているかチェック
          // wrapBrLineGroups()で作成されたグループはpadding-right: 0pxまたは20pxを持つ
          if (parent.style && parent.style.paddingRight) {
            const paddingRight = parent.style.paddingRight;
            // paddingRightが設定されている場合（'0px'も含む、wrapBrLineGroups()で作成されたグループ）
            if (paddingRight !== undefined && paddingRight !== null && paddingRight !== '') {
              // wrapBrLineGroups()で作成されたグループは、文字数制限に関係なく常にハイライト対象とする
              highlightTarget = parent;
              debugLog('wrapBrLineGroups()で作成されたグループを検出:', parent, 'paddingRight:', paddingRight);
              break;
            }
          }
          parent = parent.parentElement;
          depth++;
        }
      }

      if (isHighlightTargetTag(highlightTarget.tagName)) {
        const parentWithSpans = findParentWithConsecutiveSpans(highlightTarget);
        if (parentWithSpans) {
          highlightTarget = parentWithSpans;
          debugLog('連続するspan要素を含む親要素を検出:', parentWithSpans);
        }
      }

      // highlightTargetの文字数を使用
      const finalText = highlightTarget.textContent || '';
      const finalLanguageMode = detectLanguageMode(finalText, highlightTarget);
      const finalUnits = countUnits(finalText, finalLanguageMode);
      applyHighlight(highlightTarget);
      if (subPopupOnOff) {
        startCountdownSubPopup(finalUnits, finalLanguageMode);
      }
      startHighlightLineProgress(finalUnits, finalLanguageMode);
    }
  } catch (error) {
    debugError('highlightElement処理中にエラーが発生:', error);
    // エラーが発生しても拡張機能は停止しないようにする
  }
} //end highlightElement


// === 現在のハイライトをクリアする関数 =========================================
function clearCurrentHighlight() {
  clearHighlightOverlay();

  if (currentHighlightedElement) {
    currentHighlightedElement.style.border = '';
    currentHighlightedElement.style.outline = '';
    currentHighlightedElement.style.outlineOffset = '';
    currentHighlightedElement = null;
  }

  // カウントダウンタイマーをクリア
  if (countDownIntervalForSub) {
    clearInterval(countDownIntervalForSub);
    countDownIntervalForSub = null;
  }

  // サブポップアップの文字数を非表示にする
  hideSubPopupCharCount();
} //end clearCurrentHighlight


// === テキスト入力可能なDOMの判定 =============================================
function isEditableElement(element) {
  if (!element) return false;
  if (element.nodeType && element.nodeType !== Node.ELEMENT_NODE) return false;
  if (typeof element.getAttribute !== 'function') return false;

  // 1. contenteditable属性がtrue
  if (element.contentEditable === 'true' || element.isContentEditable) {
    return true;
  }

  // 2. input要素（text, email, search, tel, url, passwordなど）
  if (element.tagName === 'INPUT' &&
    ['text', 'email', 'search', 'tel', 'url', 'password', 'number'].includes(element.type)) {
    return true;
  }

  // 3. textarea要素
  if (element.tagName === 'TEXTAREA') {
    return true;
  }

  // 4. role="textbox"の要素
  if (element.getAttribute('role') === 'textbox') {
    return true;
  }

  // 5. 親要素がテキスト入力可能な場合もスキップ（オプション）
  // 例: contenteditableな親要素内の子要素
  if (element.closest && element.closest('[contenteditable="true"]')) {
    return true;
  }

  return false;
} //end isEditableElement


// === サブポップアップの文字数を非表示にする関数 ================================
function hideSubPopupCharCount() {
  const subpopup = document.getElementById(ID_SUBPOPUP_CONTAINER);
  if (subpopup) {
    const shadow = subpopup.shadowRoot;
    if (shadow) {
      const charCount = shadow.querySelector('.char-count');
      if (charCount) {
        charCount.style.display = 'none';
      }
    }
  }
}



// === 同一階層の子要素数(br,span,code,ruby,em,a除く)を出力 =====================
function getChildSiblingCounts(element) {
  if (!element?.children) {
    return 100; //error値
  }

  const children = element.children;
  const tagCounts = {};
  const excludeTags = ['br', 'span', 'code', 'ruby', 'em', 'a', 'strong', 'b', 'i', 'img'];

  for (let i = 0; i < children.length; i++) {
    const tagName = children[i].tagName.toLowerCase();
    tagCounts[tagName] = (tagCounts[tagName] || 0) + 1;
  }

  // 除外タグを除いた種類数
  const validTagCount = Object.keys(tagCounts)
    .filter(tag => !excludeTags.includes(tag))
    .length;

  return validTagCount;
}



// === <br>を境界として連続する要素をbr_line_wrapクラスで囲む ===================
function wrapBrLines(element) {
  // 後ろから処理してインデックスのずれを防ぐ
  for (let i = element.childNodes.length - 1; i >= 0; i--) {
    const currentNode = element.childNodes[i];

    // brタグの場合はスキップ
    if (currentNode.nodeType === Node.ELEMENT_NODE && currentNode.tagName === 'BR') {
      continue;
    }

    // 既にbr_line_wrapでラップされている要素はスキップ
    if (currentNode.nodeType === Node.ELEMENT_NODE &&
      currentNode.classList &&
      currentNode.parentNode.classList.contains(CLASS_BR_LINE_WRAP)) {
      continue;
    }

    // 連続する要素を収集（後ろから）
    const lineElements = [];
    let j = i;
    while (j >= 0) {
      const node = element.childNodes[j];

      // brタグで終了
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
        break;
      }

      // 要素ノードまたはテキストノードを収集
      if (node.nodeType === Node.ELEMENT_NODE ||
        node.nodeType === Node.TEXT_NODE) {
        lineElements.unshift(node); // 前から順番に追加
      }

      j--;
    }

    // 収集した要素が2個以上の場合のみラッピング
    if (lineElements.length >= 2) {
      // br_line_wrapコンテナを作成
      const container = document.createElement('span');
      container.className = CLASS_BR_LINE_WRAP;
      container.style.display = 'inline-block';
      container.style.width = '98%';

      // 最初の要素の前にコンテナを挿入
      element.insertBefore(container, lineElements[0]);

      // 収集した要素をコンテナに移動
      lineElements.forEach(el => {
        container.appendChild(el);
      });
    }

    // 次の処理位置を更新
    i = j;
  }
} //end wrapBrLines


// === wbrを削除 ==============================================================
function removeWbrTags(element) {
  const children = Array.from(element.childNodes);

  children.forEach(node => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'WBR') {
        // wbrタグを削除
        node.parentNode.removeChild(node);
      } else {
        // 他の要素内のwbrタグも再帰的に削除
        removeWbrTags(node);
      }
    }
  });
}


// === テキストノードが初めて存在する子階数数を算出 ==============================
function getFirstTextNodeDepth(element, maxDepth = 10) {
  // スタック: [{node: 要素, level: 深さ}, ...]
  const stack = [{ node: element, level: 0 }];

  while (stack.length > 0) {
    const { node: el, level } = stack.pop(); // 最後に追加したものから取り出す

    // 最大深さチェック
    if (level >= maxDepth) continue;

    // 子ノードをチェック
    if (el.childNodes) {
      // 逆順でスタックに追加（後で処理するため）
      for (let i = el.childNodes.length - 1; i >= 0; i--) {
        const child = el.childNodes[i];

        // テキストノードかチェック
        if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
          return level + 1; // 見つかったら即座に返す
        }

        // 要素ノードならスタックに追加
        if (child.nodeType === Node.ELEMENT_NODE) {
          stack.push({ node: child, level: level + 1 });
        }
      }
    }
  }

  return -1; // テキストノードが見つからない
} //end getFirstTextNodeDepth


// === rubyでnを削除後に長文テキストを分割(句読点を考慮して分割) =================
function splitTextByPunctuation(text, maxLength) {
  return splitJapaneseTextByBoundary(text, maxLength);
} //end splitTextByPunctuation


// === テキストノードをspanで囲む共通処理 =======================================
function wrapTextNodeWithSpan(textNode, text, className = CLASS_PROCESSED_SPAN) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  const parent = textNode.parentNode;
  parent.insertBefore(span, textNode);
  parent.removeChild(textNode);

  // 1行だけの場合、inline-blockスタイルを追加
  if (isSingleLineElement(span)) {
    span.style.display = 'inline-block';
    span.style.width = '90%';
  }
}


// === spanが一行に単独で存在するか判定するヘルパー関数 ==========================
function isSingleLineElement(span) {
  const parent = span.parentNode;
  if (!parent) return false;

  // 親要素がインライン要素（<b>, <span>, <a>など）の場合は、さらに上位の親要素を確認
  const inlineTags = ['B', 'SPAN', 'A', 'STRONG', 'EM', 'I', 'U'];
  let checkParent = parent;
  let targetElement = span; // 確認対象の要素（spanまたはその親要素）

  if (inlineTags.includes(checkParent.tagName)) {
    targetElement = checkParent; // 親要素（<b>タグなど）を確認対象にする
    checkParent = checkParent.parentNode;
    if (!checkParent) return false;
  }

  const allSiblings = Array.from(checkParent.childNodes);
  const targetIndex = allSiblings.indexOf(targetElement);
  if (targetIndex === -1) return false;

  // 前の<br>を探す
  let lineStartIndex = 0;
  for (let i = targetIndex - 1; i >= 0; i--) {
    const node = allSiblings[i];
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
      lineStartIndex = i + 1;
      break;
    }
  }

  // 後の<br>を探す
  let lineEndIndex = allSiblings.length;
  for (let i = targetIndex + 1; i < allSiblings.length; i++) {
    const node = allSiblings[i];
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
      lineEndIndex = i;
      break;
    }
  }

  // その行の要素ノード（BRを除く）をカウントし、文字数も同時にカウント
  let elementCount = 0;
  let totalTextLength = 0;
  for (let i = lineStartIndex; i < lineEndIndex; i++) {
    const node = allSiblings[i];
    totalTextLength += getNodeTextLength(node);
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== 'BR') {
      elementCount++;
    }
  }

  // まず要素数で一行か判定（要素が1つだけなら一行候補）
  if (elementCount !== 1) {
    return false; // 要素が2つ以上なら一行ではない（文字数に関係なく）
  }

  const lineText = parent.textContent || '';
  const languageMode = detectLanguageMode(lineText, span);
  if (languageMode === LANGUAGE_MODE_EN) {
    return countWords(lineText) < 12;
  }
  return totalTextLength < 40;
} //end isSingleLineElement


// === テキストノードを処理すべきかチェック =====================================
function shouldProcessTextNode(textNode) {
  // 既にクラス名付きspanで囲まれている場合はスキップ
  if (textNode.parentElement?.tagName === 'SPAN' &&
    textNode.parentElement.className.trim() !== '') {
    return false;
  }

  return true;
}

// === 単一テキストノードの分割処理 ============================================
function splitTextNodeByLength(textNode, maxLength) {
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;
  if (!shouldProcessTextNode(textNode)) return;

  const text = textNode.textContent;
  if (!text) return;

  // 改行文字一文字の場合は処理をスキップ
  if (text === '\n') return;

  // 空文字、空白文字のみ、または&nbsp;（非改行スペース）のみの場合は通常のスペースに置換
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '\u00A0') {
    // テキストノードを通常のスペースに置換
    const parent = textNode.parentNode;
    if (parent) {
      const spaceNode = document.createTextNode(' ');
      parent.replaceChild(spaceNode, textNode);
    }
    return;
  }


  const parent = textNode.parentNode;
  if (!parent) return;

  try {
    if (text.length <= maxLength) {
      wrapTextNodeWithSpan(textNode, text);
    } else {
      const chunks = splitJapaneseTextByBoundary(text, maxLength);
      chunks.forEach(chunk => {
        const span = document.createElement('span');
        span.textContent = chunk;
        parent.insertBefore(span, textNode);
      });
      parent.removeChild(textNode);
    }
  } catch (error) {
    debugError('テキストノード分割中にエラーが発生:', error);
  }
} //end splitTextNodeByLength

// === 長文テキストを指定長に分割 ==============================================
function splitAllTextNodesByLength(parentElement, maxLength = MAX_TEXT_LENGTH_FOR_HIGHLIGHT) {
  if (!parentElement?.childNodes) return;

  try {
    Array.from(parentElement.childNodes).forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) {
        splitTextNodeByLength(child, maxLength);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName !== 'STRONG') {
          splitAllTextNodesByLength(child, maxLength); // 再帰処理
        }
      }
    });
  } catch (error) {
    debugError('テキストノード分割処理中にエラーが発生:', error);
  }
}

// === 行頭～<br>までの要素をpadding-right:20pxのspanで囲む ====================
function wrapBrLineGroups(element) {
  if (!element?.childNodes) return;

  const children = Array.from(element.childNodes);
  let currentGroup = []; // 現在のグループ
  let currentLength = 0; // 現在のグループの累積文字数

  for (let i = 0; i < children.length; i++) {
    const node = children[i];

    // brタグに到達した場合
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
      // 既存のグループが1個以上の場合のみ処理（2個以上から1個以上に変更）
      if (currentGroup.length >= 1 && currentLength > 0) { // 修正が必要
        wrapNodesWithPaddingSpan(currentGroup, element, "20px");
      }
      currentGroup = [];
      currentLength = 0;
      continue;
    }

    // &nbsp;（非改行スペース）だけを含むテキストノードはスキップ
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      const trimmed = text.trim();
      if (trimmed === '' || trimmed === '\u00A0') {
        continue; // スキップ
      }
    }

    // テキストノードまたは要素ノードを処理
    const textLength = getNodeTextLength(node);

    // 追加するとMAX_TEXT_LENGTH_FOR_HIGHLIGHT文字を超える場合
    if (currentLength + textLength > MAX_TEXT_LENGTH_FOR_HIGHLIGHT) {
      if (currentGroup.length >= 1 && currentLength > 0) { // 2個以上から1個以上に変更
        // 現在のグループを処理
        wrapNodesWithPaddingSpan(currentGroup, element);
        currentGroup = [];
        currentLength = 0;
      }
      // 現在の要素を新しいグループの最初の要素として追加
    }

    // ノードを現在のグループに追加
    currentGroup.push(node);
    currentLength += textLength;
  }

  // ループ終了時に currentGroup が残っていれば処理
  if (currentGroup.length >= 1 && currentLength > 0) { // 2個以上から1個以上に変更
    // 最後の要素がBRかどうかを確認
    const lastNode = children[children.length - 1];
    const isLastNodeBR = lastNode &&
      lastNode.nodeType === Node.ELEMENT_NODE &&
      lastNode.tagName === 'BR';

    const padding = isLastNodeBR ? '20px' : '0px';
    wrapNodesWithPaddingSpan(currentGroup, element, padding);
  }
} //end wrapBrLineGroups


// === ノードのテキスト長を取得するヘルパー関数 ==================================
function getNodeTextLength(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || '').length;
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    return (node.textContent || '').length;
  }
  return 0;
}

// === ノードグループをpadding-right:20pxのspanで囲む関数 =======================
function wrapNodesWithPaddingSpan(nodes, parentElement, paddingRight = '0px') {
  if (nodes.length === 0) return;

  const firstNode = nodes[0];
  const parent = firstNode.parentNode || parentElement;
  if (!parent) return;

  // 新しいspan要素を作成
  const wrapper = document.createElement('span');
  wrapper.style.paddingRight = paddingRight;

  // 最初のノードの前にwrapperを挿入
  parent.insertBefore(wrapper, firstNode);

  // グループ内のすべてのノードをwrapperに移動（前から順に処理）
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.parentNode === parent) {
      wrapper.appendChild(node);
    }
  }
} //end wrapNodesWithPaddingSpan


// === ruby・rb・rt要素を分割削除後に\nを削除 ==================================
function removeEnNAfterRuby(element) {
  if (element && element.innerHTML.includes('\n')) {
    element.innerHTML = element.innerHTML.replace(/\n/g, '');
  }
}


// === ruby・rb・rt要素を分割削除 ==============================================
function replaceRubyWithText(element) {
  const children = Array.from(element.childNodes);

  children.forEach(node => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'RUBY') {
        const rbElement = node.querySelector('rb');
        const rtElement = node.querySelector('rt');

        let textContent = '';
        if (rbElement) textContent += rbElement.textContent;
        if (rtElement) textContent += `（${rtElement.textContent}）`;

        const textNode = document.createTextNode(textContent);
        node.parentNode.replaceChild(textNode, node);
      } else {
        replaceRubyWithText(node);
      }
    }
  });
}


// === 単独のテキストノードにspanを付ける =======================================
function splitLongTextNodes(element) {
  const childNodes = Array.from(element.childNodes);

  // 逆順で処理してインデックスずれを防ぐ
  for (let i = childNodes.length - 1; i >= 0; i--) {
    const node = childNodes[i];

    if (node.nodeType === Node.TEXT_NODE &&
      childNodes.length > 1) {
      const text = node.textContent;

      // 既にspanで囲まれているかチェック
      if (node.parentElement && node.parentElement.tagName === 'SPAN') {
        continue; // 既にspanで囲まれている場合はスキップ
      }

      // 条件チェック: 空文字でない かつ 改行文字でない かつ 1文字以上
      // かつ &nbsp;（非改行スペース）のみでない
      if (text && text.trim() !== '' && !text.match(/^\s*$/) &&
        text.trim() !== '\u00A0' && text !== '\u00A0') {
        const parent = node.parentNode;
        const nextSibling = node.nextSibling;

        // 元のノードを削除
        node.remove();

        // spanで囲む
        const span = document.createElement('span');
        span.textContent = text;
        parent.insertBefore(span, nextSibling);
      }
    }
  }
} //end splitLongTextNodes



// === code要素内の改行を分割する ==============================================
function splitTextNodesByNewline(element) {
  let i = 0;
  while (i < element.childNodes.length) {
    let targetNode = element.childNodes[i];
    
    // 要素ノードの場合は、その中身を再帰的に処理
    if (targetNode.nodeType === Node.ELEMENT_NODE) {
      // 要素ノード内のテキストノードを再帰的に処理
      splitTextNodesByNewline(targetNode);
      
      // 要素ノード内に改行が含まれているかチェック
      // 要素ノード内のすべてのテキストノードをチェック
      let hasNewline = false;
      const walker = document.createTreeWalker(
        targetNode,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );
      let textNode;
      while (textNode = walker.nextNode()) {
        if (textNode.textContent.includes('\n')) {
          hasNewline = true;
          break;
        }
      }
      
      // 改行が含まれている場合、要素ノードを分割して改行を外に出す
      if (hasNewline) {
        splitElementNodeByNewline(targetNode, element, i);
        // 分割後はインデックスを調整せず、次の要素を処理
        i++;
        continue;
      }
      
      i++;
      continue;
    }
    
    // テキストノードのみを処理
    if (targetNode.nodeType !== Node.TEXT_NODE) {
      i++;
      continue;
    }
    
    let originalText = targetNode.textContent;

    if (originalText.includes('\n')) {
      // \nの数をカウント
      const newlineCount = (originalText.match(/\n/g) || []).length;

      // 分割数 = \nの数 × 2 + 1
      const splitCount = newlineCount * 2 + 1;

      // \nで分割
      const parts = originalText.split('\n');

      // 分割したテキストを新しいテキストノードとして追加
      for (let j = parts.length - 1; j >= 0; j--) {
        // 空文字列でない場合のみ処理（空白文字は保持）
        if (parts[j] !== '') {
          element.insertBefore(document.createTextNode(parts[j]), element.childNodes[i + 1]);
        }

        if (j > 0) {  //改行文字の挿入処理。この処理は必要
          element.insertBefore(document.createTextNode('\n'), element.childNodes[i + 1]);
        }
      }

      // 既存のテキストノードを削除
      element.removeChild(element.childNodes[i]);

      // 分割により増えた要素数分、インデックスを進める
      i += splitCount;
    } else {
      // 分割処理をしなかった場合は、次の要素に進む
      i++;
    }
  }
} //end splitTextNodesByNewline

// === 要素ノード内の改行を要素ノードの外に出す関数 =======================
function splitElementNodeByNewline(elementNode, parentElement, insertIndex) {
  // 要素ノードの属性を取得（クラス、スタイルなど）
  const tagName = elementNode.tagName;
  const className = elementNode.className;
  const attributes = {};
  for (let attr of elementNode.attributes) {
    attributes[attr.name] = attr.value;
  }
  
  // 要素ノード内のすべての子ノードを取得
  const childNodes = Array.from(elementNode.childNodes);
  
  // 要素ノードを削除
  parentElement.removeChild(elementNode);
  
  // 子ノードを処理して、改行で分割
  let currentGroup = [];
  let insertPos = insertIndex;
  
  for (let child of childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent;
      if (text.includes('\n')) {
        // 現在のグループがあれば、新しい要素ノードでラップ
        if (currentGroup.length > 0) {
          const newElement = document.createElement(tagName);
          // 属性をコピー
          for (let attrName in attributes) {
            newElement.setAttribute(attrName, attributes[attrName]);
          }
          // グループのノードを追加
          currentGroup.forEach(node => newElement.appendChild(node.cloneNode(true)));
          parentElement.insertBefore(newElement, parentElement.childNodes[insertPos]);
          insertPos++;
          currentGroup = [];
        }
        
        // テキストを改行で分割
        const parts = text.split('\n');
        for (let k = 0; k < parts.length; k++) {
          if (parts[k] !== '') {
            const textNode = document.createTextNode(parts[k]);
            // テキストノードを新しい要素ノードでラップ
            const newElement = document.createElement(tagName);
            for (let attrName in attributes) {
              newElement.setAttribute(attrName, attributes[attrName]);
            }
            newElement.appendChild(textNode);
            parentElement.insertBefore(newElement, parentElement.childNodes[insertPos]);
            insertPos++;
          }
          
          if (k < parts.length - 1) {
            // 改行文字を親要素の直接の子として挿入
            parentElement.insertBefore(document.createTextNode('\n'), parentElement.childNodes[insertPos]);
            insertPos++;
          }
        }
      } else {
        // 改行がないテキストノードはグループに追加
        currentGroup.push(child);
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      // 要素ノードもグループに追加
      currentGroup.push(child);
    }
  }
  
  // 残りのグループがあれば、新しい要素ノードでラップ
  if (currentGroup.length > 0) {
    const newElement = document.createElement(tagName);
    for (let attrName in attributes) {
      newElement.setAttribute(attrName, attributes[attrName]);
    }
    currentGroup.forEach(node => newElement.appendChild(node.cloneNode(true)));
    parentElement.insertBefore(newElement, parentElement.childNodes[insertPos]);
  }
} //end splitElementNodeByNewline


// === elementのchildNodesを探索して、\nを除くテキストノードにspanを付ける関数 ====
function addSpanToNonNewlineText(element) {
  if (!element || !element.childNodes) {
    debugLog('無効な要素です');
    return;
  }

  for (let current = 0; current < element.childNodes.length; current++) {
    const currentNode = element.childNodes[current];

    // 安全チェック
    if (!currentNode) continue;

    // 条件チェック：テキストノードかつ\nでないかつ空でない
    if (currentNode.nodeType === Node.TEXT_NODE &&
      currentNode.textContent !== '\n' &&
      currentNode.textContent.trim() !== '') {

      // 既にspanで囲まれているかチェック
      if (currentNode.parentElement && currentNode.parentElement.tagName === 'SPAN') {
        continue; // 既にspanで囲まれている場合はスキップ
      }

      // spanで囲む
      const spanWrapper = document.createElement('span');
      spanWrapper.appendChild(currentNode.cloneNode(true));

      // 元のテキストノードを置換
      element.replaceChild(spanWrapper, currentNode);
    }
  }
} //end addSpanToNonNewlineText

// === code要素内の改行文字を境界として連続する要素をcode_line_wrapクラスで囲む ===
function wrapCodeLines(element) {
  // 後ろから処理してインデックスのずれを防ぐ
  for (let i = element.childNodes.length - 1; i >= 0; i--) {
    const currentNode = element.childNodes[i];

    // 改行文字の場合はスキップ
    if (currentNode.nodeType === Node.TEXT_NODE && currentNode.textContent === '\n') {
      continue;
    }

    // 連続する要素を収集（後ろから）
    const lineElements = [];
    let j = i;
    while (j >= 0) {
      const node = element.childNodes[j];

      // 改行文字で終了
      if (node.nodeType === Node.TEXT_NODE && node.textContent === '\n') {
        break;
      }

      // 要素ノードまたはテキストノード（改行以外）を収集
      if (node.nodeType === Node.ELEMENT_NODE ||
        (node.nodeType === Node.TEXT_NODE && node.textContent !== '\n')) {
        lineElements.unshift(node); // 前から順番に追加
      }

      j--;
    }

    // 収集した要素が2個以上の場合のみラッピング
    if (lineElements.length >= 2) {
      // code_line_wrapコンテナを作成
      const container = document.createElement('span');
      container.className = CLASS_CODE_LINE_WRAP;

      // 最初の要素の前にコンテナを挿入
      element.insertBefore(container, lineElements[0]);

      // 収集した要素をコンテナに移動
      lineElements.forEach(el => {
        container.appendChild(el);
      });
    }

    // 次の処理位置を更新
    i = j;
  }
} //end wrapCodeLines


// === code要素内のspanタグをinline-blockでラッピングする =======================
function wrapAllChildElements(element) {
  if (element && element.nodeType === Node.ELEMENT_NODE) {
    const childCount = element.childNodes.length;

    // 後ろから処理（インデックスがずれないように）
    for (let i = childCount - 1; i >= 0; i--) {
      let child = element.childNodes[i];
      if (child.nodeType === Node.ELEMENT_NODE) { // 要素ノードのみ
        let container = document.createElement('span');
        container.className = CODE_WRAP_CLASS_NAME;
        container.style.display = 'inline-block';
        container.style.width = '90%';
        container.style.color = 'inherit'; // 親要素の色を継承

        element.insertBefore(container, child);
        container.appendChild(child);
      }
    }
  }
}


// === 祖先要素のクリッピング(overflow:hidden/clip 等)を検出 ====================
// outline は要素の外側に描画されるため、祖先の overflow:hidden 等によって
// 上下左右が切り取られて見えなくなる場合がある。その場合は outline-offset を
// 負値にして要素の「内側」に描画することで、ハイライトを常に可視化する。
function hasClippingAncestor(element) {
  try {
    let current = element && element.parentElement;
    let depth = 0;
    const maxDepth = 12; // 過剰な遡及を防止
    const clipValues = ['hidden', 'clip', 'auto', 'scroll'];
    while (current && depth < maxDepth && current !== document.body && current !== document.documentElement) {
      const style = window.getComputedStyle(current);
      if (clipValues.includes(style.overflow) ||
          clipValues.includes(style.overflowX) ||
          clipValues.includes(style.overflowY)) {
        return true;
      }
      current = current.parentElement;
      depth++;
    }
  } catch (_e) {
    // エラー時は安全側（クリッピングありとみなして内側描画）
    return true;
  }
  return false;
}

// === ハイライト適用関数 ======================================================
function applyHighlight(element) {
  try {
    if (!element) {
      debugError('applyHighlight: elementがnullまたはundefinedです');
      return;
    }

    // 既存のハイライトをクリア
    clearCurrentHighlight();

    // 赤色、2px、solidのoutlineを追加
    currentHighlightedElement = element;

    if (currentHighlightedElement) {
      currentHighlightedElement.style.border = '';
      currentHighlightedElement.style.outline = '2px solid red';
      // 祖先に overflow:hidden 等があると outline が切り取られて見えないため、
      // 内側に描画してクリップを回避する
      if (hasClippingAncestor(currentHighlightedElement)) {
        currentHighlightedElement.style.outlineOffset = '-2px';
      } else {
        currentHighlightedElement.style.outlineOffset = '';
      }
      debugLog('要素をハイライトしました');
    }
  } catch (error) {
    debugError('applyHighlight処理中にエラーが発生:', error);
  }
} //end applyHighlight


// === カウントダウン開始関数 ==================================================
function startCountdownSubPopup(unitCount, languageMode = LANGUAGE_MODE_JA) {
  try {
    const unitLabel = getUnitLabel(languageMode);
    const readTime = calculateReadingTime(unitCount, languageMode);
    countDownTimerForSub = readTime;

    startCountdownSubPopupInterval(unitCount, readTime, unitLabel);

    // ポップアップの文字数を更新
    updateSubPopupCharCount(unitCount, readTime, unitLabel);

    debugLog(`単位: ${unitCount}${unitLabel}, 読書: ${readTime}秒`);
  } catch (error) {
    debugError('カウントダウン開始中にエラーが発生:', error);
  }
} //end startCountdownSubPopup


// === サブポップアップモードをトグルする関数 =================================
function getHourglassIcon() {
  const popupMain = document.getElementById(ID_YOMUP_POPUP_CONTAINER);
  if (!popupMain || !popupMain.shadowRoot) return null;
  return popupMain.shadowRoot.querySelector('.hourglass-button img');
}

function closeSubPopupFromUi() {
  subPopupOnOff = false;
  localStorage.setItem(LOCALSTRG_SUBPOPUP_ONOFF, 'false');
  hideSubPopup();
  const hourglassIcon = getHourglassIcon();
  if (hourglassIcon) {
    hourglassIcon.classList.remove('active');
  }
  debugLog('サブポップアップを閉じました');
}

function toggleSubPopup() {
  subPopupOnOff = !subPopupOnOff; // 状態を反転
  localStorage.setItem(LOCALSTRG_SUBPOPUP_ONOFF, subPopupOnOff.toString());

  debugLog('サブポップアップモード:', subPopupOnOff);

  if (subPopupOnOff) {
    // ポップアップを表示
    showSubPopup();
  } else {
    closeSubPopupFromUi();
  }
} //end toggleSubPopup


// === サブポップアップを表示する関数 ===========================================
function showSubPopup() {
  // 既存のポップアップがあれば削除
  const existingSubPopup = document.getElementById(ID_SUBPOPUP_CONTAINER);
  if (existingSubPopup) {
    existingSubPopup.remove();
  }

  // Shadow DOMのコンテナ要素を作成
  const container = document.createElement('div');
  container.id = ID_SUBPOPUP_CONTAINER;

  // Shadow DOMを作成
  const shadow = container.attachShadow({ mode: 'open' });

  // Shadow DOM内にスタイルシートを作成(CSS)
  const isEnSubPopup = getYomupUiLocale() === 'en';
  const subPopupWidth = isEnSubPopup ? '168px' : '140px';
  const subPopupHeight = isEnSubPopup ? 'auto' : '40px';
  const subPopupMinHeight = '40px';
  const subPopupFontSize = '12px';
  const subPopupStyles = document.createElement('style');
  subPopupStyles.textContent = `
    .${CLASS_SUBPOPUP} {
      position: fixed !important;
      top: var(--subpopup-top, 50%) !important;
      left: var(--subpopup-left, 50%) !important;
      background: white !important;
      border: 2px solid #333 !important;
      border-radius: 10px !important;
      padding: 5px !important;
      font-size: ${subPopupFontSize} !important;
      font-family: Arial, sans-serif !important;
      color: #333 !important;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3) !important;
      z-index: 10000 !important;
      width: ${subPopupWidth} !important;
      min-height: ${subPopupMinHeight} !important;
      height: ${subPopupHeight} !important;
      display: flex !important;
      flex-direction: column !important;
      text-align: center !important;
      cursor: move !important;
      user-select: none !important;
    }
    .char-count {
      margin: auto 0 !important;
      font-size: ${subPopupFontSize} !important;
      color: #666 !important;
      line-height: 1.2 !important;
      white-space: normal !important;
      word-break: break-word !important;
    }
  `;

  // Shadow DOM内にポップアップ要素を作成
  const subpopup = document.createElement('div');
  subpopup.className = CLASS_SUBPOPUP;

  // メッセージ
  const message = document.createElement('div');
  message.textContent = t('partialTimerTitle');

  // 文字数表示要素（初期状態では非表示）
  const charCount = document.createElement('div');
  charCount.className = 'char-count';
  charCount.style.display = 'none';

  // ポップアップに要素を追加
  subpopup.appendChild(message);
  subpopup.appendChild(charCount);

  // Shadow DOMに要素を追加
  shadow.appendChild(subPopupStyles);
  shadow.appendChild(subpopup);

  // ページに追加
  document.body.appendChild(container);

  restorePopupPosition(
    subpopup,
    LOCALSTRG_YOMUPSUB_XYPOS,
    '--subpopup-top',
    '--subpopup-left',
    'サブポップアップ位置の復元に失敗しました:'
  );

  // ドラッグ移動機能を追加
  addDragFunctionality(subpopup);
  addSubPopupDblClickToClose(subpopup);

  debugLog('ポップアップを表示しました');
} //end showSubPopup


// === サブポップアップを非表示にする関数 =======================================
function hideSubPopup() {
  const existingSubPopup = document.getElementById(ID_SUBPOPUP_CONTAINER);
  if (existingSubPopup) {
    existingSubPopup.remove();
    debugLog('サブポップアップを非表示にしました');
  }
}

// === サブポップアップの文字数を更新する関数 ===================================
function updateSubPopupCharCount(unitCount, readTime, unitLabel = '字') {
  const subpopup = document.getElementById(ID_SUBPOPUP_CONTAINER);
  if (subpopup) {
    const shadow = subpopup.shadowRoot;
    if (shadow) {
      const charCount = shadow.querySelector('.char-count');
      if (charCount) {
        charCount.textContent = formatUiPartialTimerDisplay(
          unitCount,
          unitLabel,
          countDownTimerForSub,
          readTime
        );
        charCount.style.display = 'block';
      }
    }
  }
}


// === ポップアップ座標: "123px" を数値に変換 ===================================
function parsePopupPositionPx(cssValue) {
  if (typeof cssValue !== 'string') return null;
  const match = cssValue.trim().match(/^(-?\d+(?:\.\d+)?)px$/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

// ドラッグ時のみ: 窓の最大欄外はずれ（少なくとも 25% は画面内に残す）
const POPUP_VIEWPORT_MAX_OFFSCREEN_RATIO = 0.50;
const POPUP_VIEWPORT_RESIZE_DEBOUNCE_MS = 150;

// === ポップアップ座標をビューポートに合わせてクランプ =======================
// allowPartialOffscreen=true: ドラッグ用（最大75%まで欄外可）
// allowPartialOffscreen=false: 復元用（はみ出さず全体を画面内に収める）
function clampPopupViewportPosition(leftPx, topPx, width, height, allowPartialOffscreen = true) {
  if (!allowPartialOffscreen) {
    const maxLeft = Math.max(0, window.innerWidth - width);
    const maxTop = Math.max(0, window.innerHeight - height);
    return {
      left: Math.min(Math.max(0, leftPx), maxLeft),
      top: Math.min(Math.max(0, topPx), maxTop),
    };
  }

  const minVisibleRatio = 1 - POPUP_VIEWPORT_MAX_OFFSCREEN_RATIO;
  const minLeft = -width * POPUP_VIEWPORT_MAX_OFFSCREEN_RATIO;
  const maxLeft = window.innerWidth - width * minVisibleRatio;
  const minTop = -height * POPUP_VIEWPORT_MAX_OFFSCREEN_RATIO;
  const maxTop = window.innerHeight - height * minVisibleRatio;
  return {
    left: Math.min(Math.max(leftPx, minLeft), maxLeft),
    top: Math.min(Math.max(topPx, minTop), maxTop),
  };
}

// === クランプ済み座標を CSS 変数と localStorage に反映（復元用・全面内） =====
function applyPopupPositionClamped(popup, leftPx, topPx, topVar, leftVar, storageKey) {
  const rect = popup.getBoundingClientRect();
  const { left, top } = clampPopupViewportPosition(
    leftPx,
    topPx,
    rect.width,
    rect.height,
    false
  );
  const leftCss = left + 'px';
  const topCss = top + 'px';
  popup.style.setProperty(leftVar, leftCss, 'important');
  popup.style.setProperty(topVar, topCss, 'important');
  if (storageKey) {
    localStorage.setItem(storageKey, JSON.stringify({ x: leftCss, y: topCss }));
  }
}

function reclampPopupFromCurrentRect(popup, topVar, leftVar, storageKey) {
  if (!popup || !popup.isConnected) return;
  const rect = popup.getBoundingClientRect();
  applyPopupPositionClamped(popup, rect.left, rect.top, topVar, leftVar, storageKey);
}

function reclampAllVisiblePopups() {
  const mainContainer = document.getElementById(ID_YOMUP_POPUP_CONTAINER);
  if (mainContainer && mainContainer.shadowRoot) {
    const mainPopup = mainContainer.shadowRoot.querySelector('.' + CLASS_YOMUP_POPUP);
    if (mainPopup) {
      reclampPopupFromCurrentRect(
        mainPopup,
        '--YomuP-popup-top',
        '--YomuP-popup-left',
        LOCALSTRG_YOMUP_XYPOS
      );
    }
  }

  const subContainer = document.getElementById(ID_SUBPOPUP_CONTAINER);
  if (subContainer && subContainer.shadowRoot) {
    const subPopup = subContainer.shadowRoot.querySelector('.' + CLASS_SUBPOPUP);
    if (subPopup) {
      reclampPopupFromCurrentRect(
        subPopup,
        '--subpopup-top',
        '--subpopup-left',
        LOCALSTRG_YOMUPSUB_XYPOS
      );
    }
  }
}

function handlePopupViewportResize() {
  if (isDragging) return;

  if (popupViewportResizeDebounceTimer) {
    clearTimeout(popupViewportResizeDebounceTimer);
  }
  popupViewportResizeDebounceTimer = setTimeout(() => {
    popupViewportResizeDebounceTimer = null;
    reclampAllVisiblePopups();
  }, POPUP_VIEWPORT_RESIZE_DEBOUNCE_MS);
}

// === localStorage からポップアップ位置を復元（画面外は全面内に補正） =========
function restorePopupPosition(popup, storageKey, topVar, leftVar, errorMessage) {
  const savedPosition = localStorage.getItem(storageKey);
  if (!savedPosition) return;

  try {
    const parsed = JSON.parse(savedPosition);
    const leftPx = parsePopupPositionPx(parsed?.x);
    const topPx = parsePopupPositionPx(parsed?.y);
    if (leftPx === null || topPx === null) return;

    requestAnimationFrame(() => {
      if (!popup.isConnected) return;
      applyPopupPositionClamped(popup, leftPx, topPx, topVar, leftVar, storageKey);
    });
  } catch (error) {
    debugError(errorMessage, error);
    localStorage.removeItem(storageKey);
  }
}

// === ポップアップをマウスでドラッグ ==========================================
function addDragFunctionality(popup) {

  popup.addEventListener('mousedown', function (e) {
    // select要素やその他の操作可能な要素をクリックした場合はドラッグを開始しない
    if (e.target.tagName === 'SELECT' || 
        e.target.tagName === 'INPUT' || 
        e.target.tagName === 'BUTTON' ||
        e.target.closest('select') ||
        e.target.closest('input') ||
        e.target.closest('button')) {
      return; // ドラッグを開始しない
    }

    isDragging = true;
    currentDraggingPopup = popup; // 現在のポップアップを設定
    startX = e.clientX;
    startY = e.clientY;

    const rect = popup.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;

    e.preventDefault();
  });

} //end addDragFunctionality


// === ポップアップWクリック時に非表示 =========================================
function addClickToCloseFunctionality(popup) {
  popup.addEventListener('dblclick', function (e) {
    e.preventDefault();
    hideYomuPPopup();
  });
}

function addSubPopupDblClickToClose(subpopup) {
  subpopup.addEventListener('dblclick', function (e) {
    e.preventDefault();
    e.stopPropagation();
    closeSubPopupFromUi();
  });
}

// === processedElementCacheをクリアする関数 =================================
function clearProcessedElementCache() {
  processedElementCache.clear();
}



//////////////////////////////////////////////////////////////////////////////
// イベントリスナー定義
//////////////////////////////////////////////////////////////////////////////

// === ページ離脱前に状態を保存（リロード時に再表示のため） ===================
window.addEventListener('beforeunload', function () {
  const popupMain = document.getElementById(ID_YOMUP_POPUP_CONTAINER);
  if (popupMain) {
    localStorage.setItem(LOCALSTRG_YOMUP_REDISP, 'true');
    
    // ページ遷移判定用のフラグをsessionStorageに設定
    sessionStorage.setItem(SESSIONSTRG_PAGE_TRANSITION, 'true');
    
    // ストップウォッチの状態を保存（cleanupAllListeners()でタイマーがクリアされる前に保存）
    const stopwatchState = {
      isRunning: stopwatchTimerID !== null,
      seconds: stopwatchSeconds,
      limitMinutes: stopwatchLimitMinutes,
      loopCount: stopwatchLoopCount,
      isVisible: stopwatchOnOff
    };
    localStorage.setItem(LOCALSTRG_STOPWATCH_STATE, JSON.stringify(stopwatchState));
  }
  // キャッシュをクリア
  clearProcessedElementCache();
  // 全リスナーとタイマーをクリーンアップ
  cleanupAllListeners();
});

// === ページ遷移時にキャッシュをクリア（より確実） =========================
window.addEventListener('pagehide', function () {
  clearProcessedElementCache();
  // 全リスナーとタイマーをクリーンアップ
  cleanupAllListeners();
});

// === ポップアップドラッグ機能 =================================================
// 名前付き関数に変更（削除可能にするため）
function handleDragMouseMove(e) {
  if (!isDragging || !currentDraggingPopup) return;

  const popup = currentDraggingPopup;

  // ポップアップ種別を判定
  const isYomuP = popup.classList.contains(CLASS_YOMUP_POPUP);

  // CSS変数名を動的に決定
  const topVar = isYomuP ? '--YomuP-popup-top' : '--subpopup-top';
  const leftVar = isYomuP ? '--YomuP-popup-left' : '--subpopup-left';

  // 移動量を計算
  const deltaX = e.clientX - startX;
  const deltaY = e.clientY - startY;

  const rect = popup.getBoundingClientRect();
  const { left, top } = clampPopupViewportPosition(
    startLeft + deltaX,
    startTop + deltaY,
    rect.width,
    rect.height,
    true
  );
  const leftCss = left + 'px';
  const topCss = top + 'px';

  popup.style.setProperty(leftVar, leftCss, 'important');
  popup.style.setProperty(topVar, topCss, 'important');

  const popupId = isYomuP ? LOCALSTRG_YOMUP_XYPOS : LOCALSTRG_YOMUPSUB_XYPOS;
  localStorage.setItem(popupId, JSON.stringify({ x: leftCss, y: topCss }));
}

// 名前付き関数に変更（削除可能にするため）
function handleDragMouseUp() {
  // ドラッグ終了フラグを設定
  isDragging = false;
  currentDraggingPopup = null;
}

// リスナーを追加
document.addEventListener('mousemove', handleDragMouseMove);
document.addEventListener('mouseup', handleDragMouseUp);
window.addEventListener('resize', handlePopupViewportResize, { passive: true });



// === 全イベントリスナーを削除するクリーンアップ関数 ===========================
function cleanupAllListeners() {
  try {
    // ハイライト用リスナーを削除
    detachHighlightListeners();

    // ドラッグ用リスナーを削除
    document.removeEventListener('mousemove', handleDragMouseMove);
    document.removeEventListener('mouseup', handleDragMouseUp);
    window.removeEventListener('resize', handlePopupViewportResize);

    // タイマーをクリア
    if (mouseTimeoutForHighlight) {
      clearTimeout(mouseTimeoutForHighlight);
      mouseTimeoutForHighlight = null;
    }
    if (stopwatchTimerID) {
      clearInterval(stopwatchTimerID);
      stopwatchTimerID = null;
    }
    if (countDownIntervalForSub) {
      clearInterval(countDownIntervalForSub);
      countDownIntervalForSub = null;
    }
    clearHighlightProgressCountdown();
    resetHighlightProgressSession();
    if (popupViewportResizeDebounceTimer) {
      clearTimeout(popupViewportResizeDebounceTimer);
      popupViewportResizeDebounceTimer = null;
    }

    // タイマー変数をリセット
    stopwatchSeconds = 0;
    countDownTimerForSub = 0;

    // フラグをリセット
    isDragging = false;
    currentDraggingPopup = null;

    debugLog('全イベントリスナーとタイマーをクリーンアップしました');
  } catch (error) {
    debugError('クリーンアップ処理中にエラーが発生:', error);
  }
}



// === ハイライト用イベントリスナーの管理 =================================
function attachHighlightListeners() {
  if (highlightListenersAttached) return;
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseout', handleMouseOut);
  document.addEventListener('click', handleProgressPauseClick, true);
  document.addEventListener('scroll', handleHighlightViewportChange, { capture: true, passive: true });
  window.addEventListener('resize', handleHighlightViewportChange, { passive: true });
  highlightListenersAttached = true;
}

function detachHighlightListeners() {
  if (!highlightListenersAttached) return;
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseout', handleMouseOut);
  document.removeEventListener('click', handleProgressPauseClick, true);
  document.removeEventListener('scroll', handleHighlightViewportChange, { capture: true });
  window.removeEventListener('resize', handleHighlightViewportChange);
  highlightListenersAttached = false;
}


// === デバッグログ出力用のラッパー関数 =========================================
function debugLog(...args) {
  if (typeof ENABLE_DEBUG_LOG !== 'undefined' && ENABLE_DEBUG_LOG) {
    console.log(...args);
  }
}

function debugError(...args) {
  if (typeof ENABLE_DEBUG_LOG !== 'undefined' && ENABLE_DEBUG_LOG) {
    console.error(...args);
  }
}

