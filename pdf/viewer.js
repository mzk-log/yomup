import * as pdfjsLib from '../vendor/pdf.mjs';
import {
  buildLogicalChunks,
  findChunkContainingOffset,
  detectLanguageMode,
  countUnits,
  calculateReadingTime,
  getUnitLabel,
  withinHighlightLimit,
  LANGUAGE_MODE_JA,
  LANGUAGE_MODE_EN
} from './highlight-core.js';
import { initTimerPanel, startHighlightTimer, clearHighlightTimer, bindTimerToolbarToggle } from './timer-panel.js';
import { initStopwatchPanel, bindStopwatchToolbarToggle } from './stopwatch-panel.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.mjs');

const PDFJS_CMAP_URL = chrome.runtime.getURL('vendor/cmaps/');
const PDFJS_STANDARD_FONT_URL = chrome.runtime.getURL('vendor/standard_fonts/');

function createPdfDocumentTask(pdfBytes) {
  return pdfjsLib.getDocument({
    data: toUint8Array(pdfBytes),
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_STANDARD_FONT_URL
  });
}

const HIGHLIGHT_DELAY_MS = 250;
const HIGHLIGHT_STORAGE_KEY = 'highLightOnOff';
const LINE_Y_TOLERANCE_PX = 5;
const COLUMN_GAP_MIN_PX = 40;
const RECT_MERGE_LINE_TOLERANCE_PX = 6;
const RECT_MERGE_GAP_TOLERANCE_PX = 12;

const statusEl = document.getElementById('yomup-pdf-status');
const messageEl = document.getElementById('yomup-pdf-message');
const pagesEl = document.getElementById('yomup-pdf-pages');

/** @type {Array<{ pageNum: number, pageWrap: HTMLElement, blockText: string, segments: object[], lines: object[] }>} */
const pageModels = [];
let highlightOverlayRoot = null;
let currentHighlightHitRects = null;
let mouseTimeoutForHighlight = null;
let lastHighlightClientX = 0;
let lastHighlightClientY = 0;
let defaultStatusText = '';
let highLightOnOff = false;
let highlightListenersAttached = false;
let highlightToggleInitialized = false;
let selectionStatsListenerInitialized = false;
let highlightProgressSession = null;
let highlightProgressCountdownInterval = null;

function loadHighlightModeFromStorage() {
  const saved = localStorage.getItem(HIGHLIGHT_STORAGE_KEY);
  if (saved === 'false') return false;
  if (saved === 'true') return true;
  return true;
}

function formatStatusWithHighlightMode() {
  const modeLabel = highLightOnOff ? 'ハイライト ON' : 'ハイライト OFF';
  return defaultStatusText ? `${defaultStatusText}（${modeLabel}）` : modeLabel;
}

function decodeFileNameFromUrl(sourceUrl) {
  try {
    const base = new URL(sourceUrl).pathname.split('/').filter(Boolean).pop() || '';
    if (!base) return sourceUrl;
    try {
      return decodeURIComponent(base);
    } catch (_e) {
      return base;
    }
  } catch (_e) {
    return sourceUrl;
  }
}

function applyStatusWithHighlightMode() {
  const text = formatStatusWithHighlightMode();
  setStatus(text, text);
}

function updateHighlightToggleUi() {
  const btn = document.getElementById('yomup-pdf-highlight-toggle');
  if (!btn) return;
  btn.classList.toggle('is-on', highLightOnOff);
  btn.setAttribute('aria-pressed', String(highLightOnOff));
  btn.title = highLightOnOff
    ? 'ハイライト ON（クリックで OFF）'
    : 'ハイライト OFF（クリックで ON・テキスト選択向け）';
}

function toggleHighlightMode() {
  highLightOnOff = !highLightOnOff;
  localStorage.setItem(HIGHLIGHT_STORAGE_KEY, highLightOnOff.toString());
  if (highLightOnOff) {
    attachHighlightListeners();
  } else {
    clearHighlightState();
    detachHighlightListeners();
  }
  updateHighlightToggleUi();
  applyStatusWithHighlightMode();
}

function initHighlightToggle() {
  const btn = document.getElementById('yomup-pdf-highlight-toggle');
  if (!btn) return;
  if (!highlightToggleInitialized) {
    btn.addEventListener('click', toggleHighlightMode);
    highlightToggleInitialized = true;
  }
  highLightOnOff = loadHighlightModeFromStorage();
  updateHighlightToggleUi();
  if (highLightOnOff) {
    attachHighlightListeners();
  }
}

function setStatus(text, title = text) {
  statusEl.textContent = text;
  statusEl.title = title || '';
}

function showError(message) {
  messageEl.textContent = message;
  messageEl.classList.remove('hidden');
  setStatus('読み込み失敗');
}

function hideError() {
  messageEl.classList.add('hidden');
  messageEl.textContent = '';
}

