/**
 * JS-1 — 素の dd（直テキスト）ソフト折り返しで文途中切れしないこと
 * 代表: JSAE 開催概要 免責事項
 * 実行: node _tools/probe-plain-dd-wrap.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-plain-dd-wrap');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

const SENTENCE2 = '主催者は、事前の予告なくイベントの開催を中止することがあります。';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>JS-1</title>
<style>
  body { margin: 24px; font-size: 16px; line-height: 2; font-family: "Hiragino Sans", "Noto Sans JP", sans-serif; }
  dl { width: 420px; }
  dd { margin: 0; }
</style></head><body>
<dl>
  <dt>免責事項</dt>
  <dd id="target">大会参加に際し生じた事故、損害については、主催者、後援、協賛およびスポンサー企業は、一切の責任を負わないこととします。 ${SENTENCE2}</dd>
</dl>
</body></html>`;

const fixturePath = path.join(os.tmpdir(), 'yomup-js1-fixture.html');
fs.writeFileSync(fixturePath, FIXTURE, 'utf8');
const fixtureUrl = 'file:///' + fixturePath.replace(/\\/g, '/');

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
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

async function hoverAt(page, point) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(80);
  await page.mouse.move(point.x, point.y, { steps: 6 });
  await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  }, point);
  await page.waitForTimeout(700);
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
  viewport: { width: 900, height: 700 }
});
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());

await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await preparePage(context, page);

const metrics = await page.evaluate((sentence2) => {
  const dd = document.getElementById('target');
  const tn = dd.firstChild;
  const full = tn.textContent;
  const start = full.indexOf(sentence2);
  const end = start + sentence2.length;
  const rFull = document.createRange();
  rFull.setStart(tn, start);
  rFull.setEnd(tn, end);
  const rects = [...rFull.getClientRects()];
  const tops = [...new Set(rects.map((r) => Math.round(r.top)))].sort((a, b) => a - b);
  // 2行目中央を hover（折り返し前提）
  const line2 = rects.filter((r) => Math.abs(Math.round(r.top) - tops[tops.length - 1]) <= 2);
  const box = line2[0] || rects[rects.length - 1];
  let expectedRight = -Infinity;
  let expectedLeft = Infinity;
  let expectedBottom = -Infinity;
  for (const r of rects) {
    expectedRight = Math.max(expectedRight, r.right);
    expectedLeft = Math.min(expectedLeft, r.left);
    expectedBottom = Math.max(expectedBottom, r.bottom);
  }
  return {
    x: box.left + Math.min(40, box.width / 2),
    y: (box.top + box.bottom) / 2,
    visualLines: tops.length,
    expectedRight: Math.round(expectedRight),
    expectedLeft: Math.round(expectedLeft),
    expectedBottom: Math.round(expectedBottom),
    sentenceLen: sentence2.length
  };
}, SENTENCE2);

if (metrics.visualLines < 2) {
  console.log(`FAIL JS-1: fixture did not soft-wrap (lines=${metrics.visualLines})`);
  await context.close();
  process.exit(1);
}

await hoverAt(page, metrics);

const overlay = await page.evaluate((sel) => {
  const segs = [...document.querySelectorAll(sel)];
  if (!segs.length) return { count: 0, right: 0, left: 0, bottom: 0, tops: [] };
  let left = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const tops = [];
  for (const s of segs) {
    const r = s.getBoundingClientRect();
    if (r.width <= 0) continue;
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
    tops.push(Math.round(r.top));
  }
  return {
    count: segs.length,
    left: Math.round(left),
    right: Math.round(right),
    bottom: Math.round(bottom),
    tops: [...new Set(tops)].sort((a, b) => a - b)
  };
}, OVERLAY);

// 2文目の末尾付近まで下線が伸び、複数視覚行にまたがること
const reachesEnd = overlay.count > 0 && overlay.right >= metrics.expectedRight - 24;
const spansWrap = overlay.tops.length >= 2;
const ok = reachesEnd && spansWrap;

console.log(
  `${ok ? 'PASS' : 'FAIL'} JS-1: overlay=${overlay.count} right=${overlay.right}/${metrics.expectedRight} tops=${overlay.tops.join(',')} lines=${metrics.visualLines}`
);

await context.close();
fs.rmSync(USER_DATA, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
