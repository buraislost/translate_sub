/**
 * sw.js — service worker.
 *
 * Service worker của MV3 KHÔNG có DOM và bị Chrome kill sau ~30 giây không hoạt động,
 * nên nó cố tình làm rất ít:
 *
 *   - Dựng offscreen document khi được nhờ — createDocument là API chỉ service worker
 *     gọi được. Mọi việc nặng (OCR, dịch) chạy ở offscreen, và content script nói
 *     chuyện THẲNG với offscreen, không đi vòng qua đây.
 *   - Dọn session cũ trong storage.
 *
 * Không giữ state quan trọng nào: bị kill lúc nào cũng được, lần gọi sau tự dựng lại.
 */

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/**
 * Đảm bảo có đúng một offscreen document đang sống.
 *
 * Chrome chỉ cho phép MỘT offscreen document tại một thời điểm, và gọi createDocument
 * lần hai sẽ ném lỗi — nên phải hỏi getContexts trước. Promise dùng chung chặn race:
 * hai message cùng đến lúc offscreen chưa có sẽ cùng gọi createDocument.
 */
let creating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existing.length > 0) return;

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        // DOM_SCRAPING mô tả đúng việc ta làm: đọc và xử lý nội dung hình ảnh.
        reasons: ['DOM_SCRAPING'],
        justification:
          'Chạy OCR (Tesseract WASM) và dịch on-device — cả hai đều cần DOM, ' +
          'thứ mà service worker không có.',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Message có target khác là dành cho offscreen — không đụng vào.
  if (msg?.target !== 'sw') return;

  if (msg.type === 'SF_ENSURE_OFFSCREEN') {
    ensureOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }
});

/** Dọn session cũ khi vượt quá 20 site, tránh phình storage.local. */
async function pruneSessions() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('session:'));
  if (keys.length <= 20) return;
  await chrome.storage.local.remove(keys.slice(0, keys.length - 20));
}

chrome.runtime.onStartup.addListener(pruneSessions);
