/**
 * Yahoo — <p> 内 \n\n でリンク行・■見出し行が単独点灯
 * 実行: node _tools/probe-yahoo-blank-lines.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-yahoo-blank');
const URL =
  'https://news.yahoo.co.jp/articles/4eff4e1720d876618ec6d9574098bb2ebc485b14';

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
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.evaluate(() => {
  localStorage.setItem('highLightOnOff', 'true');
  localStorage.setItem('YomuPPopupVisible', 'true');
  sessionStorage.setItem('pageTransition', 'true');
  localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(3000);
try {
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
} catch (_e) {
  const sw = ctx.serviceWorkers()[0];
  if (sw) {
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
    });
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 45000 });
  }
}
await page.evaluate(() => {
  const img = document
    .getElementById('YomuP-popup-container')
    ?.shadowRoot?.querySelector('.lightbulb-button img');
  if (img && !img.classList.contains('active')) img.click();
});
await page.waitForTimeout(600);

const sw = ctx.serviceWorkers()[0];
const result = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      function pointOn(needle) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const t = walker.currentNode.textContent || '';
          const i = t.indexOf(needle);
          if (i < 0) continue;
          const n = walker.currentNode;
          n.parentElement?.scrollIntoView({ block: 'center' });
          const range = document.createRange();
          range.setStart(n, i);
          range.setEnd(n, Math.min(t.length, i + Math.min(8, needle.length)));
          const rect = range.getBoundingClientRect();
          return { x: rect.left + 8, y: rect.top + rect.height / 2 };
        }
        return null;
      }
      function probe(needle, opts) {
        const pt = pointOn(needle);
        if (!pt) return { ok: false, reason: 'missing:' + needle };
        if (typeof setHighlightModeEnabled === 'function') {
          setHighlightModeEnabled(true, { skipPersist: true });
        }
        clearCurrentHighlight();
        const lit = tryHighlightLogicalBlockAtPoint(pt.x, pt.y);
        const block = findHighlightBlockFromPoint(pt.x, pt.y);
        const ctx = resolveHighlightTextContext(block, 'ja', pt.x, pt.y);
        const text = (ctx.blockText || '').replace(/\s+/g, ' ').trim();
        const forbid = opts.forbid || [];
        const require = opts.require || [];
        const hasForbid = forbid.some((f) => text.includes(f));
        const hasRequire = require.every((f) => text.includes(f));
        return {
          ok: !!(lit && hasRequire && !hasForbid),
          lit,
          textHead: text.slice(0, 60),
          textLen: text.length,
          hasForbid,
          hasRequire
        };
      }
      const p =
        [...document.querySelectorAll('p')].find((el) =>
          (el.textContent || '').includes('【写真で見る】')
        ) || null;
      const link = probe('【写真で見る】', {
        require: ['写真で見る'],
        forbid: ['政府・日銀']
      });
      const heading = probe('■アメリカの思惑', {
        require: ['アメリカの思惑'],
        forbid: ['自国通貨安']
      });
      return {
        ok: link.ok && heading.ok,
        link,
        heading,
        blankLines: p && typeof paragraphHasSourceBlankLineSplits === 'function'
          ? paragraphHasSourceBlankLineSplits(p)
          : null,
        lineCount: p && typeof collectBlockTextSegmentLines === 'function'
          ? collectBlockTextSegmentLines(p).filter((l) => (l.blockText || '').trim()).length
          : null
      };
    }
  });
  return r.result;
});

console.log(JSON.stringify(result, null, 2));
await ctx.close();
if (!result?.ok) {
  console.log('RESULT FAIL');
  process.exit(1);
}
console.log('RESULT PASS');
process.exit(0);
