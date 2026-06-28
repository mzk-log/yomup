import { chromium } from 'playwright';

const ctx = await chromium.launch({ channel: 'chromium', headless: true });
const page = await ctx.newPage();
await page.goto('https://www.nikkei.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);

const r = await page.evaluate(() => {
  const card = [...document.querySelectorAll('a[class*="blockLink"]')].find(a =>
    (a.textContent || '').includes('DAZN')
  );
  const article = card?.parentElement;
  const bodyP = [...(article?.querySelectorAll('p') || [])].find(p =>
    (p.textContent || '').includes('サッカーワールド')
  );
  bodyP?.scrollIntoView({ block: 'center' });

  const tw = document.createTreeWalker(bodyP, NodeFilter.SHOW_TEXT);
  let node;
  while (tw.nextNode()) {
    if ((tw.currentNode.textContent || '').includes('サッカーワールド')) {
      node = tw.currentNode;
      break;
    }
  }
  const rg = document.createRange();
  rg.setStart(node, 0);
  rg.setEnd(node, 6);
  const rect = rg.getBoundingClientRect();
  const x = rect.left + 30;
  const y = rect.top + rect.height / 2;

  const INNER = 2;
  const MAXCH = 8;
  function getDirectTextDivChildren(el) {
    const list = [];
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i];
      if (child.tagName === 'DIV' && (child.textContent || '').trim()) list.push(child);
    }
    return list;
  }
  function hasOnlyInnerCardCellAllowedExtraDirectChildren(el) {
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i];
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (tag === 'DIV' && (child.textContent || '').trim()) continue;
      if (tag === 'A') continue;
      if (!(child.textContent || '').trim()) continue;
      return false;
    }
    return true;
  }
  function hasDirectHeadingChild(el) {
    for (let i = 0; i < el.children.length; i++) {
      const c = el.children[i];
      if (c.nodeType === 1 && /^H[1-4]$/.test(c.tagName)) return true;
    }
    return false;
  }
  function isInnerCardCellStructure(el) {
    if (!el || el.tagName !== 'DIV') return false;
    if (hasDirectHeadingChild(el)) return false;
    if (el.children.length > MAXCH) return false;
    const textDivs = getDirectTextDivChildren(el);
    if (textDivs.length !== INNER) return false;
    if (!hasOnlyInnerCardCellAllowedExtraDirectChildren(el)) return false;
    return textDivs.every(d => (d.textContent || '').trim());
  }
  function pickNearest(textDivs) {
    for (const d of textDivs) {
      const r = d.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return d;
    }
    let best = textDivs[0];
    let bestD = Infinity;
    for (const d of textDivs) {
      const r = d.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dist = (cx - x) ** 2 + (cy - y) ** 2;
      if (dist < bestD) { bestD = dist; best = d; }
    }
    return best;
  }

  const caret = document.caretRangeFromPoint(x, y);
  let cn = caret?.startContainer;
  let n = cn?.nodeType === 3 ? cn.parentElement : cn;
  const innerPath = [];
  while (n && n !== document.body) {
    if (isInnerCardCellStructure(n)) {
      const divs = getDirectTextDivChildren(n);
      const unit = pickNearest(divs);
      innerPath.push({
        cls: String(n.className).slice(0, 45),
        unitCls: String(unit.className).slice(0, 35),
        unitTop: Math.round(unit.getBoundingClientRect().top),
        unitText: (unit.textContent || '').trim().slice(0, 35)
      });
    }
    n = n.parentElement;
  }

  const stackBlocks = [];
  const BLOCK = new Set(['P', 'LI', 'DD', 'DT', 'BLOCKQUOTE', 'FIGCAPTION', 'TD', 'TH', 'PRE']);
  const HEAD = new Set(['H1', 'H2', 'H3', 'H4']);
  for (const el of document.elementsFromPoint(x, y)) {
    if (BLOCK.has(el.tagName) || HEAD.has(el.tagName)) {
      const tr = [];
      const tw2 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (tw2.nextNode()) {
        const t = tw2.currentNode.textContent || '';
        if (!t.trim()) continue;
        const r2 = document.createRange();
        r2.setStart(tw2.currentNode, 0);
        r2.setEnd(tw2.currentNode, t.length);
        for (const cr of r2.getClientRects()) {
          if (x >= cr.left && x <= cr.right && y >= cr.top && y <= cr.bottom) tr.push(cr);
        }
      }
      if (tr.length) {
        stackBlocks.push({
          tag: el.tagName,
          cls: String(el.className).slice(0, 35),
          text: (el.textContent || '').trim().slice(0, 35)
        });
      }
    }
  }

  return {
    x: Math.round(x), y: Math.round(y),
    caretText: cn?.nodeType === 3 ? (cn.textContent || '').slice(0, 35) : null,
    innerPath,
    stackBlocks
  };
});
console.log(JSON.stringify(r, null, 2));
await ctx.close();
