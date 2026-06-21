// 読むプ コントロール窓 UI 文言（§18）
// constants.js の直後に読み込む（LOCALSTRG_UI_LOCALE_OVERRIDE は constants で定義）

const UI_STRINGS = {
  ja: {
    totalLabel: '全体：',
    selectionLabel: '選択：',
    selectionEmpty: '選択範囲がありません',
    selectionRange: '{start} ～ {end}',
    speedLabel: '速度',
    readingSpeedTooltip: '読書速度',
    lineProgress: 'ライン進行',
    timeSeconds: '{n}秒',
    timeMinutes: '{n}分',
    timeMinutesSeconds: '{m}分{s}秒',
    appNameTooltip: '読むプ<br>Version<br>{version}',
    countSelectionTooltip: '選択範囲の<br>文字数を<br>カウント',
    highlightTooltip: 'ハイライト実施',
    stopwatchTooltip: 'ストップウォッチ',
    partialTimerTooltip: 'ハイライト部分タイマー',
    reloadTooltip: 'ページの<br>再読み込み',
    altIcon: 'アイコン',
    altCharCount: '文字カウント',
    altLightbulb: '電球',
    altStopwatch: 'ストップウォッチ',
    altHourglass: '砂時計',
    altReload: 'リロード',
    altPlay: '再生',
    altPause: '一時停止',
    altStop: '停止',
    intervalMinutesTooltip: 'インターバル時間(分)',
    loopCount: '{n}回',
    intervalOption: '{n}分',
    partialTimerTitle: 'ハイライト部分タイマー',
    partialTimerDisplay: '{units}{unitLabel}⇒［{remaining}／{total}秒］',
    speedCharsPerMin: '{n}字/分',
    speedWordsPerMin: '{n}語/分',
    pdfTitle: '読むプ PDF',
    pdfPageTitle: '読むプ — PDF',
    highlightBtn: 'ハイライト',
    partialTimerBtn: '部分タイマー',
    stopwatchBtn: 'ストップウォッチ',
    highlightOnTitle: 'ハイライト ON（クリックで OFF）',
    highlightOffTitle: 'ハイライト OFF（クリックで ON・テキスト選択向け）',
    partialTimerOnTitle: '部分タイマー ON（クリックで OFF）',
    partialTimerOffTitle: '部分タイマー OFF（クリックで ON）',
    stopwatchShowTitle: 'ストップウォッチ（クリックで表示）',
    stopwatchVisibleTitle: 'ストップウォッチ表示中（クリックで非表示）',
    loading: '読み込み中…',
    loadFailed: '読み込み失敗',
    highlightOnStatus: 'ハイライト ON',
    highlightOffStatus: 'ハイライト OFF',
    loadingWithFile: '読み込み中… ({file})',
    loadingLocalPdf: 'ローカル PDF を読み込み中…',
    fetchingPdf: 'PDF を取得中…',
    pageProgress: '{current} / {total} ページ',
    documentStatus: '{pages} ページ — {file}',
    statusWithHighlight: '{status}（{mode}）',
    donationLinkText: 'Ko-fiで応援する（任意）',
    donationLinkTitle: '応援（寄付）は任意です。<br>応援の有無で機能は変わりません。<br>クリックで外部の寄付サイト（Ko-fi）が開きます。'
  },
  en: {
    totalLabel: 'Total: ',
    selectionLabel: 'Selection: ',
    selectionEmpty: 'No selection',
    selectionRange: '{start} – {end}',
    speedLabel: 'Speed',
    readingSpeedTooltip: 'Reading speed',
    lineProgress: 'Line progress',
    timeSeconds: '{n}s',
    timeMinutes: '{n}m',
    timeMinutesSeconds: '{m}m{s}s',
    appNameTooltip: 'YomuP<br>Version<br>{version}',
    countSelectionTooltip: 'Count chars<br>in selection',
    highlightTooltip: 'Highlight',
    stopwatchTooltip: 'Stopwatch',
    partialTimerTooltip: 'Highlight partial timer',
    reloadTooltip: 'Reload<br>page',
    altIcon: 'Icon',
    altCharCount: 'Character count',
    altLightbulb: 'Highlight',
    altStopwatch: 'Stopwatch',
    altHourglass: 'Hourglass',
    altReload: 'Reload',
    altPlay: 'Play',
    altPause: 'Pause',
    altStop: 'Stop',
    intervalMinutesTooltip: 'Interval (m)',
    loopCount: '{n} loops',
    intervalOption: '{n} m',
    partialTimerTitle: 'Highlight partial timer',
    partialTimerDisplay: '{units} {unitLabel} ⇒ [{remaining}/{total} s]',
    speedCharsPerMin: '{n} chars/m',
    speedWordsPerMin: '{n} words/m',
    pdfTitle: 'YomuP PDF',
    pdfPageTitle: 'YomuP — PDF',
    highlightBtn: 'Highlight',
    partialTimerBtn: 'Partial timer',
    stopwatchBtn: 'Stopwatch',
    highlightOnTitle: 'Highlight ON (click for OFF)',
    highlightOffTitle: 'Highlight OFF (click for ON)',
    partialTimerOnTitle: 'Partial timer ON (click for OFF)',
    partialTimerOffTitle: 'Partial timer OFF (click for ON)',
    stopwatchShowTitle: 'Stopwatch (click to show)',
    stopwatchVisibleTitle: 'Stopwatch visible (click to hide)',
    loading: 'Loading…',
    loadFailed: 'Load failed',
    highlightOnStatus: 'Highlight ON',
    highlightOffStatus: 'Highlight OFF',
    loadingWithFile: 'Loading… ({file})',
    loadingLocalPdf: 'Loading local PDF…',
    fetchingPdf: 'Fetching PDF…',
    pageProgress: '{current} / {total} pages',
    documentStatus: '{pages} pages — {file}',
    statusWithHighlight: '{status} ({mode})',
    donationLinkText: 'Support on Ko-fi (optional)',
    donationLinkTitle: 'Support (donation) is optional.<br>Features are unchanged whether you support or not.<br>Opens an external donation site (Ko-fi) in a new tab.'
  }
};

