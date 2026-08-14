/**
 * footer iframe の sandbox / 属性確認
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-rakuten-float-attrs');
const URL = 'https://item.rakuten.co.jp/elecom/4549550281768/';

fs.rmSync(UD, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(UD, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1100, height: 1000 }
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(4000);
for (let i = 0; i < 12; i++) {
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(250);
}

const info = await page.evaluate(() => {
  const iframes = [...document.querySelectorAll('iframe')].map((f) => ({
    src: (f.getAttribute('src') || '').slice(0, 140),
    name: f.name,
    id: f.id,
    sandbox: f.getAttribute('sandbox'),
    csp: f.getAttribute('csp'),
    referrerpolicy: f.getAttribute('referrerpolicy'),
    loading: f.getAttribute('loading'),
    w: f.offsetWidth,
    h: f.offsetHeight,
    srcdoc: f.hasAttribute('srcdoc')
  }));
  return iframes;
});
console.log(JSON.stringify(info, null, 2));

const frame = page.frames().find((f) => (f.url() || '').includes('footer.html'));
if (frame) {
  const fr = await frame.evaluate(() => ({
    href: location.href,
    ready: document.readyState,
    yomupFlag: window.YOMUP_CONTENT_SCRIPT_LOADED === true,
    scriptCount: document.scripts.length,
    // extension content scripts don't set page-world flag if isolated — check marker in DOM
    hasOverlay: !!document.getElementById('yomup-highlight-overlay-root'),
    hasPopup: !!document.getElementById('YomuP-popup-container')
  }));
  console.log('frame', fr);
}

// Navigate directly to footer with extension
const page2 = await ctx.newPage();
await page2.goto('https://www.rakuten.ne.jp/gold/elecom/elecom/footer.html', {
  waitUntil: 'domcontentloaded',
  timeout: 60000
});
await page2.waitForTimeout(2000);
await page2.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
  sessionStorage.setItem('pageTransition', 'true');
});
await page2.reload({ waitUntil: 'domcontentloaded' });
await page2.waitForTimeout(3500);
try {
  await page2.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 15000 });
  console.log('direct footer: popup OK');
} catch (_e) {
  console.log('direct footer: no popup');
}
const direct = await page2.evaluate(() => ({
  hasPopup: !!document.getElementById('YomuP-popup-container'),
  text: (document.body?.innerText || '').includes('返品・交換')
}));
console.log('direct', direct);

await ctx.close();
