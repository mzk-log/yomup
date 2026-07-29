/**
 * AT-2 — 愛知総合工科附属中 CMS 一覧: dd > div.except の折り返し文
 * 報告 URL: https://aichi-te-jh.aichi-c.ed.jp/cms/
 * 期待: 第1文（句点まで）が折り返し両行に光る（pointer 行だけの細切れにしない）
 * 実行: node _tools/probe-aichi-te-except.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-aichi-te-except');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

const EXCEPT_TEXT =
  '夏休みにはいる直前、中学校の「チャレンジ100」の一環として、機械系学科ワークショップとして、アルミニウムの板金加工実習が実施されました。今回は、本校の高校生と名古屋聾学校の生徒の皆さんが講師役とな';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>AT-2 fixture</title>
<style>
  body { font-family: "Yu Gothic", sans-serif; font-size: 16px; line-height: 1.6; margin: 24px; }
  .schoolnews { max-width: 720px; }
  dl { max-width: 720px; }
  dd { margin: 0; }
  h4.ttl { margin: 0 0 8px; font-size: 1.1em; }
  div.except { width: 700px; }
  /* card-cell 誤認を誘発しうる兄弟テキスト div（実ページ schoolnews 類似） */
  .schoolnews > .pad { margin-top: 12px; }
</style></head><body>
<main class="site-main">
<div class="schoolnews">
<dl>
  <dd id="item">
    <h4 class="ttl"><a href="#">機械系学科ワークショップ</a></h4>
    <div class="except" id="except">${EXCEPT_TEXT}</div>
  </dd>
</dl>
<div class="pad">余白</div>
</div>
<p id="prose">先日、案内をだしましたオープンスクールについて、事前に準備をしていた枠が早期に埋まってしまいました。</p>
</main>
</body></html>`;

const fixturePath = path.join(os.tmpdir(), 'yomup-at2-fixture.html');
fs.writeFileSync(fixturePath, FIXTURE, 'utf8');
const fixtureUrl = 'file:///' + fixturePath.replace(/\\/g, '/');

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
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

async function hoverAt(page, point) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(80);
  await page.mouse.move(point.x, point.y);
  await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  }, point);
  await page.waitForTimeout(700);
}

function locateWrapMeta() {
  const el = document.getElementById('except');
  const tn = el.firstChild;
  const text = tn.textContent;
  const period = text.indexOf('。');
  const wraps = [];
  let lastTop = null;
  for (let i = 0; i < period; i++) {
    const r = document.createRange();
    r.setStart(tn, i);
    r.setEnd(tn, i + 1);
    const rect = r.getBoundingClientRect();
    const top = Math.round(rect.top);
    if (lastTop === null) lastTop = top;
    if (top !== lastTop) {
      wraps.push(i);
      lastTop = top;
    }
  }
  if (wraps.length === 0) {
    return { ok: false, reason: 'no-wrap', period, textLen: text.length };
  }
  const wrapAt = wraps[0];
  // first visual line mid
  const r1 = document.createRange();
  r1.setStart(tn, Math.max(0, Math.floor(wrapAt / 2)));
  r1.setEnd(tn, Math.max(1, Math.floor(wrapAt / 2) + 4));
  const a = r1.getBoundingClientRect();
  // second visual line mid (within first sentence)
  const mid2 = Math.min(period - 2, wrapAt + Math.floor((period - wrapAt) / 2));
  const r2 = document.createRange();
  r2.setStart(tn, mid2);
  r2.setEnd(tn, mid2 + 4);
  const b = r2.getBoundingClientRect();
  // first sentence line tops
  const lineTops = [];
  let lt = null;
  for (let i = 0; i <= period; i++) {
    const r = document.createRange();
    r.setStart(tn, Math.min(i, text.length - 1));
    r.setEnd(tn, Math.min(i + 1, text.length));
    const top = Math.round(r.getBoundingClientRect().top);
    if (lt === null || top !== lt) {
      lineTops.push(top);
      lt = top;
    }
  }
  return {
    ok: true,
    wrapAt,
    period,
    lineTops,
    line1: { x: a.left + Math.min(20, a.width / 2), y: (a.top + a.bottom) / 2 },
    line2: { x: b.left + Math.min(20, b.width / 2), y: (b.top + b.bottom) / 2 }
  };
}

async function measureOverlay(page, expectedLineCount) {
  return page.evaluate(
    ({ sel, expectedLineCount: n }) => {
      const segs = [...document.querySelectorAll(sel)].map((e) => {
        const r = e.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          w: Math.round(r.width)
        };
      });
      const lit = segs.length > 0;
      const tops = [...new Set(segs.map((s) => s.top))].sort((a, b) => a - b);
      // 旧不具合: pointer 行絞りで 1 視覚行のみ。期待は第1文の折り返し行数ぶんの下線
      return {
        lit,
        segCount: segs.length,
        distinctTops: tops.length,
        segs,
        coversAllSentenceLines: lit && tops.length >= n && segs.every((s) => s.w > 40)
      };
    },
    { sel: OVERLAY, expectedLineCount }
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

await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await preparePage(context, page);
console.log('fixture:', fixtureUrl);

const meta = await page.evaluate(locateWrapMeta);
console.log('wrap-meta:', JSON.stringify(meta, null, 2));
if (!meta.ok) {
  console.log('RESULT: FAIL setup', meta.reason);
  await context.close();
  process.exit(1);
}

await hoverAt(page, meta.line1);
const m1 = await measureOverlay(page, meta.lineTops.length);
console.log('AT-2 line1 hover:', JSON.stringify(m1, null, 2));

await hoverAt(page, meta.line2);
const m2 = await measureOverlay(page, meta.lineTops.length);
console.log('AT-2 line2 hover:', JSON.stringify(m2, null, 2));

await hoverAt(page, await page.evaluate(() => {
  const p = document.getElementById('prose');
  const r = p.getBoundingClientRect();
  return { x: r.left + 40, y: (r.top + r.bottom) / 2 };
}));
const proseLit = await page.evaluate((sel) => document.querySelectorAll(sel).length > 0, OVERLAY);
console.log('AT-2 prose lit:', proseLit);

const pass =
  m1.coversAllSentenceLines &&
  m2.coversAllSentenceLines &&
  proseLit === true;

console.log(
  pass
    ? 'RESULT: PASS (sentence covers both wrap lines from either hover)'
    : `RESULT: FAIL line1=${m1.coversAllSentenceLines} line2=${m2.coversAllSentenceLines} prose=${proseLit}`
);

await context.close();
process.exit(pass ? 0 : 1);
