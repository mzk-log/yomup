/**
 * RK-1 live — probe と同型の MouseEvent 経路を診断
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-rakuten-topics-live3');
const URL = 'https://item.rakuten.co.jp/elecom/4549550281768/';
const NEEDLE = '人の感性に寄り添う、EGG MOUSE';

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
});
await page.waitForTimeout(800);

const pageInfo = await page.evaluate((needle) => {
  const title = [...document.querySelectorAll('span')].find((s) =>
    (s.textContent || '').includes(needle)
  );
  if (!title) return { found: false };
  title.scrollIntoView({ block: 'center' });
  const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
  let textNode = null;
  while (walker.nextNode()) {
    if ((walker.currentNode.textContent || '').includes('EGG') ||
        (walker.currentNode.textContent || '').includes(needle.slice(0, 4))) {
      textNode = walker.currentNode;
      break;
    }
  }
  if (!textNode) textNode = title.firstChild;
  const r = document.createRange();
  const t = textNode.textContent || '';
  const i = Math.max(0, t.indexOf(needle.slice(0, 2)) >= 0 ? t.indexOf(needle.slice(0, 2)) : 0);
  r.setStart(textNode, i);
  r.setEnd(textNode, Math.min(t.length, i + 4));
  const rect = r.getBoundingClientRect();
  const x = rect.left + Math.min(16, rect.width / 2);
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  return {
    found: true,
    x,
    y,
    titleTag: title.tagName,
    titleCls: String(title.className || '').slice(0, 80),
    hitTag: hit && hit.tagName,
    hitCls: hit ? String(hit.className || '').slice(0, 80) : null,
    hitId: hit && hit.id,
    highLightOnOff: localStorage.getItem('highLightOnOff'),
    bulbActive: !!document
      .getElementById('YomuP-popup-container')
      ?.shadowRoot?.querySelector('.lightbulb-button img.active')
  };
}, NEEDLE);
console.log('pageInfo', pageInfo);

let yomupCtx = null;
for (const c of [...worlds.values()].sort((a, b) => b.id - a.id)) {
  if (!(c.name && String(c.name).includes('読むプ'))) continue;
  try {
    const probe = await client.send('Runtime.evaluate', {
      expression: 'typeof handleMouseMove === "function" ? "hmm" : typeof tryHighlightLogicalBlockAtPoint',
      contextId: c.id,
      returnByValue: true
    });
    if (probe.result?.value) {
      yomupCtx = c.id;
      break;
    }
  } catch (_e) {}
}

// 1) synthetic mousemove like probe
await page.evaluate(({ x, y }) => {
  document.dispatchEvent(
    new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y, view: window })
  );
  document.elementFromPoint(x, y)?.dispatchEvent(
    new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y, view: window })
  );
}, { x: pageInfo.x, y: pageInfo.y });
await page.waitForTimeout(800);

const afterSynthetic = await page.evaluate(() => {
  const root = document.getElementById('yomup-highlight-overlay-root');
  return {
    segs: root
      ? root.querySelectorAll('.yomup-highlight-underline-segment, .yomup-highlight-underline').length
      : 0,
    probe: root?.getAttribute('data-yomup-probe') || null
  };
});
console.log('afterSynthetic', afterSynthetic);

// 2) CDP tryHighlight
const afterTry = await client.send('Runtime.evaluate', {
  contextId: yomupCtx,
  returnByValue: true,
  expression: `(() => {
    const x = ${pageInfo.x}, y = ${pageInfo.y};
    const lit = tryHighlightLogicalBlockAtPoint(x, y);
    const root = document.getElementById('yomup-highlight-overlay-root');
    const segs = root
      ? root.querySelectorAll('.yomup-highlight-underline-segment, .yomup-highlight-underline').length
      : 0;
    const block = findHighlightBlockFromPoint(x, y);
    return {
      lit,
      segs,
      mode: block && block.mode,
      tag: block && block.element && block.element.tagName,
      cls: block && block.element ? String(block.element.className || '').slice(0, 60) : null
    };
  })()`
});
console.log('afterTry', afterTry.result?.value);

// 3) real playwright mouse
await page.mouse.move(pageInfo.x, pageInfo.y);
await page.waitForTimeout(800);
const afterMouse = await page.evaluate(() => {
  const root = document.getElementById('yomup-highlight-overlay-root');
  return {
    segs: root
      ? root.querySelectorAll('.yomup-highlight-underline-segment, .yomup-highlight-underline').length
      : 0
  };
});
console.log('afterMouse', afterMouse);

await ctx.close();
