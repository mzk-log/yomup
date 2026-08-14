/**
 * G09 — hit-stack 各段の ghost/candidate 判定
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-nikkei-stack');
fs.rmSync(UD, { recursive: true, force: true });

const ctx = await chromium.launchPersistentContext(UD, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1280, height: 900 }
});
if (!ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const page = ctx.pages()[0] || (await ctx.newPage());
const client = await ctx.newCDPSession(page);
await client.send('Runtime.enable');
const worlds = new Map();
client.on('Runtime.executionContextCreated', (ev) => worlds.set(ev.context.id, ev.context));

await page.goto('https://www.nikkei.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
  sessionStorage.setItem('pageTransition', 'true');
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);
await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 45000 });
await page.evaluate(() => {
  const host = document.getElementById('YomuP-popup-container');
  const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
  if (img && !img.classList.contains('active')) img.click();
});

const pt = await page.evaluate(() => {
  const title = document.querySelector('a[class*="titleText"]');
  title.scrollIntoView({ block: 'center' });
  const r = title.getBoundingClientRect();
  return { x: r.left + r.width * 0.35, y: r.top + r.height * 0.45 };
});

let yomupCtx = null;
for (const c of [...worlds.values()].sort((a, b) => b.id - a.id)) {
  if (!(c.name && String(c.name).includes('読むプ'))) continue;
  try {
    const probe = await client.send('Runtime.evaluate', {
      expression: 'typeof findHighlightBlockFromPoint',
      contextId: c.id,
      returnByValue: true
    });
    if (probe.result?.value === 'function') {
      yomupCtx = c.id;
      break;
    }
  } catch (_e) {}
}

const r = await client.send('Runtime.evaluate', {
  contextId: yomupCtx,
  returnByValue: true,
  expression: `(() => {
    const x = ${pt.x}, y = ${pt.y};
    const stack = document.elementsFromPoint(x, y).slice(0, 12);
    const rows = stack.map((el, i) => ({
      i,
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 55),
      ghost: isGhostOverlayLink(el),
      cand: isHitStackBlockCandidate(el),
      visual: elementVisuallyContainsPoint(el, x, y),
      contain: getContainingTextRectsForPoint(el, x, y).length,
      text: (el.textContent || '').trim().slice(0, 36)
    }));
    const best = pickBestHitStackBlockFromPoint(x, y, stack);
    return {
      rows,
      best: best
        ? { tag: best.tagName, cls: String(best.className || '').slice(0, 55) }
        : null,
      block: (() => {
        const b = findHighlightBlockFromPoint(x, y);
        return b && b.element
          ? { mode: b.mode, tag: b.element.tagName, cls: String(b.element.className || '').slice(0, 55) }
          : b;
      })()
    };
  })()`
});
console.log(JSON.stringify(r.result?.value, null, 2));
await ctx.close();