function getYomupUiLocale() {
  if (typeof ENABLE_UI_LOCALE_OVERRIDE !== 'undefined' && ENABLE_UI_LOCALE_OVERRIDE) {
    try {
      const override = localStorage.getItem(LOCALSTRG_UI_LOCALE_OVERRIDE);
      if (override === 'en' || override === 'ja') return override;
    } catch (_e) {
      // ignore
    }
  }
  try {
    const uiLang = chrome.i18n.getUILanguage() || 'ja';
    const primary = uiLang.trim().toLowerCase().split(/[-_]/)[0];
    return primary === 'ja' ? 'ja' : 'en';
  } catch (_e) {
    return 'ja';
  }
}

function t(key, params = {}) {
  const locale = getYomupUiLocale();
  const table = UI_STRINGS[locale] || UI_STRINGS.ja;
  let text = table[key] ?? UI_STRINGS.ja[key] ?? key;
  for (const [name, value] of Object.entries(params)) {
    text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
  }
  return text;
}

function formatUiReadingTime(seconds) {
  const n = Number(seconds) || 0;
  if (n < 60) return t('timeSeconds', { n });
  const minutes = Math.floor(n / 60);
  const remainingSeconds = n % 60;
  if (minutes >= 60) return t('timeMinutes', { n: minutes });
  if (remainingSeconds === 0) return t('timeMinutes', { n: minutes });
  return t('timeMinutesSeconds', { m: minutes, s: remainingSeconds });
}

function formatUiUnitLabel(unitLabelOrPageMode) {
  const isWordUnit = unitLabelOrPageMode === '語' || unitLabelOrPageMode === 'en';
  if (getYomupUiLocale() === 'en') {
    return isWordUnit ? ' words' : ' chars';
  }
  return isWordUnit ? '語' : '字';
}

function formatUiTotalLine(unitCount, unitLabel, readingTimeSeconds) {
  const displayUnit = formatUiUnitLabel(unitLabel);
  if (getYomupUiLocale() === 'en') {
    return `${t('totalLabel')}${unitCount}${displayUnit} · ${formatUiReadingTime(readingTimeSeconds)}`;
  }
  return `${t('totalLabel')}${unitCount}${displayUnit}　${formatUiReadingTime(readingTimeSeconds)}`;
}

function formatUiSelectionLine(startText, endText) {
  return `${t('selectionLabel')}${t('selectionRange', { start: startText, end: endText })}`;
}

function formatUiSelectionEmpty() {
  return `${t('selectionLabel')}${t('selectionEmpty')}`;
}

function formatUiSelectionStats(unitCount, unitLabel, readingTimeSeconds) {
  const displayUnit = formatUiUnitLabel(unitLabel).trim();
  const gap = getYomupUiLocale() === 'en' ? ' ' : '';
  return `${unitCount}${gap}${displayUnit} ${formatUiReadingTime(readingTimeSeconds)}`;
}

