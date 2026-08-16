/**
 * LX-1 — INAXライブミュージアム レストラン: text+br+strong+tel<a> の description が光る
 * https://livingculture.lixil.com/ilm/restaurant/
 * Usage:
 *   node _tools/probe-lixil-restaurant-br-a.mjs
 *   node _tools/probe-lixil-restaurant-br-a.mjs --live
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-lixil-restaurant');
const LIVE = process.argv.includes('--live');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';
const LIVE_URL = 'https://livingculture.lixil.com/ilm/restaurant/';
const NEEDLE = 'パーティープラン';
const HOST_SEL = '.p-restaurant-component02__description';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>LX-1 restaurant</title>
<style>
  body{margin:40px;font-size:16px;line-height:1.8}
  .p-restaurant-component02__description{max-width:640px}
</style>
</head><body>
<h2>予約について</h2>
<div class="p-restaurant-component02__description" id="desc">
ランチ、ディナータイム共にご予約承ります。<br>
 ※土・日・祝日のランチタイムは大変混雑いたしますので、11:00～11:30のご来店のみ予約を承ります。<br>
<br>
<strong>パーティープラン</strong>（通常営業時間外）<br>
 各種パーティー、ご宴会の予約を承ります。<br>
 10名～34名様（着席）/約50名様まで（立食）　2時間 ￥40,000～<br>
 結婚式の二次会等にもご活用ください。<br>
<br>
<strong>直通電話</strong>　<a href="tel:0569348266">0569-34-8266</a>   ※ご予約は直接レストランにご連絡ください。
</div>
</body></html>`;

let targetUrl;
if (LIVE) {
  targetUrl = LIVE_URL;
} else {
  const fixturePath = path.join(os.tmpdir(), 'yomup-lx1-restaurant.html');
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

async function locateNeedle(page, needle) {
  return page.evaluate(
    ({ needle, hostSel }) => {
      const host = document.querySelector(hostSel);
      if (!host) return null;
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.textContent || '';
        const i = t.indexOf(needle);
        if (i < 0) continue;
        n.parentElement?.scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, Math.min(t.length, i + Math.min(6, needle.length)));
        const r = range.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    },
    { needle, hostSel: HOST_SEL }
  );
}

async function overlayVisible(page) {
  return page.evaluate((sel) => {
    const nodes = document.querySelectorAll(sel);
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.width > 2 && r.height > 0) return true;
    }
    return false;
  }, OVERLAY);
}

async function diagHost(page) {
  return page.evaluate((hostSel) => {
    const host = document.querySelector(hostSel);
    if (!host) return { found: false };
    const tags = [];
    for (const c of host.children) tags.push(c.tagName);
    return {
      found: true,
      tag: host.tagName,
      className: host.className,
      textLen: (host.textContent || '').trim().length,
      childTags: tags
    };
  }, HOST_SEL);
}

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`
    ]
  });
  const page = await context.newPage();
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await preparePage(context, page);

  const hostInfo = await diagHost(page);
  const pt = await locateNeedle(page, NEEDLE);
  let ok = false;
  if (pt) {
    await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(700);
    ok = await overlayVisible(page);
  }

  console.log(
    JSON.stringify(
      {
        live: LIVE,
        host: hostInfo,
        point: pt,
        overlay: ok,
        pass: !!(hostInfo.found && pt && ok)
      },
      null,
      2
    )
  );

  await context.close();
  process.exit(hostInfo.found && pt && ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