function formatReadingTime(seconds) {
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes >= 60) return `${minutes}分`;
  return `${minutes}分${remainingSeconds}秒`;
}

function collectDocumentText(models) {
  return models.map((m) => m.blockText).filter(Boolean).join('\n');
}

function updateDocumentStatsDisplay(models) {
  const el = document.getElementById('yomup-pdf-total-info');
  if (!el) return;
  const fullText = collectDocumentText(models).trim();
  if (!fullText) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const languageMode = detectLanguageMode(fullText);
  const unitCount = countUnits(fullText, languageMode);
  const readingTime = calculateReadingTime(unitCount, languageMode);
  const unitLabel = getUnitLabel(languageMode);
  el.textContent = `全体：${unitCount}${unitLabel} ${formatReadingTime(readingTime)}`;
  el.hidden = false;
}

function isNodeInTextLayer(node) {
  let el = node;
  if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  return !!(el && el.closest && el.closest('.textLayer'));
}

function getDocumentLanguageMode() {
  return detectLanguageMode(collectDocumentText(pageModels).trim());
}

function resolveSelectionLanguageMode(selectedText) {
  const modeFromSelection = detectLanguageMode(selectedText);
  if (modeFromSelection === LANGUAGE_MODE_EN) return LANGUAGE_MODE_EN;

  const docMode = getDocumentLanguageMode();
  if (docMode !== LANGUAGE_MODE_EN) return modeFromSelection;

  const sample = selectedText.trim();
  const cjk = (sample.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const letters = (sample.match(/[A-Za-z]/g) || []).length;
  const denom = cjk + letters;
  const cjkThreshold = window.CJK_RATIO_THRESHOLD ?? 0.15;
  if (denom > 0 && cjk / denom < cjkThreshold) {
    return LANGUAGE_MODE_EN;
  }
  return modeFromSelection;
}

function getPdfSelectionStats() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  if (!isNodeInTextLayer(selection.anchorNode) || !isNodeInTextLayer(selection.focusNode)) {
    return null;
  }

  const selectedText = selection.toString().trim();
  if (!selectedText) return null;

  const languageMode = resolveSelectionLanguageMode(selectedText);
  const unitCount = countUnits(selectedText, languageMode);
  const readingTime = calculateReadingTime(unitCount, languageMode);
  return {
    selectedText,
    unitCount,
    readingTime,
    unitLabel: getUnitLabel(languageMode)
  };
}

function updateSelectionStatsDisplay() {
  const el = document.getElementById('yomup-pdf-selection-info');
  if (!el) return;

  el.replaceChildren('');
  const stats = getPdfSelectionStats();
  if (!stats) {
    el.textContent = '選択：選択範囲がありません';
    el.title = '';
    return;
  }

  const startText = stats.selectedText.substring(0, 3);
  const endText = stats.selectedText.substring(stats.selectedText.length - 3);
  const line1 = document.createElement('div');
  line1.textContent = `選択：${startText} ～ ${endText}`;
  const line2 = document.createElement('div');
  line2.textContent = `${stats.unitCount}${stats.unitLabel} ${formatReadingTime(stats.readingTime)}`;
  el.appendChild(line1);
  el.appendChild(line2);
  el.title = `${line1.textContent}\n${line2.textContent}`;
}

function initSelectionStatsListener() {
  if (selectionStatsListenerInitialized) return;
  selectionStatsListenerInitialized = true;
  document.addEventListener('selectionchange', updateSelectionStatsDisplay);
  const container = document.getElementById('yomup-pdf-container');
  if (container) {
    container.addEventListener('mouseup', () => {
      requestAnimationFrame(updateSelectionStatsDisplay);
    });
  }
}

async function loadPdfBytes() {
  const params = new URLSearchParams(location.search);
  const fileCacheId = params.get('fid');
  if (fileCacheId) {
    setStatus('ローカル PDF を読み込み中…');
    const response = await chrome.runtime.sendMessage({
      action: 'getFilePdfCache',
      id: fileCacheId
    });
    if (!response || response.error) {
      throw new Error(response?.error || 'ローカル PDF データを取得できませんでした。');
    }
    if (!response.bytes || !response.bytes.length) {
      throw new Error('PDF データが空です。');
    }
    return { bytes: response.bytes, url: response.url || 'file://local.pdf' };
  }

  const src = params.get('src');
  if (!src) {
    throw new Error('PDF URL がありません。拡張アイコンから PDF を開き直してください。');
  }

  setStatus('PDF を取得中…');

  const response = await chrome.runtime.sendMessage({ action: 'fetchPdf', url: src });
  if (!response || response.error) {
    throw new Error(response?.error || 'PDF データを取得できませんでした。');
  }
  if (!response.bytes || !response.bytes.length) {
    throw new Error('PDF データが空です。拡張アイコンから開き直してください。');
  }
  return { bytes: response.bytes, url: response.url || src };
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(data);
  throw new Error('PDF データ形式が不正です。拡張アイコンから開き直してください。');
}

