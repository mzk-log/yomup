/**
 * RK-2 — 各フレームの highLightOnOff / listeners を scripting で確認
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-rakuten-float-hl');
const URL = 'https://item.rakuten.co.jp/elecom/4549550281768/';
const NEEDLE = '初期不良・返品・交換をご希望の場合';

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

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
  sessionStorage.setItem('pageTransition', 'true');
  localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(3500);
try {
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
} catch (_e) {
  const sw = ctx.serviceWorkers()[0];
  if (sw) {
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
    });
  }
}
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
await page.waitForTimeout(800);

for (let i = 0; i < 12; i++) {
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(300);
}
await page.waitForTimeout(1500);

const sw = ctx.serviceWorkers()[0];
const states = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  const storage = await chrome.storage.local.get(['highLightOnOff']);
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => ({
      href: location.href,
      isTop: (() => {
        try {
          return window === window.top;
        } catch (_e) {
          return false;
        }
      })(),
      hl: typeof highLightOnOff !== 'undefined' ? highLightOnOff : null,
      listeners:
        typeof highlightListenersAttached !== 'undefined'
          ? highlightListenersAttached
          : null,
      hasFind: typeof findHighlightBlockFromPoint === 'function',
      hasSet: typeof setHighlightModeEnabled === 'function'
    })
  });
  return {
    storage,
    frames: results
      .map((r) => r.result)
      .filter(
        (r) =>
          r &&
          (r.hasFind ||
            (r.href && (r.href.includes('footer') || r.href.includes('item.rakuten'))))
      )
  };
});
console.log(JSON.stringify(states, null, 2));

// Force enable in footer + tryHighlight via scripting
const forced = await sw.evaluate(async (needle) => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (needleText) => {
      if (!location.href.includes('footer.html')) return { skip: true, href: location.href };
      if (typeof setHighlightModeEnabled === 'function') {
        setHighlightModeEnabled(true, { skipPersist: true });
      }
      const p = [...document.querySelectorAll('p')].find((el) =>
        (el.textContent || '').includes(needleText)
      );
      if (!p) return { skip: false, reason: 'no-p' };
      p.scrollIntoView({ block: 'center' });
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let tn = null;
      while (walker.nextNode()) {
        if ((walker.currentNode.textContent || '').includes('初期不良')) {
          tn = walker.currentNode;
          break;
        }
      }
      if (!tn) return { skip: false, reason: 'no-text' };
      const r = document.createRange();
      const t = tn.textContent || '';
      const i = t.indexOf('初期不良');
      r.setStart(tn, Math.max(0, i));
      r.setEnd(tn, Math.min(t.length, i + 4));
      const rect = r.getBoundingClientRect();
      const x = rect.left + 12;
      const y = rect.top + rect.height / 2;
      const lit =
        typeof tryHighlightLogicalBlockAtPoint === 'function'
          ? tryHighlightLogicalBlockAtPoint(x, y)
          : false;
      const root = document.getElementById('yomup-highlight-overlay-root');
      const segs = root
        ? root.querySelectorAll('.yomup-highlight-underline-segment, .yomup-highlight-underline')
            .length
        : 0;
      const block =
        typeof findHighlightBlockFromPoint === 'function'
          ? findHighlightBlockFromPoint(x, y)
          : null;
      const el = block && block.element;
      return {
        skip: false,
        hl: highLightOnOff,
        listeners: highlightListenersAttached,
        lit,
        segs,
        mode: block && block.mode,
        tag: el && el.tagName,
        text: el ? (el.textContent || '').trim().slice(0, 50) : null,
        x,
        y
      };
    },
    args: [needle]
  });
  return results.map((r) => r.result).filter((r) => r && !r.skip);
}, NEEDLE);
console.log('forced', JSON.stringify(forced, null, 2));

await ctx.close();
