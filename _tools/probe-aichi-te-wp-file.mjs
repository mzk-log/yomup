/**
 * AT-4 調査 — WordPress wp-block-file（タイトル a + ダウンロードボタン a）
 * Usage:
 *   node _tools/probe-aichi-te-wp-file.mjs           # fixture
 *   node _tools/probe-aichi-te-wp-file.mjs --live    # 実ページ
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-aichi-te-wp-file');
const LIVE = process.argv.includes('--live');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

const LIVE_URL = 'https://aichi-te-jh.aichi-c.ed.jp/cms/page-37.html';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>AT-4 wp-block-file</title>
<style>
  body { font-family: "Yu Gothic", sans-serif; font-size: 12.2px; line-height: 1.8; max-width: 720px; margin: 40px; }
  .wp-block-file { display: block; margin: 1em 0; }
  .wp-block-file > a:first-child { color: #4a9fd8; text-decoration: underline; }
  .wp-block-file__button {
    display: inline-block; margin-left: 8px; padding: 6.5px 11px;
    font-size: 9.8px; line-height: 1.8; background: #eee; color: #333; text-decoration: none;
  }
</style></head><body>
<div class="entry-content">
  <h1>２０２６年度　学校説明会</h1>
  <p>Ａ　当日資料<br>説明会当日に使用する資料を以下にアップロードします。</p>
  <div class="wp-block-file" id="file1">
    <a id="media1" href="#pdf1">当日資料その１</a><a href="#pdf1" class="wp-block-file__button" download>ダウンロード</a>
  </div>
  <div class="wp-block-file" id="file2">
    <a id="media2" href="#pdf2">当日資料その２</a><a href="#pdf2" class="wp-block-file__button" download>ダウンロード</a>
  </div>
</div>
</body></html>`;

let targetUrl;
if (LIVE) {
  targetUrl = LIVE_URL;
} else {
  const fixturePath = path.join(os.tmpdir(), 'yomup-at4-wp-file.html');
  fs.writeFileSync(fixturePath, FIXTURE, 'utf8');
  targetUrl = 'file:///' + fixturePath.replace(/\\/g, '/');
}

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
    localStorage.setItem('YomuP_highlightUnderlineMode', 'full');
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

async function locateMedia(page) {
  return page.evaluate((live) => {
    let a;
    if (live) {
      a = [...document.querySelectorAll('a')].find((el) =>
        (el.textContent || '').includes('当日資料その１')
      );
    } else {
      a = document.getElementById('media1');
    }
    if (!a) return null;
    const tn = [...a.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim());
    if (!tn) return null;
    const range = document.createRange();
    range.setStart(tn, 0);
    range.setEnd(tn, Math.min(4, tn.textContent.length));
    const r = range.getBoundingClientRect();
    if (r.width < 2) return null;
    return { x: r.left + Math.min(20, r.width / 2), y: (r.top + r.bottom) / 2 };
  }, LIVE);
}

async function dispatchMove(page, x, y) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(80);
  await page.mouse.move(x, y);
  await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  }, { x, y });
  await page.waitForTimeout(700);
}

async function measure(page) {
  return page.evaluate(
    ({ sel, live }) => {
      let media;
      let btn;
      let file;
      if (live) {
        media = [...document.querySelectorAll('a')].find((el) =>
          (el.textContent || '').includes('当日資料その１')
        );
        file = media && media.closest('.wp-block-file');
        btn = file && file.querySelector('.wp-block-file__button');
      } else {
        media = document.getElementById('media1');
        btn = document.querySelector('#file1 .wp-block-file__button');
        file = document.getElementById('file1');
      }
      if (!media || !btn || !file) return { error: 'missing nodes' };
      const mr = media.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      const fr = file.getBoundingClientRect();
      const segs = [...document.querySelectorAll(sel)].map((e) => {
        const r = e.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          left: Math.round(r.left),
          w: Math.round(r.width)
        };
      });
      const mediaMidY = (mr.top + mr.bottom) / 2;
      const onMediaText = segs.filter(
        (s) => s.left < mr.right + 2 && s.left + s.w > mr.left - 2
      );
      const onButton = segs.filter(
        (s) => s.left < br.right + 2 && s.left + s.w > br.left - 2
      );
      const aboveMediaGlyph = onMediaText.some((s) => s.top < mediaMidY - 2);
      const belowMediaGlyph = onMediaText.some((s) => s.top >= mr.bottom - 4);
      return {
        lit: segs.length > 0,
        segCount: segs.length,
        segs,
        media: {
          top: Math.round(mr.top),
          bottom: Math.round(mr.bottom),
          left: Math.round(mr.left),
          w: Math.round(mr.width),
          h: Math.round(mr.height)
        },
        btn: {
          top: Math.round(br.top),
          bottom: Math.round(br.bottom),
          left: Math.round(br.left),
          w: Math.round(br.width),
          h: Math.round(br.height)
        },
        file: {
          top: Math.round(fr.top),
          bottom: Math.round(fr.bottom),
          w: Math.round(fr.width)
        },
        hasButtonUnderline: onButton.length > 0,
        underlineAboveMediaGlyph: aboveMediaGlyph,
        underlineBelowMediaGlyph: belowMediaGlyph
      };
    },
    { sel: OVERLAY, live: LIVE }
  );
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

await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
await preparePage(context, page);
console.log('target:', targetUrl, LIVE ? '(live)' : '(fixture)');

const pt = await locateMedia(page);
if (!pt) {
  console.log('FAIL locate media');
  await context.close();
  process.exit(1);
}
console.log('hover point', pt);
await dispatchMove(page, pt.x, pt.y);
const m = await measure(page);
console.log('geometry:', JSON.stringify(m, null, 2));

console.log('\n=== DIAGNOSIS ===');
console.log(
  'button also underlined:',
  m.hasButtonUnderline,
  '→',
  m.hasButtonUnderline ? '親まとめて選定の疑い' : 'タイトル側のみ（または未点灯）'
);
console.log(
  'underline above media glyph:',
  m.underlineAboveMediaGlyph,
  '| below:',
  m.underlineBelowMediaGlyph
);

const pass =
  m.lit &&
  !m.hasButtonUnderline &&
  !m.underlineAboveMediaGlyph &&
  m.underlineBelowMediaGlyph &&
  m.segCount <= 2;
console.log(
  pass ? 'PASS' : 'FAIL',
  JSON.stringify({
    lit: m.lit,
    segCount: m.segCount,
    hasButtonUnderline: m.hasButtonUnderline,
    underlineAboveMediaGlyph: m.underlineAboveMediaGlyph,
    underlineBelowMediaGlyph: m.underlineBelowMediaGlyph
  })
);

await context.close();
process.exit(pass ? 0 : 1);
