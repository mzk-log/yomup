/**
 * ベースライン / 再検証 — デモ strong・Yahoo \n\n・Portescap 単独 \n
 * 実行: node _tools/diag-p-strong-yahoo-blank.mjs
 *       node _tools/diag-p-strong-yahoo-blank.mjs --after  (ラベル用)
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-p-strong-yahoo');
const DEMO = 'https://mzk-log.github.io/yomup/yomup-demo.html';
const YAHOO =
  'https://news.yahoo.co.jp/articles/4eff4e1720d876618ec6d9574098bb2ebc485b14';
const PORTESCAP =
  'https://www.portescap.com/ja-JP/%E3%83%AA%E3%82%BD%E3%83%BC%E3%82%B9/%E5%B0%8F%E5%9E%8B%E3%83%A2%E3%83%BC%E3%82%BF%E4%BB%95%E6%A7%98%E3%82%92%E3%83%80%E3%82%A6%E3%83%B3%E3%83%AD%E3%83%BC%E3%83%89-/%E3%83%9B%E3%83%AF%E3%82%A4%E3%83%88%E3%83%9A%E3%83%BC%E3%83%91%E3%83%BC/%E3%82%B9%E3%83%86%E3%83%83%E3%83%94%E3%83%B3%E3%82%B0%E3%83%A2-%E3%82%BF%E7%94%A8%E3%81%AE%E3%83%90%E3%82%A4%E3%83%9D-%E3%83%A9%E3%83%89-%E3%83%A9%E3%82%A4%E3%83%96%E3%81%A8%E3%83%A6%E3%83%8B%E3%83%9D-%E3%83%A9%E3%83%89%E3%83%A9%E3%82%A4%E3%83%96%E3%81%AE%E9%81%95%E3%81%84';

fs.rmSync(UD, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(UD, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1200, height: 900 }
});
if (!ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const page = ctx.pages()[0] || (await ctx.newPage());
const client = await ctx.newCDPSession(page);
await client.send('Runtime.enable');
const worlds = new Map();
client.on('Runtime.executionContextCreated', (ev) => worlds.set(ev.context.id, ev.context));

async function prepare() {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
    localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(2500);
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
    const img = document
      .getElementById('YomuP-popup-container')
      ?.shadowRoot?.querySelector('.lightbulb-button img');
    if (img && !img.classList.contains('active')) img.click();
  });
  await page.waitForTimeout(600);
}

async function yomupCtxId() {
  for (const c of [...worlds.values()].sort((a, b) => b.id - a.id)) {
    if (!(c.name && String(c.name).includes('読むプ'))) continue;
    try {
      const probe = await client.send('Runtime.evaluate', {
        expression: 'typeof tryHighlightLogicalBlockAtPoint',
        contextId: c.id,
        returnByValue: true
      });
      if (probe.result?.value === 'function') return c.id;
    } catch (_e) {}
  }
  return null;
}

async function highlightAt(ctxId, x, y) {
  const r = await client.send('Runtime.evaluate', {
    contextId: ctxId,
    returnByValue: true,
    expression: `(() => {
      const x = ${x}, y = ${y};
      clearCurrentHighlight && clearCurrentHighlight();
      const block = findHighlightBlockFromPoint(x, y);
      const el = block && block.element;
      const ctx = resolveHighlightTextContext(block, 'ja', x, y);
      const chunks = buildLogicalChunks(ctx.blockText, 'ja');
      const offset = getCaretOffsetInBlock(block, ctx.segments, x, y);
      const chunk = findChunkAtOffset(chunks, offset);
      const lit = tryHighlightLogicalBlockAtPoint(x, y);
      const root = document.getElementById('yomup-highlight-overlay-root');
      const segs = root
        ? [...root.querySelectorAll('.yomup-highlight-underline-segment, .yomup-highlight-underline')]
        : [];
      return {
        mode: block && block.mode,
        tag: el && el.tagName,
        cls: el ? String(el.className || '').slice(0, 40) : null,
        text: el ? (el.textContent || '').trim().slice(0, 40) : null,
        ctxHead: (ctx.blockText || '').trim().slice(0, 50),
        ctxLen: (ctx.blockText || '').trim().length,
        chunkHead: chunk ? chunk.text.trim().slice(0, 50) : null,
        chunkLen: chunk ? chunk.text.trim().length : null,
        lit,
        segCount: segs.length
      };
    })()`
  });
  return r.result?.value;
}

async function pointOnText(pageOrFrame, needle, pick = 'first') {
  return pageOrFrame.evaluate(
    ({ needle, pick }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const hits = [];
      while (walker.nextNode()) {
        const t = walker.currentNode.textContent || '';
        if (t.includes(needle)) hits.push(walker.currentNode);
      }
      const n = pick === 'last' ? hits[hits.length - 1] : hits[0];
      if (!n) return { found: false };
      n.parentElement?.scrollIntoView({ block: 'center' });
      const t = n.textContent || '';
      const i = t.indexOf(needle);
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, Math.min(t.length, i + Math.min(needle.length, 8)));
      const rect = r.getBoundingClientRect();
      return { found: true, x: rect.left + 8, y: rect.top + rect.height / 2 };
    },
    { needle, pick }
  );
}

const out = {};

await page.goto(DEMO, { waitUntil: 'domcontentloaded', timeout: 60000 });
await prepare();
let ctxId = await yomupCtxId();
let pt = await pointOnText(page, '読むプ');
out.demo_yomup = { pt, hl: pt.found ? await highlightAt(ctxId, pt.x, pt.y) : null };
pt = await pointOnText(page, 'は、Webページでの読書');
out.demo_body = { pt, hl: pt.found ? await highlightAt(ctxId, pt.x, pt.y) : null };

await page.goto(YAHOO, { waitUntil: 'domcontentloaded', timeout: 120000 });
await prepare();
ctxId = await yomupCtxId();
pt = await pointOnText(page, '【写真で見る】');
out.yahoo_link = { pt, hl: pt.found ? await highlightAt(ctxId, pt.x, pt.y) : null };
pt = await pointOnText(page, '政府・日銀は金融政策');
out.yahoo_after_link = { pt, hl: pt.found ? await highlightAt(ctxId, pt.x, pt.y) : null };
pt = await pointOnText(page, '■アメリカの思惑');
out.yahoo_heading = { pt, hl: pt.found ? await highlightAt(ctxId, pt.x, pt.y) : null };
pt = await pointOnText(page, '自国通貨安につながる介入');
out.yahoo_after_heading = { pt, hl: pt.found ? await highlightAt(ctxId, pt.x, pt.y) : null };

await page.goto(PORTESCAP, { waitUntil: 'domcontentloaded', timeout: 120000 });
await prepare();
ctxId = await yomupCtxId();
pt = await pointOnText(page, '着目してい');
out.portescap = { pt, hl: pt.found ? await highlightAt(ctxId, pt.x, pt.y) : null };

console.log(JSON.stringify(out, null, 2));
await ctx.close();
