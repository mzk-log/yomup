/**
 * デモ — <p><strong>読むプ</strong>は、… が一文で光る（fixture + mouse）
 * 実行: node _tools/probe-demo-strong-sentence.mjs
 * 任意: --live で GitHub Pages
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-demo-strong');
const LIVE = process.argv.includes('--live');
const LIVE_URL = 'https://mzk-log.github.io/yomup/yomup-demo.html';
const LOCAL = path.resolve(__dirname, '../docs/yomup-demo.html');

fs.rmSync(UD, { recursive: true, force: true });

const ctx = await chromium.launchPersistentContext(UD, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1100, height: 900 }
});
if (!ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const page = ctx.pages()[0] || (await ctx.newPage());
const target = LIVE ? LIVE_URL : 'file:///' + LOCAL.replace(/\\/g, '/');
await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
  sessionStorage.setItem('pageTransition', 'true');
  localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(LIVE ? 2500 : 1500);
try {
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 });
} catch (_e) {
  const sw = ctx.serviceWorkers()[0];
  if (sw) {
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
    });
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 30000 });
  }
}
await page.waitForTimeout(400);
await page.evaluate(() => {
  const img = document
    .getElementById('YomuP-popup-container')
    ?.shadowRoot?.querySelector('.lightbulb-button img');
  if (img && !img.classList.contains('active')) img.click();
});
await page.waitForFunction(() => {
  const img = document
    .getElementById('YomuP-popup-container')
    ?.shadowRoot?.querySelector('.lightbulb-button img');
  return !!(img && img.classList.contains('active'));
}, { timeout: 10000 });
await page.waitForTimeout(400);

const strong = page.locator('strong', { hasText: '読むプ' }).first();
await strong.scrollIntoViewIfNeeded();
await strong.hover({ force: true });
await page.waitForTimeout(800);

const result = await page.evaluate(() => {
  const strongEl = [...document.querySelectorAll('strong')].find(
    (el) => (el.textContent || '').trim() === '読むプ'
  );
  const p = strongEl?.closest('p');
  const root = document.getElementById('yomup-highlight-overlay-root');
  const segs = root
    ? [...root.querySelectorAll('.yomup-highlight-underline-segment, .yomup-highlight-underline')]
    : [];
  if (!p || segs.length === 0) {
    return { ok: false, reason: 'no-overlay', segCount: segs.length };
  }
  const pBox = p.getBoundingClientRect();
  const strongBox = strongEl.getBoundingClientRect();
  const hitsP = segs.some((s) => {
    const b = s.getBoundingClientRect();
    return b.left < pBox.right && b.right > pBox.left && b.top < pBox.bottom && b.bottom > pBox.top;
  });
  // 一文全体: 下線幅が strong だけより明らかに広い
  const maxW = Math.max(...segs.map((s) => s.getBoundingClientRect().width), 0);
  const coversBeyondStrong = maxW > strongBox.width * 1.8;
  return {
    ok: hitsP && coversBeyondStrong,
    hitsP,
    coversBeyondStrong,
    segCount: segs.length,
    maxW: Math.round(maxW),
    strongW: Math.round(strongBox.width)
  };
});

console.log('url:', target);
console.log(JSON.stringify(result, null, 2));
await ctx.close();
if (!result.ok) {
  console.log('RESULT FAIL');
  process.exit(1);
}
console.log('RESULT PASS');
process.exit(0);
