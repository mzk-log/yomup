/**
 * §75 HL-POP-1b — 窓なし他タブがハイライト ON を潰さないこと
 * Usage: node _tools/probe-hl-multitab-veto.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-hl-multitab-veto');
fs.rmSync(USER_DATA, { recursive: true, force: true });

async function waitContent(context, page) {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  for (let i = 0; i < 40; i++) {
    const ok = await sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({ url });
      const tab = tabs[0];
      if (!tab?.id) return false;
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => !!window.YOMUP_CONTENT_SCRIPT_LOADED
        });
        return !!result;
      } catch (_e) {
        return false;
      }
    }, page.url());
    if (ok) return;
    await page.waitForTimeout(250);
  }
  throw new Error('content script not loaded: ' + page.url());
}

async function openPopup(context, page) {
  await waitContent(context, page);
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    if (!tabs[0]?.id) throw new Error('tab not found: ' + url);
    await chrome.tabs.sendMessage(tabs[0].id, { action: 'executeYomuP' });
  }, page.url());
  await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 20000 });
}

async function lightbulbState(page) {
  return page.evaluate(() => {
    const host = document.getElementById('YomuP-popup-container');
    const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
    return {
      hasPopup: !!host,
      active: !!(img && img.classList.contains('active')),
      local: localStorage.getItem('highLightOnOff')
    };
  });
}

async function clickLightbulb(page) {
  await page.evaluate(() => {
    const host = document.getElementById('YomuP-popup-container');
    const img = host?.shadowRoot?.querySelector('.lightbulb-button img');
    if (!img) throw new Error('lightbulb not found');
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
}

async function storageHighlight(context) {
  const sw = context.serviceWorkers()[0];
  if (!sw) return null;
  return sw.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.storage.local.get(['highLightOnOff'], (r) => resolve(r.highLightOnOff));
      })
  );
}

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA, {
    channel: 'chromium',
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`
    ],
    viewport: { width: 1100, height: 800 }
  });
  if (!context.serviceWorkers()[0]) {
    await context.waitForEvent('serviceworker', { timeout: 20000 });
  }

  // 窓なしタブ（拒否役）
  const quiet = await context.newPage();
  await quiet.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitContent(context, quiet);
  await quiet.waitForTimeout(800);

  // 作業タブ
  const active = await context.newPage();
  await active.goto('https://example.org/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await openPopup(context, active);

  const before = await lightbulbState(active);
  await clickLightbulb(active);
  await active.waitForTimeout(900);
  const after = await lightbulbState(active);
  const shared = await storageHighlight(context);

  const pass = before.hasPopup && !before.active && after.active === true && after.local === 'true' && shared === true;
  console.log(JSON.stringify({ before, after, shared, pass }, null, 2));

  await context.close();
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
