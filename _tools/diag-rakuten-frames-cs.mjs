/**
 * 各楽天 iframe に content script が入っているか CDP で列挙
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-rakuten-frames-cs');
const URL = 'https://item.rakuten.co.jp/elecom/4549550281768/';

fs.rmSync(UD, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(UD, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1100, height: 1000 }
});
if (!ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const page = ctx.pages()[0] || (await ctx.newPage());
const client = await ctx.newCDPSession(page);
await client.send('Runtime.enable');
await client.send('Page.enable');
const worlds = [];
client.on('Runtime.executionContextCreated', (ev) => worlds.push(ev.context));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 180000 }).catch(() => {});
await page.waitForTimeout(5000);
for (let i = 0; i < 15; i++) {
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(400);
}
await page.waitForTimeout(3000);

console.log('playwright frames:');
for (const f of page.frames()) {
  console.log(' -', f.url().slice(0, 120));
}

const yomup = worlds.filter((w) => w.name && String(w.name).includes('読むプ'));
console.log('yomup world count', yomup.length);
for (const w of yomup) {
  try {
    const probe = await client.send('Runtime.evaluate', {
      contextId: w.id,
      returnByValue: true,
      expression: `({ href: location.href, ready: document.readyState })`
    });
    console.log(' cs', w.id, probe.result?.value);
  } catch (e) {
    console.log(' cs err', w.id, e.message);
  }
}

// Try SW scripting.executeScript allFrames
const sw = ctx.serviceWorkers()[0];
const inj = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (!tabId) return { err: 'no tab' };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        href: location.href,
        hasFind: typeof findHighlightBlockFromPoint,
        // isolated world of executeScript is NEW world, not content_scripts world
        yomupPopup: !!document.getElementById('YomuP-popup-container'),
        overlay: !!document.getElementById('yomup-highlight-overlay-root'),
        marker: document.documentElement.getAttribute('data-yomup-cs')
      })
    });
    return { count: results.length, results };
  } catch (e) {
    return { err: String(e) };
  }
});
console.log('executeScript allFrames', JSON.stringify(inj, null, 2));

await ctx.close();
