/**
 * AS-2 — 愛西市 soshiki: inner-card 誤認で下線が文字中央に寄る
 * https://www.city.aisai.lg.jp/soshiki/1-10-5-0-0_1.html
 * Usage:
 *   node _tools/probe-aisai-soshiki-inner-card-li.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-aisai-soshiki-inner-card-li');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const URL = 'https://www.city.aisai.lg.jp/soshiki/1-10-5-0-0_1.html';
const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';

const CASES = [
  { name: 'digital-course', needle: '女性のためのデジタル' },
  { name: 'reemployment', needle: '再就職を考えている女性' }
];

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
    localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 });
  } catch (_e) {
    const sw = context.serviceWorkers()[0];
    if (sw) {
      await sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
      });
    }
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 30000 });
  }
}

async function locateNeedle(page, needle) {
  return page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent || '';
      const i = t.indexOf(needle);
      if (i < 0) continue;
      const el = n.parentElement;
      el?.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, Math.min(t.length, i + Math.min(4, needle.length)));
      const r = range.getBoundingClientRect();
      if (r.width < 2) continue;
      const a = el?.closest?.('a') || el;
      const titleRange = document.createRange();
      titleRange.selectNodeContents(a);
      // title text node only (exclude date span metrics if possible)
      let textBottom = r.bottom;
      let textTop = r.top;
      for (const child of a.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && (child.textContent || '').trim()) {
          const tr = document.createRange();
          tr.selectNodeContents(child);
          const br = tr.getBoundingClientRect();
          if (br.height > 0) {
            textTop = br.top;
            textBottom = br.bottom;
          }
          break;
        }
      }
      return {
        x: r.left + Math.min(24, r.width / 2),
        y: (r.top + r.bottom) / 2,
        textTop,
        textBottom,
        liTag: !!el?.closest?.('li')
      };
    }
    return null;
  }, needle);
}

async function dispatchMove(page, x, y) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(50);
  await page.mouse.move(x, y);
  await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  }, { x, y });
  await page.waitForTimeout(900);
}

async function measure(page, textTop, textBottom) {
  return page.evaluate(
    ({ sel, textTop, textBottom }) => {
      const segs = [...document.querySelectorAll(sel)].map((e) => {
        const r = e.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, width: r.width };
      });
      const mid = (textTop + textBottom) / 2;
      // mid-glyph / strikethrough: segment through middle half of glyphs
      const throughMid = segs.some(
        (s) => s.width > 40 && s.top < mid + 2 && s.bottom > mid - 2 && s.top < textBottom - 6
      );
      const nearBottom = segs.some(
        (s) => s.width > 40 && s.top >= textBottom - 6 && s.top <= textBottom + 4
      );
      return {
        lit: segs.length > 0,
        segs,
        throughMid,
        nearBottom,
        textTop,
        textBottom,
        mid
      };
    },
    { sel: OVERLAY, textTop, textBottom }
  );
}

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
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await preparePage(context, page);

let failed = 0;
for (const c of CASES) {
  console.log('case:', c.name);
  let pass = false;
  for (let i = 0; i < 3; i++) {
    const pt = await locateNeedle(page, c.needle);
    if (!pt) {
      console.log('FAIL locate', c.name);
      failed++;
      break;
    }
    await dispatchMove(page, pt.x, pt.y);
    const m = await measure(page, pt.textTop, pt.textBottom);
    console.log('measure:', JSON.stringify(m, null, 2));
    pass = m.lit && m.nearBottom && !m.throughMid;
    if (pass) {
      console.log('PASS', c.name);
      break;
    }
  }
  if (!pass) {
    console.log('FAIL', c.name);
    failed++;
  }
}

await context.close();
process.exit(failed ? 1 : 0);
