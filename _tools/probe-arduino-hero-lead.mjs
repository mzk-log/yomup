/**
 * AL-8 — Arduino top hero-lead: 「できた！」内の！で文分割しない
 * URL: https://mzk-log.github.io/arduino/
 * 実行: node _tools/probe-arduino-hero-lead.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-arduino-hero-lead');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

const LINE2 = '自分に合ったコースから、一つずつ「できた！」を増やしていきます。';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>AL-8 fixture</title>
<style>
  body { font-family: "Yu Gothic", sans-serif; font-size: 18px; line-height: 1.8; max-width: 720px; margin: 40px; }
  .hero-lead { margin: 1em 0; }
</style></head><body>
<p class="hero-lead" id="hero">
  パソコンとArduinoで、プログラムの基本から電子工作まで段階的に学ぼう。<br>
  自分に合ったコースから、一つずつ「できた！」を増やしていきます。
</p>
</body></html>`;

const fixturePath = path.join(os.tmpdir(), 'yomup-al8-fixture.html');
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
  viewport: { width: 1280, height: 900 }
});
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());

await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await preparePage(context, page);

const point = await page.evaluate((needle) => {
  const p = document.getElementById('hero');
  const tn = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('できた'));
  if (!tn) return null;
  const idx = tn.textContent.indexOf('できた');
  const range = document.createRange();
  range.setStart(tn, idx);
  range.setEnd(tn, idx + 3);
  const r = range.getBoundingClientRect();
  // full line2 range for expected width
  const full = document.createRange();
  const start = tn.textContent.indexOf('自分に合った');
  const end = tn.textContent.indexOf('。', start) + 1;
  full.setStart(tn, start);
  full.setEnd(tn, end);
  const fr = full.getBoundingClientRect();
  const bangOnly = document.createRange();
  const bi = tn.textContent.indexOf('「できた！」');
  bangOnly.setStart(tn, bi);
  bangOnly.setEnd(tn, bi + 6);
  const br = bangOnly.getBoundingClientRect();
  return {
    x: r.left + 8,
    y: (r.top + r.bottom) / 2,
    fullW: Math.round(fr.width),
    bangW: Math.round(br.width),
    line2: tn.textContent.slice(start, end)
  };
}, LINE2);

if (!point) {
  console.log('FAIL locate');
  await context.close();
  process.exit(1);
}
console.log('point', point);

await hoverAt(page, point);
const m = await page.evaluate((sel) => {
  const segs = [...document.querySelectorAll(sel)].map((e) => {
    const r = e.getBoundingClientRect();
    return { top: Math.round(r.top), w: Math.round(r.width), left: Math.round(r.left) };
  });
  const unionW = segs.reduce((s, g) => s + g.w, 0);
  return { lit: segs.length > 0, segCount: segs.length, unionW, segs };
}, OVERLAY);

console.log('measure', m);

// 旧不具合: 「できた！」までで切れ unionW ≒ bangW
// 期待: 第2文全体 ≈ fullW（1行なら）
const notTruncatedAtBang = m.lit && m.unionW > point.bangW + 40;
const nearFull = m.unionW >= point.fullW * 0.85;
const ok = notTruncatedAtBang && nearFull;

console.log(
  ok
    ? 'RESULT: PASS (line2 kept whole past 「できた！」)'
    : `RESULT: FAIL unionW=${m.unionW} bangW=${point.bangW} fullW=${point.fullW}`
);

await context.close();
process.exit(ok ? 0 : 1);
