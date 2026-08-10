/**
 * SV-3 — Servus HOME NEWS: h5>span>a タイトルが光る／日付 p も光る
 * https://www.servusjapan.com/
 * Usage:
 *   node _tools/probe-servus-home-news-h5a.mjs
 *   node _tools/probe-servus-home-news-h5a.mjs --live
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-servus-home-news-h5a');
const LIVE = process.argv.includes('--live');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';

const LIVE_URL = 'https://www.servusjapan.com/';
const TITLE = '2027年向けエンジニアインターン';
const DATE = '2025年10日21日';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>SV-3 news h5a</title>
<style>
body{font-family:Helvetica,sans-serif;margin:40px;background:#fff}
.grid{display:grid;grid-template-columns:1fr auto;gap:8px 24px;max-width:920px;align-items:end}
h5{margin:0;font-size:15px;font-weight:normal;line-height:normal}
p.date{margin:0;font-size:15px;color:#545454;line-height:normal}
a{color:#000;text-decoration:underline}
.line{grid-column:1/-1;border-bottom:1px solid #ccc;height:1px;margin-top:4px}
</style></head><body>
<div class="grid" data-testid="mesh-container-content">
  <div id="comp-title" class="wixui-rich-text" data-testid="richTextElement">
    <h5 class="font_8 wixui-rich-text__text" style="font-size:15px;line-height:normal;">
      <span style="text-decoration:underline;" class="wixui-rich-text__text">
        <a href="https://www.servusjapan.com/recruit/2027-インターンシップ-エンジニア" target="_self" class="wixui-rich-text__text">${TITLE}募集ページを更新しました</a>
      </span>
    </h5>
  </div>
  <div id="comp-date" class="wixui-rich-text" data-testid="richTextElement">
    <p class="font_7 wixui-rich-text__text date" style="font-size:15px;line-height:normal;">
      <span style="font-size:15px;" class="wixui-rich-text__text">
        <span style="letter-spacing:normal;" class="wixui-rich-text__text">
          <span style="font-family:helvetica-w01-roman,sans-serif;" class="wixui-rich-text__text">
            <span style="color:#545454;" class="wixui-rich-text__text">${DATE}&nbsp;</span>
          </span>
        </span>
      </span>
    </p>
  </div>
  <div class="line"></div>
</div>
</body></html>`;

let targetUrl;
if (LIVE) {
  targetUrl = LIVE_URL;
} else {
  const fixturePath = path.join(os.tmpdir(), 'yomup-sv3-servus-home-news-h5a.html');
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
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(LIVE ? 3500 : 2000);
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
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 45000 });
  }
  await page.evaluate(() => {
    const host = document.getElementById('YomuP-popup-container');
    const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
    if (img && !img.classList.contains('active')) img.click();
  });
}

async function locateNeedle(page, needle) {
  return page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent || '';
      const i = t.indexOf(needle);
      if (i < 0) continue;
      n.parentElement?.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, Math.min(t.length, i + Math.min(8, needle.length)));
      const r = range.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      return { x: r.left + Math.min(24, r.width / 2), y: (r.top + r.bottom) / 2 };
    }
    return null;
  }, needle);
}

async function dispatchMove(page, x, y) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(80);
  await page.mouse.move(x, y);
  await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  }, { x, y });
  await page.waitForTimeout(LIVE ? 1200 : 900);
}

async function measure(page) {
  return page.evaluate((sel) => {
    const segs = [...document.querySelectorAll(sel)].map((e) => {
      const r = e.getBoundingClientRect();
      return { top: Math.round(r.top), width: Math.round(r.width) };
    });
    const tops = [...new Set(segs.filter((s) => s.width > 20).map((s) => s.top))];
    return { lit: segs.length > 0, lineCount: tops.length, segCount: segs.length };
  }, OVERLAY);
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
if (!context.serviceWorkers()[0]) await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());
await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
await preparePage(context, page);
if (LIVE) {
  await page.waitForFunction(
    (needle) => (document.body?.innerText || '').includes(needle),
    TITLE,
    { timeout: 90000 }
  );
  await page.waitForTimeout(2000);
}
console.log('url:', targetUrl);

let failed = 0;

async function assertLit(name, needle) {
  let ok = false;
  for (let i = 0; i < 3; i++) {
    const pt = await locateNeedle(page, needle);
    if (!pt) continue;
    await dispatchMove(page, pt.x, pt.y);
    const m = await measure(page);
    console.log(name, JSON.stringify(m));
    if (m.lit && m.lineCount >= 1) {
      ok = true;
      break;
    }
  }
  if (!ok) {
    console.log(name, 'FAIL');
    failed++;
  } else {
    console.log(name, 'PASS');
  }
}

await assertLit('title-h5a', TITLE);
await assertLit('date-p', DATE);

await context.close();
if (failed) {
  console.log('RESULT FAIL', failed);
  process.exit(1);
}
console.log('RESULT PASS');
