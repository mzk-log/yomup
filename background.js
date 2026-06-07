// Content Script for Chrome Extension 読むプ
// Copyright (c) 2025 [MZK]
// All rights reserved.
// このソフトウェアおよび関連文書ファイル（以下「ソフトウェア」）の複製、
// 使用、改変、配布を禁止します。


// 共通定数ファイルの読み込み
importScripts('constants.js');

/** @type {Map<string, { bytes: number[], url: string }>} */
const pdfFileCache = new Map();

function isPdfUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /\.pdf(\?|#|$)/i.test(url);
}

function isKnownPdfViewerExtensionId(extensionId) {
  return BUILTIN_PDF_VIEWER_IDS.includes(extensionId);
}

function decodeUriComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch (_e) {
    return value;
  }
}

function extractPdfUrlFromViewerQueryString(queryString) {
  if (!queryString) return null;
  const normalized = queryString.startsWith('?') ? queryString.slice(1) : queryString;
  if (!normalized) return null;

  try {
    const params = new URLSearchParams(normalized);
    for (const key of ['file', 'src', 'url']) {
      const val = params.get(key);
      if (!val) continue;
      const decoded = decodeUriComponentSafe(val);
      if (isPdfUrl(decoded) || decoded.startsWith('http://') || decoded.startsWith('https://') || decoded.startsWith('file://')) {
        return decoded;
      }
    }
  } catch (_e) {
    return null;
  }
  return null;
}

