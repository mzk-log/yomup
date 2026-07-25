/**
 * MS-2 / MS-3 — もしも beginner 相当 DOM（要ログイン実ページの代替フィクスチャ）
 * 実行: node _tools/probe-moshimo-beginner.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-moshimo-beginner');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>MS-2/MS-3 fixture</title>
<style>
  body { font-family: sans-serif; font-size: 16px; line-height: 1.8; max-width: 720px; margin: 40px; }
  strong.head { display: block; margin-bottom: 0.4em; font-size: 1.2em; }
  strong.red { color: #c00; }
  p { margin: 1.5em 0; }
</style></head><body>
<p id="ms2">
  <strong class="head">もしもアフィリエイトにようこそ！</strong>
  ご登録ありがとうございました！私の名前はもしもちゃん、あなたのサポート担当です。<br>
  まずはアフィリエイトで成果を出すための3ステップを、一緒に確認していきましょう。
</p>
<p id="ms3">直訳すると｢加入、提携｣の意味になる affiliate とは、カンタンに言うと、<br>
    <strong class="red">「あなたがある企業に代わって商品やサービスを宣伝・紹介して、お客様にお申込みやご購入していただけると、その企業から“報酬”がもらえる」</strong>というシステムです。</p>
</body></html>`;

const fixturePath = path.join(os.tmpdir(), 'yomup-ms23-fixture.html');
fs.writeFileSync(fixturePath, FIXTURE, 'utf8');
const fixtureUrl = 'file:///' + fixturePath.replace(/\\/g, '/');

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

async function hoverAndMeasure(page, locateFn, label) {
  const point = await page.evaluate(locateFn);
  if (!point) {
    console.log(`${label}: FAIL locate`);
    return { ok: false, reason: 'locate' };
  }
  await page.mouse.move(4, 4);
  await page.waitForTimeout(80);
  await page.mouse.move(point.x, point.y);
  await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  }, point);
  await page.waitForTimeout(700);

  const m = await page.evaluate(
    ({ x, y, sel, expectSub }) => {
      const hit = document.elementFromPoint(x, y);
      const segs = [...document.querySelectorAll(sel)].map((e) => {
        const r = e.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          left: Math.round(r.left),
          w: Math.round(r.width),
          h: Math.round(r.height)
        };
      });
      const unionW = segs.reduce((s, g) => s + g.w, 0);
      const overlayTextApprox = (() => {
        // no text on overlay; use range under hover via selection of lighted area width vs expected phrase
        return null;
      })();
      return {
        hit: hit ? `${hit.tagName}.${String(hit.className || '').slice(0, 40)}` : null,
        segs,
        segCount: segs.length,
        unionW,
        expectSub,
        lit: segs.length > 0
      };
    },
    { x: point.x, y: point.y, sel: OVERLAY, expectSub: point.expectSub || null }
  );

  // Diagnose CK-3 misdetect for MS-2
  const diag = await page.evaluate(({ x, y }) => {
    const p = document.getElementById('ms2');
    const strong = p?.querySelector('strong.head');
    const nextEl = strong?.nextElementSibling;
    const between = [];
    if (strong) {
      let n = strong.nextSibling;
      while (n && !(n.nodeType === 1 && n.tagName === 'BR')) {
        if (n.nodeType === 3 && n.textContent.trim()) between.push(n.textContent.trim().slice(0, 40));
        else if (n.nodeType === 1) between.push(`<${n.tagName}>`);
        n = n.nextSibling;
      }
    }
    const br = [...(p?.children || [])].find((c) => c.tagName === 'BR') || p?.querySelector('br');
    return {
      nextElementSibling: nextEl ? nextEl.tagName : null,
      textBetweenStrongAndBr: between,
      brTop: br ? Math.round(br.getBoundingClientRect().top) : null,
      pointerY: Math.round(y),
      pointerX: Math.round(x)
    };
  }, point);

  console.log(`${label}:`, JSON.stringify({ point: { x: Math.round(point.x), y: Math.round(point.y) }, m, diag }, null, 2));
  return { ok: m.lit, m, diag, point };
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
  viewport: { width: 1280, height: 900 }
});
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());

await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await preparePage(context, page);

console.log('fixture:', fixtureUrl);

// MS-2: hover mid text between strong and br
const ms2 = await hoverAndMeasure(
  page,
  () => {
    const p = document.getElementById('ms2');
    const strong = p.querySelector('strong.head');
    // first text node after strong
    let node = strong.nextSibling;
    while (node && !(node.nodeType === 3 && node.textContent.trim())) node = node.nextSibling;
    if (!node) return null;
    const range = document.createRange();
    const t = node.textContent;
    const idx = t.indexOf('ご登録');
    range.setStart(node, Math.max(0, idx));
    range.setEnd(node, Math.min(t.length, idx + 8));
    const r = range.getBoundingClientRect();
    if (r.width < 2) return null;
    return { x: r.left + Math.min(20, r.width / 2), y: (r.top + r.bottom) / 2, expectSub: 'ご登録' };
  },
  'MS-2 mid-body'
);

// MS-2b: hover strong.head (should light)
const ms2b = await hoverAndMeasure(
  page,
  () => {
    const el = document.querySelector('#ms2 strong.head');
    const r = el.getBoundingClientRect();
    return { x: r.left + 40, y: (r.top + r.bottom) / 2 };
  },
  'MS-2 strong.head'
);

// MS-3: hover inside strong.red near 「その企」
const ms3 = await hoverAndMeasure(
  page,
  () => {
    const el = document.querySelector('#ms3 strong.red');
    const text = el.firstChild;
    if (!text || text.nodeType !== 3) return null;
    const idx = text.textContent.indexOf('その企');
    if (idx < 0) return null;
    const range = document.createRange();
    range.setStart(text, idx);
    range.setEnd(text, idx + 3);
    const r = range.getBoundingClientRect();
    return { x: r.left + 2, y: (r.top + r.bottom) / 2, expectSub: 'その企' };
  },
  'MS-3 near その企'
);

// Extra: measure which chunk width / whether cut mid-sentence
const ms3chunk = await page.evaluate(() => {
  const p = document.getElementById('ms3');
  const full = (p.innerText || '').replace(/\s+/g, '');
  return {
    fullLen: full.length,
    idxSono: full.indexOf('その企'),
    hasKuten: full.includes('。')
  };
});
console.log('MS-3 text lens:', ms3chunk);

// MS-3: hover at paragraph start — underline should cover past その企 through です。
await page.mouse.move(4, 4);
await page.waitForTimeout(80);
const ms3start = await page.evaluate(() => {
  const node = document.getElementById('ms3').firstChild;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 2);
  const r = range.getBoundingClientRect();
  return { x: r.left + 5, y: (r.top + r.bottom) / 2 };
});
await page.mouse.move(ms3start.x, ms3start.y);
await page.evaluate(({ x, y }) => {
  const t = document.elementFromPoint(x, y);
  const init = { bubbles: true, clientX: x, clientY: y, view: window };
  document.dispatchEvent(new MouseEvent('mousemove', init));
  t?.dispatchEvent(new MouseEvent('mousemove', init));
}, ms3start);
await page.waitForTimeout(700);
const ms3cover = await page.evaluate((sel) => {
  const segs = [...document.querySelectorAll(sel)].map((e) => {
    const r = e.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right) };
  });
  const mark = (el, needle, len) => {
    const t = el.nodeType === 3 ? el : el.firstChild;
    const i = t.textContent.indexOf(needle);
    if (i < 0) return null;
    const rg = document.createRange();
    rg.setStart(t, i);
    rg.setEnd(t, i + len);
    const r = rg.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right) };
  };
  const covers = (m) =>
    !!m &&
    segs.some(
      (s) => Math.abs(s.top - m.top) <= 16 && s.left <= m.left + 4 && s.right >= m.right - 4
    );
  const strong = document.querySelector('#ms3 strong.red');
  const after = [...document.getElementById('ms3').childNodes].find(
    (c) => c.nodeType === 3 && (c.textContent || '').includes('という')
  );
  const sono = mark(strong, 'その企', 3);
  const hou = mark(strong, '報酬', 2);
  const desu = after ? mark(after, 'です', 3) : null;
  return {
    segCount: segs.length,
    coversSono: covers(sono),
    coversHou: covers(hou),
    coversDesu: covers(desu),
    segs
  };
}, OVERLAY);
console.log('MS-3 cover from start hover:', JSON.stringify(ms3cover, null, 2));

const ms2Fail = !ms2.ok;
const ms3Fail = !(ms3cover.coversSono && ms3cover.coversHou);
// coversDesu は 「」後の別チャンクになり得るため必須としない

console.log('\n=== SUMMARY ===');
console.log(`MS-2 mid-body light: ${ms2.ok ? 'PASS' : 'FAIL'}`);
console.log(`MS-2 strong.head light: ${ms2b.ok ? 'PASS' : 'FAIL'}`);
console.log(
  `MS-3 quote intact (sono/hou, desu=${ms3cover.coversDesu}): ${ms3Fail ? 'FAIL' : 'PASS'} ` +
    `(${ms3cover.coversSono}/${ms3cover.coversHou})`
);
console.log(
  `CK-3 gate nextElementSibling=${ms2.diag?.nextElementSibling}, between=${JSON.stringify(ms2.diag?.textBetweenStrongAndBr)}`
);

process.exitCode = ms2Fail || !ms2b.ok || ms3Fail ? 1 : 0;
await context.close();
