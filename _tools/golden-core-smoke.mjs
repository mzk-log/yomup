/**
 * §7.0 コア G01〜G12 — 拡張ロード済みハイライト・スモーク
 * 実行: npm run golden:core
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA_DIR = path.join(__dirname, '.pw-user-data');
const HOVER_SETTLE_MS = 900;
const NAV_TIMEOUT_MS = 60000;

/** @type {Array<{id:string,url:string,probes:Array<{name:string,locate:()=>{x:number,y:number}|null}>}>} */
const CASES = [
  {
    id: 'G01',
    url: 'https://www.aozora.gr.jp/cards/000148/files/752_14964.html',
    probes: [{ name: 'main_text', locate: locateAozoraMainText }]
  },
  {
    id: 'G02',
    url: 'https://crowdworks.jp/public/jobs/12302510',
    probes: [
      { name: 'h1', locate: locateCrowdWorksJobH1 },
      { name: 'dt', locate: locateCrowdWorksJobDt }
    ]
  },
  {
    id: 'G03',
    url: 'https://ko-fi.com/pricing',
    probes: [{ name: 'feature-h3', locate: locateKofiFeatureCard }]
  },
  {
    id: 'G04',
    url: 'https://zenn.dev/layerx/articles/6f510abfc3fa72',
    probes: [
      { name: 'article-p', locate: locateZennArticleParagraph },
      { name: 'h2', locate: locateZennArticleHeading }
    ]
  },
  {
    id: 'G05',
    url: 'https://www.nishikawa1566.com/column/sleep/20260612104828/',
    probes: [{ name: 'body-paragraph', locate: (p) => locateLongTextIn(p, 'main, article, .rt_cf_n_body, body') }]
  },
  {
    id: 'G06',
    url: 'https://www.nishikawa1566.com/categories/',
    probes: [{ name: 'composite-a', locate: locateNishikawaCompositeAnchor }]
  },
  {
    id: 'G07',
    url: 'https://hidamarikokoro.jp/hajimete/',
    probes: [{ name: 'p', locate: (p) => locateLongTextIn(p, 'main, article, body') }]
  },
  {
    id: 'G08',
    url: 'https://developer.chrome.com/docs/webstore/program-policies/policies',
    probes: [{ name: 'policy-text', locate: locateChromePolicyText }]
  },
  {
    id: 'G09',
    url: 'https://www.nikkei.com/',
    probes: [
      { name: 'body-text', locate: locateNikkeiTopCardBody, assertOverlayNearHover: true },
      { name: 'top-card-title', locate: locateNikkeiTopCard }
    ],
    requireProbe: 'body-text'
  },
  {
    id: 'G10',
    url: 'https://www.pref.aichi.jp/soshiki/gorin/skillcompetition-aicheetahcup2025.html',
    probes: [
      {
        name: 'para-before-gap',
        locate: (p) => locateAichiPair(p, '決められた時間内に試走', '参加者やその御家族'),
        assertOverlayNotBelow: true
      },
      {
        name: 'across-image',
        locate: (p) => locateAichiPair(p, '見学者からは歓声', 'また、会場となっている'),
        assertOverlayNotBelow: true
      }
    ],
    requireProbe: 'para-before-gap'
  },
  {
    id: 'G11',
    url: 'https://www.pref.aichi.jp/soshiki/gorin/skillcompetition-aicheetahcup.html',
    probes: [
      {
        name: 'h5-heading-only',
        locate: (p) => locateAichiH5Pair(p, '集合型の事前講習会', '愛知県立名古屋工科高等学校'),
        assertOverlayNotBelow: true
      }
    ],
    requireProbe: 'h5-heading-only'
  },
  {
    id: 'G12',
    url: 'https://www.pref.aichi.jp/press-release/aichitahai2026.html',
    probes: [
      {
        name: 'long-sentence-quote',
        locate: (p) =>
          locateAichiPair(p, 'モノづくりとデジタル技術', 'この度、本大会'),
        assertOverlayNotBelow: true
      }
    ],
    requireProbe: 'long-sentence-quote'
  }
];

async function isBulbActiveInShadow(page) {
  return page.evaluate(() => {
    const shadow = document.getElementById('YomuP-popup-container')?.shadowRoot;
    return !!shadow?.querySelector('.lightbulb-button img.active');
  });
}

