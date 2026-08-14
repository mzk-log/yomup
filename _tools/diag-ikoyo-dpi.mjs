/**
 * Reproduce intro miss under deviceScaleFactor / zoom.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..');
const LIVE_URL =
  'https://iko-yo.net/facilities?genre_ids%5B%5D=21&prefecture_ids%5B%5D=23';
const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';
const HOST_SEL = '.c-container--sm > div.c-container';

async function trial({ scale, zoom, channel }) {
  const tag = `s${scale}_z${zoom}_${channel}`;
  const USER_DATA = path.join(__dirname, `.pw-ikoyo-dpi-${tag}`);
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(USER_DATA, {
    channel,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      `--force-device-scale-factor=${scale}`
    ],
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: scale
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
    // user default
    localStorage.removeItem('YomuP_highlightUnderlineMode');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  if (zoom !== 1) {
    await page.evaluate((z) => {
      document.body.style.zoom = String(z);
    }, zoom);
  }
  await page.waitForTimeout(3500);
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
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
  await page.waitForTimeout(400);

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

  const pt = await page.evaluate((hostSel) => {
    const host = document.querySelector(hostSel);
    host.scrollIntoView({ block: 'center' });
    const text = host.firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);
    const r = range.getBoundingClientRect();
    return {
      x: Math.round(r.left + 10),
      y: Math.round((r.top + r.bottom) / 2),
      dpr: window.devicePixelRatio,
      zoom: document.body.style.zoom || '1'
    };
  }, HOST_SEL);

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

  const block = await client.send('Runtime.evaluate', {
    contextId: yomupCtx,
    returnByValue: true,
    expression: `(() => {
      const x=${pt.x}, y=${pt.y};
      const b = findHighlightBlockFromPoint(x,y);
      const ok = typeof tryHighlightLogicalBlockAtPoint === 'function'
        ? tryHighlightLogicalBlockAtPoint(x,y)
        : null;
      return {
        block: b ? { mode:b.mode, cls:String(b.element.className||'').slice(0,40), text:String(b.element.textContent||'').trim().slice(0,30) } : null,
        tryOk: ok
      };
    })()`
  });

  const after = await page.evaluate(
    ({ overlaySel, hostSel }) => {
      const host = document.querySelector(hostSel);
      const hr = host.getBoundingClientRect();
      const root = document.getElementById('yomup-highlight-overlay-root');
      const segs = [...document.querySelectorAll(overlaySel)];
      return {
        rootChildCount: root ? root.childElementCount : -1,
        segCount: segs.length,
        hostLit: segs.some((e) => {
          const r = e.getBoundingClientRect();
          const mid = (r.top + r.bottom) / 2;
          return r.width > 5 && mid >= hr.top - 2 && mid <= hr.bottom + 2;
        })
      };
    },
    { overlaySel: OVERLAY, hostSel: HOST_SEL }
  );

  // also card control
  const cardPt = await page.evaluate(() => {
    const needle = '「めんたいパークとこなめ」は';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent || '';
      const i = t.indexOf(needle);
      if (i < 0) continue;
      const parent = n.parentElement;
      if (!parent?.closest?.('.p-index-list-item__description')) continue;
      parent.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + 6);
      const r = range.getBoundingClientRect();
      return { x: Math.round(r.left + 10), y: Math.round((r.top + r.bottom) / 2) };
    }
    return null;
  });
  let cardLit = null;
  if (cardPt) {
    await page.mouse.move(cardPt.x, cardPt.y);
    await page.evaluate(
      ({ x, y }) => {
        const t = document.elementFromPoint(x, y);
        const init = { bubbles: true, clientX: x, clientY: y, view: window };
        document.dispatchEvent(new MouseEvent('mousemove', init));
        t?.dispatchEvent(new MouseEvent('mousemove', init));
      },
      cardPt
    );
    await page.waitForTimeout(900);
    cardLit = await page.evaluate((sel) => document.querySelectorAll(sel).length > 0, OVERLAY);
  }

  await context.close();
  return {
    tag,
    pt,
    block: block.result?.value,
    after,
    cardLit,
    exc: block.exceptionDetails?.text
  };
}

console.log('EXT', EXTENSION_PATH);
const configs = [
  { scale: 1, zoom: 1, channel: 'chromium' },
  { scale: 1.25, zoom: 1, channel: 'chromium' },
  { scale: 1.5, zoom: 1, channel: 'chromium' },
  { scale: 1, zoom: 1.25, channel: 'chromium' },
  { scale: 1.25, zoom: 1, channel: 'chrome' }
];

for (const c of configs) {
  try {
    const r = await trial(c);
    console.log(JSON.stringify(r));
  } catch (e) {
    console.log(JSON.stringify({ tag: c, error: String(e.message || e) }));
  }
}
