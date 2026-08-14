/**
 * Inspect c-ad-information overlap with intro on live iko-yo.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = 'C:/Users/hidenori/Downloads/yomup';
const USER_DATA = path.join(__dirname, '.pw-ikoyo-ad');
const LIVE_URL =
  'https://iko-yo.net/facilities?genre_ids%5B%5D=21&prefecture_ids%5B%5D=23';

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
await page.waitForTimeout(5000);

const info = await page.evaluate(() => {
  const intro = document.querySelector('.c-container--sm > div.c-container');
  const ad = document.querySelector('.c-information.c-ad-information');
  const ir = intro.getBoundingClientRect();
  const ar = ad ? ad.getBoundingClientRect() : null;
  const points = [
    { x: 292, y: 390 },
    { x: 417, y: 403 },
    { x: Math.round(ir.left + 40), y: Math.round(ir.top + 12) }
  ];
  return {
    intro: { top: ir.top, bottom: ir.bottom, left: ir.left, right: ir.right, w: ir.width, h: ir.height },
    ad: ad
      ? {
          top: ar.top,
          bottom: ar.bottom,
          left: ar.left,
          right: ar.right,
          w: ar.width,
          h: ar.height,
          html: ad.outerHTML.slice(0, 500),
          childTags: [...ad.children].map((c) => c.tagName + (c.id ? '#' + c.id : '') + '.' + String(c.className || '').slice(0, 40)),
          textLen: (ad.textContent || '').trim().length
        }
      : null,
    hits: points.map((p) => ({
      ...p,
      efp: (() => {
        const e = document.elementFromPoint(p.x, p.y);
        return e
          ? { tag: e.tagName, cls: String(e.className || '').slice(0, 60), id: e.id }
          : null;
      })(),
      stack: document.elementsFromPoint(p.x, p.y).slice(0, 8).map((e) => ({
        tag: e.tagName,
        cls: String(e.className || '').slice(0, 50),
        id: e.id
      }))
    }))
  };
});
console.log(JSON.stringify(info, null, 2));
await context.close();
