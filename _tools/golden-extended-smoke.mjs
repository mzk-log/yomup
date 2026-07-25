/**
 * §7.0 拡張 G15〜G26 — リリース前ハイライト・スモーク
 * 実行: npm run golden:extended
 * 単独: node _tools/golden-extended-smoke.mjs G15
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA_DIR = path.join(__dirname, '.pw-user-data-extended');
const HOVER_SETTLE_MS = 900;
const NAV_TIMEOUT_MS = 60000;
const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

const CASES = [
  {
    id: 'G15',
    url: 'https://www.musashinodenpa.com/arduino/ref/',
    probes: [
      { name: 'toc-link-setup', locate: (p) => locateTextIn(p, 'setup()', 'a, td') },
      { name: 'toc-prose', locate: (p) => locateTextIn(p, 'Arduino言語はC/C++', 'td') }
    ],
    requireProbes: ['toc-link-setup', 'toc-prose']
  },
  {
    id: 'G16',
    url: 'https://cursor.com/ja/docs/models-and-pricing',
    probes: [{ name: 'docs-body', locate: (p) => locateLongTextIn(p, 'main, article, body') }]
  },
  {
    id: 'G17',
    url: 'https://career.levtech.jp/guide/knowhow/article/61016/',
    probes: [
      {
        name: 'article-p',
        locate: async (page) => {
          // 上部バナー/画像の被りを避け、本文 p 内で elementFromPoint が通る座標を探す
          return page.evaluate(() => {
            document
              .querySelectorAll(
                '.articleTagWrap, .p-articleTag, .HeaderWrap, .articleHeader, [class*="floating"], [class*="FixedBan"], [class*="fixedBan"]'
              )
              .forEach((el) => {
                el.style.pointerEvents = 'none';
              });
            const paras = [...document.querySelectorAll('p.article__txt')].filter(
              (el) => (el.textContent || '').trim().length > 80
            );
            for (const p of paras) {
              p.scrollIntoView({ block: 'center' });
              const range = document.createRange();
              range.selectNodeContents(p);
              const rects = [...range.getClientRects()].filter((r) => r.width > 20 && r.height > 8);
              for (const r of rects) {
                const candidates = [
                  [12, 6],
                  [36, 8],
                  [72, 10],
                  [120, 8],
                  [Math.min(160, r.width / 2), r.height / 2]
                ];
                for (const [dx, dy] of candidates) {
                  const x = r.left + dx;
                  const y = r.top + dy;
                  const hit = document.elementFromPoint(x, y);
                  if (hit && (hit === p || p.contains(hit)) && hit.tagName !== 'IMG') {
                    return { x, y };
                  }
                }
              }
            }
            return null;
          });
        }
      }
    ]
  },
  {
    id: 'G18',
    url: 'https://kikokusei-mikata.com/column/english-learning-site/',
    probes: [{ name: 'column-body', locate: (p) => locateLongTextIn(p, 'article, main, .entry-content, body') }]
  },
  {
    id: 'G19',
    url: 'https://www3.nhk.or.jp/nhkworld/en/news/20260626_99/',
    probes: [{ name: 'news-body', locate: (p) => locateLongTextIn(p, 'article, main, body') }]
  },
  {
    id: 'G20',
    url: 'https://www.portescap.com/ja-JP/%E3%83%AA%E3%82%BD%E3%83%BC%E3%82%B9/%E5%B0%8F%E5%9E%8B%E3%83%A2%E3%83%BC%E3%82%BF%E4%BB%95%E6%A7%98%E3%82%92%E3%83%80%E3%82%A6%E3%83%B3%E3%83%AD%E3%83%BC%E3%83%89-/%E3%83%9B%E3%83%AF%E3%82%A4%E3%83%88%E3%83%9A%E3%83%BC%E3%83%91%E3%83%BC/%E3%82%B9%E3%83%86%E3%83%83%E3%83%94%E3%83%B3%E3%82%B0%E3%83%A2-%E3%82%BF%E7%94%A8%E3%81%AE%E3%83%90%E3%82%A4%E3%83%9D-%E3%83%A9%E3%83%89-%E3%83%A9%E3%82%A4%E3%83%96%E3%81%A8%E3%83%A6%E3%83%8B%E3%83%9D-%E3%83%A9%E3%83%89%E3%83%A9%E3%82%A4%E3%83%96%E3%81%AE%E9%81%95%E3%81%84',
    probes: [{ name: 'p-newline', locate: (p) => locateTextIn(p, '着目してい', 'p, body') }]
  },
  {
    id: 'G21',
    url: 'https://konifar-zatsu.hatenadiary.jp/entry/2024/11/05/192421',
    probes: [{ name: 'inline-code-p', locate: (p) => locateLongTextIn(p, 'article, .entry-content, body') }]
  },
  {
    id: 'G23',
    url: 'https://github.com/mzk-log/yomup',
    probes: [{ name: 'readme-ja', locate: (p) => locateTextIn(p, '読むプ', 'article, #readme, body') }]
  },
  {
    id: 'G24',
    url: 'https://t-msg.co.jp/',
    probes: [{ name: 'text02', locate: (p) => locateLongTextIn(p, 'div.text02, .text02, body') }]
  },
  {
    id: 'G25',
    url: 'https://t-msg.co.jp/enter/',
    probes: [{ name: 'flow-step', locate: (p) => locateTextIn(p, 'Step 1', 'div.box01, .box01, body') }]
  },
  {
    id: 'G26',
    url: 'https://www.honda.co.jp/enjoyhonda/fukuoka/',
    probes: [
      {
        name: 'dt-schedule',
        locate: async (page) => {
          return page.evaluate(() => {
            const dt = [...document.querySelectorAll('dt')].find((el) =>
              (el.textContent || '').includes('開催日程')
            );
            if (!dt) return null;
            dt.scrollIntoView({ block: 'center' });
            const range = document.createRange();
            const tn = [...dt.childNodes].find(
              (n) => n.nodeType === 3 && (n.textContent || '').includes('開催')
            );
            if (tn) {
              const t = tn.textContent || '';
              const i = t.indexOf('開催');
              range.setStart(tn, Math.max(0, i));
              range.setEnd(tn, Math.min(t.length, i + 4));
            } else {
              range.selectNodeContents(dt);
            }
            const r = range.getBoundingClientRect();
            return {
              x: r.left + Math.min(24, Math.max(r.width, 4) / 2),
              y: r.top + Math.max(r.height, 8) / 2
            };
          });
        }
      }
    ]
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
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 });
  } catch (_e) {
    return;
  }
  for (let i = 0; i < 10; i++) {
    if (await isBulbActiveInShadow(page)) return;
    await page.waitForTimeout(400);
  }
  // Playwright click が効かないサイトがあるため shadow 内で直接 toggle
  await page.evaluate(() => {
    const img = document
      .getElementById('YomuP-popup-container')
      ?.shadowRoot?.querySelector('.lightbulb-button img');
    if (img && !img.classList.contains('active')) {
      img.click();
    }
  });
  await page.waitForTimeout(500);
}

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  // content.js は pageTransition 復元で executeYomuP を約 2s 遅延
  await page.waitForTimeout(2500);
  let popupReady = false;
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
    popupReady = true;
  } catch (_e) {
    // continue
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
  // 電球 OFF のまま進むと全 probe FAIL になるため最終確認
  if (!(await isBulbActiveInShadow(page))) {
    await page.evaluate(() => {
      const img = document
        .getElementById('YomuP-popup-container')
        ?.shadowRoot?.querySelector('.lightbulb-button img');
      img?.click();
    });
    await page.waitForTimeout(400);
  }
}

async function clearHighlight(page) {
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    document.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 4, clientY: 4, view: window })
    );
  });
  await page.waitForTimeout(120);
}

async function hoverProbe(page, point) {
  await page.mouse.move(point.x, point.y);
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    const eventInit = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', eventInit));
    target?.dispatchEvent(new MouseEvent('mousemove', eventInit));
  }, point);
  await page.waitForTimeout(HOVER_SETTLE_MS);
}

async function hasHighlightOverlay(page) {
  return page.evaluate((sel) => {
    const segs = document.querySelectorAll(sel);
    for (let i = 0; i < segs.length; i++) {
      const r = segs[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }, OVERLAY);
}

async function locateLongTextIn(page, rootSelector) {
  return page.evaluate((rootSelector) => {
    const roots = rootSelector.split(',').map((s) => s.trim());
    let root = null;
    for (const sel of roots) {
      root = document.querySelector(sel);
      if (root) break;
    }
    if (!root) root = document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let best = null;
    let bestLen = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const t = (node.textContent || '').trim();
      if (t.length < 40) continue;
      if (node.parentElement?.closest?.('script, style, noscript, nav, header, footer')) continue;
      if (t.length > bestLen) {
        bestLen = t.length;
        best = node;
      }
    }
    if (!best) return null;
    const range = document.createRange();
    range.selectNodeContents(best);
    const tmp = document.createElement('span');
    best.parentNode.insertBefore(tmp, best);
    tmp.scrollIntoView({ block: 'center' });
    tmp.remove();
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    const r = rects[0];
    return {
      x: r.left + Math.min(40, r.width / 2),
      y: r.top + r.height / 2
    };
  }, rootSelector);
}

async function locateTextIn(page, needle, rootSelector) {
  return page.evaluate(
    ({ needle, rootSelector }) => {
      const roots = rootSelector.split(',').map((s) => s.trim());
      let root = null;
      for (const sel of roots) {
        const el = document.querySelector(sel);
        if (el && (el.textContent || '').includes(needle)) {
          root = el;
          break;
        }
      }
      if (!root) {
        root = [...document.querySelectorAll(roots.join(','))].find((el) =>
          (el.textContent || '').includes(needle)
        );
      }
      if (!root) root = document.body;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let textNode = null;
      while (walker.nextNode()) {
        if ((walker.currentNode.textContent || '').includes(needle)) {
          textNode = walker.currentNode;
          break;
        }
      }
      if (!textNode) return null;
      const t = textNode.textContent || '';
      const idx = t.indexOf(needle);
      const range = document.createRange();
      range.setStart(textNode, Math.max(0, idx));
      range.setEnd(textNode, Math.min(t.length, idx + Math.max(2, Math.min(needle.length, 12))));
      const tmp = document.createElement('span');
      textNode.parentNode.insertBefore(tmp, textNode);
      tmp.scrollIntoView({ block: 'center' });
      tmp.remove();
      const r = range.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return null;
      return {
        x: r.left + Math.min(40, Math.max(r.width, 8) / 2),
        y: r.top + Math.max(r.height, 8) / 2
      };
    },
    { needle, rootSelector }
  );
}

function printCase(r) {
  console.log(`\n[${r.id}] ${r.ok ? 'OK' : 'NG'} ${r.url}`);
  for (const p of r.probes) {
    const extra = p.reason ? ` (${p.reason})` : '';
    const dbg = p.debug ? ` debug=${JSON.stringify(p.debug)}` : '';
    console.log(`  - ${p.name}: ${p.status}${extra}${dbg}`);
  }
  if (r.error) console.log(`  error: ${r.error}`);
}

async function main() {
  if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
    console.error('manifest.json not found:', EXTENSION_PATH);
    process.exit(2);
  }

  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

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
          let point = await probe.locate(page);
          if (!point) {
            caseResult.probes.push({ name: probe.name, status: 'SKIP', reason: 'probe-not-found' });
            continue;
          }
          await clearHighlight(page);
          // sticky header 等で座標がずれるサイト向けに直前再取得
          const refreshed = await probe.locate(page);
          if (refreshed) point = refreshed;
          await hoverProbe(page, point);
          let lit = await hasHighlightOverlay(page);
          if (!lit) {
            // リトライ: 電球再確認 + 再ホバー
            await page.evaluate(() => {
              const img = document
                .getElementById('YomuP-popup-container')
                ?.shadowRoot?.querySelector('.lightbulb-button img');
              if (img && !img.classList.contains('active')) img.click();
            });
            await page.waitForTimeout(400);
            await clearHighlight(page);
            await hoverProbe(page, point);
            lit = await hasHighlightOverlay(page);
          }
          if (!lit) {
            const dbg = await page.evaluate(
              ({ x, y, sel }) => {
                const img = document
                  .getElementById('YomuP-popup-container')
                  ?.shadowRoot?.querySelector('.lightbulb-button img');
                const h = document.elementFromPoint(x, y);
                return {
                  bulb: !!img?.classList.contains('active'),
                  hit: h ? `${h.tagName}.${String(h.className || '').slice(0, 40)}` : null,
                  segs: document.querySelectorAll(sel).length
                };
              },
              { x: point.x, y: point.y, sel: OVERLAY }
            );
            caseResult.probes.push({
              name: probe.name,
              status: 'FAIL',
              x: Math.round(point.x),
              y: Math.round(point.y),
              debug: dbg
            });
          } else {
            caseResult.probes.push({
              name: probe.name,
              status: 'PASS',
              x: Math.round(point.x),
              y: Math.round(point.y)
            });
          }
          if (lit) anyPass = true;
          continue;
        }
        if (tc.requireProbes?.length) {
          caseResult.ok = tc.requireProbes.every(
            (name) => caseResult.probes.find((p) => p.name === name)?.status === 'PASS'
          );
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
  console.log('\n=== §7.0 EXTENDED SUMMARY ===');
  console.log(`PASS: ${rows.length - failed.length} / ${rows.length}`);
  for (const r of rows) {
    const mark = r.ok ? 'OK' : 'NG';
    const detail = r.probes.map((p) => `${p.name}:${p.status}`).join(', ');
    console.log(`${r.id} ${mark}  ${detail}${r.error ? `  (${r.error})` : ''}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
