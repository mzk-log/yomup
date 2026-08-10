/**
 * AS-3 — 愛西市: <caption> が光らない／同表 td は退行なし
 * https://www.city.aisai.lg.jp/0000018333.html
 * Usage:
 *   node _tools/probe-aisai-table-caption.mjs
 *   node _tools/probe-aisai-table-caption.mjs --live
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-aisai-table-caption');
const LIVE = process.argv.includes('--live');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';

const LIVE_URL = 'https://www.city.aisai.lg.jp/0000018333.html';
const CAPTION = '愛西市市民協働課';
const CELL_LINK = '女性のためのデジタル人材育成講座';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>AS-3 caption</title>
<style>
  body { font-family: "Yu Gothic", sans-serif; font-size: 16px; margin: 40px; line-height: 1.5; }
  table { border-collapse: collapse; width: 100%; }
  caption { caption-side: top; text-align: left; font-weight: bold; padding: 12px 8px; }
  th, td { border: 1px solid #ccc; padding: 8px; vertical-align: top; }
</style></head><body>
<div class="mol_tableblock">
<table>
  <caption>${CAPTION}</caption>
  <tbody>
    <tr><th>名称</th><th>開催日時・場所</th></tr>
    <tr><td><a href="#">${CELL_LINK}</a></td><td>全5回　午前10時～正午</td></tr>
  </tbody>
</table>
</div>
</body></html>`;

let targetUrl;
if (LIVE) {
  targetUrl = LIVE_URL;
} else {
  const fixturePath = path.join(os.tmpdir(), 'yomup-as3-table-caption.html');
  fs.writeFileSync(fixturePath, FIXTURE, 'utf8');
  targetUrl = 'file:///' + fixturePath.replace(/\\/g, '/');
}

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
    localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
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
      } catch (_err) {
        /* ignore */
      }
    }
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 30000 });
  }
  await page.waitForTimeout(500);
}

async function locateText(page, needle, preferTag) {
  return page.evaluate(
    ({ needle, preferTag }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.textContent || '';
        const i = t.indexOf(needle);
        if (i < 0) continue;
        const el = n.parentElement;
        if (preferTag && !el?.closest?.(preferTag)) continue;
        el?.scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, Math.min(t.length, i + Math.min(4, needle.length)));
        const r = range.getBoundingClientRect();
        if (r.width < 2) continue;
        return {
          x: r.left + Math.min(24, r.width / 2),
          y: (r.top + r.bottom) / 2,
          textTop: r.top,
          textBottom: r.bottom
        };
      }
      return null;
    },
    { needle, preferTag: preferTag || null }
  );
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
  await page.waitForTimeout(800);
}

async function measureLit(page, textTop, textBottom) {
  return page.evaluate(
    ({ sel, textTop, textBottom }) => {
      const segs = [...document.querySelectorAll(sel)].map((e) => {
        const r = e.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, width: r.width, left: r.left };
      });
      const near = segs.some(
        (s) => s.width > 20 && s.top >= textBottom - 8 && s.top <= textBottom + 6
      );
      return { lit: segs.length > 0, nearBottom: near, segCount: segs.length, segs };
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
    `--load-extension=${EXTENSION_PATH}`,
    '--allow-file-access-from-files'
  ],
  viewport: { width: 1280, height: 900 }
});
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());

await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
await preparePage(context, page);
console.log('url:', targetUrl);

let failed = 0;

async function tryCase(name, needle, preferTag, requireNearBottom) {
  for (let i = 0; i < 3; i++) {
    const pt = await locateText(page, needle, preferTag);
    if (!pt) {
      if (i === 2) {
        console.log('FAIL locate', name);
        failed++;
      }
      continue;
    }
    await dispatchMove(page, pt.x, pt.y);
    const m = await measureLit(page, pt.textTop, pt.textBottom);
    console.log(name + ':', JSON.stringify(m));
    const ok = m.lit && (!requireNearBottom || m.nearBottom);
    if (ok) {
      console.log('PASS', name);
      return;
    }
    if (i === 2) {
      console.log('FAIL', name);
      failed++;
    }
  }
}

await tryCase('caption', CAPTION, 'caption', true);
await tryCase('cell-link', CELL_LINK, 'a', false);

await context.close();
process.exit(failed ? 1 : 0);