function formatUiLoopCount(count) {
  return t('loopCount', { n: count });
}

function formatUiIntervalOption(minutes) {
  return t('intervalOption', { n: minutes });
}

function formatUiPartialTimerDisplay(units, unitLabel, remaining, total) {
  const displayUnit = formatUiUnitLabel(unitLabel).trim();
  return t('partialTimerDisplay', {
    units,
    unitLabel: displayUnit,
    remaining,
    total
  });
}

function formatUiReadingSpeedOptionLabel(pageLanguageMode, charsPerMin) {
  const n = Number(charsPerMin);
  if (pageLanguageMode === 'en') {
    const wordsPerMin = typeof wordsPerMinFromCharsPerMin === 'function'
      ? wordsPerMinFromCharsPerMin(n)
      : n;
    return t('speedWordsPerMin', { n: wordsPerMin });
  }
  return t('speedCharsPerMin', { n });
}

function getHighlightModeToggleLabel() {
  return t('lineProgress');
}

function buildStopwatchIntervalOptionsHtml() {
  const values = [1, 3, 5, 10, 15];
  let html = '<option value="-">-</option>';
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    html += `<option value="${value}">${formatUiIntervalOption(value)}</option>`;
  }
  return html;
}

function applyPdfToolbarStaticUi() {
  const titleEl = document.getElementById('yomup-pdf-title');
  if (titleEl) titleEl.textContent = t('pdfTitle');

  const selectionEl = document.getElementById('yomup-pdf-selection-info');
  if (selectionEl) selectionEl.textContent = formatUiSelectionEmpty();

  const highlightBtn = document.getElementById('yomup-pdf-highlight-toggle');
  if (highlightBtn) highlightBtn.textContent = t('highlightBtn');

  const timerBtn = document.getElementById('yomup-pdf-timer-toggle');
  if (timerBtn) timerBtn.textContent = t('partialTimerBtn');

  const stopwatchBtn = document.getElementById('yomup-pdf-stopwatch-toggle');
  if (stopwatchBtn) stopwatchBtn.textContent = t('stopwatchBtn');

  const speedLabel = document.querySelector('.yomup-pdf-reading-speed-label');
  if (speedLabel) speedLabel.textContent = t('speedLabel');

  const speedSelect = document.getElementById('yomup-pdf-reading-speed');
  if (speedSelect) speedSelect.title = t('readingSpeedTooltip');

  const modeBtn = document.getElementById('yomup-pdf-mode-progress');
  if (modeBtn) modeBtn.setAttribute('aria-label', t('lineProgress'));

  const statusEl = document.getElementById('yomup-pdf-status');
  if (statusEl && !statusEl.textContent) statusEl.textContent = t('loading');

  if (document.title) document.title = t('pdfPageTitle');
}

const YomupUi = {
  getYomupUiLocale,
  t,
  formatUiReadingTime,
  formatUiUnitLabel,
  formatUiTotalLine,
  formatUiSelectionLine,
  formatUiSelectionEmpty,
  formatUiSelectionStats,
  formatUiLoopCount,
  formatUiIntervalOption,
  formatUiPartialTimerDisplay,
  formatUiReadingSpeedOptionLabel,
  getHighlightModeToggleLabel,
  buildStopwatchIntervalOptionsHtml,
  applyPdfToolbarStaticUi
};

if (typeof window !== 'undefined') {
  window.getYomupUiLocale = getYomupUiLocale;
  window.t = t;
  window.formatUiReadingTime = formatUiReadingTime;
  window.formatUiTotalLine = formatUiTotalLine;
  window.formatUiSelectionLine = formatUiSelectionLine;
  window.formatUiSelectionEmpty = formatUiSelectionEmpty;
  window.formatUiSelectionStats = formatUiSelectionStats;
  window.formatUiLoopCount = formatUiLoopCount;
  window.formatUiIntervalOption = formatUiIntervalOption;
  window.formatUiPartialTimerDisplay = formatUiPartialTimerDisplay;
  window.formatUiReadingSpeedOptionLabel = formatUiReadingSpeedOptionLabel;
  window.getHighlightModeToggleLabel = getHighlightModeToggleLabel;
  window.buildStopwatchIntervalOptionsHtml = buildStopwatchIntervalOptionsHtml;
  window.applyPdfToolbarStaticUi = applyPdfToolbarStaticUi;
  window.YomupUi = YomupUi;
}
