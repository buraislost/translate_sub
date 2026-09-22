/**
 * errors.js — mô tả một giá trị bị ném ra, dù nó là Error, chuỗi hay Event.
 *
 * Vì sao cần: tesseract.js ném lỗi tải worker dưới dạng CHUỖI THUẦN, và code cũ viết
 * `${err.name}: ${err.message}` cho ra "undefined: undefined" — mất sạch nguyên nhân
 * thật. Đã tốn một vòng debug chỉ vì dòng đó.
 */
export function describeError(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    try {
      return err.message || err.type || JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}
