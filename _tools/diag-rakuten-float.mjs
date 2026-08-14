/**
 * 楽天 — .float 内 H2/P（返品・チャット等）不発の切り分け
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-rakuten-float');
const URL = 'https://item.rakuten.co.jp/elecom/4549550281768/';
const NEEDLE = '初期不良・返品・交換をご希望の場合';

fs.rmSync(UD, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(UD, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1100, height: 900 }
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
await page.waitForTimeout(3500);
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
await page.waitForTimeout(500);
await page.evaluate(() => {
  const img = document
    .getElementById('YomuP-popup-container')
    ?.shadowRoot?.querySelector('.lightbulb-button img');
  if (img && !img.classList.contains('active')) img.click();
});
await page.waitForFunction(() => {
  const img = document
    .getElementById('YomuP-popup-container')
    ?.shadowRoot?.querySelector('.lightbulb-button img');
  return !!(img && img.classList.contains('active'));
}, { timeout: 10000 });

const located = await page.evaluate((needle) => {
  const p = [...document.querySelectorAll('p')].find((el) =>
    (el.textContent || '').includes(needle)
  );
  if (!p) return { found: false };
  const float = p.closest('.float');
  p.scrollIntoView({ block: 'center' });
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let textNode = null;
  while (walker.nextNode()) {
    if ((walker.currentNode.textContent || '').includes('初期不良')) {
      textNode = walker.currentNode;
      break;
    }
  }
  if (!textNode) return { found: false, reason: 'text' };
  const r = document.createRange();
  const t = textNode.textContent || '';
  const i = t.indexOf('初期不良');
  r.setStart(textNode, Math.max(0, i));
  r.setEnd(textNode, Math.min(t.length, i + 4));
  const rect = r.getBoundingClientRect();
  const anc = [];
  let n = p;
  for (let k = 0; k < 12 && n; k++) {
    anc.push({
      tag: n.tagName,
      cls: String(n.className || '').slice(0, 50),
      id: n.id || ''
    });
    n = n.parentElement;
  }
  return {
    found: true,
    x: rect.left + 12,
    y: rect.top + rect.height / 2,
    pLen: (p.textContent || '').trim().length,
    floatTag: float && float.tagName,
    floatCls: float && String(float.className || ''),
    ancestors: anc,
    hit: (() => {
      const el = document.elementFromPoint(rect.left + 12, rect.top + rect.height / 2);
      return el
        ? { tag: el.tagName, cls: String(el.className || '').slice(0, 60) }
        : null;
    })()
  };
}, NEEDLE);
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

const detail = await client.send('Runtime.evaluate', {
  contextId: yomupCtx,
  returnByValue: true,
  expression: `(() => {
    const x = ${located.x}, y = ${located.y};
    const block = findHighlightBlockFromPoint(x, y);
    const el = block && (block.element || block.container || block.root);
    const languageMode = 'ja';
    const ctx = resolveHighlightTextContext(block, languageMode, x, y);
    const chunks = buildLogicalChunks(ctx.blockText, languageMode);
    let offset = getCaretOffsetInBlock(block, ctx.segments, x, y);
    const chunk = findChunkAtOffset(chunks, offset);
    const reasons = [];
    const maxLen = typeof getJapaneseHighlightMaxLength === 'function'
      ? getJapaneseHighlightMaxLength()
      : (typeof MAX_TEXT_LENGTH_FOR_HIGHLIGHT !== 'undefined' ? MAX_TEXT_LENGTH_FOR_HIGHLIGHT : null);
    const chunkLen = chunk ? (chunk.text || '').trim().length : 0;
    if (!chunk) reasons.push('no-chunk');
    else if (maxLen != null && chunkLen > maxLen) reasons.push('over-limit:' + chunkLen + '>' + maxLen);
    const lit = tryHighlightLogicalBlockAtPoint(x, y);
    const root = document.getElementById('yomup-highlight-overlay-root');
    const segs = root
      ? root.querySelectorAll('.yomup-highlight-underline-segment, .yomup-highlight-underline').length
      : 0;
    return {
      mode: block && block.mode,
      tag: el && el.tagName,
      cls: el ? String(el.className || '').slice(0, 70) : null,
      textLen: el ? (el.textContent || '').trim().length : null,
      textHead: el ? (el.textContent || '').trim().slice(0, 50) : null,
      isTableCell: el && typeof isTableCellHighlightHost === 'function' && isTableCellHighlightHost(el),
      layout: el && typeof isLayoutTableCell === 'function' && isLayoutTableCell(el),
      fullCell: block && typeof shouldUseFullTableCellChunk === 'function' && shouldUseFullTableCellChunk(block),
      ctxLen: (ctx.blockText || '').trim().length,
      chunkCount: chunks.length,
      chunkLens: chunks.map((c) => (c.text || '').trim().length),
      chunkHead: chunk ? chunk.text.slice(0, 60) : null,
      chunkLen,
      maxLen,
      reasons,
      lit,
      segs,
      contentInner: (() => {
        const td = el && el.closest && el.closest('td,th');
        if (!td || typeof findContentTableCellInnerBlockFromPoint !== 'function') return null;
        const inner = findContentTableCellInnerBlockFromPoint(x, y, td);
        const ie = inner && inner.element;
        return inner
          ? {
              mode: inner.mode,
              tag: ie && ie.tagName,
              cls: ie ? String(ie.className || '').slice(0, 50) : null,
              len: ie ? (ie.textContent || '').trim().length : null
            }
          : null;
      })()
    };
  })()`
});
console.log('detail', JSON.stringify(detail.result?.value, null, 2));

// H2 も同様に
const h2 = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find((el) =>
    (el.textContent || '').includes('返品・交換について')
  );
  if (!h) return { found: false };
  h.scrollIntoView({ block: 'center' });
  const r = h.getBoundingClientRect();
  return { found: true, x: r.left + 20, y: r.top + r.height / 2 };
});
if (h2.found) {
  const h2d = await client.send('Runtime.evaluate', {
    contextId: yomupCtx,
    returnByValue: true,
    expression: `(() => {
      const x = ${h2.x}, y = ${h2.y};
      const block = findHighlightBlockFromPoint(x, y);
      const el = block && block.element;
      const lit = tryHighlightLogicalBlockAtPoint(x, y);
      const root = document.getElementById('yomup-highlight-overlay-root');
      const segs = root
        ? root.querySelectorAll('.yomup-highlight-underline-segment, .yomup-highlight-underline').length
        : 0;
      return {
        mode: block && block.mode,
        tag: el && el.tagName,
        cls: el ? String(el.className || '').slice(0, 50) : null,
        text: el ? (el.textContent || '').trim().slice(0, 40) : null,
        len: el ? (el.textContent || '').trim().length : null,
        lit,
        segs
      };
    })()`
  });
  console.log('h2', JSON.stringify(h2d.result?.value, null, 2));
}

await ctx.close();
