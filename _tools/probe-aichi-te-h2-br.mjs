/**
 * AT-5 調査 — H2 内 br+〇 長文切れ / p 内「B」「１」行分離
 * Usage:
 *   node _tools/probe-aichi-te-h2-br.mjs
 *   node _tools/probe-aichi-te-h2-br.mjs --live
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-aichi-te-h2-br');
const LIVE = process.argv.includes('--live');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

const LIVE_URL = 'https://aichi-te-jh.aichi-c.ed.jp/cms/page-37.html';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>AT-5 h2-br</title>
<style>
  body { font-family: "Yu Gothic", sans-serif; font-size: 16px; line-height: 1.8; max-width: 720px; margin: 40px; }
  h2 { font-size: 1.2em; font-weight: 700; }
</style></head><body>
<div class="entry-content">
  <h2 class="wp-block-heading" id="notes">当日の注意事項について<br>〇貸し出し用のスリッパはありません。児童・保護者ともにかならず室内履き（スリッパ可）をお持ちください。<br>〇校内に来客用の駐車場はありません。公共交通機関での来校にご協力ください（自家用車で来られる際は、コインパーキングなどを利用し、千種スポーツセンターへの駐車をしないようにしてください）。<br>〇当日の学校紹介は後日動画にて配信予定です。また、１０月３１日（土）のMTE祭（文化祭）も一般公開を行う予定です。</h2>
  <p id="video">↑肖像権などの関係で、一部スライド・写真を非表示としています。<br><br>B　当日動画<br>１　導入校校長あいさつと高校紹介</p>
</div>
</body></html>`;

let targetUrl;
if (LIVE) {
  targetUrl = LIVE_URL;
} else {
  const fixturePath = path.join(os.tmpdir(), 'yomup-at5-h2-br.html');
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
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, Math.min(t.length, i + Math.min(needle.length, 6)));
      const el = n.parentElement;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = range.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      return {
        x: r.left + Math.min(20, r.width / 2),
        y: (r.top + r.bottom) / 2,
        foundIn: t.slice(0, 80)
      };
    }
    return null;
  }, needle);
}

async function dispatchMove(page, x, y) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(60);
  await page.mouse.move(x, y);
  await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  }, { x, y });
  await page.waitForTimeout(700);
}

async function measureChunk(page, fullNeedle) {
  return page.evaluate(
    ({ sel, fullNeedle }) => {
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
      let full = null;
      if (fullNeedle) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          const t = n.textContent || '';
          const i = t.indexOf(fullNeedle);
          if (i < 0) continue;
          const range = document.createRange();
          range.setStart(n, i);
          range.setEnd(n, i + fullNeedle.length);
          const r = range.getBoundingClientRect();
          full = {
            left: Math.round(r.left),
            right: Math.round(r.right),
            w: Math.round(r.width),
            top: Math.round(r.top),
            bottom: Math.round(r.bottom)
          };
          break;
        }
      }
      let coverRatio = null;
      if (full && segs.length) {
        const litLeft = Math.min(...segs.map((s) => s.left));
        const litRight = Math.max(...segs.map((s) => s.right));
        const litTop = Math.min(...segs.map((s) => s.top));
        const litBottom = Math.max(...segs.map((s) => s.bottom));
        const yOverlap = Math.max(
          0,
          Math.min(litBottom, full.bottom) - Math.max(litTop, full.top)
        );
        const xOverlap = Math.max(
          0,
          Math.min(litRight, full.right) - Math.max(litLeft, full.left)
        );
        coverRatio =
          full.w > 0 && yOverlap > 0 ? xOverlap / full.w : yOverlap > 0 ? 0 : 0;
        if (yOverlap <= 0) coverRatio = 0;
      }
      const charEl = document.querySelector(
        '#YomuP-char-count, .yomup-char-count, [data-yomup-char], #YomuP-popup-container'
      );
      const popupText = charEl ? (charEl.innerText || '').replace(/\s+/g, ' ').slice(0, 240) : '';
      return { lit: segs.length > 0, segCount: segs.length, segs, full, coverRatio, popupText };
    },
    { sel: OVERLAY, fullNeedle: fullNeedle || null }
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

// Dump structural facts from page
const facts = await page.evaluate(() => {
  const h2 = [...document.querySelectorAll('h2')].find((el) =>
    (el.textContent || '').includes('当日の注意事項')
  );
  const p = [...document.querySelectorAll('p')].find((el) =>
    (el.textContent || '').includes('B　当日動画')
  );
  function lineLens(el) {
    if (!el) return null;
    const html = el.innerHTML;
    const parts = (el.innerText || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
    return {
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 40),
      br: el.querySelectorAll('br').length,
      parts: parts.map((t) => ({ len: t.length, text: t.slice(0, 60) })),
      htmlPreview: html.slice(0, 180)
    };
  }
  return { h2: lineLens(h2), p: lineLens(p) };
});
console.log('facts:', JSON.stringify(facts, null, 2));

const cases = [
  {
    id: 'h2-slipper-mid',
    needle: '室内履き',
    full: '児童・保護者ともにかならず室内履き（スリッパ可）をお持ちください。'
  },
  {
    id: 'h2-parking-mid',
    needle: '公共交通機関',
    full: '公共交通機関での来校にご協力ください（自家用車で来られる際は、コインパーキングなどを利用し、千種スポーツセンターへの駐車をしないようにしてください）。'
  },
  {
    id: 'p-B',
    needle: 'B　当日動画',
    full: 'B　当日動画',
    forbidFull: '１　導入校校長あいさつと高校紹介'
  },
  {
    id: 'p-1',
    needle: '１　導入校校長',
    full: '１　導入校校長あいさつと高校紹介',
    forbidFull: 'B　当日動画'
  }
];

const results = [];
for (const c of cases) {
  const pt = await locateSnippet(page, c.needle);
  if (!pt) {
    console.log(c.id, 'FAIL locate');
    results.push({ id: c.id, pass: false, reason: 'locate' });
    continue;
  }
  await dispatchMove(page, pt.x, pt.y);
  const m = await measureChunk(page, c.full);
  let forbidCover = null;
  if (c.forbidFull) {
    const m2 = await measureChunk(page, c.forbidFull);
    forbidCover = m2.coverRatio;
  }
  let pass = false;
  let reason = '';
  if (c.id.startsWith('h2-')) {
    pass = m.lit && m.coverRatio != null && m.coverRatio >= 0.9;
    reason = pass ? 'full-sentence' : `coverRatio=${m.coverRatio}`;
  } else {
    const noForbid = forbidCover == null || forbidCover < 0.15;
    pass = m.lit && m.coverRatio != null && m.coverRatio >= 0.9 && noForbid && m.segCount === 1;
    reason = pass
      ? 'label-only'
      : `cover=${m.coverRatio} forbid=${forbidCover} segs=${m.segCount}`;
  }
  results.push({ id: c.id, pass, reason });
  console.log(
    '\nCASE',
    c.id,
    JSON.stringify(
      {
        pass,
        reason,
        lit: m.lit,
        segCount: m.segCount,
        coverRatio: m.coverRatio,
        full: m.full,
        segs: m.segs,
        forbidCover
      },
      null,
      2
    )
  );
}

const allPass = results.length === cases.length && results.every((r) => r.pass);
console.log('\nRESULT:', allPass ? 'PASS' : 'FAIL', JSON.stringify(results));
await context.close();
process.exit(allPass ? 0 : 1);
