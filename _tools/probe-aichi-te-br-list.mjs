/**
 * AT-1 — 愛知総合工科附属中 CMS: <p> 内 <br> + 「〇」箇条書きの行分離
 * 報告 URL: https://aichi-te-jh.aichi-c.ed.jp/cms/2026/07/post-1510.html
 * 実行: node _tools/probe-aichi-te-br-list.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-aichi-te-br-list');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>AT-1 fixture</title>
<style>
  body { font-family: "Yu Gothic", sans-serif; font-size: 16px; line-height: 1.9; max-width: 720px; margin: 40px; }
  p { margin: 1.5em 0; }
</style></head><body>
<p id="notes">当日の注意事項について<br>〇貸し出し用のスリッパはありません。児童・保護者ともにかならず室内履き（スリッパ可）をお持ちください。<br>〇校内に来客用の駐車場はありません。公共交通機関での来校にご協力ください（自家用車で来られる際は、コインパーキングなどを利用し、千種スポーツセンターへの駐車をしないようにしてください）。<br>〇当日の学校紹介は後日動画にて配信予定です。また、１０月３１日（土）のMTE祭（文化祭）も一般公開を行う予定です。</p>
<p id="prose">先日、案内をだしましたオープンスクールについて、事前に準備をしていた枠が早期に埋まってしまいました。多くの方にご興味を持っていただきありがとうございます。</p>
</body></html>`;

const fixturePath = path.join(os.tmpdir(), 'yomup-at1-fixture.html');
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

function locateTitleLine() {
  const p = document.getElementById('notes');
  const tn = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('当日の注意'));
  if (!tn) return null;
  const range = document.createRange();
  const idx = tn.textContent.indexOf('当日の注意');
  range.setStart(tn, idx);
  range.setEnd(tn, idx + 6);
  const r = range.getBoundingClientRect();
  if (r.width < 2) return null;
  return { x: r.left + Math.min(24, r.width / 2), y: (r.top + r.bottom) / 2 };
}

function locateFirstBullet() {
  const p = document.getElementById('notes');
  const tn = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('〇貸し出し'));
  if (!tn) return null;
  const range = document.createRange();
  const idx = tn.textContent.indexOf('〇貸し出し');
  range.setStart(tn, idx);
  range.setEnd(tn, idx + 5);
  const r = range.getBoundingClientRect();
  if (r.width < 2) return null;
  return { x: r.left + Math.min(24, r.width / 2), y: (r.top + r.bottom) / 2 };
}

function locateProse() {
  const p = document.getElementById('prose');
  const tn = p.firstChild;
  if (!tn || tn.nodeType !== 3) return null;
  const range = document.createRange();
  range.setStart(tn, 2);
  range.setEnd(tn, 8);
  const r = range.getBoundingClientRect();
  if (r.width < 2) return null;
  return { x: r.left + Math.min(24, r.width / 2), y: (r.top + r.bottom) / 2 };
}

async function measureSeparation(page) {
  return page.evaluate((sel) => {
    const p = document.getElementById('notes');
    const nodes = [...p.childNodes];
    const titleNode = nodes.find((n) => n.nodeType === 3 && n.textContent.includes('当日の注意'));
    const bulletNode = nodes.find((n) => n.nodeType === 3 && n.textContent.includes('〇貸し出し'));
    const titleRange = document.createRange();
    titleRange.selectNodeContents(titleNode);
    const titleBottom = titleRange.getBoundingClientRect().bottom;
    const bulletRange = document.createRange();
    const bi = bulletNode.textContent.indexOf('〇');
    bulletRange.setStart(bulletNode, bi);
    bulletRange.setEnd(bulletNode, Math.min(bulletNode.textContent.length, bi + 8));
    const bulletTop = bulletRange.getBoundingClientRect().top;

    const segs = [...document.querySelectorAll(sel)].map((e) => {
      const r = e.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        w: Math.round(r.width)
      };
    });
    const lit = segs.length > 0;
    const maxBottom = segs.reduce((m, s) => Math.max(m, s.bottom), -Infinity);
    const minTop = segs.reduce((m, s) => Math.min(m, s.top), Infinity);
    return {
      lit,
      segCount: segs.length,
      segs,
      titleBottom: Math.round(titleBottom),
      bulletTop: Math.round(bulletTop),
      maxBottom,
      minTop,
      titleOnly: lit && maxBottom < bulletTop - 2,
      bulletOnly: lit && minTop > titleBottom + 2
    };
  }, OVERLAY);
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

const titlePoint = await page.evaluate(locateTitleLine);
const bulletPoint = await page.evaluate(locateFirstBullet);
const prosePoint = await page.evaluate(locateProse);

if (!titlePoint || !bulletPoint || !prosePoint) {
  console.log('FAIL locate', { titlePoint, bulletPoint, prosePoint });
  await context.close();
  process.exit(1);
}

await hoverAt(page, titlePoint);
const titleM = await measureSeparation(page);
console.log('AT-1 title hover:', JSON.stringify(titleM, null, 2));

await hoverAt(page, bulletPoint);
const bulletM = await measureSeparation(page);
console.log('AT-1 first-bullet hover:', JSON.stringify(bulletM, null, 2));

await hoverAt(page, prosePoint);
const proseLit = await page.evaluate((sel) => {
  const segs = document.querySelectorAll(sel);
  return segs.length > 0;
}, OVERLAY);
console.log('AT-1 prose hover lit:', proseLit);

const passTitle = titleM.lit && titleM.titleOnly;
const passBullet = bulletM.lit && bulletM.bulletOnly;
const passProse = proseLit === true;
const ok = passTitle && passBullet && passProse;

console.log(
  ok
    ? 'RESULT: PASS (title-only / bullet-only / prose-lit)'
    : `RESULT: FAIL title=${passTitle} bullet=${passBullet} prose=${passProse}`
);

await context.close();
process.exit(ok ? 0 : 1);
