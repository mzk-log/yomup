/**
 * AS-1 — 愛西市: 横並び rect の下線 Y が文字上にずれる
 * - 暮らしの情報: li > .date + .list > a（絵文字見出し）
 * - お知らせ: a > 本文 + span.date
 * Usage:
 *   node _tools/probe-aisai-side-by-side-underline.mjs
 *   node _tools/probe-aisai-side-by-side-underline.mjs --live
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-aisai-side-by-side-underline');
const LIVE = process.argv.includes('--live');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';

const CASES = LIVE
  ? [
      {
        name: 'recommend-emoji',
        url: 'https://www.city.aisai.lg.jp/category/3-0-0-0-0-0-0-0-0-0.html',
        needle: 'オリンピアン'
      },
      {
        name: 'notice-date-span',
        url: 'https://www.city.aisai.lg.jp/category/1-0-0-0-0-0-0-0-0-0.html',
        needle: '物価高騰対応支援金'
      }
    ]
  : [
      {
        name: 'fixture-date-span',
        url: null,
        needle: '物価高騰対応支援金'
      },
      {
        name: 'fixture-li-date-list',
        url: null,
        needle: 'オリンピアン'
      }
    ];

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>AS-1</title>
<style>
  body { font-family: "Yu Gothic", sans-serif; font-size: 16px; margin: 40px; line-height: 1.6; }
  ul { list-style: none; padding: 0; }
  li.rec { display: flex; gap: 12px; align-items: baseline; margin: 16px 0; }
  li.rec .date { color: #666; flex: 0 0 auto; }
  li.rec .list a { color: #a65; text-decoration: none; }
  .file a { display: inline; color: #222; text-decoration: none; }
  .file .date { color: #888; font-size: 0.85em; }
</style></head><body>
<ul>
  <li class="rec" id="rec">
    <div class="date">6月23日</div>
    <div class="list"><a href="#">【アジア競技大会推進事業】🚣オリンピアンが教えるボート教室を開催しました！</a></div>
  </li>
</ul>
<p class="file" id="file">
  <a href="#">【申請受付終了（令和8年6月30日）】愛西市物価高騰対応支援金について<span class="date">&nbsp;[2026年8月7日]</span></a>
</p>
</body></html>`;

let fixtureUrl = null;
if (!LIVE) {
  const fixturePath = path.join(os.tmpdir(), 'yomup-as1-side-by-side.html');
  fs.writeFileSync(fixturePath, FIXTURE, 'utf8');
  fixtureUrl = 'file:///' + fixturePath.replace(/\\/g, '/');
  for (const c of CASES) c.url = fixtureUrl;
}

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
      if (el?.scrollIntoView) el.scrollIntoView({ block: 'center' });
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
  await page.waitForTimeout(800);
}

async function measure(page, textTop, textBottom) {
  return page.evaluate(
    ({ sel, textTop, textBottom }) => {
      const segs = [...document.querySelectorAll(sel)].map((e) => {
        const r = e.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, width: r.width };
      });
      const mid = (textTop + textBottom) / 2;
      const onTop = segs.some((s) => s.bottom <= mid && s.width > 40);
      const belowOrNearBottom = segs.some(
        (s) => s.top >= textBottom - 6 && s.top <= textBottom + 4 && s.width > 40
      );
      return {
        lit: segs.length > 0,
        segCount: segs.length,
        segs,
        onTop,
        belowOrNearBottom,
        textTop,
        textBottom
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
    `--load-extension=${EXTENSION_PATH}`,
    '--allow-file-access-from-files'
  ],
  viewport: { width: 1280, height: 900 }
});
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());

let failed = 0;
for (const c of CASES) {
  await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await preparePage(context, page);
  console.log('case:', c.name, c.url);

  let pt = null;
  for (let i = 0; i < 3; i++) {
    pt = await locateNeedle(page, c.needle);
    if (!pt) break;
    await dispatchMove(page, pt.x, pt.y);
    const m = await measure(page, pt.textTop, pt.textBottom);
    console.log('measure:', JSON.stringify(m, null, 2));
    const pass = m.lit && m.belowOrNearBottom && !m.onTop;
    if (pass) {
      console.log('PASS', c.name);
      break;
    }
    if (i === 2) {
      console.log('FAIL', c.name);
      failed++;
    }
  }
  if (!pt) {
    console.log('FAIL locate', c.name);
    failed++;
  }
}

await context.close();
process.exit(failed ? 1 : 0);
