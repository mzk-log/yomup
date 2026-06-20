import { calculateReadingTime, getUnitLabel } from './highlight-core.js';

const PANEL_ID = 'yomup-pdf-timer-panel';
const POSITION_KEY = 'subPopupPosition';
const VISIBILITY_KEY = 'subPopupOnOff';

let countDownInterval = null;
let countDownRemaining = 0;
let activeTimerContext = null;
let panelEl = null;
let charCountEl = null;
let dragState = null;
let enabled = false;

function parsePopupPositionPx(cssValue) {
  if (typeof cssValue !== 'string') return null;
  const match = cssValue.trim().match(/^(-?\d+(?:\.\d+)?)px$/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function clampPanelPosition(leftPx, topPx, width, height) {
  const maxLeft = Math.max(0, window.innerWidth - width);
  const maxTop = Math.max(0, window.innerHeight - height);
  return {
    left: Math.min(Math.max(0, leftPx), maxLeft),
    top: Math.min(Math.max(0, topPx), maxTop)
  };
}

function applyPanelPosition(leftPx, topPx, persist) {
  if (!panelEl) return;
  const rect = panelEl.getBoundingClientRect();
  const { left, top } = clampPanelPosition(leftPx, topPx, rect.width, rect.height);
  const leftCss = `${left}px`;
  const topCss = `${top}px`;
  panelEl.style.setProperty('--subpopup-top', topCss);
  panelEl.style.setProperty('--subpopup-left', leftCss);
  if (persist) {
    localStorage.setItem(POSITION_KEY, JSON.stringify({ x: leftCss, y: topCss }));
  }
}

function restorePanelPosition() {
  const saved = localStorage.getItem(POSITION_KEY);
  if (!saved || !panelEl) return;
  try {
    const parsed = JSON.parse(saved);
    const leftPx = parsePopupPositionPx(parsed?.x);
    const topPx = parsePopupPositionPx(parsed?.y);
    if (leftPx === null || topPx === null) return;
    requestAnimationFrame(() => {
      if (panelEl?.isConnected) applyPanelPosition(leftPx, topPx, false);
    });
  } catch (_e) {
    // ignore
  }
}

function onDragMove(event) {
  if (!dragState || !panelEl) return;
  const deltaX = event.clientX - dragState.startX;
  const deltaY = event.clientY - dragState.startY;
  applyPanelPosition(dragState.startLeft + deltaX, dragState.startTop + deltaY, true);
}

function onDragEnd() {
  dragState = null;
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
}

function attachDragHandlers() {
  if (!panelEl || panelEl.dataset.dragBound === '1') return;
  panelEl.dataset.dragBound = '1';
  panelEl.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    const rect = panelEl.getBoundingClientRect();
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top
    };
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    event.preventDefault();
  });
}

function updateCharCountDisplay(unitCount, readTime, unitLabel) {
  if (!charCountEl) return;
  charCountEl.textContent = `${unitCount}${unitLabel}⇒［${countDownRemaining}／${readTime}秒］`;
  charCountEl.style.display = 'block';
}

function loadVisibilityFromStorage() {
  const saved = localStorage.getItem(VISIBILITY_KEY);
  if (saved === 'true') return true;
  if (saved === 'false') return false;
  return false;
}

function updateToolbarToggleUi() {
  const btn = document.getElementById('yomup-pdf-timer-toggle');
  if (!btn) return;
  btn.classList.toggle('is-on', enabled);
  btn.setAttribute('aria-pressed', String(enabled));
  btn.title = enabled
    ? '部分タイマー ON（クリックで OFF）'
    : '部分タイマー OFF（クリックで ON）';
}

function buildPanelIfNeeded() {
  if (panelEl?.isConnected) return;

  panelEl = document.createElement('div');
  panelEl.id = PANEL_ID;
  panelEl.className = 'yomup-pdf-timer-panel';

  const title = document.createElement('div');
  title.className = 'yomup-pdf-timer-title';
  title.textContent = 'ハイライト部分タイマー';

  charCountEl = document.createElement('div');
  charCountEl.className = 'yomup-pdf-timer-count';
  charCountEl.style.display = 'none';

  panelEl.appendChild(title);
  panelEl.appendChild(charCountEl);
  document.body.appendChild(panelEl);

  attachDragHandlers();
  restorePanelPosition();

  window.addEventListener('resize', () => {
    if (!panelEl) return;
    const rect = panelEl.getBoundingClientRect();
    applyPanelPosition(rect.left, rect.top, true);
  }, { passive: true });
}

export function setTimerPanelVisible(nextVisible) {
  buildPanelIfNeeded();
  enabled = nextVisible;
  panelEl.hidden = !enabled;
  localStorage.setItem(VISIBILITY_KEY, enabled.toString());
  if (!enabled) clearHighlightTimer();
  updateToolbarToggleUi();
}

export function toggleTimerPanel() {
  setTimerPanelVisible(!enabled);
}

export function initTimerPanel() {
  buildPanelIfNeeded();
  enabled = loadVisibilityFromStorage();
  panelEl.hidden = !enabled;
  updateToolbarToggleUi();
}

export function bindTimerToolbarToggle() {
  const btn = document.getElementById('yomup-pdf-timer-toggle');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', toggleTimerPanel);
}

export function startHighlightTimer(unitCount, languageMode) {
  const unitLabel = getUnitLabel(languageMode);
  const readTime = calculateReadingTime(unitCount, languageMode);
  countDownRemaining = readTime;
  activeTimerContext = { unitCount, readTime, unitLabel };

  if (enabled) {
    buildPanelIfNeeded();
    updateCharCountDisplay(unitCount, readTime, unitLabel);
  }

  startHighlightTimerInterval();
}

function startHighlightTimerInterval() {
  if (!activeTimerContext) return;
  const { unitCount, readTime, unitLabel } = activeTimerContext;
  if (countDownRemaining <= 0) return;

  if (countDownInterval) {
    clearInterval(countDownInterval);
    countDownInterval = null;
  }

  countDownInterval = setInterval(() => {
    countDownRemaining -= 1;
    if (enabled) {
      updateCharCountDisplay(unitCount, readTime, unitLabel);
    }
    if (countDownRemaining <= 0 && countDownInterval) {
      clearInterval(countDownInterval);
      countDownInterval = null;
      activeTimerContext = null;
    }
  }, 1000);
}

export function pauseHighlightTimer() {
  if (countDownInterval) {
    clearInterval(countDownInterval);
    countDownInterval = null;
  }
}

export function resumeHighlightTimer() {
  startHighlightTimerInterval();
}

export function getCountDownRemaining() {
  return countDownRemaining;
}

export function clearHighlightTimer() {
  if (countDownInterval) {
    clearInterval(countDownInterval);
    countDownInterval = null;
  }
  countDownRemaining = 0;
  activeTimerContext = null;
  if (charCountEl) {
    charCountEl.style.display = 'none';
  }
}
