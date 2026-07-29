/**
 * AT-2 live diag — 実URLでホスト/チャンク/下線行数を出す
 * 実行: node _tools/probe-aichi-te-except-live.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-aichi-te-except-live');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const URL = 'https://aichi-te-jh.aichi-c.ed.jp/cms/';
const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
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
  await page.waitForTimeout(500);
}

async function hoverAt(page, point) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(120);
  await page.mouse.move(point.x, point.y, { steps: 8 });
  await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  }, point);
  await page.waitForTimeout(900);
}

async function measure(page) {
  return page.evaluate((sel) => {
    const segs = [...document.querySelectorAll(sel)].map((e) => {
      const r = e.getBoundingClientRect();
      return { top: Math.round(r.top), w: Math.round(r.width), bottom: Math.round(r.bottom) };
    });
    const tops = [...new Set(segs.map((s) => s.top))];
    return {
      segCount: segs.length,
      distinctTops: tops.length,
      segs,
      popup: !!document.getElementById('YomuP-popup-container'),
      hlRoot: !!document.getElementById('yomup-highlight-overlay-root')
    };
  }, OVERLAY);
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

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await preparePage(context, page);

const meta = await page.evaluate(() => {
  const except = document.querySelector('div.except');
  except.scrollIntoView({ block: 'center' });
  const tn = [...except.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
  const text = tn.textContent;
  const period = text.indexOf('。');
  const wraps = [];
  let lastTop = null;
  for (let i = 0; i < period; i++) {
    const r = document.createRange();
    r.setStart(tn, i);
    r.setEnd(tn, i + 1);
    const top = Math.round(r.getBoundingClientRect().top);
    if (lastTop === null) lastTop = top;
    if (top !== lastTop) {
      wraps.push({ i, top, ch: text[i] });
      lastTop = top;
    }
  }
  const wrapAt = wraps[0] ? wraps[0].i : Math.floor(period / 2);
  const mk = (from, len) => {
    const r = document.createRange();
    r.setStart(tn, from);
    r.setEnd(tn, Math.min(text.length, from + len));
    const b = r.getBoundingClientRect();
    return { x: b.left + Math.min(20, b.width / 2), y: (b.top + b.bottom) / 2, from, text: text.slice(from, from + len) };
  };
  return {
    period,
    wrapAt,
    wraps,
    lineTops: wraps.length ? [wraps[0].top - 20, wraps[0].top] : [],
    line1: mk(Math.max(1, Math.floor(wrapAt / 2)), 4),
    line2: mk(Math.min(period - 4, wrapAt + 5), 4),
    exceptBox: (() => {
      const r = except.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width) };
    })()
  };
});
console.log('meta', JSON.stringify(meta, null, 2));

await hoverAt(page, meta.line1);
const m1 = await measure(page);
console.log('line1-hover', JSON.stringify(m1, null, 2));

await hoverAt(page, meta.line2);
const m2 = await measure(page);
console.log('line2-hover', JSON.stringify(m2, null, 2));

const pass =
  m1.segCount >= 2 &&
  m1.distinctTops >= 2 &&
  m2.segCount >= 2 &&
  m2.distinctTops >= 2;

console.log(
  pass
    ? 'RESULT: PASS (multi-line underline on both hovers)'
    : `RESULT: FAIL line1Tops=${m1.distinctTops} line2Tops=${m2.distinctTops}`
);

await context.close();
process.exit(pass ? 0 : 1);
