/**
 * ocr-service.js — nhận ảnh cắt từ khung hình, trả về văn bản phụ đề.
 *
 * Đây là "tầng nặng" của pipeline: dựng mặt nạ đầy đủ (top-hat, hạt giống trắng,
 * gom cụm...) rồi chạy Tesseract. Cố tình đặt ở offscreen document chứ không ở
 * content script: phần này tốn 50–150 ms mỗi câu, và content script dùng chung
 * luồng chính với trang phim — chạy ở đó sẽ làm giao diện trang giật.
 */

import { prepareForOcr } from '../core/preprocess.js';
import { cleanOcrText } from '../core/text-utils.js';
import { base64ToBytes, grayToRgba, rgbaToPgm } from '../core/bytes.js';
import { TesseractEngine } from './ocr-engine.js';

// Cố ý KHÔNG dùng OffscreenCanvas.convertToBlob ở file này. Offscreen document là trang
// ẩn nên Chrome bóp nhịp nó: convertToBlob mất đúng ~1000ms mỗi lần khi popup đóng —
// đo 22 lần liên tiếp 1005–1012ms, chiếm gần hết độ trễ ~1,2s của bản đầu. Mọi bước ở
// đây giờ đồng bộ (atob, dựng PGM) hoặc đi qua postMessage tới worker của Tesseract,
// vốn không bị bóp nhịp. Xem src/core/bytes.js.

export class OcrService {
  /** @param {TesseractEngine} [engine] dùng chung engine của offscreen để khỏi nạp WASM hai lần */
  constructor(engine) {
    this.engine = engine ?? new TesseractEngine();
    /** Hàng đợi tuần tự: Tesseract chỉ có một worker, gọi chồng chỉ xếp hàng ngầm. */
    this._chain = Promise.resolve();
    this.stats = { requests: 0, none: 0, invalid: 0, ok: 0, lastMs: 0 };
  }

  /** Nạp sẵn engine để câu phụ đề đầu tiên không phải chờ giải nén WASM. */
  async warm(lang = 'vie') {
    await this.engine.init({ lang });
    return { ok: true };
  }

  /**
   * @param {{luma: string, width: number, height: number, frameH?: number, lang?: string}} req
   * luma:    mặt phẳng xám (1 byte/pixel) dạng base64, cắt ở ĐỘ PHÂN GIẢI GỐC của video
   * frameH:  chiều cao khung hình gốc — để quy đổi bán kính bộ lọc theo độ phân giải
   */
  recognize(req) {
    const run = this._chain.then(() => this._run(req));
    // Một lần lỗi không được làm hỏng cả hàng đợi.
    this._chain = run.catch(() => {});
    return run;
  }

  async _run({ luma, width, height, frameH = 1080, lang = 'vie' }) {
    this.stats.requests++;
    await this.engine.init({ lang });

    const t0 = performance.now();
    const img = grayToRgba(base64ToBytes(luma), width, height);
    const prepared = prepareForOcr(img, { scale: frameH / 1080 });
    const prepMs = Math.round(performance.now() - t0);

    // Tầng nhẹ báo có chữ nhưng tầng nặng không dựng được mặt nạ → thường là nhiễu
    // tranh vẽ (vệt trắng có viền đen). Báo về để bên gọi bỏ qua thay vì OCR rác.
    if (!prepared) {
      this.stats.none++;
      return { ok: true, none: true, prepMs };
    }

    // Uint8Array đưa thẳng cho Tesseract: nó ghi nguyên byte vào FS ảo của WASM rồi để
    // Leptonica tự nhận dạng định dạng — PGM không phải đi qua FileReader hay giải nén.
    const res = await this.engine.recognize(rgbaToPgm(prepared.image));
    const clean = cleanOcrText(res.text, { confidence: res.confidence });
    this.stats.lastMs = prepMs + res.ms;
    if (clean.ok) this.stats.ok++;
    else this.stats.invalid++;

    return {
      ok: true,
      none: false,
      valid: clean.ok,
      reason: clean.reason,
      text: clean.text,
      raw: res.text,
      confidence: res.confidence,
      lines: prepared.lines.length,
      prepMs,
      ocrMs: res.ms,
    };
  }
}
