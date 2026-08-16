/**
 * §74 案A — 読むプ窓が表示されているときだけハイライト有効
 * Usage: node _tools/probe-popup-gated-highlight.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-popup-gated-hl');
fs.rmSync(USER_DATA, { recursive: true, force: true });

const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';

const FIXTURE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>§74 popup-gated</title>
<style>body{margin:48px;font-size:18px;line-height:1.8}p{max-width:520px}</style>
</head><body>
<p id="p1">これは読むプのハイライト確認用の文章です。窓がないときは光ってはいけません。</p>
</body></html>`;

const fixturePath = path.join(os.tmpdir(), 'yomup-popup-gated.html');
fs.writeFileSync(fixturePath, FIXTURE, 'utf8');
const fixtureUrl = 'file:///' + fixturePath.replace(/\\/g, '/');

async function ensurePopup(context, page) {
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 8000 });
    return;
  } catch (_e) {
    /* fall through */
  }
  const sw = context.serviceWorkers()[0];
  if (sw) {
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
    });
  }
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 });
}

async function overlayVisible(page) {
  return page.evaluate((sel) => {
    const nodes = document.querySelectorAll(sel);
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.width > 2 && r.height > 0) return true;
    }
    return false;
  }, OVERLAY);
}

async function hoverProbeText(page) {
  const box = await page.locator('#p1').boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + Math.min(120, box.width / 2), box.y + box.height / 2);
  await page.waitForTimeout(700);
  return overlayVisible(page);
}

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`
    ]
  });
  const page = await context.newPage();
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 幽霊 ON を仕込んでリロード（窓は出さない）
  await page.evaluate(async () => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.removeItem('YomuPPopupVisible');
    sessionStorage.removeItem('pageTransition');
    await new Promise((resolve) => {
      try {
        chrome.storage.local.set({ highLightOnOff: true }, () => resolve());
      } catch (_e) {
        resolve();
      }
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  const noPopup = await page.evaluate(() => !document.getElementById('YomuP-popup-container'));
  const ghostLit = await hoverProbeText(page);
  const passGhost = noPopup && !ghostLit;

  // 窓を開いてハイライト ON
  await page.evaluate(() => {
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
  });
  await ensurePopup(context, page);
  await page.evaluate(() => {
    const host = document.getElementById('YomuP-popup-container');
    const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
    if (img && !img.classList.contains('active')) img.click();
  });
  await page.waitForTimeout(400);
  const withPopupLit = await hoverProbeText(page);

  // 窓を閉じる → 光らない
  await page.evaluate(() => {
    const host = document.getElementById('YomuP-popup-container');
    const popup = host?.shadowRoot?.querySelector('.YomuP-popup, [class*="YomuP"]');
    if (popup) {
      popup.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    }
  });
  await page.waitForTimeout(500);
  const closed = await page.evaluate(() => !document.getElementById('YomuP-popup-container'));
  const afterCloseLit = await hoverProbeText(page);
  const passClose = closed && !afterCloseLit;

  const pass = passGhost && withPopupLit && passClose;
  console.log(
    JSON.stringify(
      {
        passGhost,
        noPopup,
        ghostLit,
        withPopupLit,
        passClose,
        closed,
        afterCloseLit,
        pass
      },
      null,
      2
    )
  );

  await context.close();
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
