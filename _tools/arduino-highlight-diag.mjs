import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA = path.join(__dirname, '.pw-arduino-diag');
const OVERLAY =
  '#yomup-highlight-overlay-root .yomup-highlight-underline-segment, #yomup-highlight-overlay-root .yomup-highlight-underline';

async function preparePage(context, page) {
  await page.evaluate(() => {
    localStorage.setItem('highLightOnOff', 'true');
    localStorage.setItem('YomuPPopupVisible', 'true');
    sessionStorage.setItem('pageTransition', 'true');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  try {
    await page.locator('#YomuP-popup-container').waitFor({ state: 'attached', timeout: 25000 });
  } catch (_e) {
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
  await page.evaluate(() => {
    const container = document.getElementById('YomuP-popup-container');
    const popup = container?.shadowRoot?.querySelector('.YomuP-popup');
    if (!popup) return;
    popup.style.setProperty('--YomuP-popup-top', '12px', 'important');
    popup.style.setProperty('--YomuP-popup-left', `${Math.max(0, window.innerWidth - 220)}px`, 'important');
  });
  await page.waitForTimeout(200);
}

async function hoverAndMeasure(page, x, y, note) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(80);
  await page.mouse.move(x, y);
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    const init = { bubbles: true, clientX: x, clientY: y, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', init));
    target?.dispatchEvent(new MouseEvent('mousemove', init));
  }, { x, y });
  await page.waitForTimeout(450);
  return page.evaluate(({ x, y, overlaySel, note }) => {
    const hit = document.elementFromPoint(x, y);
    const segs = [...document.querySelectorAll(overlaySel)].map((e) => {
      const r = e.getBoundingClientRect();
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        top: Math.round(r.top),
        width: Math.round(r.width)
      };
    });
    const unionW = segs.reduce((m, s) => Math.max(m, s.width), 0);
    const minTop = segs.length ? Math.min(...segs.map((s) => s.top)) : null;
    const maxTop = segs.length ? Math.max(...segs.map((s) => s.top)) : null;
    return {
      note,
      hit: hit
        ? `${hit.tagName}.${String(hit.className || '')
            .toString()
            .slice(0, 40)}`
        : null,
      lit: segs.length > 0,
      unionW,
      minTop,
      maxTop,
      segCount: segs.length
    };
  }, { x, y, overlaySel: OVERLAY, note });
}

