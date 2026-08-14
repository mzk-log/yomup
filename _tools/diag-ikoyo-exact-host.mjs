/**
 * Verify exact selector: .c-container--sm > div.c-container (intro)
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-ikoyo-exact');
const LIVE_URL =
  'https://iko-yo.net/facilities?genre_ids%5B%5D=21&prefecture_ids%5B%5D=23';
const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';
const HOST_SEL = '.c-container--sm > div.c-container';

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

const dom = await page.evaluate((hostSel) => {
  const host = document.querySelector(hostSel);
  const sm = host?.parentElement;
  return {
    found: !!host,
    hostTag: host?.tagName,
    hostClass: host?.className,
    hostText: (host?.textContent || '').trim().slice(0, 80),
    hostLen: (host?.textContent || '').trim().length,
    childElementCount: host?.childElementCount,
    parentClass: sm?.className,
    parentHTML: sm?.outerHTML?.slice(0, 500),
    allCContainers: [...document.querySelectorAll('div.c-container')].map((el) => ({
      cls: el.className,
      len: (el.textContent || '').trim().length,
      preview: (el.textContent || '').trim().slice(0, 30),
      parent: el.parentElement?.className
    }))
  };
}, HOST_SEL);
console.log('DOM', JSON.stringify(dom, null, 2));

const pt = await page.evaluate((hostSel) => {
  const host = document.querySelector(hostSel);
  if (!host) return null;
  host.scrollIntoView({ block: 'center' });
  const text = host.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE) {
    const r = host.getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.top + 12), mode: 'bbox' };
  }
  const needle = '愛知県にある子供が喜ぶ';
  const i = text.textContent.indexOf(needle);
  const range = document.createRange();
  range.setStart(text, Math.max(0, i));
  range.setEnd(text, Math.max(0, i) + 6);
  const r = range.getBoundingClientRect();
  return {
    x: Math.round(r.left + 10),
    y: Math.round((r.top + r.bottom) / 2),
    mode: 'text',
    textNodeLen: text.textContent.length
  };
}, HOST_SEL);
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

const before = await evalIn(
  yomupCtx,
  `(() => {
    const host = document.querySelector(${JSON.stringify(HOST_SEL)});
    const x = ${pt.x}, y = ${pt.y};
    const b = findHighlightBlockFromPoint(x, y);
    return {
      isLeaf: isLeafTextDivElement(host),
      excl: isLeafTextDivExcludedContext(host),
      accepts: inlineTextHostAcceptsHoverPoint(host, x, y),
      leaf: (() => { const t = findLeafTextDivBlockFromPoint(x,y); return t ? t.element === host : false; })(),
      blockSame: (() => { const b2 = findHighlightBlockFromPoint(x,y); return b2 && b2.element === host; })(),
      block: b ? { mode: b.mode, cls: String(b.element.className||''), text: String(b.element.textContent||'').trim().slice(0,40) } : null
    };
  })()`
);
console.log('before', JSON.stringify(before.result?.value, null, 2));

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
  ({ overlaySel, hostSel }) => {
    const host = document.querySelector(hostSel);
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
  { overlaySel: OVERLAY, hostSel: HOST_SEL }
);
console.log('after', JSON.stringify(after, null, 2));
const pass = after.hostLit && before.result?.value?.blockSame;
console.log(pass ? 'EXACT HOST PASS' : 'EXACT HOST FAIL');
await context.close();
process.exit(pass ? 0 : 1);
