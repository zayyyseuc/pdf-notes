// ============================================================
// background.js — 后台数据管家
// ============================================================
// 负责两类数据的存取：
//   1. PDF 文件本身（base64格式，供 viewer 加载）
//   2. 用户的笔记数据
//
// 为什么要把 PDF 文件也存进来？
//   因为 popup 选择文件后会关闭，blob:// URL 随之失效。
//   解决方案：popup 把文件读成 base64 字符串，
//   存到 chrome.storage.local，viewer 再从这里取出来加载。
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── 存储 PDF 文件（base64）──────────────────────────────
  if (message.type === 'STORE_PDF_FILE') {
    // message.fileKey  = 文件的唯一key（用文件名哈希生成）
    // message.fileData = base64字符串（PDF文件内容）
    // message.fileName = 原始文件名
    const entry = {
      fileName: message.fileName,
      fileData: message.fileData,   // base64 编码的 PDF 内容
      storedAt: Date.now(),
    };
    chrome.storage.local.set({ [message.fileKey]: entry }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true });
      }
    });
    return true;
  }

  // ── 读取 PDF 文件（base64）──────────────────────────────
  if (message.type === 'GET_PDF_FILE') {
    chrome.storage.local.get(message.fileKey, (result) => {
      sendResponse({ entry: result[message.fileKey] || null });
    });
    return true;
  }

  // ── 保存笔记 ────────────────────────────────────────────
  if (message.type === 'SAVE_NOTES') {
    chrome.storage.local.set({ [message.pdfKey]: message.notes }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  // ── 读取笔记 ────────────────────────────────────────────
  if (message.type === 'LOAD_NOTES') {
    chrome.storage.local.get(message.pdfKey, (result) => {
      sendResponse({ notes: result[message.pdfKey] || [] });
    });
    return true;
  }

  // ── 获取全部数据（用于 popup 显示统计）──────────────────
  if (message.type === 'GET_ALL_DATA') {
    chrome.storage.local.get(null, (result) => {
      sendResponse({ data: result });
    });
    return true;
  }

});
