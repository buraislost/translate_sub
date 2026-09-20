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

/* ------------------------------------------------------------------ */
/* Phép thử 3 — video này có hardsub không                             */
/* ------------------------------------------------------------------ */

/**
 * Quét rải khắp phim để trả lời: có phụ đề cháy trên hình không?
 *
 * Vì sao cần: đo thật trên một web phim Việt cho thấy có phim KHÔNG hề có
 * hardsub (server ghi "Song Ngữ" hoá ra là chọn tiếng lồng). Khi đó Tesseract
 * vẫn chạy và vẫn trả chuỗi — nhưng là rác đọc từ nhiễu ảnh, confidence ~44%.
 * Không kiểm tra trước thì extension ngốn CPU hàng giờ để sinh phụ đề vô nghĩa.
 *
 * Có TUA video để lấy mẫu rải đều, nên bắt buộc phải khôi phục lại đúng vị trí
 * và trạng thái phát ban đầu — người dùng đang xem dở, không được cướp chỗ họ.
 */
export async function probeHardsub(video, { samples = 12, bandTop = 0.70 } = {}) {
  if (!video) return { error: 'Không có video' };
  if (!video.videoWidth) return { error: 'Video chưa có kích thước — bấm play rồi thử lại' };

  const { detectSubtitleBand, summarizeScan } = await import(
    chrome.runtime.getURL('src/core/hardsub-detect.js')
  );

  const restoreTime = video.currentTime;
  const wasPaused = video.paused;
  const duration = video.duration || 0;

  const W = video.videoWidth;
  const H = video.videoHeight;
  const y0 = Math.round(H * bandTop);
  const bandH = H - y0;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = bandH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const seek = (t) =>
    new Promise((resolve) => {
      const done = () => {
        video.removeEventListener('seeked', done);
        // Chờ thêm một nhịp: sự kiện 'seeked' bắn trước khi khung hình mới
        // thực sự được vẽ xong, vẽ ngay sẽ dính khung cũ.
        setTimeout(resolve, 260);
      };
      video.addEventListener('seeked', done);
      video.currentTime = t;
    });

  const ratios = [];
  const bands = [];

  try {
    video.pause(); // tua trong lúc đang phát cho ra khung hình nhoè

    for (let i = 0; i < samples; i++) {
      // Bỏ 5% đầu và 5% cuối: intro và credit thường không có thoại.
      const t = duration * (0.05 + (0.9 * i) / Math.max(1, samples - 1));
      await seek(t);

      ctx.drawImage(video, 0, y0, W, bandH, 0, 0, W, bandH);
      const band = detectSubtitleBand(ctx.getImageData(0, 0, W, bandH));

      ratios.push(band?.ratio ?? 0);
      if (band) bands.push(band);
    }
  } catch (err) {
    return { error: `${err.name}: ${err.message}` };
  } finally {
    video.currentTime = restoreTime;
    if (!wasPaused) video.play().catch(() => {});
  }

  const verdict = summarizeScan(ratios);

  // Gộp vị trí dải chữ từ các frame CÓ chữ, quy về tỉ lệ của cả khung hình.
  // Đây chính là vùng crop mà pipeline OCR nên dùng — đo được thì đừng đoán.
  let cropHint = null;
  if (bands.length) {
    const top = Math.min(...bands.map((b) => b.top));
    const bottom = Math.max(...bands.map((b) => b.bottom));
    cropHint = {
      topPct: +((bandTop + top * (1 - bandTop)) * 100).toFixed(1),
      bottomPct: +((bandTop + bottom * (1 - bandTop)) * 100).toFixed(1),
    };
  }

  return {
    ...verdict,
    samples: ratios.length,
    maxRatio: +verdict.maxRatio.toFixed(5),
    cropHint,
    frame: `${W}x${H}`,
  };
}
