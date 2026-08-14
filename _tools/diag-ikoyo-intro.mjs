/**
 * Live diag: why intro div.c-container fails to highlight on iko-yo.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-ikoyo-intro-diag');
const LIVE_URL =
  'https://iko-yo.net/facilities?genre_ids%5B%5D=21&prefecture_ids%5B%5D=23';
const NEEDLE = '愛知県にある子供が喜ぶ';

fs.rmSync(USER_DATA, { recursive: true, force: true });

const context = await chromium.launchPersistentContext(USER_DATA, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`
  ],
  viewport: { width: 1280, height: 900 }
});
if (!context.serviceWorkers()[0]) await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());
await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
  sessionStorage.setItem('pageTransition', 'true');
  localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(4500);
try {
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
} catch (_e) {
  const sw = context.serviceWorkers()[0];
  if (sw) {
    try {
      await sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
      });
    } catch (_err) {}
  }
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 45000 });
}
await page.evaluate(() => {
  const host = document.getElementById('YomuP-popup-container');
  const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
  if (img && !img.classList.contains('active')) img.click();
});
await page.waitForTimeout(800);

const pt = await page.evaluate((needle) => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent || '';
    const i = t.indexOf(needle);
    if (i < 0) continue;
    const parent = n.parentElement;
    if (!parent || !parent.closest('div.c-container')) continue;
    parent.scrollIntoView({ block: 'center' });
    const range = document.createRange();
    range.setStart(n, i);
    range.setEnd(n, Math.min(t.length, i + 6));
    const r = range.getBoundingClientRect();
    return {
      x: Math.round(r.left + Math.min(20, r.width / 2)),
      y: Math.round((r.top + r.bottom) / 2),
      hostCls: parent.className?.toString?.()?.slice(0, 80),
      textLen: (parent.textContent || '').trim().length
    };
  }
  return null;
}, NEEDLE);

console.log('pt', JSON.stringify(pt));
if (!pt) {
  await context.close();
  process.exit(1);
}

const diag = await page.evaluate(({ x, y }) => {
  const out = { x, y };
  const el = document.elementFromPoint(x, y);
  out.efp = {
    tag: el?.tagName,
    cls: el?.className?.toString?.()?.slice(0, 100),
    id: el?.id || ''
  };
  const stack = document.elementsFromPoint(x, y).slice(0, 12).map((e) => ({
    tag: e.tagName,
    cls: (e.className?.toString?.() || '').slice(0, 60)
  }));
  out.stack = stack;

  const intro = [...document.querySelectorAll('div.c-container')].find((e) =>
    (e.textContent || '').includes('子供が喜ぶ')
  );
  if (intro) {
    const ir = intro.getBoundingClientRect();
    out.intro = {
      top: ir.top,
      bottom: ir.bottom,
      left: ir.left,
      right: ir.right,
      childElementCount: intro.childElementCount,
      textLen: (intro.textContent || '').trim().length,
      html: intro.innerHTML.slice(0, 200)
    };
  }
  const region = document.querySelector('.l-region');
  if (region) {
    const rr = region.getBoundingClientRect();
    out.region = {
      top: rr.top,
      bottom: rr.bottom,
      left: rr.left,
      right: rr.right,
      containsPoint: x >= rr.left && x <= rr.right && y >= rr.top && y <= rr.bottom,
      text: (region.textContent || '').replace(/\s+/g, ' ').slice(0, 40)
    };
  }

  // Call extension internals if exposed; else mirror key checks via page script injection of getters
  // Content script runs in isolated world — use window hook if any
  out.hasYomup = typeof window.__YOMUP_DEBUG !== 'undefined';

  return out;
}, pt);

console.log('diag', JSON.stringify(diag, null, 2));

// Inject into content-script world via CDP? Playwright can't easily.
// Instead: dispatch mousemove and capture console TRACE
const logs = [];
page.on('console', (msg) => {
  const t = msg.text();
  if (t.includes('[yomup]') || t.includes('TRACE') || t.includes('block')) logs.push(t);
});

await page.evaluate(() => {
  try {
    localStorage.setItem('YomuP_TRACE_HIGHLIGHT', '1');
  } catch (_e) {}
});

await page.mouse.move(4, 4);
await page.waitForTimeout(100);
await page.mouse.move(pt.x, pt.y);
await page.evaluate(
  ({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  },
  pt
);
await page.waitForTimeout(1500);

const segs = await page.evaluate(() => {
  const sel =
    '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';
  return [...document.querySelectorAll(sel)].map((e) => {
    const r = e.getBoundingClientRect();
    return { top: Math.round(r.top), w: Math.round(r.width), left: Math.round(r.left) };
  });
});
console.log('segs', JSON.stringify(segs));
console.log('---logs---');
for (const l of logs.slice(-30)) console.log(l);

await context.close();
