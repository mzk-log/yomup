/**
 * Multi-point live verify on iko-yo intro paragraph.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-ikoyo-multipoint');
const LIVE_URL =
  'https://iko-yo.net/facilities?genre_ids%5B%5D=21&prefecture_ids%5B%5D=23';
const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';

const NEEDLES = [
  '愛知県にある子供が喜ぶ',
  '貴重な体験ができたり',
  'お気に入りの工場見学スポット'
];

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

async function locate(needle) {
  return page.evaluate((needle) => {
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
      range.setEnd(n, Math.min(t.length, i + Math.min(8, needle.length)));
      const r = range.getBoundingClientRect();
      return {
        x: Math.round(r.left + Math.min(20, r.width / 2)),
        y: Math.round((r.top + r.bottom) / 2),
        rect: { top: r.top, bottom: r.bottom, left: r.left, width: r.width }
      };
    }
    return null;
  }, needle);
}

async function hoverAndMeasure(pt) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(50);
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
  await page.waitForTimeout(1100);

  const block = await evalIn(
    yomupCtx,
    `(() => {
      const x=${pt.x}, y=${pt.y};
      const b = findHighlightBlockFromPoint(x,y);
      return b ? { mode:b.mode, cls:String(b.element.className||'').slice(0,40), text:String(b.element.textContent||'').trim().slice(0,40) } : null;
    })()`
  );

  const measure = await page.evaluate((overlaySel) => {
    const intro = [...document.querySelectorAll('div.c-container')].find((e) =>
      (e.textContent || '').includes('子供が喜ぶ')
    );
    const hr = intro.getBoundingClientRect();
    const segs = [...document.querySelectorAll(overlaySel)].map((e) => {
      const r = e.getBoundingClientRect();
      const mid = (r.top + r.bottom) / 2;
      return {
        top: Math.round(r.top),
        h: Math.round(r.height),
        w: Math.round(r.width),
        inIntro: r.width > 20 && mid >= hr.top - 2 && mid <= hr.bottom + 2
      };
    });
    return {
      introLit: segs.some((s) => s.inIntro),
      segCount: segs.length,
      segs
    };
  }, OVERLAY);

  return { block: block.result?.value, measure };
}

// also center of whole intro box
const centerPt = await page.evaluate(() => {
  const intro = [...document.querySelectorAll('div.c-container')].find((e) =>
    (e.textContent || '').includes('子供が喜ぶ')
  );
  intro.scrollIntoView({ block: 'center' });
  const r = intro.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});

const results = [];
for (const needle of NEEDLES) {
  const pt = await locate(needle);
  const r = await hoverAndMeasure(pt);
  results.push({ needle, pt, ...r });
  console.log('POINT', needle, JSON.stringify({ pt, block: r.block, measure: r.measure }));
}

const rCenter = await hoverAndMeasure(centerPt);
results.push({ needle: 'CENTER', pt: centerPt, ...rCenter });
console.log('POINT CENTER', JSON.stringify({ pt: centerPt, block: rCenter.block, measure: rCenter.measure }));

const fail = results.filter((r) => !r.measure?.introLit);
console.log(fail.length ? `MULTI FAIL ${fail.length}` : 'MULTI PASS');
await context.close();
process.exit(fail.length ? 1 : 0);
