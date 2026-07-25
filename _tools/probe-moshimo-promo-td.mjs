/**
 * MS-4 — もしもプロモ条件 TD（ol/li + option-item）が光らない
 * 実行: node _tools/probe-moshimo-promo-td.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-moshimo-promo-td');
const FIXTURE = path.join(__dirname, 'fixtures', 'moshimo-promo-condition.html');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 });
  } catch (_e) {
    const sw = context.serviceWorkers()[0];
    if (sw) {
      await sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
      });
    }
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 30000 });
  }
}

async function hoverText(page, needle, rootSel) {
  const point = await page.evaluate(
    ({ needle, rootSel }) => {
      const root = rootSel ? document.querySelector(rootSel) : document.body;
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) {
        const t = walk.currentNode;
        const i = (t.textContent || '').indexOf(needle);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(t, i);
        range.setEnd(t, i + Math.min(needle.length, (t.textContent || '').length - i));
        const r = range.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        t.parentElement?.scrollIntoView({ block: 'center' });
        const r2 = range.getBoundingClientRect();
        return { x: r2.left + Math.min(12, r2.width / 2), y: (r2.top + r2.bottom) / 2 };
      }
      return null;
    },
    { needle, rootSel }
  );
  if (!point) return { ok: false, reason: 'locate', needle };
  await page.mouse.move(4, 4);
  await page.waitForTimeout(60);
  await page.mouse.move(point.x, point.y);
  await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  }, point);
  await page.waitForTimeout(700);
  const m = await page.evaluate(
    ({ x, y, sel }) => {
      const hit = document.elementFromPoint(x, y);
      const segs = [...document.querySelectorAll(sel)].map((e) => {
        const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), top: Math.round(r.top) };
      });
      const td = hit?.closest?.('td.condition');
      const li = hit?.closest?.('li');
      const p = hit?.closest?.('p.option-item');
      const pText = p ? (p.textContent || '').replace(/\u00a0/g, ' ').trim() : null;
      let style = null;
      let textRect = null;
      if (p) {
        const cs = getComputedStyle(p);
        style = {
          display: cs.display,
          fontSize: cs.fontSize,
          color: cs.color,
          visibility: cs.visibility,
          opacity: cs.opacity,
          textIndent: cs.textIndent,
          width: Math.round(p.getBoundingClientRect().width),
          height: Math.round(p.getBoundingClientRect().height)
        };
        const rg = document.createRange();
        rg.selectNodeContents(p);
        const tr = rg.getBoundingClientRect();
        textRect = {
          w: Math.round(tr.width),
          h: Math.round(tr.height),
          top: Math.round(tr.top),
          left: Math.round(tr.left)
        };
      }
      const img = document
        .getElementById('YomuP-popup-container')
        ?.shadowRoot?.querySelector('.lightbulb-button img');
      return {
        hit: hit ? `${hit.tagName}.${String(hit.className || '').slice(0, 40)}` : null,
        segs: segs.length,
        segDetail: segs,
        lit: segs.length > 0,
        inTd: !!td,
        inLi: !!li,
        inOption: !!p,
        pText,
        pLen: pText ? pText.length : 0,
        style,
        textRect,
        xy: { x: Math.round(x), y: Math.round(y) },
        bulb: !!img?.classList.contains('active'),
        tdTextLen: td ? (td.innerText || '').replace(/\s+/g, '').length : 0
      };
    },
    { x: point.x, y: point.y, sel: OVERLAY }
  );
  return { ok: m.lit, needle, point, m };
}

const context = await chromium.launchPersistentContext(USER_DATA, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    '--allow-file-access-from-files'
  ],
  viewport: { width: 1400, height: 900 }
});
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());

const url = 'file:///' + FIXTURE.replace(/\\/g, '/');
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await preparePage(context, page);

const diag = await page.evaluate(() => {
  const td = document.querySelector('td.condition');
  if (!td) return { err: 'no td' };
  const direct = [...td.children].map((c) => c.tagName + '.' + String(c.className || '').slice(0, 30));
  return {
    directChildren: direct,
    br: td.querySelectorAll('br').length,
    a: td.querySelectorAll('a[href]').length,
    h: td.querySelectorAll('h1,h2,h3').length,
    ol: td.querySelectorAll('ol').length,
    li: td.querySelectorAll('li').length,
    option: td.querySelectorAll('p.option-item').length,
    textLen: (td.innerText || '').replace(/\s+/g, '').length
  };
});
console.log('TD diag:', JSON.stringify(diag, null, 2));

// option-item → LI
const cases = [
  await hoverText(page, '本人', 'td.condition'),
  await hoverText(page, '審査あり', 'td.condition'),
  await hoverText(page, 'ITP対応', 'td.condition'),
  await hoverText(page, '出荷された時点で成果発生', 'td.condition'),
  await hoverText(page, 'Amazonプライム無料体験', 'td.condition')
];

for (const c of cases) {
  console.log(
    `${c.needle}: ${c.ok ? 'PASS' : 'FAIL'}`,
    JSON.stringify(c.m || { reason: c.reason })
  );
}

const failed = cases.filter((c) => !c.ok).length;
console.log(`\n=== SUMMARY ${cases.length - failed}/${cases.length} lit ===`);
process.exitCode = failed === cases.length ? 1 : failed > 0 ? 1 : 0;
// 現状は全滅想定 → exit 1
await context.close();
