import * as pdfjsLib from '../vendor/pdf.mjs';
import {
  buildLogicalChunks,
  findChunkContainingOffset,
  detectLanguageMode,
  countUnits,
  calculateReadingTime,
  getUnitLabel,
  withinHighlightLimit,
  LANGUAGE_MODE_JA
} from './highlight-core.js';
import { initTimerPanel, startHighlightTimer, clearHighlightTimer, bindTimerToolbarToggle } from './timer-panel.js';
import { initStopwatchPanel, bindStopwatchToolbarToggle } from './stopwatch-panel.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.mjs');

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
let mouseTimeoutForHighlight = null;
let lastHighlightClientX = 0;
let lastHighlightClientY = 0;
let defaultStatusText = '';
let highLightOnOff = false;
let highlightListenersAttached = false;
let highlightToggleInitialized = false;

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
  setStatus(formatStatusWithHighlightMode());
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

function setStatus(text) {
  statusEl.textContent = text;
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
  if (highlightOverlayRoot) {
    highlightOverlayRoot.textContent = '';
  }
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

function applyHighlightOverlayRects(rects) {
  clearHighlightOverlay();
  const root = ensureHighlightOverlayRoot();
  const merged = mergeHighlightClientRects(rects);
  for (const rect of merged) {
    const box = document.createElement('div');
    box.className = 'yomup-pdf-highlight-box';
    box.style.cssText =
      `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
    root.appendChild(box);
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

function resolveHighlightContext(pageModel, languageMode, clientX, clientY) {
  const useLineSplit = languageMode === LANGUAGE_MODE_JA;
  if (!useLineSplit || pageModel.lines.length <= 1) {
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
  const ctx = resolveHighlightContext(pageModel, languageMode, clientX, clientY);
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

  applyHighlightOverlayRects(rects);
  startHighlightTimer(countUnits(chunk.text, languageMode), languageMode);
}

function handleMouseMove(event) {
  if (!highLightOnOff || !highlightListenersAttached) return;
  lastHighlightClientX = event.clientX;
  lastHighlightClientY = event.clientY;

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
  window.addEventListener('scroll', handleViewportChange, true);
  window.addEventListener('resize', handleViewportChange);
}

function detachHighlightListeners() {
  if (!highlightListenersAttached) return;
  highlightListenersAttached = false;
  const container = document.getElementById('yomup-pdf-container');
  container.removeEventListener('mousemove', handleMouseMove);
  container.removeEventListener('mouseleave', handleMouseLeave);
  window.removeEventListener('scroll', handleViewportChange, true);
  window.removeEventListener('resize', handleViewportChange);
  if (mouseTimeoutForHighlight) {
    clearTimeout(mouseTimeoutForHighlight);
    mouseTimeoutForHighlight = null;
  }
}

async function renderPdf(pdfBytes, sourceUrl) {
  hideError();
  detachHighlightListeners();
  pagesEl.replaceChildren('');
  pageModels.length = 0;
  clearHighlightState();

  const fileName = (() => {
    try {
      const path = new URL(sourceUrl).pathname;
      const base = path.split('/').pop();
      return base || sourceUrl;
    } catch (_e) {
      return sourceUrl;
    }
  })();

  setStatus(`読み込み中… (${fileName})`);

  const loadingTask = pdfjsLib.getDocument({ data: toUint8Array(pdfBytes) });
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
  initHighlightToggle();
  setStatus(formatStatusWithHighlightMode());
  initTimerPanel();
  bindTimerToolbarToggle();
  initStopwatchPanel();
  bindStopwatchToolbarToggle();
}

async function main() {
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