async function parkPopupOutOfWay(page) {
  await page.evaluate(() => {
    const container = document.getElementById('YomuP-popup-container');
    const popup = container?.shadowRoot?.querySelector('.YomuP-popup');
    if (!popup) return;
    popup.style.setProperty('--YomuP-popup-top', '12px', 'important');
    popup.style.setProperty('--YomuP-popup-left', `${Math.max(0, window.innerWidth - 220)}px`, 'important');
  });
  await page.waitForTimeout(120);
}

async function ensureHighlightEnabled(page) {
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 12000 });
  } catch (_e) {
    return;
  }
  for (let i = 0; i < 8; i++) {
    if (await isBulbActiveInShadow(page)) return;
    const stored = await page.evaluate(
      () => localStorage.getItem('highLightOnOff') === 'true'
    );
    if (stored) {
      await page.waitForTimeout(400);
      continue;
    }
    break;
  }
  if (await isBulbActiveInShadow(page)) return;
  const bulb = page.locator('#YomuP-popup-container').locator('.lightbulb-button img');
  if (await bulb.count()) {
    await bulb.click({ timeout: 5000 });
    await page.waitForTimeout(400);
  }
}

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(1500);
  let popupReady = false;
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
    popupReady = true;
  } catch (_e) {
    // 青空など getCharCountInfo が遅いページ向け
  }
  if (!popupReady) {
    const sw = context.serviceWorkers()[0];
    if (sw) {
      await sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) {
          await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
        }
      });
      await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 30000 });
    }
  }
  await ensureHighlightEnabled(page);
  await parkPopupOutOfWay(page);
}

async function clearHighlight(page) {
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: 4,
      clientY: 4,
      view: window
    }));
  });
  await page.waitForTimeout(120);
}

async function hoverProbe(page, point) {
  await page.mouse.move(point.x, point.y);
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    const eventInit = {
      bubbles: true,
      clientX: x,
      clientY: y,
      view: window
    };
    document.dispatchEvent(new MouseEvent('mousemove', eventInit));
    target?.dispatchEvent(new MouseEvent('mousemove', eventInit));
  }, point);
  await page.waitForTimeout(HOVER_SETTLE_MS);
}

