// PDF viewer 用: 論理塊分割・言語判定（content.js と同等ロジック）
// constants.js を viewer.html で先に読み込む前提

const MAX_TEXT_LENGTH_FOR_HIGHLIGHT = window.MAX_TEXT_LENGTH_FOR_HIGHLIGHT;
const MAX_WORDS_FOR_HIGHLIGHT = window.MAX_WORDS_FOR_HIGHLIGHT;
const HIGHLIGHT_UNIT_SLACK_JA = window.HIGHLIGHT_UNIT_SLACK_JA;
const HIGHLIGHT_UNIT_SLACK_EN = window.HIGHLIGHT_UNIT_SLACK_EN;
const EN_BOUNDARY_SEARCH_WINDOW_WORDS = window.EN_BOUNDARY_SEARCH_WINDOW_WORDS;
const JA_BOUNDARY_SEARCH_WINDOW_FORWARD = window.JA_BOUNDARY_SEARCH_WINDOW_FORWARD;
const CJK_RATIO_THRESHOLD = window.CJK_RATIO_THRESHOLD;
const WORDS_PER_MINUTE = window.WORDS_PER_MINUTE;
const READING_SPEED_CHARS_PER_MIN = window.READING_SPEED_CHARS_PER_MIN;

const LANGUAGE_MODE_JA = 'ja';
const LANGUAGE_MODE_EN = 'en';
const COALESCE_MIN_WORDS_EN = 8;
const COALESCE_MIN_CHARS_JA = 40;

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

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
  if (prev === '!' || prev === '?') return { cutAfter, priority: 1, kind: prev };
  if (prev === '.') {
    if (isSentenceEndingPeriod(text, cutAfter - 1)) return { cutAfter, priority: 1, kind: '.' };
    return null;
  }
  if (prev === ';') return { cutAfter, priority: 2, kind: ';' };
  if (prev === ':') return { cutAfter, priority: 3, kind: ':' };
  if (prev === ')' || prev === '—' || prev === '–') return { cutAfter, priority: 4, kind: prev };
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

function classifyJapaneseBoundary(text, cutAfter, allowComma) {
  if (cutAfter <= 0 || cutAfter > text.length) return null;
  const prev = text[cutAfter - 1];
  if (prev === '。' || prev === '！' || prev === '？' || prev === '．') {
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
  const allowComma = chunkLength > maxLength * 1.2;
  const maxChunkEnd = start + maxLength + HIGHLIGHT_UNIT_SLACK_JA;
  let best = null;
  let bestPriority = 999;
  let bestDistance = Infinity;
  for (let i = searchEnd; i >= searchStart; i--) {
    const boundary = classifyJapaneseBoundary(text, i, allowComma);
    if (!boundary || boundary.cutAfter > maxChunkEnd) continue;
    const distance = Math.abs(i - targetEnd);
    if (
      boundary.priority < bestPriority ||
      (boundary.priority === bestPriority && distance < bestDistance)
    ) {
      best = { cutAfter: boundary.cutAfter, kind: boundary.kind };
      bestPriority = boundary.priority;
      bestDistance = distance;
    }
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
  const mergedText = blockText.slice(prev.start, last.end);
  const mergedUnits = languageMode === LANGUAGE_MODE_EN
    ? countWords(mergedText)
    : mergedText.trim().length;
  const slack = languageMode === LANGUAGE_MODE_EN
    ? HIGHLIGHT_UNIT_SLACK_EN
    : HIGHLIGHT_UNIT_SLACK_JA;
  if (mergedUnits <= maxUnits + slack) {
    return chunks.slice(0, -2).concat({
      start: prev.start,
      end: last.end,
      text: mergedText
    });
  }
  return chunks;
}

export function buildLogicalChunks(blockText, languageMode) {
  const maxUnits = languageMode === LANGUAGE_MODE_EN
    ? MAX_WORDS_FOR_HIGHLIGHT
    : MAX_TEXT_LENGTH_FOR_HIGHLIGHT;
  const parts = languageMode === LANGUAGE_MODE_EN
    ? splitEnglishTextByBoundary(blockText, maxUnits)
    : splitJapaneseTextByBoundary(blockText, maxUnits);
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

export function findChunkContainingOffset(chunks, offset) {
  for (const chunk of chunks) {
    if (offset >= chunk.start && offset < chunk.end) return chunk;
  }
  if (chunks.length > 0) {
    const last = chunks[chunks.length - 1];
    if (offset === last.end) return last;
  }
  return chunks[0] || null;
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

export function detectLanguageMode(text) {
  if ((text || '').trim()) {
    return detectLanguageByHeuristic(text);
  }
  const docLang = normalizeLangTag(document.documentElement.getAttribute('lang'));
  if (docLang) return docLang;
  return LANGUAGE_MODE_JA;
}

export function countUnits(text, languageMode) {
  if (languageMode === LANGUAGE_MODE_EN) return countWords(text);
  return (text || '').trim().length;
}

export function getUnitLabel(languageMode) {
  return languageMode === LANGUAGE_MODE_EN ? '語' : '字';
}

export function calculateReadingTime(unitCount, languageMode) {
  if (typeof window.calculateReadingTimeWithSettings === 'function') {
    return window.calculateReadingTimeWithSettings(unitCount, languageMode);
  }
  if (languageMode === LANGUAGE_MODE_EN) {
    return Math.round(unitCount * (60 / WORDS_PER_MINUTE));
  }
  return Math.round(unitCount * (60 / READING_SPEED_CHARS_PER_MIN));
}

export function withinHighlightLimit(text, languageMode) {
  if (languageMode === LANGUAGE_MODE_EN) {
    return countWords(text) <= MAX_WORDS_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_EN;
  }
  return text.trim().length <= MAX_TEXT_LENGTH_FOR_HIGHLIGHT + HIGHLIGHT_UNIT_SLACK_JA;
}

export { LANGUAGE_MODE_JA, LANGUAGE_MODE_EN };
