/**
 * 楽天 — .float / 返品テキストの所在確認
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const UD = path.join(__dirname, '.pw-rakuten-float-find');
const URL = 'https://item.rakuten.co.jp/elecom/4549550281768/';

fs.rmSync(UD, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(UD, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1100, height: 1200 }
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(5000);

// スクロールで遅延コンテンツを起こす
for (let i = 0; i < 8; i++) {
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(600);
}

const info = await page.evaluate(() => {
  const needles = ['返品・交換について', '初期不良', 'チャットについて', 'ラッピングについて'];
  const hits = [];
  for (const n of needles) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let found = null;
    while (walker.nextNode()) {
      if ((walker.currentNode.textContent || '').includes(n)) {
        found = walker.currentNode;
        break;
      }
    }
    if (!found) {
      hits.push({ needle: n, found: false });
      continue;
    }
    const el = found.parentElement;
    const float = el?.closest?.('.float');
    const rect = found.parentElement?.getBoundingClientRect?.();
    hits.push({
      needle: n,
      found: true,
      parentTag: el?.tagName,
      parentCls: String(el?.className || '').slice(0, 40),
      float: !!float,
      inIframe: false,
      display: el ? getComputedStyle(el).display : null,
      visibility: el ? getComputedStyle(el).visibility : null,
      rect: rect
        ? { w: rect.width, h: rect.height, top: rect.top, left: rect.left }
        : null,
      anc: (() => {
        const a = [];
        let n2 = el;
        for (let i = 0; i < 10 && n2; i++) {
          a.push(n2.tagName + (n2.className ? '.' + String(n2.className).slice(0, 30) : ''));
          n2 = n2.parentElement;
        }
        return a;
      })()
    });
  }

  const floats = [...document.querySelectorAll('.float')].slice(0, 5).map((f) => ({
    text: (f.textContent || '').trim().slice(0, 80),
    len: (f.textContent || '').trim().length,
    childTags: [...f.children].map((c) => c.tagName).slice(0, 12)
  }));

  const iframes = [...document.querySelectorAll('iframe')].map((f) => ({
    src: (f.src || '').slice(0, 120),
    id: f.id,
    name: f.name,
    w: f.offsetWidth,
    h: f.offsetHeight
  }));

  return { hits, floats, iframeCount: iframes.length, iframes: iframes.slice(0, 15) };
});
console.log(JSON.stringify(info, null, 2));

// iframe 内も探す
for (const frame of page.frames()) {
  if (frame === page.mainFrame()) continue;
  try {
    const fr = await frame.evaluate(() => {
      const t = document.body ? document.body.innerText || '' : '';
      return {
        url: location.href.slice(0, 100),
        hasReturn: t.includes('返品・交換'),
        hasFloat: !!document.querySelector('.float'),
        sample: t.includes('返品') ? t.slice(t.indexOf('返品') - 20, t.indexOf('返品') + 80) : null
      };
    });
    if (fr.hasReturn || fr.hasFloat) console.log('frame-hit', JSON.stringify(fr, null, 2));
  } catch (_e) {}
}

await ctx.close();
