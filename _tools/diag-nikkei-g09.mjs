/**
 * G09 日経トップ — probe 不達 / title 不点灯の切り分け
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-nikkei-g09-diag');
fs.rmSync(UD, { recursive: true, force: true });

const ctx = await chromium.launchPersistentContext(UD, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`
  ],
  viewport: { width: 1280, height: 900 }
});
if (!ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://www.nikkei.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
  sessionStorage.setItem('pageTransition', 'true');
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
let popupOk = false;
try {
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 });
  popupOk = true;
} catch (_e) {
  const sw = ctx.serviceWorkers()[0];
  if (sw) {
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
    });
    try {
      await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 30000 });
      popupOk = true;
    } catch (_e2) {
      popupOk = false;
    }
  }
}
console.log('popupOk', popupOk);

const info = await page.evaluate(() => {
  const titles = [...document.querySelectorAll('a[class*="titleText"]')].slice(0, 5).map((a) => ({
    cls: String(a.className).slice(0, 80),
    text: (a.textContent || '').trim().slice(0, 60),
    w: a.getBoundingClientRect().width,
    h: a.getBoundingClientRect().height
  }));
  const sampleCards = [...document.querySelectorAll('a[class*="blockLink"]')]
    .slice(0, 8)
    .map((a) => (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80));
  const daznOrSoccer = [...document.querySelectorAll('a[class*="blockLink"]')].some((a) =>
    /DAZN|サッカーワールド/.test(a.textContent || '')
  );
  return {
    titleCount: document.querySelectorAll('a[class*="titleText"]').length,
    titles,
    daznOrSoccer,
    sampleCards,
    overlayRoot: !!document.getElementById('yomup-highlight-overlay-root'),
    popup: !!document.getElementById('YomuP-popup-container'),
    href: location.href,
    title: document.title
  };
});
console.log('page', JSON.stringify(info, null, 2));

if (info.titleCount > 0) {
  const pt = await page.evaluate(() => {
    const title = document.querySelector('a[class*="titleText"]');
    title.scrollIntoView({ block: 'center' });
    const r = title.getBoundingClientRect();
    return {
      x: r.left + r.width * 0.35,
      y: r.top + r.height * 0.45,
      text: (title.textContent || '').trim().slice(0, 40)
    };
  });
  await page.mouse.move(pt.x, pt.y);
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    target?.dispatchEvent(new MouseEvent('mousemove', init));
  }, pt);
  await page.waitForTimeout(700);
  const lit = await page.evaluate((p) => {
    const root = document.getElementById('yomup-highlight-overlay-root');
    const segs = root
      ? root.querySelectorAll(
          '.yomup-highlight-underline-segment, .yomup-highlight-underline, .yomup-highlight-outline'
        )
      : [];
    const efp = document.elementFromPoint(p.x, p.y);
    const stack = document.elementsFromPoint(p.x, p.y).slice(0, 8).map((el) => ({
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 60),
      id: el.id || ''
    }));
    return {
      pt: p,
      segCount: segs.length,
      efp: efp
        ? {
            tag: efp.tagName,
            cls: String(efp.className || '').slice(0, 80),
            text: (efp.textContent || '').trim().slice(0, 40)
          }
        : null,
      stack
    };
  }, pt);
  console.log('hover', JSON.stringify(lit, null, 2));
}

await ctx.close();
