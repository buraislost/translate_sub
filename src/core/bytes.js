/**
 * bytes.js — chuyển ảnh giữa các phần của extension với chi phí thấp nhất.
 *
 * Hai ràng buộc thật đã đo được, định hình toàn bộ file này:
 *
 *   1. chrome.runtime.sendMessage serialize bằng JSON (đã thử trên Chrome 153):
 *      ArrayBuffer tới nơi thành `{}` rỗng, Uint8Array thành object {"0":7,"1":8,…}.
 *      → Byte phải đi dưới dạng CHUỖI. Base64 qua btoa/atob là cách rẻ nhất.
 *
 *   2. Offscreen document là trang ẩn, Chrome bóp nhịp nó: OffscreenCanvas.convertToBlob
 *      mất ĐÚNG ~1000ms mỗi lần khi không có trang nào của extension đang hiện (đo 22
 *      lần liên tiếp: 1005–1012ms). Đó là gần như toàn bộ độ trễ ~1,2s của bản đầu.
 *      → Không mã hoá ảnh bằng canvas ở offscreen. Tự dựng PGM bằng JS: đồng bộ, không
 *        thể bị bóp nhịp, và Leptonica (bộ đọc ảnh trong Tesseract) đọc thẳng được.
 *
 * Toàn hàm thuần, chạy được cả trong Node lẫn browser (btoa/atob có sẵn ở cả hai).
 */

/**
 * String.fromCharCode(...arr) với mảng lớn sẽ tràn stack ("Maximum call stack size
 * exceeded") — một dải phụ đề 1200×200 là 240.000 byte. Cắt thành từng khúc.
 */
const CHUNK = 0x8000;

/** @param {Uint8Array} bytes */
export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** @returns {Uint8Array} */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Mặt phẳng xám 1 byte/pixel → ảnh RGBA với R = G = B = độ xám.
 *
 * Tầng nặng chỉ cần độ sáng (textMask chỉ đọc lumaPlane), nên content script gửi 1 byte
 * thay vì 4 byte mỗi pixel — nhẹ đi 4 lần. Dựng lại RGBA ở đây để preprocess.js không
 * phải biết gì về cách truyền. Không mất thông tin: luma của (Y,Y,Y) đúng bằng Y, vì hệ
 * số Rec.601 dạng số nguyên cộng lại đúng 256 (77 + 150 + 29).
 */
export function grayToRgba(gray, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
    data[o] = data[o + 1] = data[o + 2] = gray[i];
    data[o + 3] = 255;
  }
  return { data, width, height };
}

/**
 * Ảnh RGBA → PGM nhị phân (P5): một dòng header văn bản rồi tới byte xám thô.
 *
 * Không nén gì cả nên dựng mất 1–2ms, và Leptonica đọc được mà không phải qua bước giải
 * nén PNG — Tesseract đọc nhanh hơn ~30% (đo: 23–38ms so với 43–64ms với PNG, cùng chữ,
 * cùng độ tin cậy trên khung hình thật).
 */
export function rgbaToPgm({ data, width, height }) {
  const head = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const out = new Uint8Array(head.length + width * height);
  out.set(head, 0);
  for (let i = 0, p = head.length, o = 0; i < width * height; i++, p++, o += 4) {
    out[p] = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8;
  }
  return out;
}
