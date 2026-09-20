/**
 * sw.js — service worker.
 *
 * Sprint 1 gần như không cần service worker: toàn bộ việc nặng nằm ở content
 * script. File này giữ chỗ và xử lý việc dọn dẹp storage.
 *
 * Từ Sprint 2 trở đi, đây sẽ là nơi:
 *   - gọi chrome.tabCapture.getMediaStreamId()
 *   - tạo và quản lý offscreen document
 *   - giữ service worker sống bằng heartbeat trong lúc ASR/OCR đang chạy
 *     (MV3 kill service worker sau ~30 giây idle)
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log('[SubForge] đã cài đặt');
});

/** Dọn session cũ khi vượt quá 20 site, tránh phình storage.local. */
async function pruneSessions() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('session:'));
  if (keys.length <= 20) return;
  await chrome.storage.local.remove(keys.slice(0, keys.length - 20));
}

chrome.runtime.onStartup.addListener(pruneSessions);
