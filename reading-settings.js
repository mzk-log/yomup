// 読書速度・ハイライト下線モード（Web / PDF 共通）
// constants.js の直後に読み込む

const READING_SPEED_PRESET_VALUES = [150, 250, 500, 750, 1000];
const READING_SPEED_DEFAULT_CHARS_PER_MIN = 500;
const READING_SPEED_BASELINE_CHARS_PER_MIN = 500;
// 500字/分相当の英文基準（2026-07-31: 225→…→75→90・体感確定候補）
const READING_SPEED_BASELINE_WORDS_PER_MIN = 90;

const LOCALSTRG_READING_SPEED_CHARS = 'YomuP_readingSpeedCharsPerMin';
const LOCALSTRG_HIGHLIGHT_UNDERLINE_MODE = 'YomuP_highlightUnderlineMode';

const HIGHLIGHT_UNDERLINE_MODE_PROGRESS = 'progress';
const HIGHLIGHT_UNDERLINE_MODE_FULL = 'full';

function isReadingSpeedPreset(value) {
  return READING_SPEED_PRESET_VALUES.includes(Number(value));
}

function loadReadingSpeedCharsPerMin() {
  const saved = localStorage.getItem(LOCALSTRG_READING_SPEED_CHARS);
  const parsed = Number(saved);
  if (isReadingSpeedPreset(parsed)) return parsed;
  return READING_SPEED_DEFAULT_CHARS_PER_MIN;
}

function saveReadingSpeedCharsPerMin(charsPerMin) {
  if (!isReadingSpeedPreset(charsPerMin)) return;
  localStorage.setItem(LOCALSTRG_READING_SPEED_CHARS, String(charsPerMin));
}

function wordsPerMinFromCharsPerMin(charsPerMin) {
  return Math.round(
    READING_SPEED_BASELINE_WORDS_PER_MIN * (charsPerMin / READING_SPEED_BASELINE_CHARS_PER_MIN)
  );
}

function getReadingSpeedForLanguage(languageMode) {
  const charsPerMin = loadReadingSpeedCharsPerMin();
  if (languageMode === 'en') {
    return wordsPerMinFromCharsPerMin(charsPerMin);
  }
  return charsPerMin;
}

function formatReadingSpeedOptionLabel(languageMode, charsPerMin) {
  if (typeof formatUiReadingSpeedOptionLabel === 'function') {
    return formatUiReadingSpeedOptionLabel(languageMode, charsPerMin);
  }
  if (languageMode === 'en') {
    return `${wordsPerMinFromCharsPerMin(charsPerMin)}語/分`;
  }
  return `${charsPerMin}字/分`;
}

function loadHighlightUnderlineMode() {
  const saved = localStorage.getItem(LOCALSTRG_HIGHLIGHT_UNDERLINE_MODE);
  if (saved === HIGHLIGHT_UNDERLINE_MODE_FULL) return HIGHLIGHT_UNDERLINE_MODE_FULL;
  return HIGHLIGHT_UNDERLINE_MODE_PROGRESS;
}

function saveHighlightUnderlineMode(mode) {
  if (mode !== HIGHLIGHT_UNDERLINE_MODE_FULL && mode !== HIGHLIGHT_UNDERLINE_MODE_PROGRESS) {
    return;
  }
  localStorage.setItem(LOCALSTRG_HIGHLIGHT_UNDERLINE_MODE, mode);
}

function isHighlightUnderlineProgressMode() {
  return loadHighlightUnderlineMode() === HIGHLIGHT_UNDERLINE_MODE_PROGRESS;
}

function calculateReadingTimeWithSettings(unitCount, languageMode) {
  const speed = getReadingSpeedForLanguage(languageMode);
  if (!speed || speed <= 0) return 0;
  return Math.round(unitCount * (60 / speed));
}

function populateReadingSpeedSelect(selectEl, languageMode, selectedCharsPerMin) {
  if (!selectEl) return;
  selectEl.textContent = '';
  for (let i = 0; i < READING_SPEED_PRESET_VALUES.length; i++) {
    const value = READING_SPEED_PRESET_VALUES[i];
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = formatReadingSpeedOptionLabel(languageMode, value);
    selectEl.appendChild(option);
  }
  selectEl.value = String(selectedCharsPerMin);
}

const HIGHLIGHT_MODE_TOGGLE_LABEL = 'ライン進行';

function getHighlightModeToggleUiLabel() {
  if (typeof getHighlightModeToggleLabel === 'function') {
    return getHighlightModeToggleLabel();
  }
  return HIGHLIGHT_MODE_TOGGLE_LABEL;
}

function bindReadingModeToggleButton(toggleBtn, onChange) {
  if (!toggleBtn) return;

  function syncActive() {
    const isProgress = isHighlightUnderlineProgressMode();
    toggleBtn.classList.toggle('active', isProgress);
    toggleBtn.setAttribute('aria-pressed', String(isProgress));
    toggleBtn.setAttribute('aria-label', getHighlightModeToggleUiLabel());
    const tooltip = toggleBtn.querySelector('.tooltip');
    if (tooltip) {
      tooltip.textContent = getHighlightModeToggleUiLabel();
      toggleBtn.removeAttribute('title');
    } else {
      toggleBtn.title = getHighlightModeToggleUiLabel();
    }
  }

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    saveHighlightUnderlineMode(
      isHighlightUnderlineProgressMode()
        ? HIGHLIGHT_UNDERLINE_MODE_FULL
        : HIGHLIGHT_UNDERLINE_MODE_PROGRESS
    );
    syncActive();
    if (onChange) onChange();
  });

  syncActive();
}

if (typeof window !== 'undefined') {
  window.READING_SPEED_PRESET_VALUES = READING_SPEED_PRESET_VALUES;
  window.READING_SPEED_DEFAULT_CHARS_PER_MIN = READING_SPEED_DEFAULT_CHARS_PER_MIN;
  window.HIGHLIGHT_UNDERLINE_MODE_PROGRESS = HIGHLIGHT_UNDERLINE_MODE_PROGRESS;
  window.HIGHLIGHT_UNDERLINE_MODE_FULL = HIGHLIGHT_UNDERLINE_MODE_FULL;
  window.loadReadingSpeedCharsPerMin = loadReadingSpeedCharsPerMin;
  window.saveReadingSpeedCharsPerMin = saveReadingSpeedCharsPerMin;
  window.wordsPerMinFromCharsPerMin = wordsPerMinFromCharsPerMin;
  window.getReadingSpeedForLanguage = getReadingSpeedForLanguage;
  window.formatReadingSpeedOptionLabel = formatReadingSpeedOptionLabel;
  window.loadHighlightUnderlineMode = loadHighlightUnderlineMode;
  window.saveHighlightUnderlineMode = saveHighlightUnderlineMode;
  window.isHighlightUnderlineProgressMode = isHighlightUnderlineProgressMode;
  window.calculateReadingTimeWithSettings = calculateReadingTimeWithSettings;
  window.populateReadingSpeedSelect = populateReadingSpeedSelect;
  window.getHighlightModeToggleUiLabel = getHighlightModeToggleUiLabel;
  window.bindReadingModeToggleButton = bindReadingModeToggleButton;
}
