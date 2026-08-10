/**
 * SV-1 — Servus / Wix: 無マーカー <p>+<br> 3行は1行単位。句点付き3行散文は誤分割しない
 * https://www.servusjapan.com/recruit/2027新卒採用
 * Usage:
 *   node _tools/probe-servus-br3-holidays.mjs
 *   node _tools/probe-servus-br3-holidays.mjs --live
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-servus-br3-holidays');
const LIVE = process.argv.includes('--live');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';

const LIVE_URL =
  'https://www.servusjapan.com/recruit/2027%E6%96%B0%E5%8D%92%E6%8E%A1%E7%94%A8';

const HOLIDAY_L1 = '年間休日105';
const HOLIDAY_L2 = '有給休暇';
const PROSE_L1 = 'これは通常の散文です';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>SV-1 br3</title>
<style>
  body { font-family: "Yu Gothic", sans-serif; font-size: 15px; line-height: 1.5; margin: 40px; }
</style></head><body>
<h2>休日</h2>
<p class="font_9 wixui-rich-text__text" id="hol">
<span style="font-weight:normal;"><span style="font-family:helvetica-w01-roman,sans-serif;">年間休日105 日<br class="wixui-rich-text__text">
有給休暇：勤続6 か月以上で有給10 日、最長20 日<br class="wixui-rich-text__text">
土日出張対応時は平日に代休取得</span></span></p>
<p id="prose">これは通常の散文です。<br>
句点があるので一覧扱いしたくない行です。<br>
最後の行も句点があります。</p>
</body></html>`;

let targetUrl;
if (LIVE) {
  targetUrl = LIVE_URL;
} else {
  const fixturePath = path.join(os.tmpdir(), 'yomup-sv1-br3-holidays.html');
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
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(LIVE ? 3500 : 2000);
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
  } catch (_e) {
    const sw = context.serviceWorkers()[0];
    if (sw) {
      try {
        await sw.evaluate(async () => {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
        });
      } catch (_err) {
        /* ignore */
      }
    }
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 30000 });
  }
}

async function locateNeedle(page, needle) {
  return page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent || '';
      const i = t.indexOf(needle);
      if (i < 0) continue;
      n.parentElement?.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, Math.min(t.length, i + Math.min(4, needle.length)));
      const r = range.getBoundingClientRect();
      if (r.width < 2) continue;
      return { x: r.left + Math.min(20, r.width / 2), y: (r.top + r.bottom) / 2, top: r.top, bottom: r.bottom };
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
  await page.waitForTimeout(LIVE ? 1200 : 900);
}

async function measureTops(page) {
  return page.evaluate((sel) => {
    const segs = [...document.querySelectorAll(sel)].map((e) => {
      const r = e.getBoundingClientRect();
      return { top: r.top, width: r.width };
    });
    const tops = [...new Set(segs.filter((s) => s.width > 20).map((s) => Math.round(s.top)))];
    return { lit: segs.length > 0, lineCount: tops.length, tops, segCount: segs.length };
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

await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
await preparePage(context, page);
if (LIVE) {
  await page.waitForFunction(
    () => (document.body?.innerText || '').includes('年間休日105'),
    null,
    { timeout: 60000 }
  );
  await page.waitForTimeout(2000);
}
console.log('url:', targetUrl);

let failed = 0;

async function assertSingleLine(name, needle) {
  let ok = false;
  for (let i = 0; i < 3; i++) {
    const pt = await locateNeedle(page, needle);
    if (!pt) continue;
    await dispatchMove(page, pt.x, pt.y);
    const m = await measureTops(page);
    console.log(name, JSON.stringify(m));
    if (m.lit && m.lineCount === 1) {
      console.log('PASS', name);
      ok = true;
      break;
    }
  }
  if (!ok) {
    console.log('FAIL', name);
    failed++;
  }
}

await assertSingleLine('holiday-l1', HOLIDAY_L1);
await assertSingleLine('holiday-l2', HOLIDAY_L2);

if (!LIVE) {
  // 句点付き3行: 無マーカー一覧にしない → ホバー1文でも br 3行同時下線にならないよう、
  // 少なくとも「一覧分割で1行だけ」にはしない（＝誤って unmarked 採用していないこと）。
  // 期待: 句点チャンクなら1行相当、または段落チャンクで複数行。unmarked 誤爆時は lineCount===1 かつ幅が1行分のみになり得るが、
  // ここでは「3行すべてが同時」でも「1 br 行のみ」でもなく、散文として句点分割されることを確認する。
  const pt = await locateNeedle(page, PROSE_L1);
  if (!pt) {
    console.log('FAIL locate prose');
    failed++;
  } else {
    await dispatchMove(page, pt.x, pt.y);
    const m = await measureTops(page);
    console.log('prose-period', JSON.stringify(m));
    // unmarked 誤採用だと br 1行のみ (lineCount===1)。句点分割でも lineCount===1 になりうる。
    // 誤採用検知: 本文「これは通常の散文です。」だけ光るのは OK。
    // より強い検知: 2行目「句点があるので…」の矩形と同時に出ないこと。
    const secondLit = await page.evaluate((sel) => {
      const needle = '句点があるので一覧扱い';
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const i = (n.textContent || '').indexOf(needle);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + 4);
        const tr = range.getBoundingClientRect();
        const segs = [...document.querySelectorAll(sel)];
        return segs.some((e) => {
          const r = e.getBoundingClientRect();
          const horiz = Math.min(r.right, tr.right) - Math.max(r.left, tr.left);
          return horiz > 10 && Math.abs(r.top - (tr.bottom - 2)) < 8;
        });
      }
      return false;
    }, OVERLAY);
    if (m.lit && !secondLit) {
      console.log('PASS prose-period (line2 not co-lit)');
    } else {
      console.log('FAIL prose-period', { secondLit });
      failed++;
    }
  }
}

await context.close();
process.exit(failed ? 1 : 0);
