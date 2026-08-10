/**
 * KZ-1 — footer 内 <address> 直テキストが光らない
 * Usage:
 *   node _tools/probe-kongozen-footer-address.mjs
 *   node _tools/probe-kongozen-footer-address.mjs --live
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-kongozen-footer-address');
const LIVE = process.argv.includes('--live');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

const LIVE_URL =
  'https://kongozen.jp/%e5%85%a5%e9%96%80%e6%99%82%e3%81%ab%e5%bf%85%e8%a6%81%e3%81%aa%e8%b2%bb%e7%94%a8%e3%81%ab%e3%81%a4%e3%81%84%e3%81%a6';

const ADDR = '〒764-8511 香川県仲多度郡多度津町本通３－１－４８';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>KZ-1 footer address</title>
<style>
  body { font-family: "Yu Gothic", sans-serif; font-size: 16px; margin: 40px; min-height: 80vh; }
  footer { margin-top: 120px; padding: 24px; border-top: 1px solid #ccc; }
  address { font-style: normal; }
</style></head><body>
<main><p>本文の段落です。フッターの住所を確認します。</p></main>
<footer>
  <div class="page_footer">
    <h4>金剛禅総本山少林寺</h4>
    <address id="addr">${ADDR}</address>
    <div class="copyright">Copyright© SHORINJI KEMPO All rights reserved.</div>
  </div>
</footer>
</body></html>`;

let targetUrl;
if (LIVE) {
  targetUrl = LIVE_URL;
} else {
  const fixturePath = path.join(os.tmpdir(), 'yomup-kz1-footer-address.html');
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

async function locateAddress(page) {
  return page.evaluate((needle) => {
    const addr =
      document.querySelector('#addr') ||
      [...document.querySelectorAll('footer address, address')].find((el) =>
        (el.textContent || '').includes(needle.slice(0, 8))
      );
    if (!addr) return null;
    addr.scrollIntoView({ block: 'center' });
    const tn = [...addr.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim());
    if (!tn) return null;
    const range = document.createRange();
    const t = tn.textContent || '';
    const i = Math.max(0, t.indexOf('香川'));
    range.setStart(tn, i >= 0 ? i : 0);
    range.setEnd(tn, Math.min(t.length, (i >= 0 ? i : 0) + 4));
    const r = range.getBoundingClientRect();
    if (r.width < 2) {
      const br = addr.getBoundingClientRect();
      return { x: br.left + Math.min(40, br.width / 2), y: (br.top + br.bottom) / 2 };
    }
    return { x: r.left + Math.min(24, r.width / 2), y: (r.top + r.bottom) / 2 };
  }, ADDR);
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

async function measure(page) {
  return page.evaluate(
    ({ sel, needle }) => {
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
      const addr =
        document.querySelector('#addr') ||
        [...document.querySelectorAll('footer address, address')].find((el) =>
          (el.textContent || '').includes(needle.slice(0, 8))
        );
      let hit = false;
      if (addr && segs.length) {
        const tn = [...addr.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim());
        if (tn) {
          const range = document.createRange();
          range.selectNodeContents(tn);
          const fr = range.getBoundingClientRect();
          hit = segs.some(
            (s) =>
              Math.min(s.bottom, fr.bottom) - Math.max(s.top, fr.top) > 0 &&
              Math.min(s.right, fr.right) - Math.max(s.left, fr.left) > fr.width * 0.3
          );
        }
      }
      const copyright = document.querySelector('.copyright');
      let copyrightHit = false;
      if (copyright && segs.length) {
        const cr = copyright.getBoundingClientRect();
        copyrightHit = segs.some(
          (s) => Math.min(s.bottom, cr.bottom) - Math.max(s.top, cr.top) > cr.height * 0.5
        );
      }
      return {
        lit: segs.length > 0,
        segCount: segs.length,
        hit,
        copyrightHit,
        hostTag: document.elementFromPoint
          ? null
          : null
      };
    },
    { sel: OVERLAY, needle: ADDR }
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

const pt = await locateAddress(page);
if (!pt) {
  console.log('FAIL locate');
  await context.close();
  process.exit(1);
}
await page.waitForTimeout(200);
const pt2 = (await locateAddress(page)) || pt;
console.log('hover point', pt2);
await dispatchMove(page, pt2.x, pt2.y);
const m = await measure(page);
const pass = m.lit && m.hit && !m.copyrightHit;
console.log('measure:', JSON.stringify(m, null, 2));
console.log(pass ? 'PASS (address lit)' : 'FAIL', m);

await context.close();
process.exit(pass ? 0 : 1);
