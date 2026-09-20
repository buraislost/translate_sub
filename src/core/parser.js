/**
 * parser.js — chuyển nội dung file phụ đề thành mảng cue chuẩn.
 *
 * Định dạng cue dùng chung cho TOÀN BỘ project (file, OCR, ASR đều trả về
 * đúng shape này):
 *   { start: number, end: number, text: string, confidence?: number }
 * start/end tính bằng GIÂY (số thực), không phải mili-giây.
 */

/** Regex bắt timestamp của cả SRT (dấu phẩy) lẫn VTT (dấu chấm). */
const TIME_RE = /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})|(\d{1,3}):(\d{2})[,.](\d{1,3})/;

/**
 * Đổi chuỗi timestamp thành giây.
 * Chấp nhận cả "01:23:45,678" (có giờ) và "23:45.678" (không có giờ — VTT cho phép).
 */
export function parseTimestamp(raw) {
  const m = raw.trim().match(TIME_RE);
  if (!m) return NaN;

  if (m[1] !== undefined) {
    const [, h, mm, ss, ms] = m;
    return +h * 3600 + +mm * 60 + +ss + +ms / 1000;
  }
  const [, , , , , mm, ss, ms] = m;
  return +mm * 60 + +ss + +ms / 1000;
}

/**
 * Làm sạch text của một cue.
 * - bỏ thẻ HTML <i>, <b>, <font color=...>
 * - bỏ tag định vị kiểu ASS {\an8}
 * - gộp khoảng trắng thừa
 */
function cleanText(raw) {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Parse SRT hoặc VTT. Tự nhận diện, không cần chỉ định định dạng.
 *
 * Cách làm: bỏ qua cấu trúc "số thứ tự" của SRT (nhiều file bị đánh số sai),
 * chỉ bám vào dòng có "-->" làm mốc. Cách này chịu lỗi tốt hơn hẳn parser
 * đòi đúng chuẩn.
 */
export function parseSubtitle(content) {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const arrowIdx = lines.findIndex((l) => l.includes('-->'));
    if (arrowIdx === -1) continue;

    const [left, right] = lines[arrowIdx].split('-->');
    const start = parseTimestamp(left);
    const end = parseTimestamp(right);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;

    const body = cleanText(lines.slice(arrowIdx + 1).join('\n'));
    if (!body) continue;

    cues.push({ start, end, text: body });
  }

  return normalizeCues(cues);
}

/**
 * Chuẩn hoá danh sách cue:
 * - sắp xếp theo thời gian bắt đầu (bắt buộc, vì binary search phụ thuộc vào đây)
 * - sửa cue có end <= start (một số file bị lỗi) bằng cách cho tối thiểu 0.5s
 * - cắt phần chồng lấn giữa hai cue liên tiếp
 */
export function normalizeCues(cues) {
  const sorted = [...cues].sort((a, b) => a.start - b.start);

  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].end <= sorted[i].start) {
      sorted[i].end = sorted[i].start + 0.5;
    }
    const next = sorted[i + 1];
    if (next && sorted[i].end > next.start) {
      sorted[i].end = next.start;
    }
  }

  return sorted.filter((c) => c.end > c.start);
}

/** Xuất ngược ra chuỗi SRT — dùng cho nút "Tải sub" ở các sprint sau (OCR/ASR). */
export function toSrt(cues) {
  const fmt = (t) => {
    const h = String(Math.floor(t / 3600)).padStart(2, '0');
    const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(t % 60)).padStart(2, '0');
    const ms = String(Math.round((t % 1) * 1000)).padStart(3, '0');
    return `${h}:${m}:${s},${ms}`;
  };

  return cues
    .map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`)
    .join('\n');
}
