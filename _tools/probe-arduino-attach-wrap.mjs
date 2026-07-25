/**
 * AR-1: Arduino ref 詳細 TD — ソフト折り返しで文中切れしない
 * Usage: node _tools/probe-arduino-attach-wrap.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-arduino-attach-wrap');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const URL = 'https://www.musashinodenpa.com/arduino/ref/index.php?f=0&pos=3063';
const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg';
const PHRASE = '呼び出せる関数は';
const FULL = '外部割り込みが発生したときに実行する関数を指定します';
const THIRD = '呼び出せる関数は引数と戻り値が不要なものだけです。';

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
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

const context = await chromium.launchPersistentContext(USER_DATA, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  viewport: { width: 900, height: 900 },
});
const page = context.pages()[0] || (await context.newPage());
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await preparePage(context, page);

const target = await page.evaluate(({ full, phrase }) => {
  const td = [...document.querySelectorAll('td')].find((el) =>
    (el.textContent || '').includes(full)
  );
  if (!td) return null;
  const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
  let textNode = null;
  while (walker.nextNode()) {
    if ((walker.currentNode.textContent || '').includes(full)) {
      textNode = walker.currentNode;
      break;
    }
  }
  if (!textNode) return null;
  const t = textNode.textContent || '';
  const idx = t.indexOf(phrase);
  const tmp = document.createElement('span');
  textNode.parentNode.insertBefore(tmp, textNode);
  tmp.scrollIntoView({ block: 'center' });
  tmp.remove();
  const phraseRange = document.createRange();
  phraseRange.setStart(textNode, idx);
  phraseRange.setEnd(textNode, idx + phrase.length);
  const pr = phraseRange.getBoundingClientRect();
  const fullRange = document.createRange();
  fullRange.selectNodeContents(textNode);
  const wraps = [...fullRange.getClientRects()].filter((r) => r.width > 0);
  return {
    wrapCount: wraps.length,
    x: Math.round(pr.left + pr.width / 2),
    y: Math.round(pr.top + pr.height / 2),
    phraseW: Math.round(pr.width),
  };
}, { full: FULL, phrase: PHRASE });

if (!target || target.wrapCount < 2) {
  console.error('FAIL: need soft-wrapped prose', target);
  await context.close();
  process.exit(1);
}

await page.mouse.move(4, 4);
await page.waitForTimeout(80);
await page.mouse.move(target.x, target.y);
await page.evaluate(({ x, y }) => {
  const t = document.elementFromPoint(x, y);
  const init = { bubbles: true, clientX: x, clientY: y, view: window };
  document.dispatchEvent(new MouseEvent('mousemove', init));
  t?.dispatchEvent(new MouseEvent('mousemove', init));
}, target);
await page.waitForTimeout(450);

const segs = await page.evaluate((sel) => {
  return [...document.querySelectorAll(sel)].map((e) => {
    const r = e.getBoundingClientRect();
    return { top: Math.round(r.top), w: Math.round(r.width) };
  });
}, OVERLAY);

const unionW = segs.reduce((a, s) => a + s.w, 0);
// 旧不具合: pointer 絞りでフレーズ幅(~phraseW)程度だけ光る / 文の後半が欠ける
// 期待: 第3文全体（折り返し含む）が光り、union がフレーズ幅より明らかに広い
const coversSentence = segs.length >= 1 && unionW >= target.phraseW + 80;
const notWholeTd = segs.every((s) => s.w < 850);

console.log({ target, segs, unionW, thirdLen: THIRD.length, coversSentence, notWholeTd });
const pass = coversSentence && notWholeTd;
console.log(pass ? 'PASS: AR-1 phrase hover lights full sentence' : 'FAIL: AR-1');
await context.close();
process.exit(pass ? 0 : 2);
