/**
 * G-1b — Gemini li>p>b ラベル＋本文: 本文 hover でラベルが同時点灯しないこと
 * 実行: node _tools/probe-gemini-block-label-body.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-gemini-block-label-body');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';

const FIXTURE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>G-1b</title>
<style>
body { font-family: "Yu Gothic", sans-serif; font-size: 16px; line-height: 1.7; max-width: 720px; margin: 40px; }
</style></head><body>
<ul>
<li><p data-path-to-node="19,1,0"><b data-path-to-node="19,1,0" data-index-in-node="0">「たった一人」に深く刺されば成功</b>
同じようにChrome拡張機能を作ろうとして「ルビの描画崩れ」や「Yahooの特殊構造」に絶望している開発者が日本に数人は必ずいます。その人たちから「救われました！」とブックマーク（ストック）されるだけで、一次情報としての価値は証明されます。</p></li>
</ul>
</body></html>`;

const htmlPath = path.join(os.tmpdir(), 'yomup-gemini-block-label-body.html');
fs.writeFileSync(htmlPath, FIXTURE, 'utf8');

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
    localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
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
      await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 30000 });
    }
  }
  await page.evaluate(() => {
    const host = document.getElementById('YomuP-popup-container');
    const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
    if (img && !img.classList.contains('active')) img.click();
  });
  await page.waitForTimeout(400);
}

async function hoverAndMeasure(page) {
  return page.evaluate(async () => {
    const p = document.querySelector('p');
    const b = p.querySelector('b');
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let bodyNode = null;
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (b.contains(n)) continue;
      if ((n.textContent || '').includes('同じように')) {
        bodyNode = n;
        break;
      }
    }
    if (!bodyNode) return { ok: false, reason: 'body-node-missing' };

    const i = bodyNode.textContent.indexOf('同じように');
    const bodyRange = document.createRange();
    bodyRange.setStart(bodyNode, i);
    bodyRange.setEnd(bodyNode, i + 4);
    const bodyRect = bodyRange.getBoundingClientRect();
    const x = bodyRect.left + 12;
    const y = bodyRect.top + bodyRect.height / 2;

    const bBox = b.getBoundingClientRect();
    document.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y, view: window })
    );
    const target = document.elementFromPoint(x, y);
    target?.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y, view: window })
    );
    await new Promise((r) => setTimeout(r, 700));

    const root = document.getElementById('yomup-highlight-overlay-root');
    const segs = root
      ? [...root.querySelectorAll(
          '.yomup-highlight-underline-segment, .yomup-highlight-underline'
        )]
      : [];
    if (segs.length === 0) return { ok: false, reason: 'no-overlay', x, y };

    const overlapsB = segs.some((s) => {
      const r = s.getBoundingClientRect();
      const yMid = (r.top + r.bottom) / 2;
      const sameLine = yMid >= bBox.top - 2 && yMid <= bBox.bottom + 4;
      return sameLine && r.left < bBox.right - 1 && r.right > bBox.left + 1;
    });

    const litBody = segs.some((s) => {
      const r = s.getBoundingClientRect();
      return (
        x >= r.left - 2 &&
        x <= r.right + 2 &&
        Math.abs((r.top + r.bottom) / 2 - y) < 30
      );
    });

    return {
      ok: litBody && !overlapsB,
      litBody,
      overlapsB,
      segCount: segs.length,
      x: Math.round(x),
      y: Math.round(y),
      bBox: {
        left: Math.round(bBox.left),
        right: Math.round(bBox.right),
        top: Math.round(bBox.top)
      },
      segs: segs.map((s) => {
        const r = s.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          left: Math.round(r.left),
          right: Math.round(r.right)
        };
      })
    };
  });
}

const context = await chromium.launchPersistentContext(USER_DATA, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`
  ],
  viewport: { width: 1000, height: 800 }
});
if (!context.serviceWorkers()[0]) {
  await context.waitForEvent('serviceworker', { timeout: 20000 });
}
const page = context.pages()[0] || (await context.newPage());
await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), {
  waitUntil: 'domcontentloaded',
  timeout: 60000
});
await preparePage(context, page);

const result = await hoverAndMeasure(page);
console.log(JSON.stringify(result, null, 2));
await context.close();

if (!result.ok) {
  console.log('RESULT FAIL');
  process.exit(1);
}
console.log('RESULT PASS');
process.exit(0);
