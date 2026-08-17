/**
 * SP-1 — HubSpot h1 ラップ span の折り返しタイトル下線
 * - fixture: 全文ラップ span の折り返し h1（全行下線・文字下）
 * - fixture-cw1: 直下テキスト + subtitle span（主タイトル行のみ）
 * Usage:
 *   node _tools/probe-sgplus-h1-wrap-span.mjs
 *   node _tools/probe-sgplus-h1-wrap-span.mjs --live
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-sgplus-h1-wrap-span');
const LIVE = process.argv.includes('--live');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';

const TITLE =
  'SharePoint サイトのデザイン例まとめ｜見やすい社内ポータルのレイアウトと作り方';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>SP-1</title>
<style>
  body { font-family: "Yu Gothic", sans-serif; margin: 40px; }
  .blog-title { width: 280px; }
  .blog-post__title {
    font-size: 36px;
    line-height: 1.35;
    font-weight: 700;
    margin: 0 0 40px;
    color: #1a1a2e;
  }
  .title_container { width: 520px; }
  .title_container h1 { font-size: 22px; line-height: 1.4; margin: 0; }
  .title_container .subtitle { display: block; font-size: 13px; font-weight: 400; margin-top: 8px; }
</style></head><body>
<div class="blog-title" id="sp1">
  <h1 class="blog-post__title"><span id="hs_cos_wrapper_name" class="hs_cos_wrapper hs_cos_wrapper_meta_field hs_cos_wrapper_type_text">${TITLE}</span></h1>
</div>
<div class="title_container" id="cw1">
  <h1>【長期依頼】Googleスプレッドシートに詳しい方を募集します！
    <span class="subtitle">Excel VBA・マクロ開発の仕事の依頼</span>
  </h1>
</div>
</body></html>`;

const CASES = LIVE
  ? [
      {
        name: 'live-title',
        url: 'https://www.sg-plus.jp/blog/20260814',
        needle: 'デザイン例まとめ',
        root: 'h1.blog-post__title',
        expectMinSegs: 2,
        expectCw1SingleRow: false
      }
    ]
  : [
      {
        name: 'fixture-wrap-span',
        url: null,
        needle: 'SharePoint',
        expectMinSegs: 2,
        expectCw1SingleRow: false
      },
      {
        name: 'fixture-cw1',
        url: null,
        needle: 'スプレッドシートに詳しい方',
        expectMinSegs: 1,
        expectCw1SingleRow: true
      }
    ];

let fixtureUrl = null;
if (!LIVE) {
  const fixturePath = path.join(os.tmpdir(), 'yomup-sp1-h1-wrap.html');
  fs.writeFileSync(fixturePath, FIXTURE, 'utf8');
  fixtureUrl = 'file:///' + fixturePath.replace(/\\/g, '/');
  for (const c of CASES) c.url = fixtureUrl;
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

async function locateNeedle(page, needle, rootSel) {
  return page.evaluate(({ needle, rootSel }) => {
    const root = rootSel ? document.querySelector(rootSel) : document.body;
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent || '';
      const i = t.indexOf(needle);
      if (i < 0) continue;
      const el = n.parentElement;
      if (el?.scrollIntoView) el.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, Math.min(t.length, i + Math.min(4, needle.length)));
      const r = range.getBoundingClientRect();
      if (r.width < 2) continue;
      const host = el.closest('h1') || el;
      const hostRange = document.createRange();
      hostRange.selectNodeContents(host);
      const lineRects = [...hostRange.getClientRects()].filter((cr) => cr.width > 2 && cr.height > 2);
      return {
        x: r.left + Math.min(24, r.width / 2),
        y: (r.top + r.bottom) / 2,
        textTop: r.top,
        textBottom: r.bottom,
        lineCount: lineRects.length,
        hostTag: host.tagName,
        hostChild: host.children[0] ? host.children[0].tagName : null,
        childCount: host.children.length
      };
    }
    return null;
  }, { needle, rootSel: rootSel || null });
}

async function dispatchMove(page, x, y) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(80);
  await page.mouse.move(x, y);
  await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  }, { x, y });
  await page.waitForTimeout(800);
}

async function measure(page, pt) {
  return page.evaluate(
    ({ sel, textTop, textBottom, lineCount }) => {
      const segs = [...document.querySelectorAll(sel)].map((e) => {
        const r = e.getBoundingClientRect();
        return {
          top: Math.round(r.top * 10) / 10,
          bottom: Math.round(r.bottom * 10) / 10,
          width: Math.round(r.width)
        };
      });
      const mid = (textTop + textBottom) / 2;
      const glyphH = textBottom - textTop;
      const throughGlyphs = segs.some(
        (s) => s.width > 20 && s.top > textTop + glyphH * 0.15 && s.top < textBottom - glyphH * 0.2
      );
      const belowNeedle = segs.some(
        (s) => s.width > 20 && s.top >= textBottom - 8 && s.top <= textBottom + 10
      );
      const h1 = document.querySelector('h1.blog-post__title, #sp1 h1');
      const cs = h1 ? getComputedStyle(h1) : null;
      let titleRects = [];
      if (h1) {
        const range = document.createRange();
        range.selectNodeContents(h1);
        titleRects = [...range.getClientRects()]
          .filter((cr) => cr.width > 2 && cr.height > 2)
          .map((cr) => ({
            top: Math.round(cr.top * 10) / 10,
            bottom: Math.round(cr.bottom * 10) / 10,
            height: Math.round(cr.height * 10) / 10,
            width: Math.round(cr.width)
          }));
      }
      const uniq = [];
      for (const cr of titleRects) {
        if (!uniq.some((u) => Math.abs(u.top - cr.top) < 2)) uniq.push(cr);
      }
      const fontPx = cs ? parseFloat(cs.fontSize) : NaN;
      const lineHits = uniq.map((line) => {
        const emBottom = Number.isFinite(fontPx) ? line.top + fontPx : line.bottom - 2;
        const hit = segs.some(
          (s) => s.width > 20 && s.top >= emBottom - 12 && s.top <= emBottom + 10
        );
        return { top: line.top, emBottom: Math.round(emBottom * 10) / 10, hit };
      });
      const linesCovered = lineHits.filter((l) => l.hit).length;
      return {
        lit: segs.length > 0,
        segCount: segs.length,
        lineCount,
        uniqueLines: uniq.length,
        segs,
        throughGlyphs,
        belowNeedle,
        linesCovered,
        lineHits,
        textTop,
        textBottom,
        fontSize: cs ? cs.fontSize : null,
        lineHeight: cs ? cs.lineHeight : null
      };
    },
    { sel: OVERLAY, textTop: pt.textTop, textBottom: pt.textBottom, lineCount: pt.lineCount }
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

let failed = 0;
for (const c of CASES) {
  await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await preparePage(context, page);
  console.log('case:', c.name, c.url);

  const pt = await locateNeedle(page, c.needle, c.root);
  if (!pt) {
    console.log('FAIL locate', c.name);
    failed++;
    continue;
  }
  console.log('locate:', JSON.stringify(pt, null, 2));
  await dispatchMove(page, pt.x, pt.y);
  const m = await measure(page, pt);
  console.log('measure:', JSON.stringify(m, null, 2));

  let pass;
  if (c.expectCw1SingleRow) {
    pass = m.lit && m.belowNeedle && !m.throughGlyphs && m.segCount <= 2;
  } else if (c.expectMinSegs > 1) {
    pass =
      m.lit &&
      m.segCount >= c.expectMinSegs &&
      (m.linesCovered || 0) >= Math.max(c.expectMinSegs, (m.uniqueLines || 2) - 1);
  } else {
    pass = m.lit && !m.throughGlyphs && m.belowNeedle;
  }
  if (pass) console.log('PASS', c.name);
  else {
    console.log('FAIL', c.name);
    failed++;
  }
}

await context.close();
process.exit(failed ? 1 : 0);
