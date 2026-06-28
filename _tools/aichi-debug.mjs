/**
 * AI-1/AI-2 調査 — ブロック選定の DOM 確認
 * 実行: node _tools/aichi-debug.mjs
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA_DIR = path.join(__dirname, '.pw-aichi-debug');

function locateSnippet(page, hoverSnippet, nextSnippet) {
  return page.evaluate(({ hoverSnippet, nextSnippet }) => {
    const root =
      document.querySelector('#main, main, [role="main"], #contents, .inner') || document.body;
    let hoverPoint = null;
    let nextTop = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const full = node.textContent || '';
      if (node.parentElement?.closest('nav, header, footer, script, style')) continue;
      if (!hoverPoint) {
        const idx = full.indexOf(hoverSnippet);
        if (idx >= 0) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, Math.min(idx + hoverSnippet.length, full.length));
          const r = range.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            window.scrollBy(0, r.top - window.innerHeight * 0.38);
            const r2 = range.getBoundingClientRect();
            hoverPoint = { x: r2.left + 20, y: r2.top + r2.height / 2, hoverTop: r2.top };
          }
        }
      }
      const nextIdx = full.indexOf(nextSnippet);
      if (nextIdx >= 0) {
        const range = document.createRange();
        range.setStart(node, nextIdx);
        range.setEnd(node, nextIdx + 1);
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const top = r.top;
          if (nextTop == null || top < nextTop) nextTop = top;
        }
      }
    }
    if (!hoverPoint) return null;
    hoverPoint.forbidBelowY = nextTop - 6;
    const chain = [];
    let el = document.elementFromPoint(hoverPoint.x, hoverPoint.y);
    while (el && el !== document.body) {
      chain.push({
        tag: el.tagName,
        id: el.id || null,
        cls: String(el.className || '').slice(0, 40) || null,
        textLen: (el.textContent || '').trim().length
      });
      el = el.parentElement;
    }
    hoverPoint.chain = chain;

    const BR_FLOW_CONTAINER_TAGS = new Set(['DIV', 'ARTICLE', 'SECTION', 'MAIN']);
    const BR_FLOW_BOUNDARY_TAGS = new Set(['H2', 'H3']);
    let n = document.elementFromPoint(hoverPoint.x, hoverPoint.y);
    const brFlowAncestors = [];
    while (n && n !== document.body) {
      if (BR_FLOW_CONTAINER_TAGS.has(n.tagName)) {
        let hasDirectHeading = false;
        let hasDirectBody = false;
        for (let i = 0; i < n.childNodes.length; i++) {
          const child = n.childNodes[i];
          if (child.nodeType === Node.ELEMENT_NODE) {
            const tag = child.tagName;
            if (tag && BR_FLOW_BOUNDARY_TAGS.has(tag)) hasDirectHeading = true;
            if (tag === 'BR') hasDirectBody = true;
          } else if (child.nodeType === Node.TEXT_NODE && (child.textContent || '').trim()) {
            hasDirectBody = true;
          }
        }
        if (hasDirectHeading && hasDirectBody) {
          brFlowAncestors.push({ tag: n.tagName, id: n.id, textLen: (n.textContent || '').length });
        }
      }
      n = n.parentElement;
    }
    hoverPoint.brFlowAncestors = brFlowAncestors;
    return hoverPoint;
  }, { hoverSnippet, nextSnippet });
}

async function inspectOverlay(page, point) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(100);
  await page.mouse.move(point.x, point.y);
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    const eventInit = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', eventInit));
    target?.dispatchEvent(new MouseEvent('mousemove', eventInit));
  }, point);
  await page.waitForTimeout(1000);
  return page.evaluate(({ forbidBelowY, hoverTop, y }) => {
    const segs = [
      ...document.querySelectorAll(
        '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline'
      )
    ];
    const tops = segs.map((s) => s.getBoundingClientRect().top);
    const bottoms = segs.map((s) => s.getBoundingClientRect().bottom);
    const targetY = typeof hoverTop === 'number' ? hoverTop : y;
    const nearHover = tops.some((t) => Math.abs(t - targetY) < 55);
    return {
      segCount: segs.length,
      minTop: tops.length ? Math.min(...tops) : null,
      maxBottom: bottoms.length ? Math.max(...bottoms) : null,
      forbidBelowY,
      hoverTop,
      spills: bottoms.some((b) => b > forbidBelowY),
      nearHover,
      pass: nearHover && !bottoms.some((b) => b > forbidBelowY) && segs.length > 0
    };
  }, point);
}

async function main() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chromium',
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`
    ],
    viewport: { width: 1280, height: 900 }
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('highLightOnOff', 'true');
      localStorage.setItem('YomuPPopupVisible', 'true');
    } catch (_e) {
      // ignore
    }
  });
  const page = context.pages()[0] || (await context.newPage());

  const cases = [
    {
      name: 'G10-para-gap',
      url: 'https://www.pref.aichi.jp/soshiki/gorin/skillcompetition-aicheetahcup2025.html',
      hover: '決められた時間内に試走',
      next: '参加者やその御家族'
    },
    {
      name: 'G11-h5',
      url: 'https://www.pref.aichi.jp/soshiki/gorin/skillcompetition-aicheetahcup.html',
      hover: '集合型の事前講習会',
      next: '愛知県立名古屋工科高等学校'
    }
  ];

  for (const tc of cases) {
    console.log('\n===', tc.name, '===');
    await page.goto(tc.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(() => {
      localStorage.setItem('highLightOnOff', 'true');
      localStorage.setItem('YomuPPopupVisible', 'true');
      sessionStorage.setItem('pageTransition', 'true');
    });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    try {
      await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
      const bulb = page.locator('#YomuP-popup-container').locator('.lightbulb-button img');
      if (await bulb.count()) await bulb.click({ timeout: 5000 });
      await page.waitForTimeout(500);
    } catch (_e) {
      console.log('popup/bulb issue');
    }
    const point = await locateSnippet(page, tc.hover, tc.next);
    console.log('point', JSON.stringify(point, null, 2));
    if (point) {
      const ov = await inspectOverlay(page, point);
      console.log('overlay', ov);
    }
  }
  await context.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
