/**
 * scanner.js — lấy dải phụ đề từ thẻ <video> và quét nhẹ xem có chữ không.
 *
 * Chạy trong content script, mỗi ~250ms, nên chi phí là ràng buộc thật: đo được
 * 1,3 ms/lần quét ở nửa độ phân giải. Phần đắt (mặt nạ đầy đủ + OCR) nằm ở offscreen.
 */

import { quickScan, lumaPlane } from './preprocess.js';
import { bytesToBase64 } from './bytes.js';

/** Bề rộng ảnh quét. Ở 1080p nét chữ ~10px → ~5px ở 960 rộng, còn giữ được lõi trắng tinh. */
const SCAN_WIDTH = 960;

export class BandScanner {
  /**
   * @param {HTMLVideoElement} video
   * @param {{bandTop?: number}} opts bandTop = phần trăm chiều cao (0–1) nơi dải quét bắt đầu.
   *   Đo thật: phụ đề nằm ở 81,6%–96% chiều cao; lấy 62% để chừa dư cho phim đặt sub cao hơn.
   */
  constructor(video, { bandTop = 0.62 } = {}) {
    this.video = video;
    this.bandTop = bandTop;

    // Hai canvas không gắn vào DOM: một cho ảnh quét thu nhỏ, một cho ảnh cắt độ phân giải gốc.
    this.scanCanvas = document.createElement('canvas');
    // willReadFrequently: đọc pixel liên tục nên Chrome giữ canvas trên CPU thay vì GPU,
    // tránh mỗi lần getImageData lại phải chép ngược từ GPU về.
    this.scanCtx = this.scanCanvas.getContext('2d', { willReadFrequently: true });
    this.cropCanvas = document.createElement('canvas');
    this.cropCtx = this.cropCanvas.getContext('2d', { willReadFrequently: true });
  }

  /**
   * Quét một lần.
   * @returns {null | object} null nếu video chưa sẵn sàng. Ném SecurityError nếu canvas
   *   bị "tainted" (video cross-origin không CORS hoặc DRM) — bên gọi phải bắt và dừng.
   */
  scan() {
    const v = this.video;
    const W = v.videoWidth;
    const H = v.videoHeight;
    if (!W || !H || v.readyState < 2) return null;

    // Tính theo khung hình THẬT, không giả định 16:9: đã gặp phim 1924×1040.
    const s = Math.min(1, SCAN_WIDTH / W);
    const bandY = Math.round(H * this.bandTop);
    const bandH = H - bandY;
    const cw = Math.max(16, Math.round(W * s));
    const ch = Math.max(8, Math.round(bandH * s));

    if (this.scanCanvas.width !== cw || this.scanCanvas.height !== ch) {
      this.scanCanvas.width = cw;
      this.scanCanvas.height = ch;
    }
    this.scanCtx.drawImage(v, 0, bandY, W, bandH, 0, 0, cw, ch);
    const img = this.scanCtx.getImageData(0, 0, cw, ch); // ném SecurityError nếu tainted

    // scale quy về "độ phân giải gốc 1920 rộng"; video nhỏ hơn 960px thì bán kính tìm viền giảm.
    const q = quickScan(img, { scale: cw / 1920, reach: cw >= 900 ? 2 : 1 });

    let rect = null;
    let textTopFrac = null;
    if (q.present && q.lines?.length) {
      // Vùng cắt ở độ phân giải GỐC (chia cho s), chừa lề ~nửa dòng để khỏi cụt đầu chữ.
      const lineHFull = q.lineHeight / s;
      const pad = Math.round(lineHFull * 0.6);
      const x0 = Math.max(0, Math.round(q.x0 / s) - pad);
      const x1 = Math.min(W - 1, Math.round(q.x1 / s) + pad);
      const y0 = Math.max(bandY, bandY + Math.round(q.lines[0].top / s) - 4);
      const y1 = Math.min(H - 1, bandY + Math.round(q.lines[q.lines.length - 1].bottom / s) + 4);
      rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
      textTopFrac = y0 / H;
    }

    return { ...q, rect, frameW: W, frameH: H, textTopFrac };
  }

  /**
   * Cắt vùng chữ ở độ phân giải gốc, trả về mặt phẳng XÁM (1 byte/pixel) dạng base64.
   *
   * Bản đầu mã hoá PNG (canvas.toBlob) rồi đọc thành data URL (FileReader): đo được
   * 7–122ms, qua hai lần chờ bất đồng bộ. Bản này đồng bộ hoàn toàn, ~2–4ms:
   *   - Xám thay vì RGBA: tầng nặng chỉ đọc độ sáng. Đã kiểm trên 22 khung thật — ảnh
   *     đưa vào Tesseract giống hệt từng pixel (tests/bytes.test.mjs), nhẹ đi 4 lần.
   *   - Base64 thay vì ArrayBuffer: messaging của extension serialize bằng JSON,
   *     ArrayBuffer tới nơi thành `{}` rỗng (đã thử) — phải đi dưới dạng chuỗi.
   * Không nén nên không mất dữ liệu: lõi trắng tinh và viền đen còn nguyên.
   */
  cropLuma(rect) {
    const c = this.cropCanvas;
    if (c.width !== rect.w || c.height !== rect.h) {
      c.width = rect.w;
      c.height = rect.h;
    }
    this.cropCtx.drawImage(this.video, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    const img = this.cropCtx.getImageData(0, 0, rect.w, rect.h);
    return { luma: bytesToBase64(lumaPlane(img)), width: rect.w, height: rect.h };
  }
}
