/**
 * 楽天 footer iframe 内のハイライト切り分け
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-rakuten-float-iframe');
const URL = 'https://item.rakuten.co.jp/elecom/4549550281768/';
const NEEDLE = '初期不良・返品・交換をご希望の場合';

fs.rmSync(UD, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(UD, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1100, height: 1200 }
});
if (!ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
  sessionStorage.setItem('pageTransition', 'true');
  localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(3500);
try {
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
} catch (_e) {
  const sw = ctx.serviceWorkers()[0];
  if (sw) {
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
    });
  }
}
await page.evaluate(() => {
  const img = document
    .getElementById('YomuP-popup-container')
    ?.shadowRoot?.querySelector('.lightbulb-button img');
  if (img && !img.classList.contains('active')) img.click();
});
await page.waitForTimeout(800);

// footer iframe までスクロール
for (let i = 0; i < 10; i++) {
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(400);
}

const frame = page.frames().find((f) => (f.url() || '').includes('footer.html'));
if (!frame) {
  console.log('no footer frame', page.frames().map((f) => f.url()));
  await ctx.close();
  process.exit(2);
}

const frameInfo = await frame.evaluate((needle) => {
  const hasYomup = !!document.getElementById('YomuP-popup-container');
  const hasOverlay = !!document.getElementById('yomup-highlight-overlay-root');
  const scripts = [...document.scripts].map((s) => s.src).filter(Boolean).slice(0, 5);
  const p = [...document.querySelectorAll('p')].find((el) =>
    (el.textContent || '').includes(needle)
  );
  const h2 = [...document.querySelectorAll('h2')].find((el) =>
    (el.textContent || '').includes('返品・交換について')
  );
  let pt = null;
  if (p) {
    p.scrollIntoView({ block: 'center' });
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let tn = null;
    while (walker.nextNode()) {
      if ((walker.currentNode.textContent || '').includes('初期不良')) {
        tn = walker.currentNode;
        break;
      }
    }
    if (tn) {
      const r = document.createRange();
      const t = tn.textContent || '';
      const i = t.indexOf('初期不良');
      r.setStart(tn, Math.max(0, i));
      r.setEnd(tn, Math.min(t.length, i + 4));
      const rect = r.getBoundingClientRect();
      pt = {
        x: rect.left + 12,
        y: rect.top + rect.height / 2,
        pLen: (p.textContent || '').trim().length,
        float: !!p.closest('.float')
      };
    }
  }
  return {
    url: location.href,
    hasYomup,
    hasOverlay,
    highLightLS: localStorage.getItem('highLightOnOff'),
    pFound: !!p,
    h2Found: !!h2,
    h2Text: h2 ? (h2.textContent || '').trim() : null,
    pt,
    bodyTextLen: (document.body?.innerText || '').length
  };
}, NEEDLE);
console.log('frameInfo', JSON.stringify(frameInfo, null, 2));

// CDP: iframe の execution context を探す
const client = await ctx.newCDPSession(page);
await client.send('Runtime.enable');
await client.send('Page.enable');
const worlds = [];
client.on('Runtime.executionContextCreated', (ev) => {
  worlds.push(ev.context);
});
// 既存コンテキスト取得
const { contexts } = await client.send('Runtime.evaluate', {
  expression: '1',
  returnByValue: true
}).then(() => ({ contexts: [] })).catch(() => ({ contexts: [] }));

// 再ナビでイベントを拾い直すより、frame 内 evaluate で関数有無を見る
const fnProbe = await frame.evaluate(() => ({
  findHighlightBlockFromPoint: typeof findHighlightBlockFromPoint,
  tryHighlight: typeof tryHighlightLogicalBlockAtPoint,
  handleMouseMove: typeof handleMouseMove,
  highLightOnOffGlobal: typeof highLightOnOff !== 'undefined' ? String(highLightOnOff) : 'undef'
}));
console.log('fnProbe', fnProbe);

// 親ページの content script 有無
const parentProbe = await page.evaluate(() => ({
  find: typeof findHighlightBlockFromPoint,
  yomup: !!document.getElementById('YomuP-popup-container'),
  highLightLS: localStorage.getItem('highLightOnOff')
}));
console.log('parentProbe', parentProbe);

if (frameInfo.pt && fnProbe.tryHighlight === 'function') {
  const lit = await frame.evaluate(({ x, y }) => {
    const block = findHighlightBlockFromPoint(x, y);
    const el = block && block.element;
    const litOk = tryHighlightLogicalBlockAtPoint(x, y);
    const root = document.getElementById('yomup-highlight-overlay-root');
    const segs = root
      ? root.querySelectorAll('.yomup-highlight-underline-segment, .yomup-highlight-underline')
          .length
      : 0;
    return {
      mode: block && block.mode,
      tag: el && el.tagName,
      cls: el ? String(el.className || '').slice(0, 50) : null,
      len: el ? (el.textContent || '').trim().length : null,
      text: el ? (el.textContent || '').trim().slice(0, 50) : null,
      lit: litOk,
      segs
    };
  }, frameInfo.pt);
  console.log('lit', JSON.stringify(lit, null, 2));
} else if (frameInfo.pt) {
  // content script が iframe に無い場合: 親から elementFromPoint は iframe を返すだけ
  const parentHit = await page.evaluate(() => {
    // iframe element を見つけてその位置でヒット確認
    const iframes = [...document.querySelectorAll('iframe')];
    const footer = iframes.find((f) => (f.src || '').includes('footer.html'));
    if (!footer) return { footer: false };
    const br = footer.getBoundingClientRect();
    return {
      footer: true,
      iframeBox: { top: br.top, left: br.left, w: br.width, h: br.height },
      // iframe 内座標は親では取れない
      note: 'content script likely missing in iframe'
    };
  });
  console.log('parentHit', parentHit);
}

await ctx.close();
