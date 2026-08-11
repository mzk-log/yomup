/**
 * TK-1 — 高岡観光ナビ: Froala div.fr-view（text+br + 末尾 p/button/style）が光る
 * https://www.takaoka.or.jp/viewpoint/detail_3204.html
 * Usage:
 *   node _tools/probe-takaoka-fr-view.mjs
 *   node _tools/probe-takaoka-fr-view.mjs --live
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-takaoka-fr-view');
const LIVE = process.argv.includes('--live');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';
const LIVE_URL = 'https://www.takaoka.or.jp/viewpoint/detail_3204.html';
const BODY_NEEDLE = '高さ16';
const H3_NEEDLE = '日本一の美男';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>TK-1 fr-view</title>
<style>body{margin:40px;font-size:16px;line-height:1.8}.fr-view{max-width:640px}</style>
</head><body>
<h2>高岡大仏</h2>
<h3 id="lead">${H3_NEEDLE}と呼ばれる阿弥陀如来坐像。銅器日本一の高岡の象徴的存在</h3>
<div class="fr-view" id="body">高岡市の大佛寺にある青銅製阿弥陀如来坐像「高岡大仏」は高さ16m。<br>
地元の銅器製造技術の粋を集め1907年より26年の歳月をかけて完成し、小杉大仏、庄川大仏と共に越中三大仏の一つです。<br>
およそ800年前、承久の乱をさけて越中で入道した源義勝が木造大仏を造営したことがはじまりだといわれています。<br>
<br>
境内入口から台座までまっすぐ伸びた参道を歩みます。<br>
<p><br><span style="font-size:20px;"><strong>■関連するモデルコース</strong></span></p>
<button type="button">高岡大仏＆瑞龍寺とご当地グルメ満喫モデルコース</button>
<style>.x{}</style>
</div>
</body></html>`;

let targetUrl;
if (LIVE) {
  targetUrl = LIVE_URL;
} else {
  const fixturePath = path.join(os.tmpdir(), 'yomup-tk1-fr-view.html');
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
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 45000 });
  }
  await page.evaluate(() => {
    const host = document.getElementById('YomuP-popup-container');
    const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
    if (img && !img.classList.contains('active')) img.click();
  });
}

async function bringNeedleIntoView(page, needle) {
  if (!LIVE) return;
  await page.mouse.move(640, 400);
  for (let i = 0; i < 40; i++) {
    const inView = await page.evaluate((needle) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (!(n.textContent || '').includes(needle)) continue;
        const parent = n.parentElement;
        if (!parent || !parent.closest || !parent.closest('div.fr-view, h3')) continue;
        const range = document.createRange();
        const i = (n.textContent || '').indexOf(needle);
        range.setStart(n, i);
        range.setEnd(n, Math.min(n.textContent.length, i + 4));
        const r = range.getBoundingClientRect();
        if (r.width < 2) continue;
        const mid = (r.top + r.bottom) / 2;
        return mid > 80 && mid < window.innerHeight - 40;
      }
      return false;
    }, needle);
    if (inView) return;
    await page.mouse.wheel(0, 350);
    await page.waitForTimeout(120);
  }
}

async function locateNeedle(page, needle, requireFrView) {
  return page.evaluate(
    ({ needle, requireFrView }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.textContent || '';
        const i = t.indexOf(needle);
        if (i < 0) continue;
        const parent = n.parentElement;
        if (!parent) continue;
        if (requireFrView && !(parent.closest && parent.closest('div.fr-view'))) continue;
        parent.scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, Math.min(t.length, i + Math.min(6, needle.length)));
        const r = range.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const y = (r.top + r.bottom) / 2;
        if (y < 0 || y > window.innerHeight) continue;
        return { x: r.left + Math.min(20, r.width / 2), y };
      }
      return null;
    },
    { needle, requireFrView: !!requireFrView }
  );
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
    return { lit: segs.length > 0, lineCount: tops.length, segCount: segs.length };
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
if (!context.serviceWorkers()[0]) await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());
await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
await preparePage(context, page);
console.log('url:', targetUrl);

let failed = 0;

async function assertLit(name, needle, requireFrView, soft = false) {
  if (LIVE) await bringNeedleIntoView(page, needle);
  let ok = false;
  const tries = soft ? 2 : 4;
  for (let i = 0; i < tries; i++) {
    if (LIVE) await bringNeedleIntoView(page, needle);
    const pt = await locateNeedle(page, needle, requireFrView);
    if (!pt) continue;
    await dispatchMove(page, pt.x, pt.y);
    const m = await measure(page);
    console.log(name, JSON.stringify(m));
    if (m.lit && m.lineCount >= 1) {
      ok = true;
      break;
    }
  }
  if (!ok) {
    if (soft) {
      console.log(name, 'SKIP (soft live; fr-body is primary)');
    } else {
      console.log(name, 'FAIL');
      failed++;
    }
  } else {
    console.log(name, soft ? 'PASS (soft)' : 'PASS');
  }
}

await assertLit('fr-body', BODY_NEEDLE, true);
// live は本文点灯が本命。h3 はスクロール/ホバーぶれで落ちやすいので soft。
await assertLit('h3-lead', H3_NEEDLE, false, LIVE);

await context.close();
if (failed) {
  console.log('RESULT FAIL', failed);
  process.exit(1);
}
console.log('RESULT PASS');
