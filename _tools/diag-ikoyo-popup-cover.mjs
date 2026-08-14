/**
 * If YomuP popup covers intro, does highlight fail?
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-ikoyo-popup-cover');
const LIVE_URL =
  'https://iko-yo.net/facilities?genre_ids%5B%5D=21&prefecture_ids%5B%5D=23';
const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';
const HOST_SEL = '.c-container--sm > div.c-container';

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
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(4000);
await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 45000 });
await page.evaluate(() => {
  const host = document.getElementById('YomuP-popup-container');
  const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
  if (img && !img.classList.contains('active')) img.click();
});
await page.waitForTimeout(400);

const info = await page.evaluate((hostSel) => {
  const host = document.querySelector(hostSel);
  host.scrollIntoView({ block: 'center' });
  const hr = host.getBoundingClientRect();
  const popup = document.getElementById('YomuP-popup-container');
  const pr = popup.getBoundingClientRect();
  // move popup over intro center
  popup.style.setProperty('--YomuP-popup-top', `${Math.round(hr.top)}px`);
  popup.style.setProperty('--YomuP-popup-left', `${Math.round(hr.left)}px`);
  popup.style.top = `${Math.round(hr.top)}px`;
  popup.style.left = `${Math.round(hr.left)}px`;
  const pr2 = popup.getBoundingClientRect();
  const x = Math.round(hr.left + 40);
  const y = Math.round(hr.top + 12);
  const efp = document.elementFromPoint(x, y);
  return {
    intro: { top: hr.top, left: hr.left, bottom: hr.bottom, right: hr.right },
    popupBefore: { top: pr.top, left: pr.left, w: pr.width, h: pr.height },
    popupAfter: { top: pr2.top, left: pr2.left, w: pr2.width, h: pr2.height },
    x,
    y,
    efpTag: efp?.tagName,
    efpId: efp?.id,
    efpCls: String(efp?.className || '').slice(0, 40)
  };
}, HOST_SEL);
console.log('info', JSON.stringify(info, null, 2));

await page.mouse.move(info.x, info.y);
await page.evaluate(
  ({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  },
  info
);
await page.waitForTimeout(1200);

const after = await page.evaluate(
  ({ overlaySel, hostSel }) => {
    const host = document.querySelector(hostSel);
    const hr = host.getBoundingClientRect();
    const root = document.getElementById('yomup-highlight-overlay-root');
    const segs = [...document.querySelectorAll(overlaySel)];
    return {
      rootChildCount: root?.childElementCount,
      hostLit: segs.some((e) => {
        const r = e.getBoundingClientRect();
        const mid = (r.top + r.bottom) / 2;
        return r.w > 5 || (r.width > 5 && mid >= hr.top - 2 && mid <= hr.bottom + 2);
      }),
      segCount: segs.length,
      efp: (() => {
        const e = document.elementFromPoint(
          Math.round(hr.left + 40),
          Math.round(hr.top + 12)
        );
        return { id: e?.id, tag: e?.tagName };
      })()
    };
  },
  { overlaySel: OVERLAY, hostSel: HOST_SEL }
);
console.log('afterCover', JSON.stringify(after, null, 2));
console.log(after.segCount > 0 ? 'COVERED STILL LIT' : 'COVERED DARK (popup blocks)');
await context.close();
