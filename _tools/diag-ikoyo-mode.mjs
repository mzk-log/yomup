/**
 * Compare full vs progress underline mode on iko-yo intro.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..');
const LIVE_URL =
  'https://iko-yo.net/facilities?genre_ids%5B%5D=21&prefecture_ids%5B%5D=23';
const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';
const HOST_SEL = '.c-container--sm > div.c-container';

async function runMode(mode) {
  const USER_DATA = path.join(__dirname, `.pw-ikoyo-mode-${mode}`);
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
  await page.evaluate((mode) => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
    localStorage.setItem('YomuP_highlightUnderlineMode', mode);
  }, mode);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(4000);
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 });
  } catch (_e) {
    const sw = context.serviceWorkers()[0];
    if (sw) {
      await sw
        .evaluate(async () => {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
        })
        .catch(() => {});
    }
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 45000 });
  }
  await page.evaluate(() => {
    const host = document.getElementById('YomuP-popup-container');
    const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
    if (img && !img.classList.contains('active')) img.click();
  });
  await page.waitForTimeout(400);

  const modeRead = await page.evaluate(() => localStorage.getItem('YomuP_highlightUnderlineMode'));

  const pt = await page.evaluate((hostSel) => {
    const host = document.querySelector(hostSel);
    host.scrollIntoView({ block: 'center' });
    const text = host.firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    const r = range.getBoundingClientRect();
    return { x: Math.round(r.left + 10), y: Math.round((r.top + r.bottom) / 2) };
  }, HOST_SEL);

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

  const samples = [];
  let elapsed = 0;
  for (const wait of [200, 800, 1500, 3000]) {
    await page.waitForTimeout(wait - elapsed);
    elapsed = wait;
    const m = await page.evaluate(
      ({ overlaySel, hostSel }) => {
        const host = document.querySelector(hostSel);
        const hr = host.getBoundingClientRect();
        const segs = [...document.querySelectorAll(overlaySel)].map((e) => {
          const r = e.getBoundingClientRect();
          return { top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        });
        const hostLit = segs.some((s) => {
          const mid = s.top + s.h / 2;
          return s.w > 5 && mid >= hr.top - 2 && mid <= hr.bottom + 2;
        });
        return { hostLit, segCount: segs.length, segs };
      },
      { overlaySel: OVERLAY, hostSel: HOST_SEL }
    );
    m.waitMs = wait;
    samples.push(m);
  }

  await context.close();
  return { mode, modeRead, pt, samples };
}

console.log('EXT', EXTENSION_PATH);
for (const mode of ['full', 'progress']) {
  const r = await runMode(mode);
  console.log(JSON.stringify(r, null, 2));
  const anyLit = r.samples.some((s) => s.hostLit);
  console.log(mode, anyLit ? 'LIT' : 'DARK');
}
