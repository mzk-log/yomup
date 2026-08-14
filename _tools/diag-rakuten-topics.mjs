/**
 * 楽天商品ページ — ショップ内トピックス不発の切り分け
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-rakuten-topics');
const URL =
  'https://item.rakuten.co.jp/elecom/4549550281768/';

fs.rmSync(UD, { recursive: true, force: true });

const ctx = await chromium.launchPersistentContext(UD, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1280, height: 900 }
});
if (!ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const page = ctx.pages()[0] || (await ctx.newPage());
const client = await ctx.newCDPSession(page);
await client.send('Runtime.enable');
const worlds = new Map();
client.on('Runtime.executionContextCreated', (ev) => worlds.set(ev.context.id, ev.context));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
  sessionStorage.setItem('pageTransition', 'true');
  localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(3000);
try {
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
} catch (_e) {
  const sw = ctx.serviceWorkers()[0];
  if (sw) {
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
    });
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 45000 });
  }
}
await page.evaluate(() => {
  const host = document.getElementById('YomuP-popup-container');
  const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
  if (img && !img.classList.contains('active')) img.click();
});

const located = await page.evaluate(() => {
  const needle = '人の感性に寄り添う、EGG MOUSE';
  const el = [...document.querySelectorAll('span, a, div')].find((n) =>
    (n.textContent || '').includes(needle)
  );
  if (!el) return { found: false };
  const titleSpan = [...document.querySelectorAll('span')].find(
    (s) => (s.textContent || '').trim() === needle || (s.textContent || '').includes(needle)
  );
  const target = titleSpan || el;
  target.scrollIntoView({ block: 'center' });
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let textNode = null;
  while (walker.nextNode()) {
    if ((walker.currentNode.textContent || '').includes('EGG')) {
      textNode = walker.currentNode;
      break;
    }
  }
  let x;
  let y;
  if (textNode) {
    const r = document.createRange();
    const t = textNode.textContent || '';
    const i = Math.max(0, t.indexOf('EGG'));
    r.setStart(textNode, i);
    r.setEnd(textNode, Math.min(t.length, i + 3));
    const rect = r.getBoundingClientRect();
    x = rect.left + Math.min(20, rect.width / 2);
    y = rect.top + rect.height / 2;
  } else {
    const rect = target.getBoundingClientRect();
    x = rect.left + 40;
    y = rect.top + 12;
  }
  const td = target.closest('td, th');
  const a = target.closest('a');
  return {
    found: true,
    x,
    y,
    td: td
      ? {
          links: td.querySelectorAll('a[href]').length,
          headings: td.querySelectorAll('h1,h2,h3').length,
          brs: td.querySelectorAll('br').length,
          textLen: (td.textContent || '').trim().length
        }
      : null,
    a: a
      ? {
          cls: String(a.className || '').slice(0, 60),
          href: (a.getAttribute('href') || '').slice(0, 80),
          childTags: [...a.children].map((c) => c.tagName),
          text: (a.textContent || '').trim().slice(0, 80)
        }
      : null,
    efp: (() => {
      const hit = document.elementFromPoint(x, y);
      return hit
        ? { tag: hit.tagName, cls: String(hit.className || '').slice(0, 60) }
        : null;
    })()
  };
});
console.log('located', JSON.stringify(located, null, 2));
if (!located.found) {
  await ctx.close();
  process.exit(2);
}

let yomupCtx = null;
for (const c of [...worlds.values()].sort((a, b) => b.id - a.id)) {
  if (!(c.name && String(c.name).includes('読むプ'))) continue;
  try {
    const probe = await client.send('Runtime.evaluate', {
      expression: 'typeof findHighlightBlockFromPoint',
      contextId: c.id,
      returnByValue: true
    });
    if (probe.result?.value === 'function') {
      yomupCtx = c.id;
      break;
    }
  } catch (_e) {}
}
console.log('yomupCtx', yomupCtx);

const before = await client.send('Runtime.evaluate', {
  contextId: yomupCtx,
  returnByValue: true,
  expression: `(() => {
    const x = ${located.x}, y = ${located.y};
    const block = findHighlightBlockFromPoint(x, y);
    const el = block && block.element;
    const languageMode = 'ja';
    const ctx = resolveHighlightTextContext(block, languageMode, x, y);
    const chunks = buildLogicalChunks(ctx.blockText, languageMode);
    let offset = getCaretOffsetInBlock(block, ctx.segments, x, y);
    const chunk = findChunkContainingOffset(chunks, offset);
    const reasons = [];
    if (!chunk || !(chunk.text || '').trim()) reasons.push('chunk-empty');
    else if (!withinHighlightLimit(chunk.text, languageMode)) {
      reasons.push('over-limit:' + chunk.text.trim().length);
    }
    const range = chunk ? createRangeForChunk(ctx.segments, chunk.start, chunk.end) : null;
    if (chunk && !range) reasons.push('range-null');
    const rects = chunk
      ? getClientRectsForChunkSegments(ctx.segments, chunk.start, chunk.end)
      : [];
    if (chunk && rects.length && !clientPointInClientRects(rects, x, y, {
      lineTolerance: HIGHLIGHT_RECT_MERGE_LINE_TOLERANCE_PX
    })) reasons.push('pointer-outside');
    return {
      tag: el && el.tagName,
      fullCell: shouldUseFullTableCellChunk(block),
      structured: isStructuredTableCellForLineSplit(el),
      ctxLen: (ctx.blockText || '').trim().length,
      offset,
      chunkCount: chunks.length,
      chunkLens: chunks.map((c) => (c.text || '').trim().length),
      chunkHead: chunk ? chunk.text.slice(0, 80) : null,
      chunkLen: chunk ? chunk.text.trim().length : null,
      rectCount: rects.length,
      reasons,
      afterFull: (() => {
        if (!shouldUseFullTableCellChunk(block)) return null;
        const full = { start: 0, end: ctx.blockText.length, text: ctx.blockText };
        return {
          len: full.text.trim().length,
          within: withinHighlightLimit(full.text, languageMode)
        };
      })(),
      lit: tryHighlightLogicalBlockAtPoint(x, y)
    };
  })()`
});
console.log('detail', JSON.stringify(before.result?.value, null, 2));
await ctx.close();
process.exit(0);