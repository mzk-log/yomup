/**
 * Probe weather h4 on iko-yo facilities page.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-ikoyo-weather');
const LIVE_URL =
  'https://iko-yo.net/facilities?genre_ids%5B%5D=21&prefecture_ids%5B%5D=23';
const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';
const HOST_SEL = 'h4.c-heading--normal.c-side-title';
const NEEDLE = '今日・明日の天気予報';

fs.rmSync(USER_DATA, { recursive: true, force: true });
console.log('EXT', EXTENSION_PATH);

const context = await chromium.launchPersistentContext(USER_DATA, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`
  ],
  viewport: { width: 1280, height: 900 }
});
if (!context.serviceWorkers()[0]) await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());
const client = await context.newCDPSession(page);
await client.send('Runtime.enable');
const worlds = new Map();
client.on('Runtime.executionContextCreated', (ev) => worlds.set(ev.context.id, ev.context));

await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
  sessionStorage.setItem('pageTransition', 'true');
  localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(4000);
try {
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 });
} catch (_e) {
  const sw = context.serviceWorkers()[0];
  if (sw) {
    await sw
      .evaluate(async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
      })
      .catch(() => {});
  }
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 45000 });
}
await page.evaluate(() => {
  const host = document.getElementById('YomuP-popup-container');
  const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
  if (img && !img.classList.contains('active')) img.click();
});
await page.waitForTimeout(500);

const pt = await page.evaluate(
  ({ hostSel, needle }) => {
    const host = [...document.querySelectorAll(hostSel)].find((el) =>
      (el.textContent || '').includes(needle)
    );
    if (!host) return { found: false };
    host.scrollIntoView({ block: 'center' });
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent || '';
      const i = t.indexOf('天気予報');
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, Math.min(t.length, i + 4));
      const r = range.getBoundingClientRect();
      if (r.width < 2) continue;
      return {
        found: true,
        x: Math.round(r.left + r.width / 2),
        y: Math.round((r.top + r.bottom) / 2),
        hostHTML: host.outerHTML.slice(0, 400),
        hostRect: {
          top: host.getBoundingClientRect().top,
          bottom: host.getBoundingClientRect().bottom,
          height: host.getBoundingClientRect().height
        }
      };
    }
    const r = host.getBoundingClientRect();
    return {
      found: true,
      x: Math.round(r.left + 40),
      y: Math.round(r.top + 12),
      hostHTML: host.outerHTML.slice(0, 400),
      fallback: true
    };
  },
  { hostSel: HOST_SEL, needle: NEEDLE }
);
console.log('pt', JSON.stringify(pt, null, 2));
if (!pt.found) {
  await context.close();
  process.exit(2);
}

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

const before = await evalIn(
  yomupCtx,
  `(() => {
    const x=${pt.x}, y=${pt.y};
    const host = [...document.querySelectorAll('h4.c-heading--normal.c-side-title')].find(el => (el.textContent||'').includes('今日・明日の天気予報'));
    const b = findHighlightBlockFromPoint(x,y);
    const heading = findHeadingBlockFromPoint(x,y);
    const child = heading ? resolveHeadingChildTextHostAtPoint(heading, x, y) : null;
    return {
      headingTag: heading && heading.tagName,
      headingText: heading && String(heading.textContent||'').trim().slice(0,60),
      child: child ? { tag: child.tagName, cls: String(child.className||''), text: String(child.textContent||'').trim().slice(0,40) } : null,
      block: b ? { mode: b.mode, tag: b.element.tagName, cls: String(b.element.className||'').slice(0,60), text: String(b.element.textContent||'').trim().slice(0,60) } : null,
      efp: (() => { const e=document.elementFromPoint(x,y); return e?{tag:e.tagName,cls:String(e.className||'').slice(0,40)}:null; })()
    };
  })()`
);
console.log('before', JSON.stringify(before.result?.value, null, 2));
if (before.exceptionDetails) console.log('exc', JSON.stringify(before.exceptionDetails));

await page.mouse.move(4, 4);
await page.waitForTimeout(80);
await page.mouse.move(pt.x, pt.y);
await page.evaluate(
  ({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  },
  pt
);
await page.waitForTimeout(1200);

const after = await page.evaluate(
  ({ overlaySel, hostSel, needle }) => {
    const host = [...document.querySelectorAll(hostSel)].find((el) =>
      (el.textContent || '').includes(needle)
    );
    const hr = host.getBoundingClientRect();
    const segs = [...document.querySelectorAll(overlaySel)].map((e) => {
      const r = e.getBoundingClientRect();
      const mid = (r.top + r.bottom) / 2;
      return {
        top: Math.round(r.top),
        w: Math.round(r.width),
        inHost: r.width > 20 && mid >= hr.top - 2 && mid <= hr.bottom + 2
      };
    });
    return { segCount: segs.length, hostLit: segs.some((s) => s.inHost), segs };
  },
  { overlaySel: OVERLAY, hostSel: HOST_SEL, needle: NEEDLE }
);
console.log('after', JSON.stringify(after, null, 2));
console.log(after.hostLit ? 'WEATHER H4 PASS' : 'WEATHER H4 FAIL (does not light)');
await context.close();
process.exit(after.hostLit ? 0 : 1);
