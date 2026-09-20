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
import { TesseractEngine } from './ocr-engine.js';

console.log('[SubForge][offscreen] đã khởi động');

/**
 * Mô tả một giá trị bị ném ra, dù nó là Error, chuỗi hay Event.
 *
 * Vì sao cần: tesseract.js ném lỗi tải worker dưới dạng CHUỖI THUẦN, và code
 * cũ viết `${err.name}: ${err.message}` cho ra "undefined: undefined" —
 * mất sạch nguyên nhân thật. Đã tốn một vòng debug chỉ vì dòng đó.
 */
export function describeError(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    try {
      return err.message || err.type || JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

/** Một engine dùng chung cho cả phiên — mỗi bản là ~3,9MB WASM trong RAM. */
const engine = new TesseractEngine();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Chỉ nhận message có đích danh là offscreen — service worker và content
  // script dùng chung kênh chrome.runtime, không lọc thì nhận nhầm của nhau.
  if (msg?.target !== 'offscreen') return;

  switch (msg.type) {
    case 'SF_PROBE_TRANSLATOR':
      probeTranslator(msg.langs).then(sendResponse);
      return true; // giữ kênh mở cho lời gọi bất đồng bộ

    case 'SF_OCR_SELFTEST':
      runSelfTest(msg.lang).then(sendResponse);
      return true;

    case 'SF_PING':
      // Heartbeat: service worker gọi định kỳ để tự giữ mình không bị kill.
      sendResponse({ alive: true });
      return true;
  }
});

/**
 * Nạp engine rồi chạy bộ ca thử tự vẽ.
 *
 * Nuốt lỗi thành object thay vì để Promise reject: message trả về từ offscreen
 * bị serialize qua JSON nên Error chỉ còn lại `{}` ở đầu bên kia — không đọc
 * được gì, rất khó debug.
 */
async function runSelfTest(lang = 'vie') {
  const t0 = performance.now();
  try {
    let lastStatus = '';
    await engine.init({
      lang,
      onProgress: (m) => {
        if (m.status !== lastStatus) {
          lastStatus = m.status;
          console.log('[SubForge][ocr]', m.status);
        }
      },
    });
    const initMs = Math.round(performance.now() - t0);

    const { runOcrSelfTest } = await import('../dev/ocr-selftest.js');
    const report = await runOcrSelfTest(engine);
    return { ok: true, initMs, ...report };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}