const context = await chromium.launchPersistentContext(USER_DATA, {
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
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
const page = context.pages()[0] || (await context.newPage());
let fail = 0;

await page.goto('https://mzk-log.github.io/arduino/index.html', {
  waitUntil: 'domcontentloaded',
  timeout: 60000
});
await preparePage(context, page);

const pendingCard = page.locator('div.lesson-card.pending-card').first();
await pendingCard.scrollIntoViewIfNeeded();
const pendingPoints = await page.evaluate(() => {
  const card = document.querySelector('div.lesson-card.pending-card');
  return ['lesson-num', 'lesson-title', 'lesson-meta', 'status-label'].map((cls) => {
    const span = card.querySelector(`span.${cls}`);
    const r = span.getBoundingClientRect();
    return {
      cls,
      x: r.left + Math.min(24, r.width / 2),
      y: r.top + r.height / 2,
      w: Math.round(
        (() => {
          const range = document.createRange();
          range.selectNodeContents(span.firstChild || span);
          const tr = range.getBoundingClientRect();
          return tr.width || r.width;
        })()
      )
    };
  });
});
const pendingMs = [];
for (const pt of pendingPoints) {
  pendingMs.push(await hoverAndMeasure(page, pt.x, pt.y, `pending-${pt.cls}`));
}
console.log(JSON.stringify({ pendingPoints, pendingMs }, null, 2));
for (let i = 0; i < pendingMs.length; i++) {
  const m = pendingMs[i];
  const pt = pendingPoints[i];
  if (!m.lit || m.segCount !== 1) {
    console.log(`FAIL: pending ${pt.cls} expected 1 seg, got ${m.segCount}`);
    fail++;
  }
  if (m.unionW > pt.w + 40) {
    console.log(`FAIL: pending ${pt.cls} highlight too wide`);
    fail++;
  }
}

await page.goto('https://mzk-log.github.io/arduino/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000
});
await preparePage(context, page);

const card = page.locator('a.guide-card').first();
await card.scrollIntoViewIfNeeded();
const points = await page.evaluate(() => {
  const a = document.querySelector('a.guide-card');
  const strong = a.querySelector('strong');
  const sr = strong.getBoundingClientRect();
  let bodyNode = null;
  for (const n of a.childNodes) {
    if (n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim()) {
      bodyNode = n;
      break;
    }
  }
  const range = document.createRange();
  range.selectNodeContents(bodyNode);
  const br = range.getBoundingClientRect();
  return {
    title: { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 },
    body: { x: br.left + Math.min(40, br.width / 2), y: br.top + br.height / 2 },
    titleW: Math.round(sr.width),
    bodyW: Math.round(br.width)
  };
});

const titleM = await hoverAndMeasure(page, points.title.x, points.title.y, 'guide-title');
const bodyM = await hoverAndMeasure(page, points.body.x, points.body.y, 'guide-body');
console.log(JSON.stringify({ points, titleM, bodyM }, null, 2));

if (!titleM.lit || !bodyM.lit) fail++;
// 見出しと本文は別塊: 下線の幅が大きく違う（全体一塊だと両方ともカード幅に近い）
if (titleM.unionW > points.titleW + 40) {
  console.log('FAIL: title highlight too wide (likely whole card)');
  fail++;
}
if (Math.abs(titleM.minTop - bodyM.minTop) < 8 && titleM.unionW > 200 && bodyM.unionW > 200) {
  // same line band and both wide — suspicious
  console.log('WARN: title/body similar tops and wide');
}
if (titleM.unionW >= bodyM.unionW - 10 && bodyM.unionW >= titleM.unionW - 10 && titleM.unionW > 180) {
  console.log('FAIL: title and body similar width — not separated');
  fail++;
}

await page.goto('https://mzk-log.github.io/arduino/start/setup.html', {
  waitUntil: 'domcontentloaded',
  timeout: 60000
});
await preparePage(context, page);
for (const sel of ['div.intro-box > strong', 'div.intro-box > p', 'div.error-item >> nth=1']) {
  const el = page.locator(sel).first();
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  const m = await hoverAndMeasure(
    page,
    box.x + box.width / 3,
    box.y + box.height / 2,
    sel
  );
  console.log(JSON.stringify(m));
  if (!m.lit) fail++;
}

await page.goto('https://mzk-log.github.io/arduino/lessons/basic/lesson014.html', {
  waitUntil: 'domcontentloaded',
  timeout: 60000
});
await preparePage(context, page);
const stepItem = page.locator('div.step-item').first();
await stepItem.scrollIntoViewIfNeeded();
const stepPoints = await page.evaluate(() => {
  const step = document.querySelector('div.step-item');
  const badge = step.querySelector('.step-badge');
  const title = step.querySelector('.step-title');
  const p = step.querySelector('p');
  const pack = (el, note) => {
    const r = el.getBoundingClientRect();
    let tw = Math.round(r.width);
    try {
      const range = document.createRange();
      range.selectNodeContents(el.childNodes[0] || el);
      tw = Math.round(range.getBoundingClientRect().width) || tw;
    } catch (_e) {
      // ignore
    }
    return {
      note,
      x: r.left + Math.min(20, r.width / 2),
      y: r.top + r.height / 2,
      w: tw
    };
  };
  return [pack(badge, 'step-badge'), pack(title, 'step-title'), pack(p, 'step-p')];
});
const stepMs = [];
for (const pt of stepPoints) {
  stepMs.push(await hoverAndMeasure(page, pt.x, pt.y, pt.note));
}
console.log(JSON.stringify({ stepPoints, stepMs }, null, 2));
for (let i = 0; i < stepMs.length; i++) {
  const m = stepMs[i];
  const pt = stepPoints[i];
  if (!m.lit || m.segCount !== 1) {
    console.log(`FAIL: ${pt.note} expected 1 seg, got ${m.segCount}`);
    fail++;
  }
  if (m.unionW > pt.w + 40) {
    console.log(`FAIL: ${pt.note} highlight too wide`);
    fail++;
  }
}

const voidLoopPts = await page.evaluate(() => {
  const li = [...document.querySelectorAll('li')].find(
    (x) => (x.textContent || '').includes('void loop()') && x.querySelector('br')
  );
  if (!li) return null;
  li.scrollIntoView({ block: 'center' });
  const strong = li.querySelector('strong');
  const br = li.querySelector('br');
  const sr = strong.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(br.nextSibling);
  const brc = range.getBoundingClientRect();
  return {
    label: {
      x: sr.left + Math.min(20, sr.width / 2),
      y: sr.top + sr.height / 2,
      w: Math.round(sr.width)
    },
    body: {
      x: brc.left + Math.min(20, brc.width / 2),
      y: brc.top + brc.height / 2,
      w: Math.round(brc.width)
    }
  };
});
if (!voidLoopPts) {
  console.log('FAIL: void loop li not found');
  fail++;
} else {
  const voidLabel = await hoverAndMeasure(
    page,
    voidLoopPts.label.x,
    voidLoopPts.label.y,
    'void-loop-label'
  );
  const voidBody = await hoverAndMeasure(
    page,
    voidLoopPts.body.x,
    voidLoopPts.body.y,
    'void-loop-body'
  );
  console.log(JSON.stringify({ voidLoopPts, voidLabel, voidBody }, null, 2));
  if (!voidLabel.lit || voidLabel.segCount !== 1 || voidLabel.unionW > voidLoopPts.label.w + 40) {
    console.log('FAIL: void-loop-label not separated');
    fail++;
  }
  if (!voidBody.lit || voidBody.segCount !== 1 || voidBody.unionW > voidLoopPts.body.w + 40) {
    console.log('FAIL: void-loop-body not separated');
    fail++;
  }
  if (Math.abs(voidLabel.minTop - voidBody.minTop) < 8) {
    console.log('FAIL: void-loop label/body same top');
    fail++;
  }
}

await context.close();
console.log(fail === 0 ? 'ARDUINO_PROBES_OK' : `ARDUINO_PROBES_FAIL count=${fail}`);
process.exit(fail === 0 ? 0 : 1);
