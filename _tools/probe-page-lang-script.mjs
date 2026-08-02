/**
 * GL-2 — 全体カウント TreeWalker が <script> 内 JS を拾い英語誤判定しないこと
 * 代表: Yahoo 台風情報型（本文 ja + 先頭 script 大量ラテン）
 * 実行: node _tools/probe-page-lang-script.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-page-lang-script');
fs.rmSync(USER_DATA, { recursive: true, force: true });

// 先頭 script をラテン過多にして、除外なしだと en になる量を入れる
const latinPad = Array.from({ length: 120 }, (_, i) =>
  `window.__pad${i} = function padBlock${i}(value) { return String(value).toLowerCase(); };`
).join('\n');

// main/article 無し → findPageMainContentRoot は body（Yahoo 台風と同型）
// script を body 先頭に置き、除外なしだと先頭4000字がラテン過多で en になる
const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>GL-2</title></head><body>
<script>
window.googletag = window.googletag || {cmd: []};
${latinPad}
</script>
<h1>台風情報</h1>
<div class="typhoonCondition_contents">
  非常に強い台風13号は、南鳥島近海にあって、時速25キロで西北西へ進んでいます。
  この台風は、今後も西よりに進み、小笠原諸島に接近するおそれがあります。
</div>
</body></html>`;

const fixturePath = path.join(os.tmpdir(), 'yomup-gl2-fixture.html');
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

const info = await page.evaluate(() => {
  const host = document.getElementById('YomuP-popup-container');
  const root = host?.shadowRoot;
  const total = root?.querySelector('.total-info')?.textContent || '';
  const speed = root?.querySelector('.reading-speed-select')?.selectedOptions?.[0]?.textContent || '';
  return { total, speed };
});

const usesJaUnits = /字/.test(info.total) && !/語/.test(info.total);
const speedJa = /字\/分/.test(info.speed) && !/語\/分/.test(info.speed);
const ok = usesJaUnits && speedJa;

console.log(
  `${ok ? 'PASS' : 'FAIL'} GL-2: total="${info.total}" speed="${info.speed}"`
);

await context.close();
fs.rmSync(USER_DATA, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
