/**
 * AT-3 — 愛知総合工科附属中 CMS: 閉じ済み `）` 短行と次の br 行の誤結合
 * 報告 URL: https://aichi-te-jh.aichi-c.ed.jp/cms/2026/08/post-1543.html
 * 実行: node _tools/probe-aichi-te-contact-br.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-aichi-te-contact-br');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>AT-3 fixture</title>
<style>
  body { font-family: "Yu Gothic", sans-serif; font-size: 16px; line-height: 1.9; max-width: 720px; margin: 40px; }
  p { margin: 1.5em 0; }
</style></head><body>
<p id="contact">説明会を受けてのご質問などありましたら、以下までご連絡ください。<br>※連絡は平日日中にお願いします。また、会議や出張などで不在の際はご容赦ください。<br><br>学校概要・教育方針等学校生活全般について<br>TEL:052-784-6358<br>担当：附属中学校　副校長（〇〇）<br><br>入学者選抜について<br>TEL:052-954-7432<br>担当：愛知県教育委員会　高等学校教育課　中高一貫グループ<br><br>なお、2029年度に開校を目指している県立高専については、学校として、県の公式発表以外に、説明できる情報を持っていません。当該内容に関するご質問には十分なお答えができないことをご理解ください。</p>
</body></html>`;

const fixturePath = path.join(os.tmpdir(), 'yomup-at3-contact-fixture.html');
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

function locateText(snippet) {
  const p = document.getElementById('contact');
  const tn = [...p.childNodes].find(
    (n) => n.nodeType === 3 && n.textContent.includes(snippet)
  );
  if (!tn) return null;
  const range = document.createRange();
  const idx = tn.textContent.indexOf(snippet);
  range.setStart(tn, idx);
  range.setEnd(tn, Math.min(tn.textContent.length, idx + Math.min(6, snippet.length)));
  const r = range.getBoundingClientRect();
  if (r.width < 2) return null;
  return { x: r.left + Math.min(24, r.width / 2), y: (r.top + r.bottom) / 2 };
}

async function measureSeparation(page) {
  return page.evaluate((sel) => {
    const p = document.getElementById('contact');
    const nodes = [...p.childNodes];
    const tantoNode = nodes.find((n) => n.nodeType === 3 && n.textContent.includes('担当：附属'));
    const nyushiNode = nodes.find((n) => n.nodeType === 3 && n.textContent.includes('入学者選抜'));
    const tantoRange = document.createRange();
    tantoRange.selectNodeContents(tantoNode);
    const tantoBottom = tantoRange.getBoundingClientRect().bottom;
    const nyushiRange = document.createRange();
    const ni = nyushiNode.textContent.indexOf('入学者');
    nyushiRange.setStart(nyushiNode, ni);
    nyushiRange.setEnd(nyushiNode, Math.min(nyushiNode.textContent.length, ni + 6));
    const nyushiTop = nyushiRange.getBoundingClientRect().top;

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
      tantoBottom: Math.round(tantoBottom),
      nyushiTop: Math.round(nyushiTop),
      maxBottom,
      minTop,
      tantoOnly: lit && maxBottom < nyushiTop - 2,
      nyushiOnly: lit && minTop > tantoBottom + 2
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

const tantoPoint = await page.evaluate(locateText, '担当：附属');
const nyushiPoint = await page.evaluate(locateText, '入学者選抜');

if (!tantoPoint || !nyushiPoint) {
  console.log('FAIL locate', { tantoPoint, nyushiPoint });
  await context.close();
  process.exit(1);
}

await hoverAt(page, tantoPoint);
const tantoM = await measureSeparation(page);
console.log('AT-3 tanto hover:', JSON.stringify(tantoM, null, 2));

await hoverAt(page, nyushiPoint);
const nyushiM = await measureSeparation(page);
console.log('AT-3 nyushi hover:', JSON.stringify(nyushiM, null, 2));

const passTanto = tantoM.lit && tantoM.tantoOnly;
const passNyushi = nyushiM.lit && nyushiM.nyushiOnly;
const ok = passTanto && passNyushi;

console.log(
  ok
    ? 'RESULT: PASS (tanto-only / nyushi-only)'
    : `RESULT: FAIL tanto=${passTanto} nyushi=${passNyushi}`
);

await context.close();
process.exit(ok ? 0 : 1);
