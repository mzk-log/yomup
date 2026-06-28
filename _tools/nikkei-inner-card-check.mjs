import { chromium } from 'playwright';

const ctx = await chromium.launch({ channel: 'chromium', headless: true });
const page = await ctx.newPage();
await page.goto('https://www.nikkei.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);

const r = await page.evaluate(() => {
  const card = [...document.querySelectorAll('a[class*="blockLink"]')].find(a =>
    (a.textContent || '').includes('DAZN')
  );
  const bodyP = [...(card?.parentElement?.querySelectorAll('p') || [])].find(p =>
    (p.textContent || '').includes('サッカーワールド')
  );
  const tw = document.createTreeWalker(bodyP, NodeFilter.SHOW_TEXT);
  let node;
  while (tw.nextNode()) {
    if ((tw.currentNode.textContent || '').includes('サッカーワールド')) {
      node = tw.currentNode;
      break;
    }
  }
  bodyP.scrollIntoView({ block: 'center' });
  const rg = document.createRange();
  rg.setStart(node, 0);
  rg.setEnd(node, 6);
  const rect = rg.getBoundingClientRect();
  const x = rect.left + 30;
  const y = rect.top + rect.height / 2;

  const INNER = 2;
  const MAXCH = 8;
  function getDirectTextDivChildren(el) {
    return [...el.children].filter(c => c.tagName === 'DIV' && (c.textContent || '').trim());
  }
  function isInnerCardCellStructure(el) {
    if (!el || el.tagName !== 'DIV') return false;
    if (el.children.length > MAXCH) return false;
    const textDivs = getDirectTextDivChildren(el);
    if (textDivs.length !== INNER) return false;
    return textDivs.every(d => (d.textContent || '').trim());
  }

  const caret = document.caretRangeFromPoint(x, y);
  let n = caret?.startContainer?.nodeType === 3
    ? caret.startContainer.parentElement
    : caret?.startContainer;
  const innerCardHits = [];
  while (n && n !== document.body) {
    if (isInnerCardCellStructure(n)) {
      const divs = getDirectTextDivChildren(n);
      innerCardHits.push({
        cls: String(n.className).slice(0, 50),
        divs: divs.map(d => ({
          cls: String(d.className).slice(0, 30),
          top: Math.round(d.getBoundingClientRect().top),
          text: (d.textContent || '').trim().slice(0, 30)
        }))
      });
    }
    n = n.parentElement;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    caretParent: caret?.startContainer?.parentElement?.tagName + '.' +
      String(caret?.startContainer?.parentElement?.className || '').slice(0, 25),
    innerCardHits,
    stack: document.elementsFromPoint(x, y).slice(0, 6).map(e =>
      `${e.tagName}.${String(e.className || '').slice(0, 25)}`
    )
  };
});
console.log(JSON.stringify(r, null, 2));
await ctx.close();
