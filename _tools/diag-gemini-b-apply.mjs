/**
 * Gemini G-1b — tryHighlight 後の apply rect と chunkRects を比較
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-gemini-b-apply');
fs.rmSync(UD, { recursive: true, force: true });

const FIXTURE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>apply</title>
<style>
body { font-family: "Yu Gothic", sans-serif; font-size: 16px; line-height: 1.7; max-width: 720px; margin: 40px; }
</style></head><body>
<ul>
<li><p><b>「たった一人」に深く刺されば成功</b>
同じようにChrome拡張機能を作ろうとして「ルビの描画崩れ」や「Yahooの特殊構造」に絶望している開発者が日本に数人は必ずいます。その人たちから「救われました！」とブックマーク（ストック）されるだけで、一次情報としての価値は証明されます。</p></li>
</ul>
</body></html>`;
fs.writeFileSync(path.join(os.tmpdir(), 'yomup-gemini-b-apply.html'), FIXTURE, 'utf8');

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

const htmlPath = path.join(os.tmpdir(), 'yomup-gemini-b-apply.html');
await page.goto('file:///' + htmlPath.replace(/\\/g, '/'));
await page.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
  sessionStorage.setItem('pageTransition', 'true');
  localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
});
await page.reload();
await page.waitForTimeout(1500);
await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 45000 });
await page.evaluate(() => {
  const host = document.getElementById('YomuP-popup-container');
  const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
  if (img && !img.classList.contains('active')) img.click();
});

const pt = await page.evaluate(() => {
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
  const i = bodyNode.textContent.indexOf('同じように');
  const r = document.createRange();
  r.setStart(bodyNode, i);
  r.setEnd(bodyNode, i + 4);
  const rect = r.getBoundingClientRect();
  return { x: rect.left + 10, y: rect.top + rect.height / 2 };
});

let yomupCtx = null;
for (const c of [...worlds.values()].sort((a, b) => b.id - a.id)) {
  if (!(c.name && String(c.name).includes('読むプ'))) continue;
  try {
    const probe = await client.send('Runtime.evaluate', {
      expression: 'typeof tryHighlightLogicalBlockAtPoint',
      contextId: c.id,
      returnByValue: true
    });
    if (probe.result?.value === 'function') {
      yomupCtx = c.id;
      break;
    }
  } catch (_e) {}
}

const result = await client.send('Runtime.evaluate', {
  contextId: yomupCtx,
  returnByValue: true,
  expression: `(() => {
    const x = ${pt.x}, y = ${pt.y};
    const ok = tryHighlightLogicalBlockAtPoint(x, y);
    const root = document.getElementById('yomup-highlight-overlay-root');
    const segs = root
      ? [...root.querySelectorAll('.yomup-highlight-underline-segment, .yomup-highlight-underline')]
      : [];
    const b = document.querySelector('b');
    const bBox = b.getBoundingClientRect();
    return {
      ok,
      currentRects: (currentHighlightRects || []).map(r => ({
        top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.left + r.width), w: Math.round(r.width)
      })),
      segs: segs.map(s => {
        const r = s.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
      }),
      bBox: { left: Math.round(bBox.left), right: Math.round(bBox.right), top: Math.round(bBox.top) }
    };
  })()`
});
console.log(JSON.stringify(result.result?.value, null, 2));
await ctx.close();
