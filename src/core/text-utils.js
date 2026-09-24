/**
 * text-utils.js — xử lý chuỗi phụ đề: làm sạch kết quả OCR và tách câu để dịch.
 *
 * Thuần hàm, không phụ thuộc trình duyệt → test được bằng node:test.
 */

/**
 * Gạch đầu dòng thoại: gạch nối, en dash, em dash và vài dạng OCR hay đọc nhầm (dấu rác
 * đứng trước gạch cũng được nuốt luôn).
 *
 * Viết bằng regex LITERAL, không dựng từ chuỗi: chuỗi template chứa dấu gạch chéo ngược
 * kép đã từng bị mất một dấu khi ghi file, làm `\s` thành chữ `s` thường — regex vẫn
 * chạy nhưng khớp sai âm thầm.
 */
const LEADING_DASH_RE = /^[\s_¬~^*.,]*[-–—‒―]\s*/;
const LEADING_DASH_RUN_RE = /^[-–—‒―\s]+/;

/**
 * Làm sạch chuỗi Tesseract trả về.
 *
 * Tesseract hay chèn ký tự rác ở những chỗ nó "không chắc": khe giữa các từ,
 * gạch đầu dòng, rìa ảnh. Ở đây chỉ dọn những lỗi có hệ thống đã thấy khi đo
 * trên phim thật — không đoán mò sửa chính tả (việc của bộ sửa theo âm tiết).
 *
 * @param {string} raw
 * @param {{confidence?: number, minConfidence?: number}} opts
 * @returns {{text: string, ok: boolean, reason?: string}}
 */
export function cleanOcrText(raw, { confidence = 100, minConfidence = 30 } = {}) {
  let t = String(raw ?? "").normalize("NFC").replace(/\r/g, "");

  // Chỉ giữ chữ, số, khoảng trắng và dấu câu thường gặp trong phụ đề.
  t = t.replace(/[^\p{L}\p{N}\s.,!?;:…'"“”‘’()\-–—%&/\n]/gu, " ");

  // Khe nền giữa hai từ đôi khi bị đọc thành : ; " kẹp giữa hai chữ, dính liền cả hai
  // bên ("Hôm:nay;trời"). Tiếng Việt không có dấu câu ở giữa từ nên đổi thành khoảng
  // trắng. Không đụng dấu nháy đơn vì tên/từ tiếng Anh có thể chứa (don't, O'Brien).
  t = t.replace(/(?<=[\p{L}\p{N}])[:;"“”](?=[\p{L}\p{N}])/gu, " ");

  const lines = t
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .map((l) => {
      // Gạch đầu dòng bị nhiễu ("_-", "¬", "- -") → chuẩn hoá về đúng "- ".
      if (LEADING_DASH_RE.test(l)) l = "- " + l.replace(LEADING_DASH_RE, "").replace(LEADING_DASH_RUN_RE, "");
      return l;
    })
    // Dòng không có chữ/số nào thì là rác thuần tuý.
    .filter((l) => /[\p{L}\p{N}]/u.test(l));

  // Số 0 lẫn trong từ chữ: "ch0", "tr0ng", "kh0" → o. Chỉ xử lý khi có chữ cái sát bên.
  const fixed = lines.map((l) =>
    l.replace(/(?<=\p{L})0|0(?=\p{L})/gu, "o")
  );

  const text = fixed.join("\n").trim();
  const letters = (text.match(/\p{L}/gu) || []).length;

  if (letters < 2) return { text, ok: false, reason: "too few letters" };
  if (confidence < minConfidence) return { text, ok: false, reason: `low confidence (${Math.round(confidence)})` };
  return { text, ok: true };
}

/**
 * Tách một cue thành các "phát ngôn" để dịch riêng.
 *
 * Phụ đề có hai kiểu hai dòng, và dịch sai kiểu là mất nghĩa:
 *   - Hai NGƯỜI nói:   "- Chào cô ạ!\n- Hôm nay học gì..."  → hai câu độc lập
 *   - Một câu bị NGẮT: "Ngày mai nếu trời không mưa\nthì chúng ta..." → một câu
 * Dấu gạch đầu dòng là dấu hiệu phân biệt. Dịch từng dòng riêng lẻ với kiểu thứ hai
 * sẽ ra hai mảnh câu vô nghĩa, nên dòng không có gạch được nối vào dòng trước.
 *
 * @param {string} text
 * @returns {{parts: string[], dialogue: boolean}}
 */
export function splitUtterances(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const parts = [];
  let dialogue = false;
  for (const line of lines) {
    const isDash = LEADING_DASH_RE.test(line);
    const body = line.replace(LEADING_DASH_RE, "").trim();
    if (!body) continue;
    if (isDash) {
      dialogue = true;
      parts.push(body);
    } else if (parts.length) {
      parts[parts.length - 1] += " " + body; // dòng nối tiếp của câu đang dở
    } else {
      parts.push(body);
    }
  }
  return { parts, dialogue };
}

/** Ghép các bản dịch lại: thoại thì mỗi người một dòng có gạch, không thì một dòng. */
export function joinUtterances(parts, dialogue) {
  if (!parts.length) return "";
  if (dialogue && parts.length > 1) return parts.map((p) => "- " + p).join("\n");
  return parts.join(" ");
}