function extractUrlFromBuiltinPdfViewerTab(tabUrl) {
  // Chrome: chrome-extension://ID/https://...pdf
  // Edge:   extension://ID/https://...pdf （同一 ID）
  const match = tabUrl.match(/^(?:chrome-extension|extension):\/\/([^/]+)\/(.+)$/i);
  if (!match) return null;

  const extensionId = match[1];
  if (!isKnownPdfViewerExtensionId(extensionId)) return null;

  let remainder = decodeUriComponentSafe(match[2]);

  const queryIndex = remainder.indexOf('?');
  if (queryIndex >= 0) {
    const fromQuery = extractPdfUrlFromViewerQueryString(remainder.slice(queryIndex));
    if (fromQuery) return fromQuery;
    remainder = remainder.slice(0, queryIndex);
  }

  if (isPdfUrl(remainder)) return remainder;
  if (/^https?:\/\//i.test(remainder) || remainder.startsWith('file://')) return remainder;
  return null;
}

function resolvePdfSourceFromContext(info, tab) {
  const candidates = [
    info?.pageUrl,
    info?.frameUrl,
    tab?.url,
    info?.linkUrl,
    info?.srcUrl
  ];
  for (const url of candidates) {
    const resolved = resolvePdfSourceUrl(url || '');
    if (resolved) return resolved;
  }
  return null;
}

function isYomupPdfViewerTabUrl(tabUrl) {
  if (!tabUrl || typeof tabUrl !== 'string') return false;
  return tabUrl.startsWith(chrome.runtime.getURL('pdf/'));
}

function resolvePdfSourceUrl(tabUrl) {
  if (!tabUrl || typeof tabUrl !== 'string') return null;
  if (isYomupPdfViewerTabUrl(tabUrl)) return null;

  const fromViewer = extractUrlFromBuiltinPdfViewerTab(tabUrl);
  if (fromViewer) return fromViewer;

  if (isPdfUrl(tabUrl)) return tabUrl;
  return null;
}

function arrayBufferToByteArray(buffer) {
  return Array.from(new Uint8Array(buffer));
}

function isFilePdfUrl(url) {
  return typeof url === 'string' && url.startsWith('file://') && isPdfUrl(url);
}

function fileFetchErrorMessage(cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return (
    'ローカル PDF を読めませんでした。' +
    ' chrome://extensions で読むプの「ファイルの URL へのアクセスを許可」をオンにし、' +
    ' PDF タブで拡張アイコンをもう一度押してください。' +
    (detail ? `（${detail}）` : '')
  );
}

async function fetchPdfArrayBuffer(pdfSourceUrl) {
  let response;
  try {
    response = await fetch(pdfSourceUrl);
  } catch (error) {
    if (isFilePdfUrl(pdfSourceUrl)) {
      throw new Error(fileFetchErrorMessage(error));
    }
    throw error;
  }
  if (!response.ok) {
    const err = new Error(`PDF の取得に失敗しました (${response.status})`);
    if (isFilePdfUrl(pdfSourceUrl)) {
      throw new Error(fileFetchErrorMessage(err));
    }
    throw err;
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType && !contentType.includes('pdf') && !isPdfUrl(pdfSourceUrl)) {
    throw new Error('PDF ではない応答でした');
  }
  return response.arrayBuffer();
}

async function prefetchFilePdfToCache(pdfSourceUrl) {
  const buffer = await fetchPdfArrayBuffer(pdfSourceUrl);
  const id = crypto.randomUUID();
  pdfFileCache.set(id, { bytes: arrayBufferToByteArray(buffer), url: pdfSourceUrl });
  return id;
}

async function openPdfViewer(tabId, pdfSourceUrl) {
  let viewerUrl;
  if (isFilePdfUrl(pdfSourceUrl)) {
    try {
      const cacheId = await prefetchFilePdfToCache(pdfSourceUrl);
      viewerUrl = chrome.runtime.getURL(
        `pdf/viewer.html?fid=${encodeURIComponent(cacheId)}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      viewerUrl = chrome.runtime.getURL(
        `pdf/viewer.html?error=${encodeURIComponent(message)}`
      );
    }
  } else {
    viewerUrl = chrome.runtime.getURL(
      `pdf/viewer.html?src=${encodeURIComponent(pdfSourceUrl)}`
    );
  }
  await chrome.tabs.update(tabId, { url: viewerUrl });
}

async function openPdfViewerInNewTab(pdfSourceUrl) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  await openPdfViewer(tab.id, pdfSourceUrl);
}

function isLikelyBuiltinPdfViewerTab(tabUrl) {
  if (!tabUrl || typeof tabUrl !== 'string') return false;
  return BUILTIN_PDF_VIEWER_IDS.some((id) =>
    tabUrl.startsWith(`chrome-extension://${id}/`) ||
    tabUrl.startsWith(`extension://${id}/`) ||
    tabUrl === `chrome-extension://${id}/`
  );
}

function isPdfTabUrl(tabUrl) {
  return !!resolvePdfSourceUrl(tabUrl || '') || isLikelyBuiltinPdfViewerTab(tabUrl || '');
}

async function resolveTabForContextClick(tab) {
  if (tab?.id != null && tab.id >= 0) return tab;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return activeTab || tab;
  } catch (_e) {
    return tab;
  }
}

async function syncPdfPageMenuForTab(tabId) {
  if (tabId == null || tabId < 0) return;
  let visible = false;
  try {
    const tab = await chrome.tabs.get(tabId);
    visible = isPdfTabUrl(tab.url || '');
  } catch (_e) {
    return;
  }
  try {
    await chrome.contextMenus.update(PDF_PAGE_MENU.id, { visible });
  } catch (_e) {
    // メニュー未登録時は無視
  }
}

async function syncPdfPageMenuForActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) await syncPdfPageMenuForTab(tab.id);
  } catch (_e) {
    // ignore
  }
}

function registerContextMenus() {
  chrome.contextMenus.removeAll(() => {
    MENU_CONFIG.forEach(menuItem => {
      chrome.contextMenus.create({
        id: menuItem.id,
        title: menuItem.title,
        contexts: ['page', 'selection']
      });
    });

    chrome.contextMenus.create({
      id: PDF_LINK_MENU.id,
      title: PDF_LINK_MENU.title,
      contexts: ['link'],
      targetUrlPatterns: ['*://*/*', 'file:///*']
    });

    // PDF タブ用（深いパス *.pdf は isPdfTabUrl で判定。iframe 対策で all）
    chrome.contextMenus.create({
      id: PDF_PAGE_MENU.id,
      title: PDF_PAGE_MENU.title,
      contexts: ['all'],
      visible: false
    }, () => {
      syncPdfPageMenuForActiveTab();
    });
  });
}

// 拡張機能がインストールされた時の処理
chrome.runtime.onInstalled.addListener(registerContextMenus);

chrome.runtime.onStartup.addListener(() => {
  syncPdfPageMenuForActiveTab();
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  syncPdfPageMenuForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    syncPdfPageMenuForTab(tabId);
  }
});

