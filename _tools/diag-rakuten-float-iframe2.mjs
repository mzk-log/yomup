/**
 * RK-2 live — iframe 注入・storage・点灯の切り分け
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-rakuten-float-diag2');
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
const client = await ctx.newCDPSession(page);
await client.send('Runtime.enable');
await client.send('Page.enable');

const worlds = [];
client.on('Runtime.executionContextCreated', (ev) => {
  worlds.push(ev.context);
});

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
await page.waitForTimeout(1000);

// top storage
const topStorage = await page.evaluate(async () => {
  const ls = localStorage.getItem('highLightOnOff');
  const cs = await new Promise((resolve) => {
    try {
      chrome.storage.local.get(['highLightOnOff'], (r) => resolve(r));
    } catch (e) {
      resolve({ err: String(e) });
    }
  });
  // page world may not have chrome.storage — expect err; use CDP later
  return { ls, cs };
});
console.log('topStorage(pageWorld)', topStorage);

for (let i = 0; i < 12; i++) {
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(300);
}

const footerWorlds = worlds.filter(
  (w) =>
    w.origin &&
    String(w.origin).includes('rakuten.ne.jp') &&
    w.name &&
    String(w.name).includes('読むプ')
);
const allFooterish = worlds.filter(
  (w) => w.origin && String(w.origin).includes('rakuten.ne.jp')
);
console.log(
  'worlds footerish',
  allFooterish.map((w) => ({ id: w.id, origin: w.origin, name: w.name, aux: w.auxData }))
);
console.log(
  'yomup footer worlds',
  footerWorlds.map((w) => ({ id: w.id, origin: w.origin, name: w.name }))
);

// Also list all 読むプ worlds
const yomupWorlds = worlds.filter((w) => w.name && String(w.name).includes('読むプ'));
console.log(
  'all yomup worlds',
  yomupWorlds.map((w) => ({ id: w.id, origin: w.origin, name: w.name }))
);

const frame = page.frames().find((f) => (f.url() || '').includes('footer.html'));
if (!frame) {
  console.log('no frame');
  await ctx.close();
  process.exit(2);
}

const pt = await frame.evaluate((needle) => {
  const p = [...document.querySelectorAll('p')].find((el) =>
    (el.textContent || '').includes(needle)
  );
  if (!p) return { found: false };
  p.scrollIntoView({ block: 'center' });
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let tn = null;
  while (walker.nextNode()) {
    if ((walker.currentNode.textContent || '').includes('初期不良')) {
      tn = walker.currentNode;
      break;
    }
  }
  if (!tn) return { found: false };
  const r = document.createRange();
  const t = tn.textContent || '';
  const i = t.indexOf('初期不良');
  r.setStart(tn, Math.max(0, i));
  r.setEnd(tn, Math.min(t.length, i + 4));
  const rect = r.getBoundingClientRect();
  return {
    found: true,
    x: rect.left + 12,
    y: rect.top + rect.height / 2,
    overlay: !!document.getElementById('yomup-highlight-overlay-root'),
    popup: !!document.getElementById('YomuP-popup-container')
  };
}, NEEDLE);
console.log('pt', pt);

// Find context by evaluating in each yomup world for footer URL marker
let footerCtx = null;
for (const w of yomupWorlds) {
  try {
    const probe = await client.send('Runtime.evaluate', {
      contextId: w.id,
      returnByValue: true,
      expression: `({
        href: location.href,
        hasFind: typeof findHighlightBlockFromPoint,
        hl: typeof highLightOnOff !== 'undefined' ? highLightOnOff : null,
        listeners: typeof highlightListenersAttached !== 'undefined' ? highlightListenersAttached : null
      })`
    });
    const v = probe.result?.value;
    console.log('world probe', w.id, v);
    if (v && v.href && String(v.href).includes('footer.html')) {
      footerCtx = w.id;
    }
  } catch (e) {
    console.log('world err', w.id, e.message);
  }
}

if (footerCtx != null && pt.found) {
  const detail = await client.send('Runtime.evaluate', {
    contextId: footerCtx,
    returnByValue: true,
    expression: `(() => {
      const x = ${pt.x}, y = ${pt.y};
      // force on for diagnosis
      if (typeof setHighlightModeEnabled === 'function') {
        setHighlightModeEnabled(true, { skipPersist: true });
      } else if (typeof applySharedHighlightOnOff === 'function') {
        applySharedHighlightOnOff(true);
      }
      const block = findHighlightBlockFromPoint(x, y);
      const el = block && block.element;
      const lit = tryHighlightLogicalBlockAtPoint(x, y);
      const root = document.getElementById('yomup-highlight-overlay-root');
      const segs = root
        ? root.querySelectorAll('.yomup-highlight-underline-segment, .yomup-highlight-underline').length
        : 0;
      return {
        hl: highLightOnOff,
        listeners: highlightListenersAttached,
        mode: block && block.mode,
        tag: el && el.tagName,
        text: el ? (el.textContent || '').trim().slice(0, 40) : null,
        len: el ? (el.textContent || '').trim().length : null,
        lit,
        segs
      };
    })()`
  });
  console.log('forced lit', JSON.stringify(detail.result?.value, null, 2));
}

await ctx.close();
