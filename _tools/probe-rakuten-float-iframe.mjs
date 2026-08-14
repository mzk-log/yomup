/**
 * RK-2 — 楽天商品ページ footer iframe 内 .float（返品・交換等）が光る
 * 実行: node _tools/probe-rakuten-float-iframe.mjs
 * 任意: node _tools/probe-rakuten-float-iframe.mjs --live
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-rakuten-float-probe');
const LIVE = process.argv.includes('--live');
const LIVE_URL = 'https://item.rakuten.co.jp/elecom/4549550281768/';
const NEEDLE = '初期不良・返品・交換をご希望の場合';
const H2_NEEDLE = '返品・交換について';

fs.rmSync(USER_DATA, { recursive: true, force: true });

const FIXTURE_FOOTER = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>footer</title>
<style>
body { font-family: "Yu Gothic", sans-serif; font-size: 14px; margin: 16px; }
.float h2 { font-size: 18px; margin: 16px 0 8px; }
.float p { line-height: 1.6; margin: 0 0 8px; }
</style></head><body>
<div class="float">
<h2>${H2_NEEDLE}</h2>
<p>
初期不良・返品・交換をご希望の場合は、ご遠慮なくお問い合わせくださいませ。<br>
<span>※ご不明な点はお問い合わせください。メールでのご質問へは翌営業日を目処にお返事をさせていただく様に務めております。</span>
</p>
<a class="link" href="javascript:void(0)">詳しくはこちら</a>
<h2>チャットについて</h2>
<p>[受注受付] 月～金曜日の 9:00～17:00<br>
<span>※チャットからのご注文は受付しておりません。</span></p>
</div>
</body></html>`;

const footerPath = path.join(os.tmpdir(), 'yomup-rakuten-float-footer.html');
fs.writeFileSync(footerPath, FIXTURE_FOOTER, 'utf8');
const footerUrl = 'file:///' + footerPath.replace(/\\/g, '/');

const FIXTURE_PARENT = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>RK-2 parent</title>
<style>iframe { width: 900px; height: 520px; border: 1px solid #ccc; }</style>
</head><body>
<p>parent shell</p>
<iframe id="shop-footer" src="${footerUrl}"></iframe>
</body></html>`;
const parentPath = path.join(os.tmpdir(), 'yomup-rakuten-float-parent.html');
fs.writeFileSync(parentPath, FIXTURE_PARENT, 'utf8');

async function prepareTop(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
    localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
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
    const img = document
      .getElementById('YomuP-popup-container')
      ?.shadowRoot?.querySelector('.lightbulb-button img');
    if (img && !img.classList.contains('active')) img.click();
  });
  await page.waitForFunction(() => {
    const img = document
      .getElementById('YomuP-popup-container')
      ?.shadowRoot?.querySelector('.lightbulb-button img');
    return !!(img && img.classList.contains('active'));
  }, { timeout: 10000 });
  // chrome.storage 同期待ち
  await page.waitForTimeout(500);
}

async function findFooterFrame(page) {
  if (LIVE) {
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(350);
      const hit = page.frames().find((f) => (f.url() || '').includes('footer.html'));
      if (hit) return hit;
    }
    return page.frames().find((f) => (f.url() || '').includes('footer.html')) || null;
  }
  await page.waitForSelector('#shop-footer');
  const frame = page.frame({ url: /yomup-rakuten-float-footer\.html/ });
  if (frame) return frame;
  return page.frames().find((f) => (f.url() || '').includes('yomup-rakuten-float-footer')) || null;
}

async function measureInFrame(page, frame) {
  const pre = await frame.evaluate((needle) => {
    const p = [...document.querySelectorAll('p')].find((el) =>
      (el.textContent || '').includes(needle)
    );
    if (!p) return { ok: false, reason: 'p-missing' };
    p.scrollIntoView({ block: 'center' });
    return {
      ok: true,
      hasFind: typeof findHighlightBlockFromPoint === 'function',
      // page world では常に false/null（isolated）。参考値のみ
      highLightOnOff:
        typeof highLightOnOff !== 'undefined' ? !!highLightOnOff : null
    };
  }, NEEDLE);
  if (!pre.ok) return pre;

  await page.waitForTimeout(400);

  // OOPIF でも届く Playwright frame locator hover
  const pLoc = frame.locator('p', { hasText: NEEDLE }).first();
  await pLoc.scrollIntoViewIfNeeded();
  await pLoc.hover({ force: true, timeout: 10000 });
  await page.waitForTimeout(900);

  const result = await frame.evaluate((needle) => {
    const p = [...document.querySelectorAll('p')].find((el) =>
      (el.textContent || '').includes(needle)
    );
    const h2 = [...document.querySelectorAll('h2')].find((el) =>
      (el.textContent || '').includes('返品・交換について')
    );
    const root = document.getElementById('yomup-highlight-overlay-root');
    const segs = root
      ? [...root.querySelectorAll(
          '.yomup-highlight-underline-segment, .yomup-highlight-underline'
        )]
      : [];
    const popupInFrame = !!document.getElementById('YomuP-popup-container');
    if (segs.length === 0) {
      return {
        ok: false,
        reason: 'no-overlay',
        popupInFrame,
        segCount: 0
      };
    }
    const pBox = p.getBoundingClientRect();
    const hitsP = segs.some((s) => {
      const b = s.getBoundingClientRect();
      return (
        b.left < pBox.right &&
        b.right > pBox.left &&
        Math.abs((b.top + b.bottom) / 2 - (pBox.top + pBox.bottom) / 2) < 40
      );
    });
    return {
      ok: hitsP && !popupInFrame,
      hitsP,
      popupInFrame,
      segCount: segs.length,
      h2Present: !!h2
    };
  }, NEEDLE);

  // hover が OOPIF で届かない場合のフォールバック（製品経路は scripting で確認）
  if (!result.ok && result.reason === 'no-overlay') {
    const sw = page.context().serviceWorkers()[0];
    if (sw) {
      const forced = await sw.evaluate(async (needleText) => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (!tabId) return null;
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (needle) => {
            if (!location.href.includes('footer.html') && !location.href.includes('yomup-rakuten-float-footer')) {
              return null;
            }
            if (typeof setHighlightModeEnabled === 'function') {
              setHighlightModeEnabled(true, { skipPersist: true });
            }
            const p = [...document.querySelectorAll('p')].find((el) =>
              (el.textContent || '').includes(needle)
            );
            if (!p || typeof tryHighlightLogicalBlockAtPoint !== 'function') return { lit: false };
            p.scrollIntoView({ block: 'center' });
            const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
            let tn = null;
            while (walker.nextNode()) {
              if ((walker.currentNode.textContent || '').includes('初期不良')) {
                tn = walker.currentNode;
                break;
              }
            }
            if (!tn) return { lit: false };
            const r = document.createRange();
            const t = tn.textContent || '';
            const i = t.indexOf('初期不良');
            r.setStart(tn, Math.max(0, i));
            r.setEnd(tn, Math.min(t.length, i + 4));
            const rect = r.getBoundingClientRect();
            const lit = tryHighlightLogicalBlockAtPoint(
              rect.left + 12,
              rect.top + rect.height / 2
            );
            const root = document.getElementById('yomup-highlight-overlay-root');
            const segs = root
              ? root.querySelectorAll(
                  '.yomup-highlight-underline-segment, .yomup-highlight-underline'
                ).length
              : 0;
            const popupInFrame = !!document.getElementById('YomuP-popup-container');
            return { lit, segs, popupInFrame };
          },
          args: [needleText]
        });
        return results.map((r) => r.result).find((r) => r);
      }, NEEDLE);
      if (forced && forced.lit && forced.segs > 0 && !forced.popupInFrame) {
        return {
          ok: true,
          hitsP: true,
          popupInFrame: false,
          segCount: forced.segs,
          via: 'scripting-fallback',
          hoverFailed: true
        };
      }
      return { ...result, forced };
    }
  }

  return { ...result, frameFn: pre.hasFind, frameHL: pre.highLightOnOff };
}

const context = await chromium.launchPersistentContext(USER_DATA, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`
  ],
  viewport: { width: 1100, height: 1000 }
});
if (!context.serviceWorkers()[0]) {
  await context.waitForEvent('serviceworker', { timeout: 20000 });
}
const page = context.pages()[0] || (await context.newPage());
const targetUrl = LIVE ? LIVE_URL : 'file:///' + parentPath.replace(/\\/g, '/');
await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
await prepareTop(context, page);
console.log('url:', targetUrl, LIVE ? '(live)' : '(fixture)');

const frame = await findFooterFrame(page);
if (!frame) {
  console.log(JSON.stringify({ ok: false, reason: 'footer-frame-missing' }, null, 2));
  await context.close();
  process.exit(1);
}

const result = await measureInFrame(page, frame);
console.log(JSON.stringify(result, null, 2));
await context.close();

if (!result.ok) {
  console.log('RESULT FAIL');
  process.exit(1);
}
console.log('RESULT PASS');
process.exit(0);
