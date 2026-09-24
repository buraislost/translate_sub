/**
 * offscreen.js — bộ xử lý nặng, chạy trong một DOM ẩn.
 *
 * Vì sao code nặng nằm ở đây chứ không ở content script:
 *   - Content script chia CPU với trang web → chạy WASM ở đó làm video giật
 *   - Content script chết theo mỗi lần điều hướng → mất hết tiến độ OCR
 *   - Translator API không chạy được trong Web Worker → cần một document
 *   - Offscreen document sống độc lập, đúng một bản cho cả extension
 *
 * Content script nói chuyện THẲNG với file này (không qua service worker): service
 * worker MV3 bị kill sau ~30s rảnh, còn offscreen document thì không.
 */

import { describeError } from '../core/errors.js';
import { TesseractEngine } from './ocr-engine.js';
import { OcrService } from './ocr-service.js';
import { TranslateService } from './translate-service.js';

/** Một engine dùng chung cho cả phiên — mỗi bản là ~3,9MB WASM trong RAM. */
const ocr = new OcrService(new TesseractEngine());
const translator = new TranslateService();

/**
 * Bọc mọi handler bất đồng bộ: lỗi thành object {ok:false,error} thay vì để Promise
 * reject. Message trả về từ offscreen bị serialize nên Error chỉ còn `{}` ở đầu bên
 * kia — không đọc được gì, rất khó debug.
 */
const safe = (fn) => async (msg) => {
  try {
    return await fn(msg);
  } catch (err) {
    console.error('[TranslateSub][offscreen]', msg?.type, err);
    return { ok: false, error: describeError(err) };
  }
};

const HANDLERS = {
  SF_OCR_WARM: safe((m) => ocr.warm(m.lang)),
  SF_OCR: safe((m) =>
    ocr.recognize({ luma: m.luma, width: m.width, height: m.height, frameH: m.frameH, lang: m.lang })
  ),
  SF_TRANSLATE: safe((m) => translator.translate(m.text, m.from ?? 'vi', m.to ?? 'en')),
  SF_TRANSLATE_WARM: safe((m) => translator.warm(m.from ?? 'vi', m.to ?? 'en')),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Chỉ nhận message có đích danh là offscreen — service worker, content script và popup
  // dùng chung kênh chrome.runtime, không lọc thì nhận nhầm của nhau.
  if (msg?.target !== 'offscreen') return;

  const handler = HANDLERS[msg.type];
  if (!handler) return;

  handler(msg).then(sendResponse);
  return true; // giữ kênh mở cho lời gọi bất đồng bộ
});
