import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.pw-user-data'), {
  channel: 'chromium', headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1280, height: 900 }
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://www.nikkei.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});
const bulb = page.locator('#YomuP-popup-container').locator('.lightbulb-button img');
if (await bulb.count()) await bulb.click().catch(() => {});
await page.waitForTimeout(500);

const point = await page.evaluate(() => {
  const card = [...document.querySelectorAll('a[class*="blockLink"]')].find(a =>
    (a.textContent || '').includes('DAZN')
  );
  const bodyP = [...(card?.parentElement?.querySelectorAll('p') || [])].find(p =>
    (p.textContent || '').includes('サッカーワールド')
  );
  if (!bodyP) return null;
  bodyP.scrollIntoView({ block: 'center' });
  const tw = document.createTreeWalker(bodyP, NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) {
    const t = tw.currentNode.textContent || '';
    if (!t.includes('サッカーワールド')) continue;
    const rg = document.createRange();
    rg.setStart(tw.currentNode, 0);
    rg.setEnd(tw.currentNode, 6);
    const r = rg.getBoundingClientRect();
    return { x: r.left + 30, y: r.top + r.height / 2, bodyTop: r.top };
  }
  return null;
});
if (!point) { console.log('no point'); await ctx.close(); process.exit(1); }

await page.mouse.move(point.x, point.y);
await page.evaluate(({ x, y }) => {
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
}, point);
await page.waitForTimeout(1000);

const info = await page.evaluate((bodyTop) => {
  const segs = [...document.querySelectorAll('#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline')];
  const h2 = document.querySelector('h2.title_tlmhwm6, h2[class*="title"]');
  const h2Top = h2 ? Math.round(h2.getBoundingClientRect().top) : null;
  return {
    overlayCount: segs.length,
    overlayTops: segs.slice(0, 8).map(s => Math.round(s.getBoundingClientRect().top)),
    bodyTop: Math.round(bodyTop),
    h2Top,
    nearBody: segs.some(s => Math.abs(s.getBoundingClientRect().top - bodyTop) < 30),
    nearTitle: segs.some(s => h2Top != null && Math.abs(s.getBoundingClientRect().top - h2Top) < 30)
  };
}, point.bodyTop);
console.log(JSON.stringify({ point, info }, null, 2));
await ctx.close();
