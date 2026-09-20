/**
 * offscreen.js — bộ xử lý nặng, chạy trong một DOM ẩn.
 *
 * Giai đoạn này (Phase 0) file mới chỉ làm một việc: trả lời phép thử
 * Translator API. Phase 1 sẽ thêm Tesseract worker, Phase 4 thêm hàng đợi dịch.
 *
 * Vì sao code nặng nằm ở đây chứ không ở content script:
 *   - Content script chia CPU với trang web → chạy WASM ở đó làm video giật
 *   - Content script chết theo mỗi lần điều hướng → mất hết tiến độ OCR
 *   - Offscreen document sống độc lập, đúng một bản cho cả extension
 */

import { probeTranslator } from '../dev/probe.js';

console.log('[SubForge][offscreen] đã khởi động');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Chỉ nhận message có đích danh là offscreen — service worker và content
  // script dùng chung kênh chrome.runtime, không lọc thì nhận nhầm của nhau.
  if (msg?.target !== 'offscreen') return;

  switch (msg.type) {
    case 'SF_PROBE_TRANSLATOR':
      probeTranslator(msg.langs).then(sendResponse);
      return true; // giữ kênh mở cho lời gọi bất đồng bộ

    case 'SF_PING':
      // Heartbeat: service worker gọi định kỳ để tự giữ mình không bị kill.
      sendResponse({ alive: true });
      return true;
  }
});
