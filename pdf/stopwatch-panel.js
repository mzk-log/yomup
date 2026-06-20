const PANEL_ID = 'yomup-pdf-stopwatch-panel';
const POSITION_KEY = 'stopwatchPanelPosition';
const VISIBILITY_KEY = 'stopwatchPanelOnOff';

const IMG = {
  play: chrome.runtime.getURL('images/GC01_play-solid-full.svg'),
  pause: chrome.runtime.getURL('images/GC02_pause-solid-full.svg'),
  stop: chrome.runtime.getURL('images/GC03_stop-solid-full.svg')
};

let panelEl = null;
let timeEl = null;
let loopCountEl = null;
let limitSelectEl = null;
let controlsEl = null;
let playBtn = null;
let pauseBtn = null;
let stopBtn = null;
let dragState = null;

let timerId = null;
let seconds = 0;
let limitMinutes = null;
let loopCount = 0;
let visible = false;

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
  panelEl.style.setProperty('--stopwatch-top', topCss);
  panelEl.style.setProperty('--stopwatch-left', leftCss);
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
    if (event.target.closest('button, select, img, option')) return;
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

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function updateTimeDisplay() {
  if (timeEl) timeEl.textContent = formatTime(seconds);
}

function resetControlsToPlayStop() {
  if (!controlsEl || !playBtn || !pauseBtn || !stopBtn) return;
  controlsEl.replaceChildren(playBtn, stopBtn);
}

function resetStopwatchState() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
  seconds = 0;
  loopCount = 0;
  updateTimeDisplay();
  if (loopCountEl) loopCountEl.textContent = formatUiLoopCount(0);
  resetControlsToPlayStop();
}

function tickStopwatch() {
  seconds += 1;
  if (limitMinutes !== null) {
    const limitSeconds = limitMinutes * 60;
    if (seconds >= limitSeconds) {
      seconds = 0;
      loopCount += 1;
      if (loopCountEl) loopCountEl.textContent = formatUiLoopCount(loopCount);
    }
  }
  updateTimeDisplay();
}

function showControlsRunning() {
  if (!controlsEl || !pauseBtn || !stopBtn) return;
  controlsEl.replaceChildren(pauseBtn, stopBtn);
}

function onPlayClick(event) {
  event.stopPropagation();
  if (timerId) return;
  timerId = setInterval(tickStopwatch, 1000);
  showControlsRunning();
}

function onPauseClick(event) {
  event.stopPropagation();
  if (!timerId) return;
  clearInterval(timerId);
  timerId = null;
  resetControlsToPlayStop();
}

function onStopClick(event) {
  event.stopPropagation();
  resetStopwatchState();
}

function onLimitChange(event) {
  event.stopPropagation();
  resetStopwatchState();
  const selected = limitSelectEl?.value ?? '-';
  if (selected === '-') {
    limitMinutes = null;
    loopCountEl?.classList.remove('visible');
  } else {
    limitMinutes = parseInt(selected, 10);
    loopCountEl?.classList.add('visible');
  }
}

function createControlButton(className, alt, src) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.innerHTML = `<img src="${src}" width="12" height="12" alt="${alt}">`;
  return btn;
}

function buildPanel() {
  panelEl = document.createElement('div');
  panelEl.id = PANEL_ID;
  panelEl.className = 'yomup-pdf-stopwatch-panel';
  panelEl.hidden = true;

  const title = document.createElement('div');
  title.className = 'yomup-pdf-stopwatch-title';
  title.textContent = t('stopwatchTooltip');

  const row = document.createElement('div');
  row.className = 'yomup-pdf-stopwatch-row';

  timeEl = document.createElement('div');
  timeEl.className = 'yomup-pdf-stopwatch-time';
  timeEl.textContent = '00:00';

  const limitWrap = document.createElement('div');
  limitWrap.className = 'yomup-pdf-stopwatch-limit-wrap';
  limitSelectEl = document.createElement('select');
  limitSelectEl.className = 'yomup-pdf-stopwatch-limit';
  limitSelectEl.title = t('intervalMinutesTooltip');
  limitSelectEl.innerHTML = buildStopwatchIntervalOptionsHtml();
  limitSelectEl.value = '-';
  limitSelectEl.addEventListener('change', onLimitChange);
  limitSelectEl.addEventListener('mousedown', (e) => e.stopPropagation());
  limitWrap.appendChild(limitSelectEl);

  loopCountEl = document.createElement('div');
  loopCountEl.className = 'yomup-pdf-stopwatch-loop';
  loopCountEl.textContent = formatUiLoopCount(0);

  row.appendChild(timeEl);
  row.appendChild(limitWrap);
  row.appendChild(loopCountEl);

  controlsEl = document.createElement('div');
  controlsEl.className = 'yomup-pdf-stopwatch-controls';

  playBtn = createControlButton('yomup-pdf-stopwatch-ctrl', t('altPlay'), IMG.play);
  pauseBtn = createControlButton('yomup-pdf-stopwatch-ctrl', t('altPause'), IMG.pause);
  stopBtn = createControlButton('yomup-pdf-stopwatch-ctrl', t('altStop'), IMG.stop);
  playBtn.addEventListener('click', onPlayClick);
  pauseBtn.addEventListener('click', onPauseClick);
  stopBtn.addEventListener('click', onStopClick);
  controlsEl.appendChild(playBtn);
  controlsEl.appendChild(stopBtn);

  panelEl.appendChild(title);
  panelEl.appendChild(row);
  panelEl.appendChild(controlsEl);
  document.body.appendChild(panelEl);

  attachDragHandlers();
  restorePanelPosition();

  window.addEventListener('resize', () => {
    if (!panelEl) return;
    const rect = panelEl.getBoundingClientRect();
    applyPanelPosition(rect.left, rect.top, true);
  }, { passive: true });
}

function loadVisibilityFromStorage() {
  const saved = localStorage.getItem(VISIBILITY_KEY);
  if (saved === 'false') return false;
  if (saved === 'true') return true;
  return false;
}

function updateToolbarToggleUi() {
  const btn = document.getElementById('yomup-pdf-stopwatch-toggle');
  if (!btn) return;
  btn.classList.toggle('is-on', visible);
  btn.setAttribute('aria-pressed', String(visible));
  btn.title = visible
    ? t('stopwatchVisibleTitle')
    : t('stopwatchShowTitle');
}

export function setStopwatchPanelVisible(nextVisible) {
  if (!panelEl) buildPanel();
  visible = nextVisible;
  panelEl.hidden = !visible;
  localStorage.setItem(VISIBILITY_KEY, visible.toString());
  if (!visible) resetStopwatchState();
  updateToolbarToggleUi();
}

export function toggleStopwatchPanel() {
  setStopwatchPanelVisible(!visible);
}

export function initStopwatchPanel() {
  if (!panelEl) buildPanel();
  visible = loadVisibilityFromStorage();
  panelEl.hidden = !visible;
  updateToolbarToggleUi();
}

export function bindStopwatchToolbarToggle() {
  const btn = document.getElementById('yomup-pdf-stopwatch-toggle');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', toggleStopwatchPanel);
}
