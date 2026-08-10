/**
 * KB-1 — <p>+<br> の英語コードが複数行まとめて光る
 * Usage:
 *   node _tools/probe-ktbkgrg-p-br-code.mjs
 *   node _tools/probe-ktbkgrg-p-br-code.mjs --live
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-ktbkgrg-p-br-code');
const LIVE = process.argv.includes('--live');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

const LIVE_URL = 'https://www.ktbkgrg.com/?p=63';

const LINES = [
  '} else if (hun == 30  && flag == 30) {',
  '// Action B',
  'File dataFile = SD.open("datalog.csv", FILE_WRITE);',
  'if (dataFile) {',
  'dataFile.print(pchDate);',
  'dataFile.print(";");',
  'dataFile.print(pchTime);',
  'dataFile.close();',
  'flag = 0;'
];

const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>KB-1 p-br code</title>
<style>
  body { font-family: Consolas, monospace; font-size: 14px; line-height: 1.5; max-width: 720px; margin: 40px; }
</style></head><body>
<article>
  <p>Some English blog text about Arduino logging and SD card modules for data files.</p>
  <p id="sketch">${LINES.join('<br>')}</p>
</article>
</body></html>`;

let targetUrl;
if (LIVE) {
  targetUrl = LIVE_URL;
} else {
  const fixturePath = path.join(os.tmpdir(), 'yomup-kb1-p-br-code.html');
  fs.writeFileSync(fixturePath, FIXTURE, 'utf8');
  targetUrl = 'file:///' + fixturePath.replace(/\\/g, '/');
}

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
    localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 });
  } catch (_e) {
    const sw = context.serviceWorkers()[0];
    if (sw) {
      await sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
      });
    }
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 30000 });
  }
}

async function locateSnippet(page, needle) {
  return page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent || '';
      const i = t.indexOf(needle);
      if (i < 0) continue;
      const el = n.parentElement;
      if (el?.scrollIntoView) el.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, Math.min(t.length, i + Math.min(6, needle.length)));
      const r = range.getBoundingClientRect();
      if (r.width < 2) continue;
      return { x: r.left + Math.min(20, r.width / 2), y: (r.top + r.bottom) / 2 };
    }
    return null;
  }, needle);
}

async function dispatchMove(page, x, y) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(50);
  await page.mouse.move(x, y);
  await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  }, { x, y });
  await page.waitForTimeout(700);
}

async function measure(page, lineNeedles) {
  return page.evaluate(
    ({ sel, lineNeedles }) => {
      const segs = [...document.querySelectorAll(sel)].map((e) => {
        const r = e.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          left: Math.round(r.left),
          right: Math.round(r.right),
          w: Math.round(r.width)
        };
      });
      const covered = [];
      for (const needle of lineNeedles) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        let hit = false;
        while ((n = walker.nextNode())) {
          const t = n.textContent || '';
          const i = t.indexOf(needle);
          if (i < 0) continue;
          const range = document.createRange();
          range.setStart(n, i);
          range.setEnd(n, i + needle.length);
          const fr = range.getBoundingClientRect();
          const yOverlap = segs.some(
            (s) => Math.min(s.bottom, fr.bottom) - Math.max(s.top, fr.top) > 0
          );
          const xOverlap = segs.some(
            (s) =>
              Math.min(s.right, fr.right) - Math.max(s.left, fr.left) > fr.width * 0.4
          );
          hit = yOverlap && xOverlap;
          break;
        }
        covered.push({ needle: needle.slice(0, 28), hit });
      }
      return {
        lit: segs.length > 0,
        segCount: segs.length,
        distinctTops: new Set(segs.map((s) => s.top)).size,
        covered,
        coveredCount: covered.filter((c) => c.hit).length
      };
    },
    { sel: OVERLAY, lineNeedles }
  );
}

const context = await chromium.launchPersistentContext(USER_DATA, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    '--allow-file-access-from-files'
  ],
  viewport: { width: 1280, height: 900 }
});
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());

await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
await preparePage(context, page);
console.log('target:', targetUrl, LIVE ? '(live)' : '(fixture)');

const hoverNeedle = LIVE ? 'flag == 30' : 'hun == 30';
const pt = await locateSnippet(page, hoverNeedle);
if (!pt) {
  console.log('FAIL locate');
  await context.close();
  process.exit(1);
}
if (LIVE) {
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find(
      (el) => (el.textContent || '').includes('flag == 30') && el.querySelectorAll('br').length >= 2
    );
    p?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(400);
}
const pt2 = (await locateSnippet(page, hoverNeedle)) || pt;
console.log('hover point', pt2);
await dispatchMove(page, pt2.x, pt2.y);
await page.waitForTimeout(400);

const checkLines = LIVE
  ? [
      '} else if (hun == 30',
      '// 動作B',
      'File dataFile = SD.open',
      'dataFile.print(pchDate)',
      'dataFile.close()',
      'flag = 0'
    ]
  : LINES;

const m = await measure(page, checkLines);
const onlyFirst = m.lit && m.coveredCount === 1 && m.covered[0]?.hit;
console.log('measure:', JSON.stringify(m, null, 2));
console.log(onlyFirst ? 'PASS (single line)' : 'FAIL (multi-line chunk)', {
  coveredCount: m.coveredCount,
  distinctTops: m.distinctTops
});

await context.close();
process.exit(onlyFirst ? 0 : 1);
