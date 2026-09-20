/**
 * text-metrics.js — đo sai số giữa chuỗi đọc được và chuỗi đúng.
 *
 * Dùng ở hai nơi rất khác nhau, nên tách thành module riêng:
 *   - Lúc chạy: fuzzy merge hai lần đọc OCR gần giống nhau (postprocess)
 *   - Lúc đo:   tính CER/WER trên test set (benchmark/score.mjs)
 *
 * Toàn hàm thuần, không đụng DOM — chạy được cả trong Node lẫn browser,
 * nên test bằng node:test không cần mock gì.
 */

/**
 * Khoảng cách Levenshtein — số phép chèn/xoá/thay tối thiểu để biến a thành b.
 *
 * Cài bằng hai hàng thay vì ma trận đầy đủ: bộ nhớ O(min(n,m)) thay vì O(n·m).
 * Với phụ đề thì chuỗi ngắn nên không quan trọng lắm, nhưng benchmark chạy
 * hàm này hàng nghìn lần trên ~200 câu nên vẫn đáng làm cho gọn.
 *
 * @param {string[]|string} a
 * @param {string[]|string} b
 */
export function levenshtein(a, b) {
  // Array.from thay vì split(''): tách đúng theo code point, không cắt đôi
  // ký tự ngoài mặt phẳng cơ bản. Tiếng Việt nằm trong BMP nhưng emoji trong
  // phụ đề thì không.
  const s = typeof a === 'string' ? Array.from(a) : a;
  const t = typeof b === 'string' ? Array.from(b) : b;

  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  let prev = new Array(t.length + 1);
  let curr = new Array(t.length + 1);

  for (let j = 0; j <= t.length; j++) prev[j] = j;

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // chèn
        prev[j] + 1, // xoá
        prev[j - 1] + cost // thay
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[t.length];
}

/** Tỉ lệ giống nhau 0–1. Dùng cho fuzzy merge (ngưỡng 0.9 lấy từ videocr). */
export function similarity(a, b) {
  const max = Math.max(Array.from(a).length, Array.from(b).length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/**
 * Chuẩn hoá trước khi so sánh. Phải áp dụng GIỐNG HỆT cho cả bản đọc lẫn bản
 * đúng, nếu không con số đo được sẽ vô nghĩa.
 *
 * Bước NFC là bắt buộc với tiếng Việt: cùng một chữ "ề" có hai cách mã hoá
 * Unicode — dựng sẵn (U+1EC1) và tổ hợp (U+0065 U+0302 U+0300). Không chuẩn
 * hoá thì hai chuỗi trông y hệt nhau trên màn hình lại bị tính là khác nhau,
 * và CER sẽ cao một cách giả tạo.
 */
export function normalizeText(text, { stripPunctuation = true, lowercase = true } = {}) {
  let out = String(text).normalize('NFC');
  if (lowercase) out = out.toLowerCase();
  if (stripPunctuation) {
    // Giữ lại chữ, số và khoảng trắng; bỏ dấu câu. \p{L} bao gồm cả chữ
    // tiếng Việt có dấu nên không cần liệt kê tay.
    out = out.replace(/[^\p{L}\p{N}\s]/gu, '');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Character Error Rate — thước đo chính cho OCR.
 * CER = levenshtein(đọc được, đúng) / độ dài bản đúng
 *
 * Giá trị > 1 là hợp lệ (khi bản đọc dài hơn hẳn bản đúng), không kẹp về 1 —
 * kẹp lại sẽ giấu mất trường hợp OCR bịa ra cả đống chữ thừa.
 */
export function cer(hypothesis, reference, opts) {
  const hyp = normalizeText(hypothesis, opts);
  const ref = normalizeText(reference, opts);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return levenshtein(hyp, ref) / Array.from(ref).length;
}

/** Word Error Rate — thước đo chính cho ASR. Giống CER nhưng đơn vị là từ. */
export function wer(hypothesis, reference, opts) {
  const hyp = normalizeText(hypothesis, opts).split(' ').filter(Boolean);
  const ref = normalizeText(reference, opts).split(' ').filter(Boolean);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return levenshtein(hyp, ref) / ref.length;
}
