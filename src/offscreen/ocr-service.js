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
import { TesseractEngine } from './ocr-engine.js';

/** Giải mã data URL base64 thành Blob mà không cần fetch(). */
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/png';
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function imageToBlob(img) {
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas
    .getContext('2d')
    .putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

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
   * @param {{dataUrl: string, frameH?: number, lang?: string}} req
   * dataUrl: ảnh PNG cắt ở ĐỘ PHÂN GIẢI GỐC của video (không thu nhỏ)
   * frameH:  chiều cao khung hình gốc — để quy đổi bán kính bộ lọc theo độ phân giải
   */
  recognize(req) {
    const run = this._chain.then(() => this._run(req));
    // Một lần lỗi không được làm hỏng cả hàng đợi.
    this._chain = run.catch(() => {});
    return run;
  }

  async _run({ dataUrl, frameH = 1080, lang = 'vie' }) {
    this.stats.requests++;
    await this.engine.init({ lang });

    const t0 = performance.now();
    const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const prepared = prepareForOcr(img, { scale: frameH / 1080 });
    const prepMs = Math.round(performance.now() - t0);

    // Tầng nhẹ báo có chữ nhưng tầng nặng không dựng được mặt nạ → thường là nhiễu
    // tranh vẽ (vệt trắng có viền đen). Báo về để bên gọi bỏ qua thay vì OCR rác.
    if (!prepared) {
      this.stats.none++;
      return { ok: true, none: true, prepMs };
    }

    const res = await this.engine.recognize(await imageToBlob(prepared.image));
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
