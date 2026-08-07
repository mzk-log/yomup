/**
 * AT-3 応答性 — ライン進行 ON 時、同一文字数の別 br 行が progress target 衝突するか計測
 * 実行: node _tools/probe-aichi-te-contact-latency.mjs
 *
 * 期待（修正後）: progress / full とも TEL→担当 が ~250ms で点灯
 * 既知（修正前）: progress のみ TEL→担当 が skip-progress で固着（両行とも 16 字）
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-aichi-te-contact-latency');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-hl-seg, #yomup-highlight-overlay-root .yomup-highlight-underline';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>AT-3 latency</title>
<style>
  body { font-family: "Yu Gothic", sans-serif; font-size: 16px; line-height: 1.9; max-width: 720px; margin: 40px; }
</style></head><body>
<p id="contact">説明会を受けてのご質問などありましたら、以下までご連絡ください。<br>※連絡は平日日中にお願いします。また、会議や出張などで不在の際はご容赦ください。<br><br>学校概要・教育方針等学校生活全般について<br>TEL:052-784-6358<br>担当：附属中学校　副校長（恩田）<br><br>入学者選抜について<br>TEL:052-954-7432<br>担当：愛知県教育委員会　高等学校教育課　中高一貫グループ<br><br>なお、2029年度に開校を目指している県立高専については、学校として、県の公式発表以外に、説明できる情報を持っていません。</p>
</body></html>`;

const fixturePath = path.join(os.tmpdir(), 'yomup-at3-latency-fixture.html');
fs.writeFileSync(fixturePath, FIXTURE, 'utf8');
const fixtureUrl = 'file:///' + fixturePath.replace(/\\/g, '/');

async function preparePage(context, page, underlineMode) {
  await page.evaluate((mode) => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
    if (mode) localStorage.setItem('YomuP_highlightUnderlineMode', mode);
    else localStorage.removeItem('YomuP_highlightUnderlineMode');
  }, underlineMode || null);
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

function locateText(snippet) {
  const p = document.getElementById('contact');
  const tn = [...p.childNodes].find(
    (n) => n.nodeType === 3 && n.textContent.includes(snippet)
  );
  if (!tn) return null;
  const range = document.createRange();
  const idx = tn.textContent.indexOf(snippet);
  range.setStart(tn, idx);
  range.setEnd(tn, Math.min(tn.textContent.length, idx + Math.min(6, snippet.length)));
  const r = range.getBoundingClientRect();
  if (r.width < 2) return null;
  return {
    x: r.left + Math.min(24, r.width / 2),
    y: (r.top + r.bottom) / 2,
    top: r.top,
    bottom: r.bottom
  };
}

async function dispatchMove(page, x, y) {
  await page.mouse.move(x, y);
  await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    t?.dispatchEvent(new MouseEvent('mousemove', init));
  }, { x, y });
}

async function waitForOverlayNearText(page, textTop, textBottom, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = await page.evaluate(
      ({ sel, textTop, textBottom }) => {
        const segs = [...document.querySelectorAll(sel)];
        if (segs.length === 0) return null;
        for (const e of segs) {
          const r = e.getBoundingClientRect();
          const cy = (r.top + r.bottom) / 2;
          if (cy >= textTop - 4 && cy <= textBottom + 10) {
            return { top: r.top, bottom: r.bottom, w: r.width };
          }
        }
        return null;
      },
      { sel: OVERLAY, textTop, textBottom }
    );
    if (hit) {
      hit.ms = Date.now() - started;
      return hit;
    }
    await page.waitForTimeout(16);
  }
  return { ms: timeoutMs, miss: true };
}

async function measureSwitch(page, fromPt, toPt, label) {
  await dispatchMove(page, fromPt.x, fromPt.y);
  await page.waitForTimeout(450);
  const t0 = Date.now();
  await dispatchMove(page, toPt.x, toPt.y);
  const hit = await waitForOverlayNearText(page, toPt.top, toPt.bottom, 1200);
  console.log(
    `${label}: lit=${!hit.miss} waitMs=${hit.ms} totalMs=${Date.now() - t0}` +
      (hit.miss ? ' MISS' : ` w=${Math.round(hit.w)}`)
  );
  return hit;
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

const results = {};
for (const mode of [null, 'full']) {
  const key = mode || 'progress';
  console.log(`\n=== underlineMode=${key} ===`);
  await preparePage(context, page, mode);
  const tel = await page.evaluate(locateText, 'TEL:052-784');
  const tanto = await page.evaluate(locateText, '担当：附属');
  const nyushi = await page.evaluate(locateText, '入学者選抜');
  if (!tel || !tanto || !nyushi) {
    console.log('FAIL locate');
    await context.close();
    process.exit(1);
  }
  results[key] = {
    telToTanto: await measureSwitch(page, tel, tanto, 'TEL→担当'),
    nyushiToTanto: await measureSwitch(page, nyushi, tanto, '入学者→担当')
  };
}

const progressOk = !results.progress.telToTanto.miss && results.progress.telToTanto.ms <= 500;
const fullOk = !results.full.telToTanto.miss && results.full.telToTanto.ms <= 500;
console.log(
  progressOk && fullOk
    ? 'RESULT: PASS (progress+full TEL→担当 ok)'
    : `RESULT: FAIL progressTelToTanto=${progressOk} fullTelToTanto=${fullOk}`
);

await context.close();
process.exit(progressOk && fullOk ? 0 : 1);
