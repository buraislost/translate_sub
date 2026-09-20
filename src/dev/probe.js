/**
 * probe.js — hai phép thử chặn cửa, chạy TRƯỚC khi viết pipeline OCR.
 *
 * Vì sao phải có file này: toàn bộ hướng đi của project đặt cược vào hai giả
 * định chưa được kiểm chứng. Nếu một trong hai sai, ta phải đổi kiến trúc —
 * và cần biết điều đó bây giờ, không phải sau khi đã viết xong pipeline.
 *
 *   1. Đọc được pixel của video?   → canvas có bị tainted không
 *   2. Dịch được ngay trong máy?   → Translator API của Chrome có dùng được không
 *
 * File này chỉ dùng lúc phát triển, không nằm trong luồng chạy chính.
 */

/* ------------------------------------------------------------------ */
/* Phép thử 1 — canvas tainted                                         */
/* ------------------------------------------------------------------ */

/**
 * Thử đọc pixel từ thẻ video.
 *
 * Trình duyệt đánh dấu canvas là "tainted" (nhiễm bẩn) khi ta vẽ lên đó một
 * nguồn cross-origin không cho phép đọc lại. Mọi lời gọi getImageData sau đó
 * ném SecurityError. Đây là rào chắn cứng của trình duyệt, không có cách lách.
 *
 * Ba nhóm kết quả:
 *   - blob: URL (HLS/MSE) → thường KHÔNG tainted → OCR chạy được
 *   - <video src> cross-origin thiếu CORS header → tainted → phải dùng tabCapture
 *   - DRM/EME (Netflix, Disney+) → tainted vĩnh viễn → OCR bất khả thi
 */
export function probeTaint(video) {
  const result = {
    ok: false,
    error: null,
    srcKind: null,
    hasDrm: false,
    videoSize: null,
    readyState: video?.readyState ?? null,
    crossOrigin: video?.crossOrigin ?? null,
    nonBlackPixelRatio: null,
  };

  if (!video) {
    result.error = 'Không tìm thấy thẻ <video> trên trang';
    return result;
  }

  result.srcKind = classifySource(video);
  result.hasDrm = Boolean(video.mediaKeys);
  result.videoSize = { width: video.videoWidth, height: video.videoHeight };

  // readyState < 2 nghĩa là chưa có frame nào để vẽ — kết quả sẽ vô nghĩa.
  if (video.readyState < 2) {
    result.error = 'Video chưa tải đủ dữ liệu (readyState < 2) — hãy bấm play rồi thử lại';
    return result;
  }

  try {
    // Chỉ lấy một dải nhỏ ở đáy khung hình: đó là nơi hardsub nằm, và nếu
    // đọc được dải này thì đọc được cả khung.
    const w = Math.min(video.videoWidth, 640);
    const h = Math.max(1, Math.round(w * 0.12));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const srcY = Math.round(video.videoHeight * 0.85);
    const srcH = Math.round(video.videoHeight * 0.12);
    ctx.drawImage(video, 0, srcY, video.videoWidth, srcH, 0, 0, w, h);

    const data = ctx.getImageData(0, 0, w, h).data; // ← ném SecurityError nếu tainted

    // Canvas tainted không phải lỗi duy nhất: với một số player có DRM, lệnh
    // trên chạy lọt nhưng trả về toàn pixel đen. Phải kiểm tra thêm nội dung.
    let nonBlack = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) nonBlack++;
    }
    result.nonBlackPixelRatio = +(nonBlack / (data.length / 4)).toFixed(4);

    if (result.nonBlackPixelRatio < 0.001) {
      result.error = 'Đọc được pixel nhưng toàn màu đen — dấu hiệu player chặn ở tầng sâu hơn';
      return result;
    }

    result.ok = true;
    return result;
  } catch (err) {
    result.error = `${err.name}: ${err.message}`;
    return result;
  }
}

/** Phân loại nguồn video — quyết định khả năng đọc pixel. */
function classifySource(video) {
  const src = video.currentSrc || video.src || '';
  if (src.startsWith('blob:')) return 'blob (MSE/HLS)';
  if (src.startsWith('data:')) return 'data URI';
  if (!src) return 'không có src (có thể dùng srcObject)';

  try {
    const origin = new URL(src, location.href).origin;
    return origin === location.origin ? 'same-origin' : `cross-origin (${origin})`;
  } catch {
    return 'src không phân tích được';
  }
}

/* ------------------------------------------------------------------ */
/* Phép thử 2 — Translator API                                         */
/* ------------------------------------------------------------------ */

/**
 * Kiểm tra Chrome Translator API — dịch on-device, không API key, không gửi
 * dữ liệu ra ngoài. Có từ Chrome 138.
 *
 * Vì sao phải thử ở NHIỀU context: API này không chạy trong Web Worker, và
 * tài liệu chỉ nói rõ về "top-level window". Offscreen document và service
 * worker là vùng xám — phải đo thực tế mới biết đặt phần dịch ở đâu.
 *
 * Nếu cả ba context đều không dùng được thì phương án thay thế là nhét
 * transformers.js + Xenova/opus-mt-vi-en (~75MB) vào vendor/.
 */
export async function probeTranslator({ sourceLanguage = 'vi', targetLanguage = 'en' } = {}) {
  const result = {
    context: detectContext(),
    api: null,
    availability: null,
    sample: null,
    error: null,
    chromeVersion: navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? null,
  };

  // Ba thế hệ API đã từng tồn tại — dò lần lượt để không phụ thuộc bản Chrome.
  const hasModern = typeof globalThis.Translator?.availability === 'function';
  const hasLegacy = typeof globalThis.translation?.createTranslator === 'function';
  const hasVeryOld = typeof globalThis.ai?.translator !== 'undefined';

  result.api = hasModern
    ? 'Translator (Chrome 138+)'
    : hasLegacy
      ? 'self.translation (bản cũ)'
      : hasVeryOld
        ? 'window.ai.translator (bản rất cũ)'
        : null;

  if (!result.api) {
    result.error = 'Không tìm thấy Translator API ở context này';
    return result;
  }

  try {
    if (hasModern) {
      result.availability = await globalThis.Translator.availability({
        sourceLanguage,
        targetLanguage,
      });

      // 'downloadable' nghĩa là dùng được nhưng Chrome phải tải model trước.
      // Không tự tải ở bước thăm dò — đó là quyết định của người dùng.
      if (result.availability === 'available') {
        const translator = await globalThis.Translator.create({ sourceLanguage, targetLanguage });
        // Câu thử cố tình nhồi dấu chồng (ế ề ể ễ ệ) — đúng chỗ Tesseract hay
        // sai nhất, nên nó vừa thử được API vừa làm mẫu đối chiếu về sau.
        result.sample = await translator.translate('Chiều nay trời đẹp, chúng ta về nhà nghỉ một chút nhé!');
        translator.destroy?.();
      }
    } else {
      result.availability = 'API cũ — cần thử tay';
    }
  } catch (err) {
    result.error = `${err.name}: ${err.message}`;
  }

  return result;
}

/** Đoán xem code đang chạy ở context nào — để đọc báo cáo cho dễ. */
function detectContext() {
  if (typeof document === 'undefined') return 'service worker';
  if (location.protocol === 'chrome-extension:') {
    return location.pathname.includes('offscreen') ? 'offscreen document' : 'trang extension';
  }
  return 'content script';
}