async function main() {
  if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
    console.error('manifest.json not found:', EXTENSION_PATH);
    process.exit(2);
  }

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

  let sw = context.serviceWorkers()[0];
  if (!sw) {
    try {
      sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
    } catch (_e) {
      console.error('ERROR: extension service worker not detected. Run: npm run golden:install');
      await context.close();
      process.exit(2);
    }
  }
  console.log('Extension loaded:', sw.url().split('/')[2]);

  await context.addInitScript(() => {
    try {
      localStorage.setItem('highLightOnOff', 'true');
      localStorage.setItem('YomuPPopupVisible', 'true');
      sessionStorage.setItem('pageTransition', 'true');
    } catch (_e) {
      // ignore
    }
  });

  const page = context.pages()[0] || (await context.newPage());
  const rows = [];

  const only = process.argv[2];
  const caseList = only ? CASES.filter((c) => c.id === only) : CASES;
  if (only && caseList.length === 0) {
    console.error('Unknown case:', only);
    process.exit(2);
  }

  try {
    for (const tc of caseList) {
      const caseResult = { id: tc.id, url: tc.url, probes: [], ok: false };
      try {
        await page.goto(tc.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await preparePage(context, page);

        let anyPass = false;
        for (const probe of tc.probes) {
          const point = await probe.locate(page);
          if (!point) {
            caseResult.probes.push({ name: probe.name, status: 'SKIP', reason: 'probe-not-found' });
            continue;
          }
          await clearHighlight(page);
          await hoverProbe(page, point);
          let lit = await hasHighlightOverlay(page);
          if (lit && probe.assertOverlayNearHover) {
            lit = await overlayNearHoverPoint(page, point);
          }
          if (lit && probe.assertOverlayNotBelow) {
            lit = await overlayNotBelowY(page, point);
          }
          const debugOverlay = probe.assertOverlayNotBelow
            ? await describeOverlayProbe(page, point)
            : undefined;
          caseResult.probes.push({
            name: probe.name,
            status: lit ? 'PASS' : 'FAIL',
            x: Math.round(point.x),
            y: Math.round(point.y),
            hoverTop: point.hoverTop != null ? Math.round(point.hoverTop) : undefined,
            forbidBelowY: point.forbidBelowY != null ? Math.round(point.forbidBelowY) : undefined,
            debugOverlay
          });
          if (lit) anyPass = true;
        }
        if (tc.requireProbe) {
          const required = caseResult.probes.find((p) => p.name === tc.requireProbe);
          caseResult.ok = required?.status === 'PASS';
        } else {
          caseResult.ok = anyPass;
        }
      } catch (err) {
        caseResult.error = String(err.message || err);
      }
      rows.push(caseResult);
      printCase(caseResult);
    }
  } finally {
    await context.close();
  }

  const failed = rows.filter((r) => !r.ok);
  console.log('\n=== §7.0 CORE SUMMARY ===');
  console.log(`PASS: ${rows.length - failed.length} / ${rows.length}`);
  for (const r of rows) {
    const mark = r.ok ? 'OK' : 'NG';
    const detail = r.probes.map((p) => `${p.name}:${p.status}`).join(', ');
    console.log(`${r.id} ${mark}  ${detail}${r.error ? `  (${r.error})` : ''}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

function printCase(r) {
  console.log(`\n[${r.id}] ${r.ok ? 'OK' : 'NG'} ${r.url}`);
  for (const p of r.probes) {
    console.log(`  - ${p.name}: ${p.status}${p.reason ? ` (${p.reason})` : ''}`);
    if (p.debugOverlay) console.log(`    debug: ${JSON.stringify(p.debugOverlay)}`);
  }
  if (r.error) console.log(`  ! ${r.error}`);
}

async function hasHighlightOverlay(page) {
  return page.evaluate(() => {
    const root = document.getElementById('yomup-highlight-overlay-root');
    if (!root) return false;
    return !!(
      root.querySelector('.yomup-highlight-underline-segment') ||
      root.querySelector('.yomup-highlight-underline') ||
      root.querySelector('.yomup-highlight-outline')
    );
  });
}

async function describeOverlayProbe(page, point) {
  return page.evaluate(({ forbidBelowY, y, hoverTop }) => {
    const targetY = typeof hoverTop === 'number' ? hoverTop : y;
    const segs = [
      ...document.querySelectorAll(
        '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline'
      )
    ];
    const tops = segs.map((s) => Math.round(s.getBoundingClientRect().top));
    const bottoms = segs.map((s) => Math.round(s.getBoundingClientRect().bottom));
    const nearHover = tops.some((t) => Math.abs(t - targetY) < 55);
    const spills = typeof forbidBelowY === 'number' && bottoms.some((b) => b > forbidBelowY);
    return { segCount: segs.length, tops, bottoms, nearHover, spills, forbidBelowY, hoverTop: targetY };
  }, point);
}

/** AI-1/AI-2: 下線が次ブロック境界をまたがないこと */
async function overlayNotBelowY(page, point) {
  return page.evaluate(({ forbidBelowY, y, hoverTop }) => {
    if (typeof forbidBelowY !== 'number') return false;
    const targetY = typeof hoverTop === 'number' ? hoverTop : y;
    const segs = [
      ...document.querySelectorAll(
        '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline'
      )
    ];
    if (segs.length === 0) return false;
    const nearHover = segs.some((s) => Math.abs(s.getBoundingClientRect().top - targetY) < 55);
    const spills = segs.some((s) => s.getBoundingClientRect().bottom > forbidBelowY);
    return nearHover && !spills;
  }, point);
}

/** NK-1R: オーバーレイがホバー行付近にあること（タイトル誤光り検出） */
async function overlayNearHoverPoint(page, point) {
  return page.evaluate(({ hoverTop, y }) => {
    const targetY = typeof hoverTop === 'number' ? hoverTop : y;
    const segs = [
      ...document.querySelectorAll(
        '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline'
      )
    ];
    if (segs.length === 0) return false;
    const tops = segs.map((s) => s.getBoundingClientRect().top);
    const nearHover = tops.some((t) => Math.abs(t - targetY) < 40);
    const h2 = document.querySelector('h2[class*="title"]');
    const h2Top = h2 ? h2.getBoundingClientRect().top : null;
    const wronglyOnTitle = h2Top != null &&
      Math.abs(targetY - h2Top) > 80 &&
      tops.some((t) => Math.abs(t - h2Top) < 35);
    return nearHover && !wronglyOnTitle;
  }, { hoverTop: point.hoverTop, y: point.y });
}

async function locateBestHeading(page, tag) {
  return page.evaluate((t) => {
    let best = null;
    let bestLen = 0;
    for (const el of document.querySelectorAll(t)) {
      const text = (el.textContent || '').trim();
      if (text.length < 8) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 8) continue;
      if (text.length > bestLen) {
        bestLen = text.length;
        best = el;
      }
    }
    if (!best) return null;
    best.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = best.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, tag);
}

async function locateElementCenter(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
}

async function locateLongTextIn(page, rootSelector) {
  return page.evaluate((rootSel) => {
    const root = document.querySelector(rootSel) || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = (node.textContent || '').trim();
      if (text.length < 25) continue;
      const parent = node.parentElement;
      if (parent && parent.closest('script, style, noscript, nav, header, footer')) continue;
      const range = document.createRange();
      try {
        range.setStart(node, 0);
        range.setEnd(node, Math.min(3, text.length));
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          window.scrollBy(0, r.top - window.innerHeight * 0.4);
          const r2 = range.getBoundingClientRect();
          return { x: r2.left + 12, y: r2.top + r2.height / 2 };
        }
      } catch (_e) {
        // ignore
      }
    }
    return null;
  }, rootSelector);
}

async function locateAozoraMainText(page) {
  return page.evaluate(() => {
    const main = document.querySelector('div.main_text');
    if (!main) return null;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement && node.parentElement.closest('rt, rp')) continue;
      const text = (node.textContent || '').trim();
      if (text.length < 20) continue;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 1);
      const r = range.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        window.scrollBy(0, r.top - window.innerHeight * 0.35);
        const r2 = range.getBoundingClientRect();
        return { x: r2.left + 16, y: r2.top + r2.height / 2 };
      }
    }
    return null;
  });
}

async function locateCrowdWorksJobH1(page) {
  return page.evaluate(() => {
    for (const h1 of document.querySelectorAll('h1')) {
      if (h1.closest('header, nav, footer')) continue;
      const text = (h1.textContent || '').trim();
      if (text.length < 12) continue;
      if (text.includes('クラウドソーシング') && text.includes('日本最大級')) continue;
      h1.scrollIntoView({ block: 'center', inline: 'nearest' });
      const walker = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const t = (node.textContent || '').trim();
        if (t.length < 8) continue;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, Math.min(4, t.length));
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
    }
    return null;
  });
}

async function locateCrowdWorksJobDt(page) {
  return page.evaluate(() => {
    for (const dt of document.querySelectorAll('dl dt, dt')) {
      if (dt.closest('header, nav, footer')) continue;
      const text = (dt.textContent || '').trim();
      if (text.length < 4) continue;
      dt.scrollIntoView({ block: 'center', inline: 'nearest' });
      const walker = document.createTreeWalker(dt, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const t = (node.textContent || '').trim();
        if (!t) continue;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, Math.min(3, t.length));
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
    }
    return null;
  });
}

async function locateKofiFeatureCard(page) {
  return page.evaluate(() => {
    for (const h3 of document.querySelectorAll('h3')) {
      const title = (h3.textContent || '').trim();
      if (title.length < 6) continue;
      const root = h3.closest('div, section, article') || h3.parentElement;
      const body = root?.querySelector('p');
      const target = body || h3;
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const t = (node.textContent || '').trim();
        if (t.length < 12) continue;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, Math.min(6, t.length));
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.left + 12, y: r.top + r.height / 2 };
        }
      }
    }
    return null;
  });
}

async function locateZennArticleParagraph(page) {
  return page.evaluate(() => {
    const roots = document.querySelectorAll('article, [class*="Markdown"], main');
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = (node.textContent || '').trim();
        if (text.length < 40) continue;
        if (node.parentElement?.closest('h1, h2, h3, nav, header, footer, pre, code')) continue;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, Math.min(8, text.length));
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          window.scrollBy(0, r.top - window.innerHeight * 0.4);
          const r2 = range.getBoundingClientRect();
          return { x: r2.left + 14, y: r2.top + r2.height / 2 };
        }
      }
    }
    return null;
  });
}

async function locateZennArticleHeading(page) {
  return page.evaluate(() => {
    const article = document.querySelector('article') || document.querySelector('main');
    if (!article) return null;
    for (const tag of ['h2', 'h3', 'h1']) {
      for (const el of article.querySelectorAll(tag)) {
        const text = (el.textContent || '').trim();
        if (text.length < 6) continue;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const t = (node.textContent || '').trim();
          if (!t) continue;
          const range = document.createRange();
          range.setStart(node, 0);
          range.setEnd(node, Math.min(4, t.length));
          const r = range.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
      }
    }
    return null;
  });
}

async function locateChromePolicyText(page) {
  return page.evaluate(() => {
    const root =
      document.querySelector('.devsite-article-body') ||
      document.querySelector('article') ||
      document.querySelector('[role="main"]') ||
      document.querySelector('main');
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = (node.textContent || '').trim();
      if (text.length < 30) continue;
      if (node.parentElement?.closest('nav, header, footer, script, style')) continue;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(10, text.length));
      const r = range.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        window.scrollBy(0, r.top - window.innerHeight * 0.35);
        const r2 = range.getBoundingClientRect();
        return { x: r2.left + 16, y: r2.top + r2.height / 2 };
      }
    }
    return null;
  });
}

async function locateNishikawaCompositeAnchor(page) {
  return page.evaluate(() => {
    for (const a of document.querySelectorAll('a')) {
      const spans = [...a.children].filter((c) => c.tagName === 'SPAN');
      if (spans.length < 2) continue;
      const text = (a.textContent || '').trim();
      if (text.length < 10) continue;
      const r = a.getBoundingClientRect();
      if (r.width < 40 || r.height < 10) continue;
      a.scrollIntoView({ block: 'center', inline: 'nearest' });
      const titleSpan = spans.find((s) => (s.textContent || '').trim().length >= 6) || spans[spans.length - 1];
      const walker = document.createTreeWalker(titleSpan, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const t = (node.textContent || '').trim();
        if (t.length < 4) continue;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, Math.min(4, t.length));
        const r2 = range.getBoundingClientRect();
        if (r2.width > 0 && r2.height > 0) {
          return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 };
        }
      }
    }
    return null;
  });
}

async function locateNikkeiTopCard(page) {
  for (let i = 0; i < 40; i++) {
    const point = await page.evaluate(() => {
      const title = document.querySelector('a[class*="titleText"]');
      if (!title) return null;
      title.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = title.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: r.left + r.width * 0.35, y: r.top + r.height * 0.45 };
    });
    if (point) return point;
    await page.waitForTimeout(500);
  }
  return null;
}

async function aichiSnippetInViewport(page, snippet) {
  return page.evaluate((hoverSnippet) => {
    const root =
      document.querySelector('#main, main, [role="main"], #contents, .inner') || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const full = node.textContent || '';
      if (node.parentElement?.closest('nav, header, footer, script, style, noscript')) continue;
      if (!full.includes(hoverSnippet)) continue;
      const host =
        node.parentElement?.closest('h1,h2,h3,h4,h5,h6,p,li,td,dd,dt') ||
        node.parentElement;
      if (!host) return false;
      const rect = host.getBoundingClientRect();
      return rect.top >= 24 && rect.bottom <= window.innerHeight - 24;
    }
    return false;
  }, snippet);
}

/** 愛知県 — 県 CMS は window.scroll が効かないことがあるため wheel で補正 */
async function scrollAichiSnippetIntoView(page, snippet) {
  const hoverLoc = page.getByText(snippet, { exact: false }).first();
  try {
    await hoverLoc.scrollIntoViewIfNeeded({ timeout: 12000 });
    if (await aichiSnippetInViewport(page, snippet)) {
      return true;
    }
  } catch (_e) {
    // Playwright では非表示扱いでも DOM 上にある → wheel 補正へ
  }

  await page.locator('body').click({ position: { x: 40, y: 40 }, timeout: 5000 }).catch(() => {});
  const targetScroll = await page.evaluate((hoverSnippet) => {
    const root =
      document.querySelector('#main, main, [role="main"], #contents, .inner') || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const full = node.textContent || '';
      if (node.parentElement?.closest('nav, header, footer, script, style, noscript')) continue;
      if (!full.includes(hoverSnippet)) continue;
      const host =
        node.parentElement?.closest('h1,h2,h3,h4,h5,h6,p,li,td,dd,dt') ||
        node.parentElement;
      if (!host) return null;
      return Math.max(0, host.getBoundingClientRect().top + window.scrollY - 180);
    }
    return null;
  }, snippet);
  if (targetScroll == null) {
    return false;
  }
  await page.mouse.move(640, 450);
  let scrolled = 0;
  while (scrolled + 80 < targetScroll) {
    const step = Math.min(500, targetScroll - scrolled);
    await page.mouse.wheel(0, step);
    scrolled += step;
    await page.waitForTimeout(80);
  }
  return aichiSnippetInViewport(page, snippet);
}

/** G11 — h5 は Playwright 上「表示」でもビューポート外のことがある */
async function locateAichiH5Pair(page, hoverSnippet, nextSnippet) {
  const h5 = page.locator('h5').filter({ hasText: hoverSnippet }).first();
  if ((await h5.count()) === 0) {
    return null;
  }
  await page.locator('body').click({ position: { x: 40, y: 40 }, timeout: 5000 }).catch(() => {});
  for (let i = 0; i < 14; i++) {
    const box = await h5.boundingBox();
    if (box && box.y >= 24 && box.y + box.height <= 860) {
      break;
    }
    await page.mouse.move(640, 450);
    await page.mouse.wheel(0, 450);
    await page.waitForTimeout(120);
  }
  const hBox = await h5.boundingBox();
  if (!hBox) {
    return null;
  }
  await page.waitForTimeout(200);
  return page.evaluate(({ hoverSnippet, nextSnippet, hBox }) => {
    const root =
      document.querySelector('#main, main, [role="main"], #contents, .inner') || document.body;

    function pointForSnippet(snippet) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const full = node.textContent || '';
        if (node.parentElement?.closest('nav, header, footer, script, style, noscript')) continue;
        const idx = full.indexOf(snippet);
        if (idx < 0) continue;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, Math.min(idx + snippet.length, full.length));
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { range, rect: r };
        }
      }
      return null;
    }

    const next = pointForSnippet(nextSnippet);
    if (!next) return null;
    const nRect = next.rect;
    return {
      x: hBox.x + Math.min(24, hBox.width * 0.3),
      y: hBox.y + hBox.height / 2,
      hoverTop: hBox.y,
      forbidBelowY: nRect.top - 6
    };
  }, { hoverSnippet, nextSnippet, hBox });
}

/** 愛知県 — hover 対象テキストと、下線が届いてはいけない次ブロック先頭 */
async function locateAichiPair(page, hoverSnippet, nextSnippet) {
  if (!(await scrollAichiSnippetIntoView(page, hoverSnippet))) {
    return null;
  }
  await page.waitForTimeout(250);
  return page.evaluate(({ hoverSnippet, nextSnippet }) => {
    const root =
      document.querySelector('#main, main, [role="main"], #contents, .inner') || document.body;

    function pointForSnippet(snippet) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const full = node.textContent || '';
        if (node.parentElement?.closest('nav, header, footer, script, style, noscript')) continue;
        const idx = full.indexOf(snippet);
        if (idx < 0) continue;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, Math.min(idx + snippet.length, full.length));
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { node, range };
        }
      }
      return null;
    }

    const hover = pointForSnippet(hoverSnippet);
    const next = pointForSnippet(nextSnippet);
    if (!hover || !next) return null;

    const hRect = hover.range.getBoundingClientRect();
    const nRect = next.range.getBoundingClientRect();
    if (hRect.width <= 0 || hRect.height <= 0) return null;

    return {
      x: hRect.left + Math.min(24, hRect.width * 0.3),
      y: hRect.top + hRect.height / 2,
      hoverTop: hRect.top,
      forbidBelowY: nRect.top - 6
    };
  }, { hoverSnippet, nextSnippet });
}

async function locateNikkeiTopCardBody(page) {
  for (let i = 0; i < 40; i++) {
    const point = await page.evaluate(() => {
      const card = [...document.querySelectorAll('a[class*="blockLink"]')].find((a) =>
        (a.textContent || '').includes('DAZN') || (a.textContent || '').includes('サッカーワールド')
      );
      if (!card) return null;
      const bodyP = [...(card.parentElement?.querySelectorAll('p') || [])].find((p) =>
        (p.textContent || '').trim().length >= 20
      );
      if (!bodyP) return null;
      bodyP.scrollIntoView({ block: 'center', inline: 'nearest' });
      const walker = document.createTreeWalker(bodyP, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = (node.textContent || '').trim();
        if (text.length < 8) continue;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, Math.min(6, text.length));
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return {
            x: r.left + Math.min(30, r.width * 0.4),
            y: r.top + r.height / 2,
            hoverTop: r.top
          };
        }
      }
      return null;
    });
    if (point) return point;
    await page.waitForTimeout(500);
  }
  return null;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