function buildSegmentMetrics(span) {
  const rect = span.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height
  };
}

function segmentRight(seg) {
  return seg.left + Math.max(seg.width || 0, 0);
}

function splitSegmentsByColumnGap(segments) {
  const sorted = segments.slice().sort((a, b) => a.left - b.left);
  const groups = [];
  let group = [];

  for (const seg of sorted) {
    if (!seg.text.trim()) continue;
    if (group.length > 0) {
      const prev = group[group.length - 1];
      if (seg.left - segmentRight(prev) >= COLUMN_GAP_MIN_PX) {
        groups.push(group);
        group = [];
      }
    }
    group.push(seg);
  }

  if (group.length) groups.push(group);
  return groups;
}

function buildLineFromSegments(segments, baselineY) {
  let blockText = '';
  const mapped = [];
  for (const seg of segments) {
    const lineStart = blockText.length;
    blockText += seg.text;
    mapped.push({ ...seg, lineStart, lineEnd: blockText.length });
  }
  return { baselineY, blockText, segments: mapped };
}

function clusterSegmentsIntoLines(segments) {
  const sorted = segments.slice().sort((a, b) => a.top - b.top || a.left - b.left);
  const yLines = [];

  for (const seg of sorted) {
    if (!seg.text.trim()) continue;
    let line = yLines.find((l) => Math.abs(l.baselineY - seg.top) <= LINE_Y_TOLERANCE_PX);
    if (!line) {
      line = { baselineY: seg.top, segments: [] };
      yLines.push(line);
    }
    line.segments.push(seg);
  }

  const lines = [];
  for (const yLine of yLines) {
    const columnGroups = splitSegmentsByColumnGap(yLine.segments);
    for (const group of columnGroups) {
      const built = buildLineFromSegments(group, yLine.baselineY);
      if (built.blockText.trim()) lines.push(built);
    }
  }

  return lines;
}

async function buildPageTextModel(textContent, viewport, textLayerDiv) {
  textLayerDiv.className = 'textLayer';

  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: textContent,
    container: textLayerDiv,
    viewport
  });
  await textLayer.render();

  let blockText = '';
  const segments = [];
  const divs = textLayer.textDivs;
  const strs = textLayer.textContentItemsStr;

  for (let i = 0; i < divs.length; i += 1) {
    const str = strs[i];
    const span = divs[i];
    if (str === undefined || str === null) continue;

    const start = blockText.length;
    blockText += str;
    const end = blockText.length;
    const metrics = buildSegmentMetrics(span);
    segments.push({
      start,
      end,
      text: str,
      span,
      top: metrics.top,
      left: metrics.left,
      width: metrics.width,
      height: metrics.height
    });
  }

  return {
    blockText,
    segments,
    lines: clusterSegmentsIntoLines(segments)
  };
}

function findTextDivAtPoint(clientX, clientY) {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit) return null;
  const el = hit.nodeType === Node.TEXT_NODE ? hit.parentElement : hit;
  if (!el || el.tagName !== 'SPAN') return null;
  if (!el.closest('.textLayer')) return null;
  return el;
}

function findLineForTextDiv(pageModel, div) {
  if (!div) return null;
  return pageModel.lines.find((line) => line.segments.some((seg) => seg.span === div)) || null;
}

function segmentClientRect(seg) {
  if (!seg.text.trim()) return null;
  const r = seg.span.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return r;
}

async function renderPage(pdf, pageNum, containerWidth) {
  const page = await pdf.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = containerWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });

  const pageWrap = document.createElement('div');
  pageWrap.className = 'yomup-pdf-page';
  pageWrap.dataset.pageNumber = String(pageNum);
  pageWrap.style.setProperty('--scale-factor', String(viewport.scale));
  pageWrap.style.width = `${viewport.width}px`;
  pageWrap.style.height = `${viewport.height}px`;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  pageWrap.appendChild(canvas);

  const textLayerDiv = document.createElement('div');
  pageWrap.appendChild(textLayerDiv);

  pagesEl.appendChild(pageWrap);
  await page.render({ canvasContext: context, viewport }).promise;

  const textContent = await page.getTextContent();
  const textModel = await buildPageTextModel(textContent, viewport, textLayerDiv);

  pageModels.push({
    pageNum,
    pageWrap,
    ...textModel
  });
}

