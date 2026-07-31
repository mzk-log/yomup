/**
 * CP-3 — 見出し h1 内 UI（custom element）を語数・下線から除外
 * 代表: Chrome docs Program Policies 型
 * 実行: node _tools/probe-heading-chrome-ui.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-heading-chrome-ui');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CP-3</title>
<style>
  body { font-family: Arial, sans-serif; margin: 40px; font-size: 28px; }
  h1 { display: flex; align-items: center; gap: 12px; }
  fake-actions { font-size: 12px; color: #666; }
</style></head><body>
<h1 class="devsite-page-title" id="title">
  Program Policies
  <fake-actions data-nosnippet="">
    <button>Dismiss</button>
    <button>Got it</button>
    <span>Stay organized with collections Save and categorize content based on your preferences Copy page as markdown bookmark action</span>
  </fake-actions>
</h1>
</body></html>`;

const fixturePath = path.join(os.tmpdir(), 'yomup-cp3-fixture.html');
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

const metrics = await page.evaluate(() => {
  const h1 = document.getElementById('title');
  const tn = [...h1.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('Program'));
  const titleRange = document.createRange();
  const start = tn.textContent.indexOf('Program');
  titleRange.setStart(tn, start);
  titleRange.setEnd(tn, start + 'Program Policies'.length);
  const tr = titleRange.getBoundingClientRect();
  const full = h1.getBoundingClientRect();
  return {
    x: tr.left + 20,
    y: (tr.top + tr.bottom) / 2,
    titleW: Math.round(tr.width),
    fullW: Math.round(full.width)
  };
});

await hoverAt(page, metrics);

const overlay = await page.evaluate((sel) => {
  const segs = [...document.querySelectorAll(sel)];
  if (!segs.length) return { count: 0, width: 0 };
  let left = Infinity;
  let right = -Infinity;
  for (const s of segs) {
    const r = s.getBoundingClientRect();
    if (r.width <= 0) continue;
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  }
  return { count: segs.length, width: right > left ? Math.round(right - left) : 0 };
}, OVERLAY);

// タイトル幅に近く、h1 全体（UI込み）より明らかに狭いこと
const nearTitle = overlay.count > 0 && overlay.width >= metrics.titleW * 0.7 && overlay.width <= metrics.titleW * 1.35;
const notFullH1 = overlay.width < metrics.fullW * 0.75;
const ok = nearTitle && notFullH1;

console.log(
  `${ok ? 'PASS' : 'FAIL'} CP-3: overlay=${overlay.count} w=${overlay.width} titleW=${metrics.titleW} fullW=${metrics.fullW}`
);

await context.close();
fs.rmSync(USER_DATA, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
