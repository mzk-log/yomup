/**
 * Gemini G-1 再発切り分け: li>p>b + 本文 の行分割／P全文経路
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-gemini-b-label');
fs.rmSync(UD, { recursive: true, force: true });

const FIXTURE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>G-1b</title>
<style>
body { font-family: "Yu Gothic", sans-serif; font-size: 16px; line-height: 1.7; max-width: 720px; margin: 40px; }
b { display: inline; }
</style></head><body>
<ul>
<li><p data-path-to-node="19,1,0"><b data-path-to-node="19,1,0" data-index-in-node="0">「たった一人」に深く刺されば成功</b>
同じようにChrome拡張機能を作ろうとして「ルビの描画崩れ」や「Yahooの特殊構造」に絶望している開発者が日本に数人は必ずいます。その人たちから「救われました！」とブックマーク（ストック）されるだけで、一次情報としての価値は証明されます。</p></li>
</ul>
</body></html>`;

const htmlPath = path.join(os.tmpdir(), 'yomup-gemini-b-label.html');
fs.writeFileSync(htmlPath, FIXTURE, 'utf8');

const ctx = await chromium.launchPersistentContext(UD, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1000, height: 800 }
});
if (!ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const page = ctx.pages()[0] || (await ctx.newPage());
const client = await ctx.newCDPSession(page);
await client.send('Runtime.enable');
const worlds = new Map();
client.on('Runtime.executionContextCreated', (ev) => worlds.set(ev.context.id, ev.context));

await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
  sessionStorage.setItem('pageTransition', 'true');
  localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
try {
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 });
} catch (_e) {
  const sw = ctx.serviceWorkers()[0];
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

const pts = await page.evaluate(() => {
  const b = document.querySelector('b');
  const p = document.querySelector('p');
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
  const br = document.createRange();
  br.selectNodeContents(b.firstChild);
  const bRect = br.getBoundingClientRect();
  const bodyRange = document.createRange();
  const i = bodyNode.textContent.indexOf('同じように');
  bodyRange.setStart(bodyNode, i);
  bodyRange.setEnd(bodyNode, i + 4);
  const bodyRect = bodyRange.getBoundingClientRect();
  return {
    label: { x: bRect.left + bRect.width / 2, y: bRect.top + bRect.height / 2 },
    body: { x: bodyRect.left + 20, y: bodyRect.top + bodyRect.height / 2 }
  };
});

async function evalIn(ctxId, expression) {
  return client.send('Runtime.evaluate', { expression, contextId: ctxId, returnByValue: true });
}

let yomupCtx = null;
for (const c of [...worlds.values()].sort((a, b) => b.id - a.id)) {
  if (!(c.name && String(c.name).includes('読むプ'))) continue;
  try {
    const probe = await evalIn(c.id, 'typeof findHighlightBlockFromPoint');
    if (probe.result?.value === 'function') {
      yomupCtx = c.id;
      break;
    }
  } catch (_e) {}
}

async function inspect(pt, name) {
  const r = await evalIn(
    yomupCtx,
    `(() => {
      const x = ${pt.x}, y = ${pt.y};
      const block = findHighlightBlockFromPoint(x, y);
      const el = block && block.element;
      const lines = el ? collectBlockTextSegmentLines(el).map(l => (l.blockText||'').trim().slice(0,50)) : [];
      const ctx = block ? resolveHighlightTextContext(block, 'ja', x, y) : null;
      return {
        name: ${JSON.stringify(name)},
        mode: block && block.mode,
        tag: el && el.tagName,
        richLi: el && el.tagName==='LI' && isRichMultiUnitListItem(el),
        lines,
        ctxLen: ctx ? (ctx.blockText||'').length : 0,
        ctxHead: ctx ? (ctx.blockText||'').trim().slice(0,80) : null
      };
    })()`
  );
  console.log(JSON.stringify(r.result?.value, null, 2));
}

await inspect(pts.label, 'label');
await inspect(pts.body, 'body');

await page.mouse.move(pts.body.x, pts.body.y);
await page.evaluate(({ x, y }) => {
  const t = document.elementFromPoint(x, y);
  const init = { bubbles: true, clientX: x, clientY: y, view: window };
  document.dispatchEvent(new MouseEvent('mousemove', init));
  t?.dispatchEvent(new MouseEvent('mousemove', init));
}, pts.body);
await page.waitForTimeout(800);
const lit = await page.evaluate(() => {
  const root = document.getElementById('yomup-highlight-overlay-root');
  const segs = root
    ? [...root.querySelectorAll('.yomup-highlight-underline-segment, .yomup-highlight-underline')]
    : [];
  const b = document.querySelector('b');
  const bBox = b.getBoundingClientRect();
  const segInfo = segs.map((s) => {
    const r = s.getBoundingClientRect();
    const yMid = (r.top + r.bottom) / 2;
    const sameLine = yMid >= bBox.top - 2 && yMid <= bBox.bottom + 4;
    const overlapsB =
      sameLine && r.left < bBox.right - 1 && r.right > bBox.left + 1;
    return {
      top: Math.round(r.top),
      left: Math.round(r.left),
      right: Math.round(r.right),
      sameLine,
      overlapsB
    };
  });
  return {
    segCount: segs.length,
    bBox: {
      top: Math.round(bBox.top),
      left: Math.round(bBox.left),
      right: Math.round(bBox.right)
    },
    segInfo,
    anyOverlapB: segInfo.some((s) => s.overlapsB)
  };
});
console.log('hover-body', JSON.stringify(lit, null, 2));

await ctx.close();
