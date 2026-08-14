/**
 * Inspect live l-page card false-positive + resolveCardCellTextUnit.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-ikoyo-cdp3');
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
client.on('Runtime.executionContextCreated', (ev) => worlds.set(ev.context.id, ev.context));
client.on('Runtime.executionContextDestroyed', (ev) => worlds.delete(ev.executionContextId));

await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
  sessionStorage.setItem('pageTransition', 'true');
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(4000);
try {
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 });
} catch (_e) {
  const sw = context.serviceWorkers()[0];
  if (sw) {
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
    }).catch(() => {});
  }
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 45000 });
}
await page.evaluate(() => {
  const host = document.getElementById('YomuP-popup-container');
  const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
  if (img && !img.classList.contains('active')) img.click();
});
await page.waitForTimeout(400);

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

const r = await evalIn(
  yomupCtx,
  `(() => {
    const x=${pt.x}, y=${pt.y};
    const page = document.querySelector('.l-page');
    const kids = [...page.children].map(c => ({
      tag: c.tagName,
      cls: String(c.className||'').slice(0,50),
      childN: c.children.length,
      textLen: (c.textContent||'').trim().length,
      isTextDiv: false
    }));
    // mark direct text divs via helper
    const tdivs = getDirectTextDivChildren(page).map(c => String(c.className||'').slice(0,50));
    const sib = countSiblingDivsWithText(page);
    const card = findCardCellBlockFromPoint(x,y);
    return {
      pageChildren: kids,
      textDivs: tdivs,
      siblingCount: sib,
      isCard: isCardCellStructure(page),
      cardBlock: card ? { mode: card.mode, cls: String(card.element?.className||'').slice(0,60), text: String(card.element?.textContent||'').trim().slice(0,40) } : null,
      leafExcl: isLeafTextDivExcludedContext(document.querySelector('div.c-container'))
    };
  })()`
);
console.log(JSON.stringify(r.result?.value, null, 2));
await context.close();
