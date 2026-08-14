/**
 * RK-1 live — 修正後の block / lit 確認
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-rakuten-topics-live2');
const URL = 'https://item.rakuten.co.jp/elecom/4549550281768/';
const NEEDLE = '人の感性に寄り添う、EGG MOUSE';

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
await page.waitForTimeout(4000);
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
  // cookie 系ボタンがあれば閉じる
  const btns = [...document.querySelectorAll('button, a')];
  for (const b of btns) {
    const t = (b.textContent || '').trim();
    if (/同意|Accept|OK|閉じる/.test(t) && b.offsetParent) {
      try { b.click(); } catch (_e) {}
    }
  }
});
await page.waitForTimeout(800);

const pt = await page.evaluate((needle) => {
  const span = [...document.querySelectorAll('span')].find((s) =>
    (s.textContent || '').includes(needle)
  );
  if (!span) return { found: false };
  span.scrollIntoView({ block: 'center' });
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let n = null;
  while (walker.nextNode()) {
    if ((walker.currentNode.textContent || '').includes('EGG')) {
      n = walker.currentNode;
      break;
    }
  }
  if (!n) return { found: false, reason: 'text' };
  const r = document.createRange();
  const t = n.textContent || '';
  const i = t.indexOf('EGG');
  r.setStart(n, i);
  r.setEnd(n, Math.min(t.length, i + 3));
  const rect = r.getBoundingClientRect();
  return {
    found: true,
    x: rect.left + 10,
    y: rect.top + rect.height / 2,
    spanCls: String(span.className || '').slice(0, 60),
    spanLen: (span.textContent || '').trim().length
  };
}, NEEDLE);
console.log('pt', pt);
if (!pt.found) {
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
    const x = ${pt.x}, y = ${pt.y};
    const block = findHighlightBlockFromPoint(x, y);
    const el = block && block.element;
    const inlineOk = el && isInlineTextHostElement(el);
    const score = el ? scoreInlineTextHostCandidate(el, x, y) : null;
    const lit = tryHighlightLogicalBlockAtPoint(x, y);
    const root = document.getElementById('yomup-highlight-overlay-root');
    const segs = root
      ? root.querySelectorAll('.yomup-highlight-underline-segment, .yomup-highlight-underline').length
      : 0;
    return {
      mode: block && block.mode,
      tag: el && el.tagName,
      cls: el ? String(el.className || '').slice(0, 70) : null,
      text: el ? (el.textContent || '').trim().slice(0, 60) : null,
      textLen: el ? (el.textContent || '').trim().length : null,
      inlineOk,
      score,
      fullCell: block && shouldUseFullTableCellChunk(block),
      lit,
      segs
    };
  })()`
});
console.log(JSON.stringify(detail.result?.value, null, 2));
await ctx.close();
