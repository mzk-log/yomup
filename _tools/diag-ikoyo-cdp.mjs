/**
 * CDP: call findHighlightBlockFromPoint inside content-script world.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-ikoyo-cdp2');
const LIVE_URL =
  'https://iko-yo.net/facilities?genre_ids%5B%5D=21&prefecture_ids%5B%5D=23';
const NEEDLE = '愛知県にある子供が喜ぶ';

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
client.on('Runtime.executionContextCreated', (ev) => {
  const c = ev.context;
  worlds.set(c.id, c);
});

await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
  sessionStorage.setItem('pageTransition', 'true');
  localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(5000);
try {
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 45000 });
  console.log('popup ok');
} catch (e) {
  console.log('popup wait fail', e.message);
  const sw = context.serviceWorkers()[0];
  if (sw) {
    try {
      await sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
      });
    } catch (_err) {}
  }
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 45000 });
  console.log('popup ok after inject');
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
    return {
      x: Math.round(r.left + Math.min(20, r.width / 2)),
      y: Math.round((r.top + r.bottom) / 2)
    };
  }
  return null;
}, NEEDLE);
console.log('pt', pt);

console.log(
  'worlds',
  [...worlds.values()].map((c) => ({
    id: c.id,
    name: c.name,
    origin: c.origin,
    isDefault: c.auxData?.isDefault
  }))
);

async function evalIn(ctxId, expression) {
  return client.send('Runtime.evaluate', {
    expression,
    contextId: ctxId,
    returnByValue: true,
    awaitPromise: true
  });
}

let yomupCtx = null;
const sorted = [...worlds.values()].sort((a, b) => b.id - a.id);
for (const c of sorted) {
  const isExt =
    (c.name && String(c.name).includes('読むプ')) ||
    (c.origin && String(c.origin).startsWith('chrome-extension://'));
  if (!isExt) continue;
  try {
    const probe = await evalIn(c.id, `typeof findHighlightBlockFromPoint`);
    console.log('probe', c.id, c.name, c.origin, probe.result?.value);
    if (probe.result?.value === 'function') {
      yomupCtx = c.id;
      break;
    }
  } catch (e) {
    console.log('probe fail', c.id, e.message);
  }
}
console.log('yomupCtx', yomupCtx);

if (yomupCtx && pt) {
  const expr = `(() => {
    const x = ${pt.x}, y = ${pt.y};
    const intro = [...document.querySelectorAll('div.c-container')].find(e => (e.textContent||'').includes('子供が喜ぶ'));
    const leafEl = intro;
    const out = {
      isLeaf: isLeafTextDivElement(leafEl),
      struct: isLeafTextDivStructure(leafEl),
      excl: isLeafTextDivExcludedContext(leafEl),
      accepts: inlineTextHostAcceptsHoverPoint(leafEl, x, y),
      textLen: (leafEl.textContent||'').trim().length,
      canChunk: canChunkLeafTextDivProse((leafEl.textContent||'').trim()),
      fromPoint: null,
      block: null
    };
    const b1 = findLeafTextDivBlockFromPoint(x, y);
    out.fromPoint = b1 ? { mode: b1.mode, cls: String(b1.element?.className||'').slice(0,80), tag: b1.element?.tagName } : null;
    const b2 = findHighlightBlockFromPoint(x, y);
    out.block = b2 ? { mode: b2.mode, cls: String(b2.element?.className||'').slice(0,80), tag: b2.element?.tagName, text: String(b2.element?.textContent||'').trim().slice(0,60) } : null;
    const anc = [];
    let n = leafEl;
    while (n && n !== document.body) {
      anc.push({
        tag: n.tagName,
        cls: String(n.className||'').slice(0,40),
        card: !!isCardCellStructure(n),
        inner: !!isInnerCardCellStructure(n),
        block: !!isBlockHighlightContainer(n)
      });
      n = n.parentElement;
    }
    out.anc = anc.slice(0, 12);
    // which early path?
    out.uiChrome = isWithinUiChromeRegion(getPointReferenceNode(x,y) || document.elementFromPoint(x,y));
    out.heading = !!(findHeadingBlockFromPoint(x,y));
    out.blockLabel = !!(findBlockLabelFromPoint(x,y));
    out.innerCard = !!(findInnerCardCellBlockFromPoint(x,y));
    out.blockAnc = (() => { const a = findBlockAncestorFromPoint(x,y); return a ? { tag:a.tagName, cls:String(a.className||'').slice(0,60), text:String(a.textContent||'').trim().slice(0,40)} : null; })();
    return out;
  })()`;
  const r = await evalIn(yomupCtx, expr);
  console.log('diag', JSON.stringify(r.result?.value, null, 2));
  if (r.exceptionDetails) console.log('exc', JSON.stringify(r.exceptionDetails, null, 2));
}

await context.close();
