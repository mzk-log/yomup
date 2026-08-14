/**
 * G09 日経 — CDP で block / 点灯可否を確認
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-nikkei-g09-cdp');
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
  localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);
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
await page.evaluate(() => {
  const host = document.getElementById('YomuP-popup-container');
  const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
  if (img && !img.classList.contains('active')) img.click();
});
await page.waitForTimeout(600);

const pt = await page.evaluate(() => {
  const title = document.querySelector('a[class*="titleText"]');
  if (!title) return null;
  title.scrollIntoView({ block: 'center' });
  const r = title.getBoundingClientRect();
  return {
    x: r.left + r.width * 0.35,
    y: r.top + r.height * 0.45,
    text: (title.textContent || '').trim().slice(0, 40)
  };
});
console.log('pt', pt);

async function evalIn(ctxId, expression) {
  return client.send('Runtime.evaluate', {
    expression,
    contextId: ctxId,
    returnByValue: true
  });
}

let yomupCtx = null;
for (const c of [...worlds.values()].sort((a, b) => b.id - a.id)) {
  if (!(c.name && String(c.name).includes('読むプ'))) continue;
  try {
    const probe = await evalIn(c.id, `typeof findHighlightBlockFromPoint`);
    if (probe.result?.value === 'function') {
      yomupCtx = c.id;
      break;
    }
  } catch (_e) {}
}
console.log('yomupCtx', yomupCtx);

if (yomupCtx && pt) {
  const before = await evalIn(
    yomupCtx,
    `(() => {
      const x = ${pt.x}, y = ${pt.y};
      const ghost = typeof isGhostOverlayAtPoint === 'function' && isGhostOverlayAtPoint(x, y);
      const block = findHighlightBlockFromPoint(x, y);
      const efp = document.elementFromPoint(x, y);
      return {
        ghost,
        hl: localStorage.getItem('highLightOnOff'),
        block: block && block.element ? {
          mode: block.mode,
          tag: block.element.tagName,
          cls: String(block.element.className || '').slice(0, 80),
          text: (block.element.textContent || '').trim().slice(0, 60)
        } : block,
        efp: efp ? { tag: efp.tagName, cls: String(efp.className || '').slice(0, 60) } : null
      };
    })()`
  );
  console.log('before', JSON.stringify(before.result?.value ?? before, null, 2));

  await page.mouse.move(pt.x, pt.y);
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    target?.dispatchEvent(new MouseEvent('mousemove', init));
  }, pt);
  await page.waitForTimeout(900);

  const after = await evalIn(
    yomupCtx,
    `(() => {
      const root = document.getElementById('yomup-highlight-overlay-root');
      const segs = root
        ? [...root.querySelectorAll('.yomup-highlight-underline-segment, .yomup-highlight-underline')]
        : [];
      return {
        overlayRoot: !!root,
        segCount: segs.length,
        tops: segs.slice(0, 4).map((s) => Math.round(s.getBoundingClientRect().top))
      };
    })()`
  );
  console.log('after', JSON.stringify(after.result?.value ?? after, null, 2));
}

await ctx.close();
