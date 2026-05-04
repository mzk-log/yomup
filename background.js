// Content Script for Chrome Extension 読むプ
// Copyright (c) 2025 [MZK]
// All rights reserved.
// このソフトウェアおよび関連文書ファイル（以下「ソフトウェア」）の複製、
// 使用、改変、配布を禁止します。


// 共通定数ファイルの読み込み
importScripts('constants.js');

// 拡張機能がインストールされた時の処理
chrome.runtime.onInstalled.addListener(() => {
  // MENU_CONFIG配列から右クリックメニューを動的に作成
  MENU_CONFIG.forEach(menuItem => {
    chrome.contextMenus.create({
      id: menuItem.id,
      title: menuItem.title,
      contexts: ["page", "selection"]  // すべてのコンテキストで表示
    });
  });
});

// Content Scriptを動的に注入する関数
async function injectContentScript(tabId) {
  try {
    // 既にconstants.jsが注入されているかチェック
    const isConstantsInjected = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        return typeof window !== 'undefined' && typeof window.MAX_TEXT_LENGTH_FOR_HIGHLIGHT !== 'undefined';
      }
    }).then(results => {
      return results && results[0] && results[0].result === true;
    }).catch(() => false);

    // constants.jsが未注入の場合のみ注入
    if (!isConstantsInjected) {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['constants.js']
      });
    }

    // content.jsが既に注入されているかチェック
    const isContentInjected = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        return typeof window !== 'undefined' && typeof window.YOMUP_CONTENT_SCRIPT_LOADED !== 'undefined';
      }
    }).then(results => {
      return results && results[0] && results[0].result === true;
    }).catch(() => false);

    // content.jsが未注入の場合のみ注入
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


// 右クリックメニューがクリックされた時の処理
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // MENU_CONFIG配列から該当するメニュー項目を検索
  const selectedMenu = MENU_CONFIG.find(menuItem => menuItem.id === info.menuItemId);

  if (selectedMenu) {
    try {
      // Content Scriptを動的に注入
      await injectContentScript(tab.id);

      // 少し待ってからメッセージを送信（Content Scriptの初期化を待つ）
      await new Promise(resolve => setTimeout(resolve, 100));

      // Content Scriptにメッセージを送信してトグル機能を実行
      chrome.tabs.sendMessage(tab.id, { action: 'executeYomuP' })
        .catch(error => {
          debugError('メッセージ送信に失敗しました:', error);
        });
    } catch (error) {
      debugError('右クリックメニュー処理中にエラーが発生しました:', error);
    }
  }
});


// 拡張機能アイコンがクリックされた時の処理
chrome.action.onClicked.addListener(async (tab) => {
  try {
    // Content Scriptを動的に注入
    await injectContentScript(tab.id);

    // 少し待ってからメッセージを送信（Content Scriptの初期化を待つ）
    await new Promise(resolve => setTimeout(resolve, 100));

    // Content Scriptにメッセージを送信
    chrome.tabs.sendMessage(tab.id, { action: 'executeYomuP' })
      .catch(error => {
        debugError('メッセージ送信に失敗しました:', error);
      });
  } catch (error) {
    debugError('拡張機能アイコンクリック処理中にエラーが発生しました:', error);
  }
});


// === デバッグログ出力用のラッパー関数 =========================================
function debugError(...args) {
  if (typeof ENABLE_DEBUG_LOG !== 'undefined' && ENABLE_DEBUG_LOG) {
    console.error(...args);
  }
}
