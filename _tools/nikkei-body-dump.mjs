import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.pw-user-data'), {
  channel: 'chromium', headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1280, height: 900 }
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://www.nikkei.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);

const info = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('a[class*="blockLink"]')].filter(a =>
    (a.textContent || '').includes('DAZN')
  );
  const card = cards.find(a => {
    const p = a.parentElement?.querySelector('p') || a.querySelector('p');
    return p && (p.textContent || '').includes('サッカーワールド');
  }) || cards[0];
  if (!card) return { error: 'card not found', blockLinks: document.querySelectorAll('a[class*="blockLink"]').length };

  const bodyP = [...card.parentElement?.querySelectorAll('p') || card.querySelectorAll('p')].find(p =>
    (p.textContent || '').includes('サッカーワールド')
  );
  if (!bodyP) return { error: 'body p not found', cardCls: String(card.className).slice(0, 80) };

  bodyP.scrollIntoView({ block: 'center' });
  const walker = document.createTreeWalker(bodyP, NodeFilter.SHOW_TEXT);
  let targetNode = null;
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent || '';
    if (t.includes('サッカーワールド')) {
      targetNode = walker.currentNode;
      break;
    }
  }
  if (!targetNode) return { error: 'text node not found' };

  const range = document.createRange();
  range.setStart(targetNode, 0);
  range.setEnd(targetNode, 6);
  const r = range.getBoundingClientRect();
  const x = r.left + 30;
  const y = r.top + r.height / 2;

  const stack = document.elementsFromPoint(x, y).slice(0, 20).map(el => ({
    tag: el.tagName,
    cls: String(el.className || '').slice(0, 60),
    ghost: (() => {
      if (el.tagName !== 'A') return false;
      let hasDirectText = false, hasDirectElement = false;
      for (const c of el.childNodes) {
        if (c.nodeType === 3 && (c.textContent || '').trim()) hasDirectText = true;
        else if (c.nodeType === 1) hasDirectElement = true;
      }
      return hasDirectText && !hasDirectElement;
    })()
  }));

  const headings = [...(card.parentElement || card).querySelectorAll('h2, a[class*="titleText"]')].map(el => {
    const lr = el.getBoundingClientRect();
    const tr = el.tagName === 'A' ? lr : null;
    return {
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 50),
      top: Math.round(lr.top),
      h: Math.round(lr.height),
      text: (el.textContent || '').trim().slice(0, 40)
    };
  });

  const caret = document.caretRangeFromPoint(x, y);
  const caretNode = caret?.startContainer;
  const caretParent = caretNode?.nodeType === 3 ? caretNode.parentElement : caretNode;
  const caretText = caretNode?.nodeType === 3 ? (caretNode.textContent || '').slice(0, 40) : null;

  const collectTextRects = (el) => {
    const rects = [];
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (tw.nextNode()) {
      const n = tw.currentNode;
      const t = n.textContent || '';
      if (!t.trim()) continue;
      const rg = document.createRange();
      rg.setStart(n, 0);
      rg.setEnd(n, t.length);
      for (const cr of rg.getClientRects()) {
        if (cr.width > 0 && cr.height > 0) rects.push(cr);
      }
    }
    return rects;
  };
  const containingAt = (el) => collectTextRects(el).filter(cr =>
    x >= cr.left && x <= cr.right && y >= cr.top && y <= cr.bottom
  ).length;

  const pContaining = containingAt(bodyP);
  const h2 = headings.find(h => h.tag === 'H2');
  const h2El = card.parentElement?.querySelector('h2');
  const h2Containing = h2El ? containingAt(h2El) : 0;
  const ghostContaining = containingAt(card);

  const pFirstChunk = (bodyP.textContent || '').trim().slice(0, 50);
  const ghostFirstChunk = (card.textContent || '').trim().slice(0, 50);

  return {
    x: Math.round(x), y: Math.round(y),
    bodyRect: { top: Math.round(r.top), left: Math.round(r.left) },
    caret: {
      tag: caretParent?.tagName,
      cls: String(caretParent?.className || '').slice(0, 60),
      text: caretText,
      inGhost: card.contains(caretParent),
      inBodyP: bodyP.contains(caretParent)
    },
    containingRects: { p: pContaining, h2: h2Containing, ghost: ghostContaining },
    firstChunks: { p: pFirstChunk, ghost: ghostFirstChunk },
    cardTag: card.tagName,
    cardCls: String(card.className).slice(0, 80),
    parentCls: String(card.parentElement?.className || '').slice(0, 80),
    parentChildren: [...(card.parentElement?.children || [])].map(c => `${c.tagName}.${String(c.className||'').slice(0,25)}`),
    headings,
    stack
  };
});
console.log(JSON.stringify(info, null, 2));
await ctx.close();
