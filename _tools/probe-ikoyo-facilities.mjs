/**
 * IK-1 / IK-2 — いこーよ施設一覧
 * IK-1: 導入文の長文葉 div.c-container が句点 chunk で光る
 * IK-2: 施設カード LI がまとめて光らず、説明/リード単位になる
 * https://iko-yo.net/facilities?genre_ids%5B%5D=21&prefecture_ids%5B%5D=23
 * Usage:
 *   node _tools/probe-ikoyo-facilities.mjs
 *   node _tools/probe-ikoyo-facilities.mjs --live
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-ikoyo-facilities');
const LIVE = process.argv.includes('--live');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';
const LIVE_URL =
  'https://iko-yo.net/facilities?genre_ids%5B%5D=21&prefecture_ids%5B%5D=23';

const INTRO =
  '愛知県にある子供が喜ぶ、親子で楽しめる工場見学をご紹介します。貴重な体験ができたり、試食や限定のお土産がもらえる工場もあり、学びながらも楽しい思い出になること間違いなし。お気に入りの工場見学スポットを見つけてくださいね。';
const INTRO_NEEDLE = '愛知県にある子供が喜ぶ';
const TITLE_NEEDLE = 'めんたいパーク';
const LEAD_NEEDLE = '明太子専門のテーマパーク';
const DESC_NEEDLE = '「めんたいパークとこなめ」は';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>IK iko-yo facilities</title>
<style>
body{margin:0;font-size:14px;line-height:1.5;font-family:sans-serif}
.l-page{max-width:900px;margin:0 auto;padding:12px}
.l-region{margin:8px 0;padding:6px 0;border-bottom:1px solid #ccc}
.l-content{margin-top:12px}
.c-container{max-width:640px;margin-bottom:24px}
.p-index-list-item{list-style:none;border:1px solid #ddd;padding:12px;max-width:720px}
.p-index-list-item__heading{font-size:20px;margin:0 0 6px}
.p-index-list-item__lead{font-weight:700;margin:8px 0}
.p-index-list-item__description{color:#333;margin:8px 0}
.p-index-list-item__address__ellipsis{display:block;margin:4px 0}
</style>
</head><body>
<div class="layout-sib">ナビA</div>
<div class="layout-sib">ナビB</div>
<div class="layout-sib">ナビC</div>
<div class="l-page">
  <div class="l-region">北海道・東北 関東 東京 神奈川 千葉 埼玉 東海 愛知</div>
  <div class="l-content">
    <div class="c-container--sm">
      <h1>愛知県の工場見学のおでかけスポット一覧</h1>
      <div class="c-container" id="intro">${INTRO}</div>
    </div>
    <ul>
    <li class="p-index-list-item" id="card">
      <div class="p-index-list-item__container">
        <div class="p-index-list-item__header">
          <a class="p-index-list-item__header__link" href="#f"><h3 class="p-index-list-item__heading">${TITLE_NEEDLE}　とこなめ</h3></a>
          <div class="p-index-list-item__address">
            <div class="p-index-list-item__address__text">
              <span class="p-index-list-item__address__ellipsis">愛知県常滑市 / <span>工場見学</span>, 室内遊び場, ショッピング</span>
            </div>
          </div>
        </div>
        <div class="p-index-list-item__content">
          <div class="p-index-list-item__body--with-padding">
            <div class="p-index-list-item__rating"><span class="rating__value">4.7</span><a href="#r">11件</a></div>
            <div class="p-index-list-item__lead" id="lead">【ミュージアム11/8リニューアルOPEN】${LEAD_NEEDLE}</div>
            <div class="p-index-list-item__description" id="desc">${DESC_NEEDLE}、明太子の老舗「かねふく」運営の明太子専門テーマパークです。中部地方では唯一のめんたいパークとなります。</div>
          </div>
        </div>
      </div>
    </li>
    </ul>
  </div>
</div>
</body></html>`;

let targetUrl;
if (LIVE) {
  targetUrl = LIVE_URL;
} else {
  const fixturePath = path.join(os.tmpdir(), 'yomup-ikoyo-facilities.html');
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
  await page.waitForTimeout(LIVE ? 4500 : 2000);
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
  await page.waitForTimeout(LIVE ? 800 : 200);
  // live: 同意バナー等を閉じる（あれば）
  if (LIVE) {
    try {
      const btn = page.locator('button:has-text("同意"), button:has-text("OK"), button:has-text("閉じる")').first();
      if (await btn.isVisible({ timeout: 1500 })) await btn.click({ timeout: 2000 });
    } catch (_e) {
      /* ignore */
    }
  }
}

async function locateNeedle(page, needle, requireSel) {
  if (LIVE) {
    await page.evaluate((needle) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (!(n.textContent || '').includes(needle)) continue;
        n.parentElement?.scrollIntoView({ block: 'center' });
        break;
      }
    }, needle);
    await page.waitForTimeout(400);
  }
  return page.evaluate(
    ({ needle, requireSel }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.textContent || '';
        const i = t.indexOf(needle);
        if (i < 0) continue;
        const parent = n.parentElement;
        if (!parent) continue;
        if (requireSel && !(parent.closest && parent.closest(requireSel))) continue;
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
    { needle, requireSel: requireSel || null }
  );
}

