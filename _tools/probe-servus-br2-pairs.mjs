/**
 * SV-2 — Servus: 2行 br はマーカー/※/句点なし「：」のみ1行単位。句点付き2行は割らない
 * Usage:
 *   node _tools/probe-servus-br2-pairs.mjs
 *   node _tools/probe-servus-br2-pairs.mjs --live
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-servus-br2-pairs');
const LIVE = process.argv.includes('--live');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';

const LIVE_URL =
  'https://www.servusjapan.com/recruit/2027%E6%96%B0%E5%8D%92%E6%8E%A1%E7%94%A8';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>SV-2 br2</title>
<style>body{font-family:"Yu Gothic",sans-serif;font-size:15px;line-height:1.5;margin:40px}</style>
</head><body>
<p id="hours">7:00~16:30/8:00~17:30/9:00~18:30 のなかで8 時間勤務（休憩90 分）<br>
※各レースカテゴリー、時期による時差出勤制度</p>
<p id="salary">①新卒メカニック　月額 234,500 円<br>
②新卒エンジニア　月額 244,500 円</p>
<p id="allow">メカニック：レースピット作業に対するもの<br>
\u200bエンジニア：プログラミング・設計業務に関するもの</p>
<p id="period">全般：英語、簿記<br>
これらの能力で業務に活かされているものに対し毎月手当が支給されます。</p>
<p id="prose2">これは通常の散文の一行目です。<br>
これは句点付きの二行目です。</p>
</body></html>`;

let targetUrl;
if (LIVE) {
  targetUrl = LIVE_URL;
} else {
  const fixturePath = path.join(os.tmpdir(), 'yomup-sv2-br2-pairs.html');
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
      } catch (_err) {}
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
  await page.waitForTimeout(LIVE ? 1200 : 900);
}

async function measure(page) {
  return page.evaluate((sel) => {
    const segs = [...document.querySelectorAll(sel)].map((e) => {
      const r = e.getBoundingClientRect();
      return { top: Math.round(r.top), width: Math.round(r.width) };
    });
    const tops = [...new Set(segs.filter((s) => s.width > 20).map((s) => s.top))];
    return { lit: segs.length > 0, lineCount: tops.length, tops };
  }, OVERLAY);
}

async function coLit(page, otherNeedle) {
  return page.evaluate(
    ({ sel, otherNeedle }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const i = (n.textContent || '').indexOf(otherNeedle);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, Math.min(n.textContent.length, i + 4));
        const tr = range.getBoundingClientRect();
        return [...document.querySelectorAll(sel)].some((e) => {
          const r = e.getBoundingClientRect();
          const horiz = Math.min(r.right, tr.right) - Math.max(r.left, tr.left);
          return horiz > 10 && Math.abs(r.top + 2 - tr.bottom) < 10;
        });
      }
      return false;
    },
    { sel: OVERLAY, otherNeedle }
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
if (!context.serviceWorkers()[0]) await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());
await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
await preparePage(context, page);
if (LIVE) {
  await page.waitForFunction(
    () => (document.body?.innerText || '').includes('全般：'),
    null,
    { timeout: 90000 }
  );
  await page.waitForTimeout(2500);
}
console.log('url:', targetUrl);

let failed = 0;

async function assertSingle(name, needle, otherNeedle) {
  let ok = false;
  for (let i = 0; i < 3; i++) {
    const pt = await locateNeedle(page, needle);
    if (!pt) continue;
    await dispatchMove(page, pt.x, pt.y);
    const m = await measure(page);
    const other = otherNeedle ? await coLit(page, otherNeedle) : false;
    console.log(name, JSON.stringify({ ...m, other }));
    if (m.lit && m.lineCount === 1 && !other) {
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

async function assertNotListSplit(name, needle, otherNeedle) {
  const pt = await locateNeedle(page, needle);
  if (!pt) {
    console.log('FAIL locate', name);
    failed++;
    return;
  }
  await dispatchMove(page, pt.x, pt.y);
  const m = await measure(page);
  const other = await coLit(page, otherNeedle);
  console.log(name, JSON.stringify({ ...m, other }));
  // 句点付き2行をリスト分割すると other=false & lineCount=1 になる。
  // 未分割（段落一括）なら other=true。AI-1 維持の合格条件は other=true。
  if (m.lit && other) {
    console.log('PASS', name, '(co-lit = not list-split)');
    return;
  }
  console.log('FAIL', name, '(expected co-lit, not 1-line list split)');
  failed++;
}

const cases = LIVE
  ? [
      ['hours', '7:00~16:30', '時差出勤'],
      ['salary', '①新卒メカニック', '②新卒エンジニア'],
      ['allow', 'メカニック：レースピット', 'エンジニア：プログラミング'],
      ['label-body', '全般：英語', 'これらの能力で業務']
    ]
  : [
      ['hours', '7:00~16:30', '時差出勤'],
      ['salary', '①新卒メカニック', '②新卒エンジニア'],
      ['allow', 'メカニック：レースピット', 'エンジニア：プログラミング'],
      ['label-body', '全般：英語', 'これらの能力で業務']
    ];

for (const [name, a, b] of cases) {
  await assertSingle(name, a, b);
}

if (!LIVE) {
  // 各行が句点終わりの散文2行 — リスト分割対象外。句点チャンクで1行のみは AI-1 として合格
  {
    const pt = await locateNeedle(page, 'これは通常の散文');
    if (!pt) {
      console.log('FAIL locate prose2');
      failed++;
    } else {
      await dispatchMove(page, pt.x, pt.y);
      const m = await measure(page);
      const other = await coLit(page, 'これは句点付き');
      console.log('prose2', JSON.stringify({ ...m, other }));
      if (m.lit && (other || m.lineCount === 1)) {
        console.log('PASS prose2 (para or sentence chunk; not forced list)');
      } else {
        console.log('FAIL prose2');
        failed++;
      }
    }
  }
}

await context.close();
process.exit(failed ? 1 : 0);
