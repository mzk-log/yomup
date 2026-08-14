/**
 * Grid sample across intro bbox — find dark spots.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-ikoyo-gap');
const LIVE_URL =
  'https://iko-yo.net/facilities?genre_ids%5B%5D=21&prefecture_ids%5B%5D=23';
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
  viewport: { width: 1400, height: 900 }
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
await page.waitForTimeout(3500);
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
await page.waitForTimeout(400);

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

const intro = await page.evaluate(() => {
  const el = [...document.querySelectorAll('div.c-container')].find((e) =>
    (e.textContent || '').includes('子供が喜ぶ')
  );
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
});

const points = [];
for (let yi = 0; yi <= 4; yi++) {
  for (let xi = 0; xi <= 4; xi++) {
    points.push({
      xi,
      yi,
      x: Math.round(intro.left + (intro.width * xi) / 4),
      y: Math.round(intro.top + (intro.height * yi) / 4)
    });
  }
}

const rows = [];
for (const pt of points) {
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
  await page.waitForTimeout(400);
  const lit = await page.evaluate((sel) => {
    const introEl = [...document.querySelectorAll('div.c-container')].find((e) =>
      (e.textContent || '').includes('子供が喜ぶ')
    );
    const hr = introEl.getBoundingClientRect();
    return [...document.querySelectorAll(sel)].some((e) => {
      const r = e.getBoundingClientRect();
      const mid = (r.top + r.bottom) / 2;
      return r.width > 20 && mid >= hr.top - 2 && mid <= hr.bottom + 2;
    });
  }, OVERLAY);
  const block = await evalIn(
    yomupCtx,
    `(() => { const b = findHighlightBlockFromPoint(${pt.x}, ${pt.y}); return b ? String(b.element.className || '').slice(0, 40) : null; })()`
  );
  rows.push({ ...pt, lit, block: block.result?.value });
}

console.log(JSON.stringify({ intro, rows }, null, 2));
const fail = rows.filter((r) => !r.lit);
console.log('failCount', fail.length, '/', rows.length);
console.log('fails', JSON.stringify(fail));
await page.screenshot({ path: path.join(__dirname, 'ikoyo-intro-hover.png') });
await context.close();
process.exit(fail.length ? 1 : 0);
