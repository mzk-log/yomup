/**
 * 日経 G09 — 3.3.0 vs 現行の本文ホバー退行比較
 * node _tools/nikkei-version-compare.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_CURRENT = path.resolve(__dirname, '..');
const EXT_330 = path.resolve(__dirname, '../../_wt_3.3.0');

const VERSIONS = process.argv[2]
  ? [{ label: process.argv[2], ext: path.resolve(__dirname, process.argv[3] || '..'), userData: path.join(__dirname, `.pw-nikkei-${process.argv[2]}`) }]
  : [
    { label: '3.3.0', ext: EXT_330, userData: path.join(__dirname, '.pw-nikkei-330') },
    { label: 'fe3c0fc', ext: path.resolve(__dirname, '../../_wt_fe3c0fc'), userData: path.join(__dirname, '.pw-nikkei-fe3c0fc') },
    { label: 'e1ad04a', ext: path.resolve(__dirname, '../../_wt_e1ad04a'), userData: path.join(__dirname, '.pw-nikkei-e1ad04a') },
    { label: 'HEAD', ext: EXT_CURRENT, userData: path.join(__dirname, '.pw-nikkei-head') }
  ];

async function probeVersion({ label, ext, userData }) {
  const ctx = await chromium.launchPersistentContext(userData, {
    channel: 'chromium',
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 1280, height: 900 }
  });
  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) {
      try {
        sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
      } catch (_e) {
        return { label, error: 'no-service-worker' };
      }
    }

    const page = ctx.pages()[0] || (await ctx.newPage());
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('highLightOnOff', 'true');
        localStorage.setItem('YomuPPopupVisible', 'true');
        sessionStorage.setItem('pageTransition', 'true');
      } catch (_e) { /* ignore */ }
    });
    await page.goto('https://www.nikkei.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      localStorage.setItem('highLightOnOff', 'true');
      localStorage.setItem('YomuPPopupVisible', 'true');
      sessionStorage.setItem('pageTransition', 'true');
    });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);

    let popupReady = false;
    try {
      await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 });
      popupReady = true;
    } catch (_e) {
      if (sw) {
        await sw.evaluate(async () => {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
        });
        try {
          await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
          popupReady = true;
        } catch (_e2) { /* fall through */ }
      }
    }
    if (!popupReady) return { label, error: 'popup-not-attached' };

    await page.evaluate(() => {
      const popup = document.getElementById('YomuP-popup-container')?.shadowRoot?.querySelector('.YomuP-popup');
      if (popup) {
        popup.style.setProperty('--YomuP-popup-top', '12px', 'important');
        popup.style.setProperty('--YomuP-popup-left', `${Math.max(0, window.innerWidth - 220)}px`, 'important');
      }
    });

    const bulb = page.locator('#YomuP-popup-container').locator('.lightbulb-button img');
    if (await bulb.count()) {
      const active = await page.evaluate(() => {
        const img = document.getElementById('YomuP-popup-container')?.shadowRoot?.querySelector('.lightbulb-button img');
        return img?.classList.contains('active');
      });
      if (!active) await bulb.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
    }

    const targets = await page.evaluate(() => {
      const card = [...document.querySelectorAll('a[class*="blockLink"]')].find(a =>
        (a.textContent || '').includes('DAZN')
      );
      if (!card) return { error: 'no-dazn-card' };

      const bodyP = [...(card.parentElement?.querySelectorAll('p') || [])].find(p =>
        (p.textContent || '').includes('サッカーワールド')
      );
      const h2 = card.parentElement?.querySelector('h2') || document.querySelector('h2[class*="title"]');
      const titleGhost = card.parentElement?.querySelector('a[class*="titleText"]');

      function pointOnText(root, needle) {
        if (!root) return null;
        const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (tw.nextNode()) {
          const t = tw.currentNode.textContent || '';
          const idx = t.indexOf(needle);
          if (idx < 0) continue;
          const rg = document.createRange();
          rg.setStart(tw.currentNode, idx);
          rg.setEnd(tw.currentNode, idx + Math.min(needle.length, 6));
          const r = rg.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return {
              x: r.left + Math.min(30, r.width * 0.4),
              y: r.top + r.height / 2,
              top: Math.round(r.top),
              text: t.slice(idx, idx + 20)
            };
          }
        }
        return null;
      }

      bodyP?.scrollIntoView({ block: 'center' });
      return {
        body: pointOnText(bodyP, 'サッカーワールド'),
        title: pointOnText(h2 || titleGhost, 'DAZN'),
        h2Top: h2 ? Math.round(h2.getBoundingClientRect().top) : null
      };
    });

    if (targets.error) return { label, error: targets.error };

    const results = {};
    for (const [name, pt] of [['body', targets.body], ['title', targets.title]]) {
      if (!pt) {
        results[name] = { status: 'SKIP', reason: 'point-not-found' };
        continue;
      }
      await page.mouse.move(4, 4);
      await page.waitForTimeout(100);
      await page.mouse.move(pt.x, pt.y);
      await page.evaluate(({ x, y }) => {
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
      }, pt);
      await page.waitForTimeout(1200);

      results[name] = await page.evaluate(({ pt, h2Top }) => {
        const segs = [...document.querySelectorAll(
          '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline'
        )];
        const tops = segs.map(s => Math.round(s.getBoundingClientRect().top));
        const caret = document.caretRangeFromPoint?.(pt.x, pt.y);
        const caretText = caret?.startContainer?.nodeType === 3
          ? (caret.startContainer.textContent || '').slice(0, 40)
          : null;
        const stack0 = document.elementsFromPoint(pt.x, pt.y)[0];
        return {
          hoverTop: pt.top,
          h2Top,
          overlayCount: segs.length,
          overlayTops: tops.slice(0, 6),
          nearHover: tops.some(t => Math.abs(t - pt.top) < 35),
          nearTitle: h2Top != null && tops.some(t => Math.abs(t - h2Top) < 35),
          caretText,
          stack0: stack0 ? `${stack0.tagName}.${String(stack0.className || '').slice(0, 30)}` : null,
          lit: segs.length > 0
        };
      }, { pt, h2Top: targets.h2Top });
      results[name].hoverText = pt.text;
    }

    return { label, results };
  } finally {
    await ctx.close();
  }
}

for (const v of VERSIONS) {
  console.log(`\n=== ${v.label} ===`);
  const r = await probeVersion(v);
  console.log(JSON.stringify(r, null, 2));
}