// Content Scriptを動的に注入する関数
async function injectContentScript(tabId) {
  try {
    const isConstantsInjected = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        return typeof window !== 'undefined' && typeof window.MAX_TEXT_LENGTH_FOR_HIGHLIGHT !== 'undefined';
      }
    }).then(results => {
      return results && results[0] && results[0].result === true;
    }).catch(() => false);

    if (!isConstantsInjected) {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['constants.js']
      });
    }

    const isContentInjected = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        return typeof window !== 'undefined' && typeof window.YOMUP_CONTENT_SCRIPT_LOADED !== 'undefined';
      }
    }).then(results => {
      return results && results[0] && results[0].result === true;
    }).catch(() => false);

    if (!isContentInjected) {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
      });
    }
  } catch (error) {
    debugError('Content Scriptの注入に失敗しました:', error);
    throw error;
  }
}

async function executeYomuPOnTab(tabId) {
  await injectContentScript(tabId);
  await new Promise(resolve => setTimeout(resolve, 100));
  chrome.tabs.sendMessage(tabId, { action: 'executeYomuP' })
    .catch(error => {
      debugError('メッセージ送信に失敗しました:', error);
    });
}

// 右クリックメニューがクリックされた時の処理
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === PDF_PAGE_MENU.id) {
    const resolvedTab = await resolveTabForContextClick(tab);
    if (!resolvedTab?.id || resolvedTab.id < 0) return;
    const pdfSourceUrl = resolvePdfSourceFromContext(info, resolvedTab);
    if (!pdfSourceUrl) return;
    try {
      await openPdfViewer(resolvedTab.id, pdfSourceUrl);
    } catch (error) {
      debugError('PDFページメニュー処理中にエラーが発生しました:', error);
    }
    return;
  }

  if (info.menuItemId === PDF_LINK_MENU.id) {
    const linkUrl = info.linkUrl;
    if (!linkUrl || !isPdfUrl(linkUrl)) return;
    try {
      const targetTabId = tab?.id;
      if (targetTabId) {
        await openPdfViewer(targetTabId, linkUrl);
      } else {
        await openPdfViewerInNewTab(linkUrl);
      }
    } catch (error) {
      debugError('PDFリンクメニュー処理中にエラーが発生しました:', error);
    }
    return;
  }

  const selectedMenu = MENU_CONFIG.find(menuItem => menuItem.id === info.menuItemId);
  if (!selectedMenu || !tab?.id) return;

  try {
    await executeYomuPOnTab(tab.id);
  } catch (error) {
    debugError('右クリックメニュー処理中にエラーが発生しました:', error);
  }
});

// 拡張機能アイコンがクリックされた時の処理
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  const pdfSourceUrl = resolvePdfSourceUrl(tab.url || '');
  if (pdfSourceUrl) {
    try {
      await openPdfViewer(tab.id, pdfSourceUrl);
    } catch (error) {
      debugError('PDFビューア起動中にエラーが発生しました:', error);
    }
    return;
  }

  try {
    await executeYomuPOnTab(tab.id);
  } catch (error) {
    debugError('拡張機能アイコンクリック処理中にエラーが発生しました:', error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'fetchPdf') {
    (async () => {
      const url = message.url;
      if (!url || !isPdfUrl(url)) {
        sendResponse({ error: 'PDF URL が不正です。' });
        return;
      }
      try {
        const buffer = await fetchPdfArrayBuffer(url);
        sendResponse({ bytes: arrayBufferToByteArray(buffer), url });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sendResponse({ error: msg });
      }
    })();
    return true;
  }
  if (message?.action === 'getFilePdfCache') {
    const entry = pdfFileCache.get(message.id);
    if (!entry) {
      sendResponse({
        error: 'ローカル PDF データが見つかりません。PDF タブで拡張アイコンから開き直してください。'
      });
      return false;
    }
    pdfFileCache.delete(message.id);
    sendResponse({ bytes: entry.bytes, url: entry.url });
    return false;
  }
  return false;
});

// === デバッグログ出力用のラッパー関数 =========================================
function debugError(...args) {
  if (typeof ENABLE_DEBUG_LOG !== 'undefined' && ENABLE_DEBUG_LOG) {
    console.error(...args);
  }
}
