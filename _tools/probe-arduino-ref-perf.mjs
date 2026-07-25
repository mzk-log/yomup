/**
 * AL-7: Arduino ref 目次型 TD — 折り返し・長文説明・H1/リンク分離
 * Usage: node _tools/probe-arduino-ref-perf.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-arduino-ref-perf');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const URL = 'https://www.musashinodenpa.com/arduino/ref/';
const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
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

async function hover(page, x, y) {
  await page.mouse.move(x, y);
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    target?.dispatchEvent(new MouseEvent('mousemove', init));
  }, { x, y });
}

async function readSegs(page) {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((e) => {
      const r = e.getBoundingClientRect();
      return { top: Math.round(r.top), w: Math.round(r.width) };
    });
  }, OVERLAY);
}

async function probeText(page, needle) {
  const loc = await page.evaluate((needle) => {
    const td = [...document.querySelectorAll('td')].find((el) =>
      (el.textContent || '').includes(needle)
    );
    if (!td) return null;
    const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
    let textNode = null;
    while (walker.nextNode()) {
      if ((walker.currentNode.textContent || '').includes(needle)) {
        textNode = walker.currentNode;
        break;
      }
    }
    if (!textNode) return null;
    const tmp = document.createElement('span');
    textNode.parentNode.insertBefore(tmp, textNode);
    tmp.scrollIntoView({ block: 'center' });
    tmp.remove();
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    const r = rects[0];
    return {
      x: Math.round(r.left + Math.min(40, r.width / 2)),
      y: Math.round(r.top + r.height / 2),
      textLen: (textNode.textContent || '').length,
      wrapCount: rects.length,
    };
  }, needle);
  if (!loc) return { needle, ok: false, reason: 'not-found' };
  await page.mouse.move(4, 4);
  await page.waitForTimeout(80);
  await hover(page, loc.x, loc.y);
  await page.waitForTimeout(450);
  const segs = await readSegs(page);
  return {
    needle,
    textLen: loc.textLen,
    wrapCount: loc.wrapCount,
    segCount: segs.length,
    segs,
    ok: segs.length > 0 && segs.every((s) => s.w < 900),
  };
}

const context = await chromium.launchPersistentContext(USER_DATA, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] || (await context.newPage());
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await preparePage(context, page);

const target = await page.evaluate(() => {
  const td = [...document.querySelectorAll('td')].find((el) =>
    (el.textContent || '').includes('Arduino言語はC/C++')
  );
  if (!td) return null;
  const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
  let textNode = null;
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent || '';
    if (t.includes('C/C++をベース')) {
      textNode = walker.currentNode;
      break;
    }
  }
  if (!textNode) return null;
  const range = document.createRange();
  range.selectNodeContents(textNode);
  const wraps = [...range.getClientRects()]
    .filter((r) => r.width > 0)
    .map((r) => ({
      x: Math.round(r.left + Math.min(40, r.width / 2)),
      y: Math.round(r.top + r.height / 2),
      top: Math.round(r.top),
      w: Math.round(r.width),
    }));
  const h1 = [...td.querySelectorAll('h1')].find((h) =>
    (h.textContent || '').includes('Arduino言語')
  );
  const setup = [...td.querySelectorAll('a')].find((a) =>
    (a.textContent || '').includes('setup()')
  );
  return {
    wraps,
    h1: h1
      ? {
          x: Math.round(h1.getBoundingClientRect().left + 20),
          y: Math.round(h1.getBoundingClientRect().top + h1.getBoundingClientRect().height / 2),
        }
      : null,
    setup: setup
      ? {
          x: Math.round(setup.getBoundingClientRect().left + 10),
          y: Math.round(
            setup.getBoundingClientRect().top + setup.getBoundingClientRect().height / 2
          ),
        }
      : null,
  };
});

if (!target || !target.wraps || target.wraps.length < 2) {
  console.error('FAIL: wrap targets not found', target);
  await context.close();
  process.exit(1);
}

await page.mouse.move(4, 4);
await page.waitForTimeout(100);
await hover(page, target.wraps[0].x, target.wraps[0].y);
await page.waitForTimeout(450);
const line0 = await readSegs(page);

let h1Segs = null;
if (target.h1) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(100);
  await hover(page, target.h1.x, target.h1.y);
  await page.waitForTimeout(450);
  h1Segs = await readSegs(page);
}

let setupSegs = null;
if (target.setup) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(100);
  await hover(page, target.setup.x, target.setup.y);
  await page.waitForTimeout(450);
  setupSegs = await readSegs(page);
}

const longProse = await probeText(page, 'min()、max()、abs()');

const multiWrapOk = line0.length >= 2;
const proseNotWholeCell = line0.every((s) => s.w < 900);
const h1Ok = !h1Segs || (h1Segs.length >= 1 && h1Segs.every((s) => s.w < 400));
const setupOk = !setupSegs || (setupSegs.length >= 1 && setupSegs.every((s) => s.w < 200));
const longOk = longProse.ok && longProse.textLen > 105;

console.log({
  line0,
  h1Segs,
  setupSegs,
  longProse,
  multiWrapOk,
  proseNotWholeCell,
  h1Ok,
  setupOk,
  longOk,
});

const pass = multiWrapOk && proseNotWholeCell && h1Ok && setupOk && longOk;
console.log(pass ? 'PASS: AL-7 layout-td prose' : 'FAIL: AL-7');
await context.close();
process.exit(pass ? 0 : 2);
