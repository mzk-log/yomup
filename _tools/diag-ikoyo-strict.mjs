/**
 * Strict live verify: intro host band must light; block must be c-container.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-ikoyo-verify');
console.log('EXTENSION_PATH', EXTENSION_PATH);
const LIVE_URL =
  'https://iko-yo.net/facilities?genre_ids%5B%5D=21&prefecture_ids%5B%5D=23';
const NEEDLE = '愛知県にある子供が喜ぶ';
const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';

fs.rmSync(USER_DATA, { recursive: true, force: true });

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
client.on('Runtime.executionContextDestroyed', (ev) => worlds.delete(ev.executionContextId));

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

const pt = await page.evaluate((needle) => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent || '';
    const i = t.indexOf(needle);
    if (i < 0) continue;
    const parent = n.parentElement;
    if (!parent?.closest?.('div.c-container')) continue;
    parent.scrollIntoView({ block: 'center' });
    const range = document.createRange();
    range.setStart(n, i);
    range.setEnd(n, Math.min(t.length, i + 6));
    const r = range.getBoundingClientRect();
    return { x: Math.round(r.left + 10), y: Math.round((r.top + r.bottom) / 2) };
  }
  return null;
}, NEEDLE);
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

const before = await evalIn(
  yomupCtx,
  `(() => {
    const x=${pt.x}, y=${pt.y};
    const pageEl = document.querySelector('.l-page');
    const intro = [...document.querySelectorAll('div.c-container')].find(e => (e.textContent||'').includes('子供が喜ぶ'));
    const b = findHighlightBlockFromPoint(x,y);
    return {
      hasUnitDivFix: (''+isCardCellStructure).includes('unitDivCount') || (''+isCardCellStructure).includes('isCardCellTextUnit'),
      lPageIsCard: isCardCellStructure(pageEl),
      excl: isLeafTextDivExcludedContext(intro),
      isLeaf: isLeafTextDivElement(intro),
      leafFromPoint: (() => { const t=findLeafTextDivBlockFromPoint(x,y); return t?String(t.element.className):null; })(),
      block: b ? { mode:b.mode, cls:String(b.element.className||'').slice(0,60), text:String(b.element.textContent||'').trim().slice(0,40) } : null
    };
  })()`
);
console.log('beforeMove', JSON.stringify(before.result?.value, null, 2));

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
await page.waitForTimeout(1500);

const after = await page.evaluate(
  ({ overlaySel, needle }) => {
    const intro = [...document.querySelectorAll('div.c-container')].find((e) =>
      (e.textContent || '').includes(needle)
    );
    const region = document.querySelector('.l-region');
    const hr = intro.getBoundingClientRect();
    const rr = region ? region.getBoundingClientRect() : null;
    const segs = [...document.querySelectorAll(overlaySel)].map((e) => {
      const r = e.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        width: Math.round(r.width),
        inIntro: r.width > 20 && (r.top + r.bottom) / 2 >= hr.top - 2 && (r.top + r.bottom) / 2 <= hr.bottom + 2,
        inRegion:
          !!rr &&
          r.width > 20 &&
          (r.top + r.bottom) / 2 >= rr.top - 2 &&
          (r.top + r.bottom) / 2 <= rr.bottom + 2
      };
    });
    return {
      segCount: segs.length,
      introLit: segs.some((s) => s.inIntro),
      regionLit: segs.some((s) => s.inRegion),
      segs,
      introRect: { top: hr.top, bottom: hr.bottom },
      regionRect: rr ? { top: rr.top, bottom: rr.bottom } : null
    };
  },
  { overlaySel: OVERLAY, needle: '子供が喜ぶ' }
);
console.log('afterMove', JSON.stringify(after, null, 2));

const pass = after.introLit && !after.regionLit && before.result?.value?.block?.cls?.includes('c-container');
console.log(pass ? 'STRICT PASS' : 'STRICT FAIL');
await context.close();
process.exit(pass ? 0 : 1);