function ensureHighlightOverlayRoot() {
  if (!highlightOverlayRoot || !highlightOverlayRoot.isConnected) {
    highlightOverlayRoot = document.createElement('div');
    highlightOverlayRoot.id = 'yomup-pdf-highlight-overlay-root';
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
  currentHighlightHitRects = null;
}

function isPointInCurrentHighlightRects(clientX, clientY) {
  if (!currentHighlightHitRects || currentHighlightHitRects.length === 0) return false;
  const rightPad = window.HIGHLIGHT_STICKY_RIGHT_PADDING_PX ?? 0;
  for (const rect of currentHighlightHitRects) {
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

function isPointInCurrentHighlightOverlay(clientX, clientY) {
  if (!highlightOverlayRoot) return false;
  const segments = highlightOverlayRoot.querySelectorAll('.yomup-pdf-highlight-underline-segment');
  const linePad = RECT_MERGE_LINE_TOLERANCE_PX;
  for (const segment of segments) {
    const rect = segment.getBoundingClientRect();
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

function isPdfYomupUiElement(el) {
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest('#yomup-pdf-timer-panel, #yomup-pdf-toolbar, #yomup-pdf-stopwatch-panel');
}

function mergeHighlightClientRects(rectList) {
  const raw = [];
  for (const r of rectList) {
    if (r.width > 0 && r.height > 0) raw.push(r);
  }
  if (raw.length === 0) return [];

  const sorted = raw.slice().sort((a, b) => {
    if (Math.abs(a.top - b.top) > RECT_MERGE_LINE_TOLERANCE_PX) return a.top - b.top;
    return a.left - b.left;
  });

  const lineGroups = [];
  for (const r of sorted) {
    let placed = false;
    for (const line of lineGroups) {
      const ref = line[0];
      if (Math.abs(r.top - ref.top) <= RECT_MERGE_LINE_TOLERANCE_PX) {
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
      if (r.left <= group.right + RECT_MERGE_GAP_TOLERANCE_PX) {
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

function isHighlightUnderlineOverlayStyle() {
  return window.HIGHLIGHT_OVERLAY_STYLE === 'underline';
}

function usesHighlightUnderlineSegmentLayer() {
  if (!isHighlightUnderlineOverlayStyle()) return false;
  return window.ENABLE_HIGHLIGHT_UNDERLINE_PROGRESS !== false;
}

function isHighlightUnderlineProgressEnabled() {
  return usesHighlightUnderlineSegmentLayer() && window.isHighlightUnderlineProgressMode();
}

function getHighlightRectBottom(rect) {
  if (typeof rect.bottom === 'number') return rect.bottom;
  return rect.top + rect.height;
}

function getHighlightUnderlineGoalColor() {
  return window.HIGHLIGHT_UNDERLINE_GOAL_COLOR || 'rgba(255, 0, 0, 0.28)';
}

function getHighlightUnderlineProgressColor() {
  return window.HIGHLIGHT_UNDERLINE_COLOR || 'red';
}

function getHighlightUnderlineProgressEl(segment) {
  return segment.querySelector('.yomup-pdf-highlight-underline-progress');
}

function createHighlightOverlayBox(rect) {
  if (isHighlightUnderlineOverlayStyle()) {
    const thickness = window.HIGHLIGHT_UNDERLINE_THICKNESS_PX ?? 2;
    const underlineTop = getHighlightRectBottom(rect) - thickness;
    const useSegmentLayer = usesHighlightUnderlineSegmentLayer();

    if (!useSegmentLayer) {
      const box = document.createElement('div');
      box.className = 'yomup-pdf-highlight-underline';
      box.style.cssText =
        `position:fixed;left:${rect.left}px;top:${underlineTop}px;` +
        `width:${rect.width}px;height:${thickness}px;background:${getHighlightUnderlineProgressColor()};`;
      return box;
    }

    const segment = document.createElement('div');
    segment.className = 'yomup-pdf-highlight-underline-segment';
    segment.dataset.fullWidth = String(rect.width);
    segment.style.cssText =
      `position:fixed;left:${rect.left}px;top:${underlineTop}px;` +
      `width:${rect.width}px;height:${thickness}px;`;

    const goal = document.createElement('div');
    goal.className = 'yomup-pdf-highlight-underline-goal';
    goal.style.cssText =
      `position:absolute;left:0;top:0;width:100%;height:100%;background:${getHighlightUnderlineGoalColor()};`;

    const progress = document.createElement('div');
    progress.className = 'yomup-pdf-highlight-underline-progress';
    progress.style.cssText =
      `position:absolute;left:0;top:0;width:0;height:100%;background:${getHighlightUnderlineProgressColor()};`;

    segment.appendChild(goal);
    segment.appendChild(progress);
    return segment;
  }

  const box = document.createElement('div');
  box.className = 'yomup-pdf-highlight-box';
  box.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
  return box;
}

function stopHighlightUnderlineProgress() {
  if (!highlightOverlayRoot) return;
  const progressEls = highlightOverlayRoot.querySelectorAll('.yomup-pdf-highlight-underline-progress');
  for (const el of progressEls) {
    el.style.transition = '';
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

function startHighlightProgressCountdown() {
  clearHighlightProgressCountdown();
  if (!highlightProgressSession) return;

  highlightProgressCountdownInterval = setInterval(() => {
    if (!highlightProgressSession || highlightProgressSession.paused) return;
    highlightProgressSession.remainingSeconds--;
    if (highlightProgressSession.remainingSeconds <= 0) {
      clearHighlightProgressCountdown();
      resetHighlightProgressSession();
    }
  }, 1000);
}

function capturePdfHighlightProgressTarget(pageModel, ctx, chunk) {
  return {
    pageNum: pageModel.pageNum,
    contextLength: ctx.blockText.length,
    chunkStart: chunk.start,
    chunkEnd: chunk.end
  };
}

function isSamePdfHighlightProgressTarget(pageModel, ctx, chunk) {
  if (!highlightProgressSession || !highlightProgressSession.target) return false;
  const target = highlightProgressSession.target;
  return target.pageNum === pageModel.pageNum &&
    target.contextLength === ctx.blockText.length &&
    target.chunkStart === chunk.start &&
    target.chunkEnd === chunk.end;
}

function getHighlightProgressElWidthPx(progressEl) {
  const styleWidth = parseFloat(progressEl.style.width);
  if (Number.isFinite(styleWidth) && styleWidth > 0) return styleWidth;
  return parseFloat(getComputedStyle(progressEl).width) || 0;
}

function pauseHighlightUnderlineProgress() {
  if (!highlightOverlayRoot) return;
  const progressEls = highlightOverlayRoot.querySelectorAll('.yomup-pdf-highlight-underline-progress');
  for (const el of progressEls) {
    const frozenWidth = getComputedStyle(el).width;
    el.style.transition = 'none';
    el.style.width = frozenWidth;
  }
}

function resumeHighlightUnderlineProgress(remainingSeconds) {
  if (!usesHighlightUnderlineSegmentLayer() || !window.isHighlightUnderlineProgressMode()) return;

  const root = ensureHighlightOverlayRoot();
  const boxes = root.querySelectorAll('.yomup-pdf-highlight-underline-segment');
  if (boxes.length === 0) return;

  const minSeconds = window.HIGHLIGHT_UNDERLINE_PROGRESS_MIN_SECONDS ?? 0.3;
  const duration = Math.max(minSeconds, remainingSeconds || 0);
  const lineTolerance = RECT_MERGE_LINE_TOLERANCE_PX;

  const sortedBoxes = Array.from(boxes).sort((a, b) =>
    compareHighlightUnderlineReadingOrder(a, b, lineTolerance)
  );

  let totalRemainingWidth = 0;
  for (const segment of sortedBoxes) {
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
  for (const group of lineGroups) {
    let lineRemainingWidth = 0;
    for (const segment of group) {
      const fullWidth = parseFloat(segment.dataset.fullWidth) || 0;
      const progressEl = getHighlightUnderlineProgressEl(segment);
      if (!fullWidth || !progressEl) continue;
      const currentWidth = getHighlightProgressElWidthPx(progressEl);
      lineRemainingWidth += Math.max(0, fullWidth - currentWidth);
    }
    if (lineRemainingWidth <= 0) continue;

    const lineDuration = duration * (lineRemainingWidth / totalRemainingWidth);
    let lineDelay = delay;
    for (const segment of group) {
      const fullWidth = parseFloat(segment.dataset.fullWidth);
      const progressEl = getHighlightUnderlineProgressEl(segment);
      if (!fullWidth || !progressEl) continue;
      const currentWidth = getHighlightProgressElWidthPx(progressEl);
      const remainingWidth = Math.max(0, fullWidth - currentWidth);
      if (remainingWidth <= 0.5) {
        progressEl.style.transition = 'none';
        progressEl.style.width = `${fullWidth}px`;
        continue;
      }

      const segmentDuration = lineRemainingWidth > 0
        ? lineDuration * (remainingWidth / lineRemainingWidth)
        : lineDuration;
      progressEl.style.transition = `width ${segmentDuration}s linear ${lineDelay}s`;
      progressEl.style.width = `${fullWidth}px`;
      lineDelay += segmentDuration;
    }
    delay += lineDuration;
  }
}

function getHighlightProgressRemainingSeconds() {
  if (!highlightProgressSession) return 0;
  return highlightProgressSession.remainingSeconds || 0;
}

function pauseHighlightProgress() {
  if (!highlightProgressSession || highlightProgressSession.paused) return;
  if (getHighlightProgressRemainingSeconds() <= 0) return;

  clearHighlightProgressCountdown();
  pauseHighlightUnderlineProgress();
  highlightProgressSession.paused = true;
}

function resumeHighlightProgress() {
  if (!highlightProgressSession || !highlightProgressSession.paused) return;
  const remaining = highlightProgressSession.remainingSeconds || 0;
  if (remaining <= 0) return;

  resumeHighlightUnderlineProgress(remaining);
  startHighlightProgressCountdown();
  highlightProgressSession.paused = false;
}

function resetHighlightProgressOnSettingsChange() {
  resetHighlightProgressSession();
  clearHighlightState();
}

function handleProgressPauseClick(event) {
  if (!highLightOnOff || !highlightListenersAttached) return;
  if (!isHighlightUnderlineProgressEnabled()) return;
  if (!highlightProgressSession) return;
  if (getHighlightProgressRemainingSeconds() <= 0) return;
  if (isPdfYomupUiElement(event.target)) return;

  const root = highlightOverlayRoot;
  if (!root || !root.querySelector('.yomup-pdf-highlight-underline-segment')) return;

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
  for (const box of sortedBoxes) {
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
  for (const group of lineGroups) {
    group.sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left));
  }
  return lineGroups;
}

function startHighlightUnderlineProgress(durationSeconds) {
  stopHighlightUnderlineProgress();
  if (!usesHighlightUnderlineSegmentLayer()) return;

  const root = ensureHighlightOverlayRoot();
  const boxes = root.querySelectorAll('.yomup-pdf-highlight-underline-segment');
  if (boxes.length === 0) return;

  const progressEls = [];
  for (const segment of boxes) {
    const progressEl = getHighlightUnderlineProgressEl(segment);
    if (progressEl) progressEls.push(progressEl);
  }
  if (progressEls.length === 0) return;

  if (!window.isHighlightUnderlineProgressMode()) {
    for (const progressEl of progressEls) {
      progressEl.style.transition = 'none';
      progressEl.style.width = '100%';
    }
    return;
  }

  const minSeconds = window.HIGHLIGHT_UNDERLINE_PROGRESS_MIN_SECONDS ?? 0.3;
  const duration = Math.max(minSeconds, durationSeconds || 0);
  const lineTolerance = RECT_MERGE_LINE_TOLERANCE_PX;

  const sortedBoxes = Array.from(boxes).sort((a, b) =>
    compareHighlightUnderlineReadingOrder(a, b, lineTolerance)
  );

  let totalWidth = 0;
  for (const box of sortedBoxes) {
    totalWidth += parseFloat(box.dataset.fullWidth) || 0;
  }
  if (totalWidth <= 0) return;

  for (const segment of sortedBoxes) {
    const progressEl = getHighlightUnderlineProgressEl(segment);
    if (!progressEl) continue;
    progressEl.style.transition = 'none';
    progressEl.style.width = '0px';
  }

  void root.offsetHeight;

  const lineGroups = groupHighlightUnderlineBoxesByLine(sortedBoxes, lineTolerance);
  let delay = 0;
  for (const group of lineGroups) {
    let lineWidth = 0;
    for (const segment of group) {
      lineWidth += parseFloat(segment.dataset.fullWidth) || 0;
    }
    const lineDuration = duration * (lineWidth / totalWidth);
    let lineDelay = delay;
    for (const segment of group) {
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

function applyHighlightOverlayRects(rects) {
  clearHighlightOverlay();
  const root = ensureHighlightOverlayRoot();
  const merged = mergeHighlightClientRects(rects);
  for (const rect of merged) {
    root.appendChild(createHighlightOverlayBox(rect));
  }
}

function findPageModelAtPoint(clientX, clientY) {
  for (const model of pageModels) {
    const rect = model.pageWrap.getBoundingClientRect();
    if (
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom
    ) {
      return model;
    }
  }
  return null;
}

function findLineAtPoint(pageModel, clientX, clientY) {
  const div = findTextDivAtPoint(clientX, clientY);
  const lineFromHit = findLineForTextDiv(pageModel, div);
  if (lineFromHit) return lineFromHit;

  let bestLine = pageModel.lines[0] || null;
  let bestDist = Infinity;
  for (const line of pageModel.lines) {
    for (const seg of line.segments) {
      if (!seg.text.trim()) continue;
      const r = seg.span.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = (cx - clientX) ** 2 + (cy - clientY) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestLine = line;
      }
    }
  }
  return bestLine;
}

function findOffsetInLine(line, clientX, clientY) {
  const div = findTextDivAtPoint(clientX, clientY);
  const hitSeg = div ? line.segments.find((seg) => seg.span === div) : null;
  if (hitSeg) {
    const r = hitSeg.span.getBoundingClientRect();
    const ratio = r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
    const charIdx = Math.min(hitSeg.text.length, Math.max(0, Math.floor(ratio * hitSeg.text.length)));
    return hitSeg.lineStart + charIdx;
  }

  let bestSeg = line.segments.find((seg) => seg.text.trim()) || line.segments[0];
  let bestDist = Infinity;
  for (const seg of line.segments) {
    if (!seg.text.trim()) continue;
    const r = seg.span.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const d = (cx - clientX) ** 2 + (cy - clientY) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestSeg = seg;
    }
  }
  return bestSeg ? bestSeg.lineStart + Math.floor(bestSeg.text.length / 2) : 0;
}

function getChunkClientRects(line, chunkStart, chunkEnd) {
  const rects = [];
  for (const seg of line.segments) {
    const segStart = seg.lineStart;
    const segEnd = seg.lineEnd;
    if (segEnd <= chunkStart || segStart >= chunkEnd) continue;
    const r = segmentClientRect(seg);
    if (r) rects.push(r);
  }
  return rects;
}

function resolveHighlightContext(pageModel, clientX, clientY) {
  // 日本文・英文とも、複数行あるページではホバー行を blockText にする（PDF のみ）
  if (pageModel.lines.length <= 1) {
    return {
      blockText: pageModel.blockText,
      getOffset: () => findOffsetInWholePage(pageModel, clientX, clientY),
      getRects: (start, end) => getChunkClientRectsFromPage(pageModel, start, end)
    };
  }

  const line = findLineAtPoint(pageModel, clientX, clientY);
  if (!line) return null;

  return {
    blockText: line.blockText,
    getOffset: () => findOffsetInLine(line, clientX, clientY),
    getRects: (start, end) => getChunkClientRects(line, start, end)
  };
}

function findOffsetInWholePage(pageModel, clientX, clientY) {
  const div = findTextDivAtPoint(clientX, clientY);
  const hitSeg = div ? pageModel.segments.find((seg) => seg.span === div) : null;
  if (hitSeg) {
    const r = hitSeg.span.getBoundingClientRect();
    const ratio = r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
    const charIdx = Math.min(hitSeg.text.length, Math.max(0, Math.floor(ratio * hitSeg.text.length)));
    return hitSeg.start + charIdx;
  }
  return Math.floor(pageModel.blockText.length / 2);
}

function getChunkClientRectsFromPage(pageModel, chunkStart, chunkEnd) {
  const rects = [];
  for (const seg of pageModel.segments) {
    if (seg.end <= chunkStart || seg.start >= chunkEnd) continue;
    const r = segmentClientRect(seg);
    if (r) rects.push(r);
  }
  return rects;
}

function clearHighlightState() {
  clearHighlightOverlay();
  clearHighlightTimer();
  if (defaultStatusText) {
    setStatus(formatStatusWithHighlightMode());
  }
}

function tryHighlightAtPoint(clientX, clientY) {
  const pageModel = findPageModelAtPoint(clientX, clientY);
  if (!pageModel || !pageModel.blockText.trim()) {
    clearHighlightState();
    return;
  }

  const languageMode = detectLanguageMode(pageModel.blockText);
  const ctx = resolveHighlightContext(pageModel, clientX, clientY);
  if (!ctx || !ctx.blockText.trim()) {
    clearHighlightState();
    return;
  }

  let offset = ctx.getOffset();
  if (offset < 0) offset = Math.floor(ctx.blockText.length / 2);

  const chunks = buildLogicalChunks(ctx.blockText, languageMode);
  const chunk = findChunkContainingOffset(chunks, offset);
  if (!chunk || !chunk.text.trim() || !withinHighlightLimit(chunk.text, languageMode)) {
    clearHighlightState();
    return;
  }

  const rects = ctx.getRects(chunk.start, chunk.end);
  if (rects.length === 0) {
    clearHighlightState();
    return;
  }

  if (isPointInCurrentHighlightRects(clientX, clientY)) {
    return;
  }

  if (highlightProgressSession && isSamePdfHighlightProgressTarget(pageModel, ctx, chunk)) {
    return;
  }

  applyHighlightOverlayRects(rects);
  currentHighlightHitRects = rects;
  const units = countUnits(chunk.text, languageMode);
  const readTime = calculateReadingTime(units, languageMode);
  startHighlightUnderlineProgress(readTime);
  startHighlightTimer(units, languageMode);

  if (isHighlightUnderlineProgressEnabled()) {
    highlightProgressSession = {
      unitCount: units,
      readTime,
      languageMode,
      unitLabel: getUnitLabel(languageMode),
      paused: false,
      remainingSeconds: readTime,
      target: capturePdfHighlightProgressTarget(pageModel, ctx, chunk)
    };
    startHighlightProgressCountdown();
  }
}

function handleMouseMove(event) {
  if (!highLightOnOff || !highlightListenersAttached) return;
  lastHighlightClientX = event.clientX;
  lastHighlightClientY = event.clientY;

  if (isPointInCurrentHighlightRects(event.clientX, event.clientY)) {
    return;
  }

  if (highlightProgressSession && getHighlightProgressRemainingSeconds() > 0) {
    if (isPointInCurrentHighlightOverlay(event.clientX, event.clientY)) {
      return;
    }
  }

  if (mouseTimeoutForHighlight) {
    clearTimeout(mouseTimeoutForHighlight);
  }

  mouseTimeoutForHighlight = setTimeout(() => {
    tryHighlightAtPoint(lastHighlightClientX, lastHighlightClientY);
  }, HIGHLIGHT_DELAY_MS);
}

function handleMouseLeave() {
  if (!highLightOnOff || !highlightListenersAttached) return;
  if (mouseTimeoutForHighlight) {
    clearTimeout(mouseTimeoutForHighlight);
    mouseTimeoutForHighlight = null;
  }
  clearHighlightState();
}

function handleViewportChange() {
  if (!highLightOnOff || !highlightListenersAttached) return;
  if (mouseTimeoutForHighlight) {
    clearTimeout(mouseTimeoutForHighlight);
    mouseTimeoutForHighlight = null;
  }
  clearHighlightState();
}

function attachHighlightListeners() {
  if (highlightListenersAttached) return;
  highlightListenersAttached = true;
  const container = document.getElementById('yomup-pdf-container');
  container.addEventListener('mousemove', handleMouseMove);
  container.addEventListener('mouseleave', handleMouseLeave);
  document.addEventListener('click', handleProgressPauseClick, true);
  window.addEventListener('scroll', handleViewportChange, true);
  window.addEventListener('resize', handleViewportChange);
}

function detachHighlightListeners() {
  if (!highlightListenersAttached) return;
  highlightListenersAttached = false;
  const container = document.getElementById('yomup-pdf-container');
  container.removeEventListener('mousemove', handleMouseMove);
  container.removeEventListener('mouseleave', handleMouseLeave);
  document.removeEventListener('click', handleProgressPauseClick, true);
  window.removeEventListener('scroll', handleViewportChange, true);
  window.removeEventListener('resize', handleViewportChange);
  if (mouseTimeoutForHighlight) {
    clearTimeout(mouseTimeoutForHighlight);
    mouseTimeoutForHighlight = null;
  }
}

function getPdfUiLanguageMode() {
  if (pageModels.length === 0) return LANGUAGE_MODE_JA;
  const sample = pageModels.map((model) => model.blockText).join('').slice(0, 4000);
  return detectLanguageMode(sample);
}

function refreshReadingSettingsToolbarLabels() {
  const select = document.getElementById('yomup-pdf-reading-speed');
  if (!select || typeof window.populateReadingSpeedSelect !== 'function') return;
  window.populateReadingSpeedSelect(
    select,
    getPdfUiLanguageMode(),
    window.loadReadingSpeedCharsPerMin()
  );
}

function initReadingSettingsToolbar() {
  const select = document.getElementById('yomup-pdf-reading-speed');
  const progressBtn = document.getElementById('yomup-pdf-mode-progress');
  if (!select || select.dataset.bound === '1') return;
  select.dataset.bound = '1';

  refreshReadingSettingsToolbarLabels();

  select.addEventListener('change', () => {
    window.saveReadingSpeedCharsPerMin(Number(select.value));
    updateDocumentStatsDisplay(pageModels);
    updateSelectionStatsDisplay();
    if (highlightProgressSession) {
      resetHighlightProgressOnSettingsChange();
    }
  });

  if (typeof window.bindReadingModeToggleButton === 'function') {
    window.bindReadingModeToggleButton(progressBtn, resetHighlightProgressOnSettingsChange);
  }
}

async function renderPdf(pdfBytes, sourceUrl) {
  hideError();
  detachHighlightListeners();
  pagesEl.replaceChildren('');
  pageModels.length = 0;
  clearHighlightState();

  const fileName = decodeFileNameFromUrl(sourceUrl);

  setStatus(`読み込み中… (${fileName})`, fileName);

  const loadingTask = createPdfDocumentTask(pdfBytes);
  const pdf = await loadingTask.promise;

  const containerWidth = Math.min(
    Math.max(document.documentElement.clientWidth - 32, 320),
    1200
  );

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    setStatus(`${pageNum} / ${pdf.numPages} ページ`);
    await renderPage(pdf, pageNum, containerWidth);
  }

  defaultStatusText = `${pdf.numPages} ページ — ${fileName}`;
  updateDocumentStatsDisplay(pageModels);
  refreshReadingSettingsToolbarLabels();
  initSelectionStatsListener();
  updateSelectionStatsDisplay();
  initHighlightToggle();
  applyStatusWithHighlightMode();
  initTimerPanel();
  bindTimerToolbarToggle();
  initStopwatchPanel();
  bindStopwatchToolbarToggle();
}

async function main() {
  initReadingSettingsToolbar();
  const params = new URLSearchParams(location.search);
  const errorParam = params.get('error');
  if (errorParam) {
    showError(decodeURIComponent(errorParam));
    return;
  }

  try {
    const { bytes, url } = await loadPdfBytes();
    await renderPdf(bytes, url);
  } catch (error) {
    console.error('[読むプ PDF]', error);
    showError(error instanceof Error ? error.message : String(error));
  }
}

main();
