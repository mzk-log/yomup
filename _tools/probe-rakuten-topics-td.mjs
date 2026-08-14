/**
 * RK-1 — 楽天商品ページ型: TD 内トピックス（画像+タイトル span）が光る
 * 実行: node _tools/probe-rakuten-topics-td.mjs
 * 任意: node _tools/probe-rakuten-topics-td.mjs --live
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-rakuten-topics-probe');
const LIVE = process.argv.includes('--live');
const LIVE_URL = 'https://item.rakuten.co.jp/elecom/4549550281768/';
const NEEDLE = '人の感性に寄り添う、EGG MOUSE';

fs.rmSync(USER_DATA, { recursive: true, force: true });

const FIXTURE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>RK-1</title>
<style>
body { font-family: "Yu Gothic", sans-serif; font-size: 14px; margin: 24px; }
table { width: 640px; }
.title { margin: 0 0 4px; }
.ellipsis { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.date { color: #666; font-size: 12px; }
.link { display: flex; gap: 12px; text-decoration: none; color: inherit; margin-bottom: 16px; }
.image { width: 120px; height: 68px; background: #ddd; flex: 0 0 auto; }
</style></head><body>
<table width="640px" cellspacing="0" cellpadding="0" border="0" align="left">
<tbody><tr><td>
<div>
  <div style="display:flex;justify-content:space-between;margin-bottom:16px;">
    <span class="heading">ショップ内の最新トピックス</span>
    <a href="#all"><span>すべて見る</span></a>
  </div>
  <div>
    <a class="link" href="#1">
      <div class="image"></div>
      <div class="info">
        <div class="title"><span class="text-container"><span class="ellipsis">${NEEDLE}。</span></span></div>
        <span class="date">2026/07/15</span>
      </div>
    </a>
    <a class="link" href="#2">
      <div class="image"></div>
      <div class="info">
        <div class="title"><span class="text-container"><span class="ellipsis">あると便利！エレコムおすすめ商品特集</span></span></div>
        <span class="date">2026/07/01</span>
      </div>
    </a>
    <a class="link" href="#3">
      <div class="image"></div>
      <div class="info">
        <div class="title"><span class="text-container"><span class="ellipsis">デジタル社会に疲れたあなたへ、安らぎの時間を。エレコムのリカバリーウェア。</span></span></div>
        <span class="date">2026/06/11</span>
      </div>
    </a>
    <a class="link" href="#4">
      <div class="image"></div>
      <div class="info">
        <div class="title"><span class="text-container"><span class="ellipsis">ユーザーの声を取り入れ、最新機能を搭載しリニューアル。 「IST PLUS」</span></span></div>
        <span class="date">2026/05/29</span>
      </div>
    </a>
  </div>
</div>
</td></tr></tbody></table>
</body></html>`;

const htmlPath = path.join(os.tmpdir(), 'yomup-rakuten-topics-td.html');
fs.writeFileSync(htmlPath, FIXTURE, 'utf8');

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
    localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  // executeYomuP 遅延(~2s)後に active 付与前クリックで OFF 化するのを避ける
  await page.waitForTimeout(LIVE ? 3500 : 1500);
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 });
  } catch (_e) {
    const sw = context.serviceWorkers()[0];
    if (sw) {
      await sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
      });
      await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 30000 });
    }
  }
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const host = document.getElementById('YomuP-popup-container');
    const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
    if (img && !img.classList.contains('active')) img.click();
  });
  await page.waitForFunction(() => {
    const img = document
      .getElementById('YomuP-popup-container')
      ?.shadowRoot?.querySelector('.lightbulb-button img');
    return !!(img && img.classList.contains('active'));
  }, { timeout: 10000 });
  await page.waitForTimeout(400);
}

async function measure(page) {
  const target = await page.evaluate((needle) => {
    const title = [...document.querySelectorAll('span')].find((s) =>
      (s.textContent || '').includes(needle)
    );
    if (!title) return { ok: false, reason: 'title-missing' };
    title.scrollIntoView({ block: 'center' });
    const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
    let textNode = null;
    while (walker.nextNode()) {
      if ((walker.currentNode.textContent || '').includes('EGG') ||
          (walker.currentNode.textContent || '').includes(needle.slice(0, 4))) {
        textNode = walker.currentNode;
        break;
      }
    }
    if (!textNode) textNode = title.firstChild;
    const r = document.createRange();
    const t = textNode.textContent || '';
    const i = Math.max(0, t.indexOf(needle.slice(0, 2)) >= 0 ? t.indexOf(needle.slice(0, 2)) : 0);
    r.setStart(textNode, i);
    r.setEnd(textNode, Math.min(t.length, i + 4));
    const rect = r.getBoundingClientRect();
    return {
      ok: true,
      x: rect.left + Math.min(16, rect.width / 2),
      y: rect.top + rect.height / 2
    };
  }, NEEDLE);
  if (!target.ok) return target;

  // scroll 完了後に実マウス移動（evaluate 内合成イベントは live で mouseout 競合しやすい）
  await page.waitForTimeout(300);
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(700);

  return page.evaluate(({ x, y, needle }) => {
    const title = [...document.querySelectorAll('span')].find((s) =>
      (s.textContent || '').includes(needle)
    );
    const td = title ? title.closest('td') : null;
    const tdBox = td ? td.getBoundingClientRect() : null;
    const root = document.getElementById('yomup-highlight-overlay-root');
    const segs = root
      ? [...root.querySelectorAll(
          '.yomup-highlight-underline-segment, .yomup-highlight-underline'
        )]
      : [];
    if (segs.length === 0) return { ok: false, reason: 'no-overlay', x, y };

    const titleBox = title.getBoundingClientRect();
    const hitsTitle = segs.some((s) => {
      const b = s.getBoundingClientRect();
      return (
        b.left < titleBox.right &&
        b.right > titleBox.left &&
        Math.abs((b.top + b.bottom) / 2 - (titleBox.top + titleBox.bottom) / 2) < 24
      );
    });

    const spillsCell =
      tdBox &&
      segs.some((s) => {
        const b = s.getBoundingClientRect();
        return b.width > tdBox.width * 0.85 && b.height > 2;
      }) &&
      segs.length >= 3;

    return {
      ok: hitsTitle && !spillsCell,
      hitsTitle,
      spillsCell,
      segCount: segs.length,
      x: Math.round(x),
      y: Math.round(y)
    };
  }, { x: target.x, y: target.y, needle: NEEDLE });
}

const context = await chromium.launchPersistentContext(USER_DATA, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`
  ],
  viewport: { width: 1100, height: 900 }
});
if (!context.serviceWorkers()[0]) {
  await context.waitForEvent('serviceworker', { timeout: 20000 });
}
const page = context.pages()[0] || (await context.newPage());
const targetUrl = LIVE ? LIVE_URL : 'file:///' + htmlPath.replace(/\\/g, '/');
await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
await preparePage(context, page);
console.log('url:', targetUrl, LIVE ? '(live)' : '(fixture)');

const result = await measure(page);
console.log(JSON.stringify(result, null, 2));
await context.close();

if (!result.ok) {
  console.log('RESULT FAIL');
  process.exit(1);
}
console.log('RESULT PASS');
process.exit(0);
