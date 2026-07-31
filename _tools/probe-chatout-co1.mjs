/**
 * CO-1 / CO-2 — chatout.html 型:
 *   CO-1: div.done（strong + テキスト・br なし）が光る
 *   CO-2: footer 直テキストが光る
 * 実行: node _tools/probe-chatout-co1.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-chatout-co1');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>CO-1/CO-2 fixture</title>
<style>
  body { font-family: "Yu Gothic", sans-serif; font-size: 18px; line-height: 1.65; margin: 40px; max-width: 720px; }
  .done { padding: 1rem; border: 1px solid #b5ddbc; background: #e8f6ea; margin-bottom: 1.25rem; }
  footer { margin-top: 1.25rem; color: #5c574f; font-size: 0.95rem; }
</style></head><body>
<main>
  <div class="done" id="done">
    <strong>済:</strong> 読むプ <strong>3.7.0</strong> はストア申請・承認・公開済み。
  </div>
  <footer id="foot">
    前提更新: ユーザー報告により 3.7.0 公開済み。優先はシリーズ⑧へ差し替え。
  </footer>
</main>
</body></html>`;

const fixturePath = path.join(os.tmpdir(), 'yomup-co1-fixture.html');
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
  await page.mouse.move(point.x, point.y, { steps: 6 });
  await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  }, point);
  await page.waitForTimeout(700);
}

async function overlayInfo(page) {
  return page.evaluate((sel) => {
    const segs = [...document.querySelectorAll(sel)];
    if (!segs.length) return { count: 0, width: 0, textHint: '' };
    let left = Infinity;
    let right = -Infinity;
    for (const s of segs) {
      const r = s.getBoundingClientRect();
      if (r.width <= 0) continue;
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
    }
    return {
      count: segs.length,
      width: right > left ? Math.round(right - left) : 0
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

const points = await page.evaluate(() => {
  function midOfText(el, needle) {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      const i = n.textContent.indexOf(needle);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + Math.min(3, needle.length));
      const r = range.getBoundingClientRect();
      return { x: r.left + Math.min(8, r.width / 2), y: (r.top + r.bottom) / 2, fullW: Math.round(el.getBoundingClientRect().width) };
    }
    return null;
  }
  return {
    done: midOfText(document.getElementById('done'), 'ストア'),
    foot: midOfText(document.getElementById('foot'), '前提更新')
  };
});

let failed = false;

async function check(label, point, minWidthRatio) {
  if (!point) {
    console.log(`FAIL ${label}: point not found`);
    failed = true;
    return;
  }
  await hoverAt(page, point);
  const info = await overlayInfo(page);
  const ok = info.count > 0 && info.width >= Math.max(40, Math.round(point.fullW * minWidthRatio));
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label}: overlay=${info.count} width=${info.width} (expect>=${Math.round(point.fullW * minWidthRatio)})`
  );
  if (!ok) failed = true;
}

await check('CO-1 done(strong+text, no br)', points.done, 0.35);
await check('CO-2 footer plain text', points.foot, 0.35);

await context.close();
fs.rmSync(USER_DATA, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