async function dispatchMove(page, x, y) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(50);
  await page.mouse.move(x, y);
  await page.evaluate(
    ({ x, y }) => {
      const t = document.elementFromPoint(x, y);
      const init = { bubbles: true, clientX: x, clientY: y, view: window };
      document.dispatchEvent(new MouseEvent('mousemove', init));
      t?.dispatchEvent(new MouseEvent('mousemove', init));
    },
    { x, y }
  );
  await page.waitForTimeout(LIVE ? 1200 : 900);
}

async function measure(page) {
  return page.evaluate((sel) => {
    const segs = [...document.querySelectorAll(sel)].map((e) => {
      const r = e.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        width: Math.round(r.width)
      };
    });
    const tops = [...new Set(segs.filter((s) => s.width > 20).map((s) => s.top))];
    return { lit: segs.length > 0, lineCount: tops.length, segCount: segs.length, segs };
  }, OVERLAY);
}

/** 針テキストを含むホスト帯に下線があるか */
async function bandLitForNeedle(page, hostSel, needle) {
  return page.evaluate(
    ({ overlaySel, hostSel, needle }) => {
      const hosts = [...document.querySelectorAll(hostSel)].filter((h) =>
        (h.textContent || '').includes(needle)
      );
      const host = hosts[0];
      if (!host) return false;
      const hr = host.getBoundingClientRect();
      const segs = [...document.querySelectorAll(overlaySel)];
      for (const e of segs) {
        const r = e.getBoundingClientRect();
        if (r.width < 20) continue;
        const mid = (r.top + r.bottom) / 2;
        if (mid >= hr.top - 2 && mid <= hr.bottom + 2) return true;
      }
      return false;
    },
    { overlaySel: OVERLAY, hostSel, needle }
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
console.log('url:', targetUrl);

let failed = 0;

async function assertIntro() {
  let ok = false;
  let last = null;
  for (let i = 0; i < 4; i++) {
    const pt = await locateNeedle(page, INTRO_NEEDLE, 'div.c-container');
    if (!pt) continue;
    await dispatchMove(page, pt.x, pt.y);
    last = await measure(page);
    console.log('intro', JSON.stringify(last));
    if (last.lit && last.lineCount >= 1) {
      ok = true;
      break;
    }
  }
  if (!ok) {
    console.log('intro FAIL');
    failed++;
  } else {
    console.log('intro PASS');
  }
}

async function assertCardUnit(name, needle, requireSel, expectSel, forbidSels) {
  let ok = false;
  let last = null;
  for (let i = 0; i < 4; i++) {
    const pt = await locateNeedle(page, needle, requireSel);
    if (!pt) continue;
    await dispatchMove(page, pt.x, pt.y);
    last = await measure(page);
    const expectHit = await bandLitForNeedle(page, expectSel, needle);
    const forbidHits = [];
    for (const fs of forbidSels) {
      const bad = await page.evaluate(
        ({ overlaySel, forbidSel, needle, requireSel }) => {
          const host = [...document.querySelectorAll(requireSel)].find((h) =>
            (h.textContent || '').includes(needle)
          );
          const card = host && host.closest('li');
          if (!card) return false;
          const targets = [...card.querySelectorAll(forbidSel)];
          const segs = [...document.querySelectorAll(overlaySel)];
          for (const t of targets) {
            const hr = t.getBoundingClientRect();
            for (const e of segs) {
              const r = e.getBoundingClientRect();
              if (r.width < 20) continue;
              const mid = (r.top + r.bottom) / 2;
              if (mid >= hr.top - 2 && mid <= hr.bottom + 2) return true;
            }
          }
          return false;
        },
        { overlaySel: OVERLAY, forbidSel: fs, needle, requireSel }
      );
      if (bad) forbidHits.push(fs);
    }
    console.log(name, JSON.stringify({ ...last, expectHit, forbidHits }));
    if (last.lit && expectHit && forbidHits.length === 0) {
      ok = true;
      break;
    }
  }
  if (!ok) {
    console.log(name, 'FAIL');
    failed++;
  } else {
    console.log(name, 'PASS');
  }
}

await assertIntro();
await assertCardUnit(
  'desc-only',
  DESC_NEEDLE,
  '.p-index-list-item__description',
  '.p-index-list-item__description',
  ['h3.p-index-list-item__heading', '.p-index-list-item__lead']
);
await assertCardUnit(
  'lead-only',
  LEAD_NEEDLE,
  '.p-index-list-item__lead',
  '.p-index-list-item__lead',
  ['h3.p-index-list-item__heading', '.p-index-list-item__description']
);

await context.close();
if (failed) {
  console.log('RESULT FAIL', failed);
  process.exit(1);
}
console.log('RESULT PASS');
