import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-jal-underline');
fs.rmSync(USER_DATA, { recursive: true, force: true });

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

const context = await chromium.launchPersistentContext(USER_DATA, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  viewport: { width: 1280, height: 900 }
});
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());

await page.goto('https://www.jal.co.jp/jp/ja/jmb/jalpay/jgw/', {
  waitUntil: 'domcontentloaded',
  timeout: 90000
});
await preparePage(context, page);

const heading = page.locator('h3.ttlLv2 span.heading').first();
await heading.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);

const info = await page.evaluate(() => {
  const h3 = document.querySelector('h3.ttlLv2');
  const label = h3?.querySelector('.stepLabel');
  const heading = h3?.querySelector('.heading');
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      cls: String(el.className || ''),
      text: (el.textContent || '').trim().slice(0, 40),
      top: Math.round(r.top * 10) / 10,
      bottom: Math.round(r.bottom * 10) / 10,
      left: Math.round(r.left * 10) / 10,
      width: Math.round(r.width),
      height: Math.round(r.height),
      display: cs.display,
      lineHeight: cs.lineHeight,
      fontSize: cs.fontSize,
      verticalAlign: cs.verticalAlign
    };
  };
  let textRect = null;
  if (heading && heading.firstChild) {
    const range = document.createRange();
    range.selectNodeContents(heading.firstChild.nodeType === 3 ? heading.firstChild : heading);
    const r = range.getBoundingClientRect();
    textRect = {
      top: Math.round(r.top * 10) / 10,
      bottom: Math.round(r.bottom * 10) / 10,
      height: Math.round(r.height * 10) / 10,
      width: Math.round(r.width)
    };
  }
  return {
    h3: box(h3),
    label: box(label),
    heading: box(heading),
    textRect,
    html: h3?.outerHTML?.slice(0, 300)
  };
});
console.log('DOM', JSON.stringify(info, null, 2));

const hr = info.heading;
await page.mouse.move(4, 4);
await page.waitForTimeout(100);
const x = hr.left + Math.min(40, hr.width / 3);
const y = (hr.top + hr.bottom) / 2;
await page.mouse.move(x, y);
await page.evaluate(({ x, y }) => {
  const t = document.elementFromPoint(x, y);
  const init = { bubbles: true, clientX: x, clientY: y, view: window };
  document.dispatchEvent(new MouseEvent('mousemove', init));
  t?.dispatchEvent(new MouseEvent('mousemove', init));
}, { x, y });
await page.waitForTimeout(500);

const measure = await page.evaluate(({ x, y, overlaySel, textBottom, textTop }) => {
  const hit = document.elementFromPoint(x, y);
  const segs = [...document.querySelectorAll(overlaySel)].map((e) => {
    const r = e.getBoundingClientRect();
    return {
      top: Math.round(r.top * 10) / 10,
      bottom: Math.round(r.bottom * 10) / 10,
      left: Math.round(r.left * 10) / 10,
      width: Math.round(r.width),
      height: Math.round(r.height * 10) / 10
    };
  });
  const mid = textTop + (textBottom - textTop) / 2;
  return {
    hit: hit ? `${hit.tagName}.${String(hit.className || '').slice(0, 40)}` : null,
    segs,
    textTop,
    textBottom,
    underlineTop: segs[0] ? segs[0].top : null,
    belowMidline: segs.length ? segs[0].top >= mid - 2 : null,
    nearBottom: segs.length ? Math.abs(segs[0].top - textBottom) <= 6 : null
  };
}, {
  x,
  y,
  overlaySel: OVERLAY,
  textBottom: info.textRect?.bottom ?? hr.bottom,
  textTop: info.textRect?.top ?? hr.top
});
console.log('HL', JSON.stringify(measure, null, 2));
if (!measure.segs.length) {
  console.log('FAIL: no underline');
  process.exitCode = 1;
} else if (!measure.belowMidline) {
  console.log('FAIL: underline above text midline');
  process.exitCode = 1;
} else {
  console.log('PASS: underline below midline');
}
await context.close();
