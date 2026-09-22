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

import { probeTranslator } from '../dev/probe.js';
import { describeError } from '../core/errors.js';
import { TesseractEngine } from './ocr-engine.js';
import { OcrService } from './ocr-service.js';
import { TranslateService } from './translate-service.js';

console.log('[SubForge][offscreen] đã khởi động');

/** Một engine dùng chung cho cả phiên — mỗi bản là ~3,9MB WASM trong RAM. */
const engine = new TesseractEngine();
const ocr = new OcrService(engine);
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
    console.error('[SubForge][offscreen]', msg?.type, err);
    return { ok: false, error: describeError(err) };
  }
};

const HANDLERS = {
  SF_PROBE_TRANSLATOR: safe((m) => probeTranslator(m.langs)),

  SF_OCR_SELFTEST: safe((m) => runSelfTest(m.lang)),

  SF_OCR_WARM: safe((m) => ocr.warm(m.lang)),
  SF_OCR: safe((m) => ocr.recognize({ dataUrl: m.dataUrl, frameH: m.frameH, lang: m.lang })),

  SF_TRANSLATOR_STATUS: safe(async (m) => ({
    ok: true,
    availability: await translator.availability(m.from ?? 'vi', m.to ?? 'en'),
  })),
  SF_TRANSLATE: safe((m) => translator.translate(m.text, m.from ?? 'vi', m.to ?? 'en')),

  SF_OFFSCREEN_STATS: safe(async () => ({
    ok: true,
    ocr: ocr.stats,
    translate: { ...translator.stats, cached: translator.cache.size },
  })),

  // Heartbeat: service worker gọi định kỳ để tự giữ mình không bị kill.
  SF_PING: safe(async () => ({ alive: true })),
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

/** Nạp engine rồi chạy bộ ca thử tự vẽ (nút "Thử OCR" trong popup). */
async function runSelfTest(lang = 'vie') {
  const t0 = performance.now();
  await engine.init({ lang });
  const initMs = Math.round(performance.now() - t0);

  const { runOcrSelfTest } = await import('../dev/ocr-selftest.js');
  const report = await runOcrSelfTest(engine);
  return { ok: true, initMs, ...report };
}
