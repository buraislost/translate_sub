/**
 * sw.js — service worker: bộ điều phối trung tâm.
 *
 * Service worker của MV3 KHÔNG có DOM và bị Chrome kill sau ~30 giây không
 * hoạt động. Hai đặc điểm đó định hình toàn bộ vai trò của file này:
 *
 *   - Việc nặng (OCR, dịch) → đẩy sang offscreen document
 *   - Việc của nó → tạo/giữ offscreen, chuyển tiếp message, đập heartbeat
 *
 * Nó cố tình KHÔNG giữ state quan trọng nào: bị kill lúc nào cũng được,
 * lần gọi sau sẽ tự khởi động lại và dựng lại offscreen nếu cần.
 */

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

chrome.runtime.onInstalled.addListener(() => {
  console.log('[SubForge] đã cài đặt');
});

/* ------------------------------------------------------------------ */
/* Offscreen document                                                  */
/* ------------------------------------------------------------------ */

/**
 * Đảm bảo có đúng một offscreen document đang sống.
 *
 * Chrome chỉ cho phép MỘT offscreen document tại một thời điểm, và gọi
 * createDocument lần hai sẽ ném lỗi. Nên bắt buộc phải hỏi getContexts trước.
 *
 * Việc gom vào một Promise dùng chung là để chặn race: nếu hai message cùng
 * đến lúc offscreen chưa tồn tại, cả hai sẽ cùng gọi createDocument và cái
 * thứ hai ném lỗi.
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
        // DOM_SCRAPING mô tả đúng nhất việc ta làm: đọc và xử lý nội dung
        // ảnh/DOM. Sang Phase 2 khi lấy audio sẽ bổ sung USER_MEDIA.
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

/** Gửi message tới offscreen, tự dựng offscreen nếu chưa có. */
async function sendToOffscreen(message) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
}

/* ------------------------------------------------------------------ */
/* Heartbeat                                                           */
/* ------------------------------------------------------------------ */

/**
 * Giữ service worker sống trong lúc có tác vụ dài đang chạy.
 *
 * Chrome reset đồng hồ 30 giây mỗi khi service worker xử lý một sự kiện.
 * Tự gửi message cho chính mình mỗi 20 giây là cách rẻ nhất để giữ nhịp đó.
 * Chỉ bật khi thực sự có việc — bật thường trực là ngốn pin vô ích.
 */
let heartbeatTimer = null;

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    sendToOffscreen({ type: 'SF_PING' }).catch(() => {
      // Offscreen đã đóng — không còn gì để giữ nhịp nữa.
      stopHeartbeat();
    });
  }, 20_000);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/* ------------------------------------------------------------------ */
/* Message                                                             */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Message có target là dành cho offscreen, service worker không đụng vào.
  if (msg?.target && msg.target !== 'sw') return;

  switch (msg.type) {
    // Phép thử Translator API — chạy ngay trong context service worker.
    case 'SF_PROBE_TRANSLATOR_SW':
      import('./dev/probe.js')
        .then((m) => m.probeTranslator(msg.langs))
        .then(sendResponse)
        .catch((err) => sendResponse({ context: 'service worker', error: String(err) }));
      return true;

    // Phép thử Translator API — chuyển tiếp xuống offscreen document.
    case 'SF_PROBE_TRANSLATOR_OFFSCREEN':
      sendToOffscreen({ type: 'SF_PROBE_TRANSLATOR', langs: msg.langs })
        .then(sendResponse)
        .catch((err) => sendResponse({ context: 'offscreen document', error: String(err) }));
      return true;

    case 'SF_START_HEARTBEAT':
      startHeartbeat();
      sendResponse({ ok: true });
      return true;

    case 'SF_STOP_HEARTBEAT':
      stopHeartbeat();
      sendResponse({ ok: true });
      return true;
  }
});

/* ------------------------------------------------------------------ */
/* Dọn dẹp                                                             */
/* ------------------------------------------------------------------ */

/** Dọn session cũ khi vượt quá 20 site, tránh phình storage.local. */
async function pruneSessions() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('session:'));
  if (keys.length <= 20) return;
  await chrome.storage.local.remove(keys.slice(0, keys.length - 20));
}

chrome.runtime.onStartup.addListener(pruneSessions);
