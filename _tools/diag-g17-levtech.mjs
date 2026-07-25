/**
 * G17 診断 — levtech 記事本文が光らない原因切り分け
 * 実行: node _tools/diag-g17-levtech.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-diag-g17');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';
const URL = 'https://career.levtech.jp/guide/knowhow/article/61016/';

async function prepare(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
  } catch {
    const sw = context.serviceWorkers()[0];
    if (sw) {
      await sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
      });
    }
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 30000 });
  }
  // 電球が OFF なら ON（golden と同様）
  await page.evaluate(() => {
    const img = document
      .getElementById('YomuP-popup-container')
      ?.shadowRoot?.querySelector('.lightbulb-button img');
    if (img && !img.classList.contains('active')) img.click();
  });
  await page.waitForTimeout(400);
}

const context = await chromium.launchPersistentContext(USER_DATA, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  viewport: { width: 1280, height: 900 }
});
const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 20000 }));
const page = context.pages()[0] || (await context.newPage());
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await prepare(context, page);

const diag = await page.evaluate(() => {
  document
    .querySelectorAll(
      '.articleTagWrap, .p-articleTag, .HeaderWrap, .articleHeader, [class*="floating"], [class*="FixedBan"], [class*="fixedBan"]'
    )
    .forEach((el) => {
      el.style.pointerEvents = 'none';
    });

  const allP = [...document.querySelectorAll('p.article__txt')];
  const paras = allP.filter((el) => (el.textContent || '').trim().length > 80);
  const info = {
    totalArticleTxt: allP.length,
    longParas: paras.length,
    sampleLens: paras.slice(0, 5).map((p) => (p.textContent || '').trim().length),
    mainCls: document.querySelector('.p-article__main')?.className || null
  };

  const attempts = [];
  for (const p of paras.slice(0, 8)) {
    p.scrollIntoView({ block: 'center' });
    const range = document.createRange();
    range.selectNodeContents(p);
    const rects = [...range.getClientRects()].filter((r) => r.width > 20 && r.height > 8);
    for (const r of rects.slice(0, 2)) {
      const candidates = [
        [12, 6],
        [36, 8],
        [72, 10],
        [120, 8],
        [Math.min(160, r.width / 2), r.height / 2]
      ];
      for (const [dx, dy] of candidates) {
        const x = r.left + dx;
        const y = r.top + dy;
        const hit = document.elementFromPoint(x, y);
        const stack = (document.elementsFromPoint(x, y) || []).slice(0, 8).map((el) => ({
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 50),
          pe: getComputedStyle(el).pointerEvents
        }));
        const ok = !!(hit && (hit === p || p.contains(hit)) && hit.tagName !== 'IMG');
        attempts.push({
          ok,
          x: Math.round(x),
          y: Math.round(y),
          hit: hit ? `${hit.tagName}.${String(hit.className || '').slice(0, 40)}` : null,
          inP: !!(hit && p.contains(hit)),
          pLen: (p.textContent || '').trim().length,
          stack
        });
        if (ok) {
          return { ...info, chosen: attempts[attempts.length - 1], attemptsTried: attempts.length };
        }
      }
    }
  }
  return { ...info, chosen: null, attemptsTried: attempts.length, firstFails: attempts.slice(0, 6) };
});
console.log('LOCATE', JSON.stringify(diag, null, 2));

if (!diag.chosen) {
  // 強制: 最初の長文 p の中心 + 全面 pointer-events 緩和
  const forced = await page.evaluate(() => {
    document.querySelectorAll('a, button, [class*="ban"], [class*="Ban"], [class*="float"], [class*="Fixed"], iframe').forEach((el) => {
      if (!el.closest('p.article__txt')) el.style.pointerEvents = 'none';
    });
    const p = [...document.querySelectorAll('p.article__txt')].find(
      (el) => (el.textContent || '').trim().length > 80
    );
    if (!p) return null;
    p.scrollIntoView({ block: 'center' });
    const range = document.createRange();
    range.selectNodeContents(p);
    const r = [...range.getClientRects()].find((rr) => rr.width > 20 && rr.height > 8);
    if (!r) return null;
    const x = r.left + Math.min(40, r.width / 2);
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const stack = (document.elementsFromPoint(x, y) || []).slice(0, 10).map((el) =>
      `${el.tagName}.${String(el.className || '').slice(0, 40)}`
    );
    return {
      x,
      y,
      hit: hit ? `${hit.tagName}.${String(hit.className || '').slice(0, 40)}` : null,
      inP: !!(hit && p.contains(hit)),
      stack,
      nextSib: p.nextElementSibling
        ? `${p.nextElementSibling.tagName}.${String(p.nextElementSibling.className || '').slice(0, 30)}`
        : null,
      hostTop: Math.round(p.getBoundingClientRect().top),
      sibTop: p.nextElementSibling
        ? Math.round(p.nextElementSibling.getBoundingClientRect().top)
        : null
    };
  });
  console.log('FORCED', JSON.stringify(forced, null, 2));
  if (forced) {
    await page.mouse.move(forced.x, forced.y);
    await page.evaluate(({ x, y }) => {
      const t = document.elementFromPoint(x, y);
      const i = { bubbles: true, clientX: x, clientY: y, view: window };
      document.dispatchEvent(new MouseEvent('mousemove', i));
      t?.dispatchEvent(new MouseEvent('mousemove', i));
    }, forced);
    await page.waitForTimeout(900);
    const lit = await page.evaluate((sel) => document.querySelectorAll(sel).length, OVERLAY);
    console.log('FORCED lit segs=', lit);
  }
} else {
  const traces = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[YomuP:underline]')) traces.push(t.slice(0, 500));
  });
  const pt = diag.chosen;
  const textMeta = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    const p = hit?.closest?.('p.article__txt');
    if (!p) return null;
    const t = (p.innerText || '').replace(/\s+/g, '');
    return {
      len: t.length,
      end: t.slice(-8),
      hasKuten: /[。！？．]/.test(t),
      preview: t.slice(0, 60)
    };
  }, pt);
  console.log('TEXT', JSON.stringify(textMeta, null, 2));

  await page.mouse.move(4, 4);
  await page.waitForTimeout(100);
  await page.mouse.move(pt.x, pt.y);
  await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const i = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', i));
    t?.dispatchEvent(new MouseEvent('mousemove', i));
  }, pt);
  await page.waitForTimeout(1000);
  const after = await page.evaluate(
    ({ x, y, sel }) => {
      const hit = document.elementFromPoint(x, y);
      const segs = document.querySelectorAll(sel).length;
      return {
        hit: hit ? `${hit.tagName}.${String(hit.className || '').slice(0, 40)}` : null,
        segs,
        miss: document.documentElement.dataset.yomupMiss || null
      };
    },
    { x: pt.x, y: pt.y, sel: OVERLAY }
  );
  console.log('HOVER', JSON.stringify(after, null, 2));
  console.log('TRACES', traces.slice(0, 12).join('\n---\n'));
}

await context.close();
