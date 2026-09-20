/**
 * cue-tracker.js — biến chuỗi kết quả quét thành các cue có start/end.
 *
 * Bộ quét chỉ nói "lúc t có chữ, chữ ký là X". Việc của file này là quyết định:
 *   - đây có phải một câu MỚI (cần OCR) hay vẫn là câu cũ (chỉ kéo dài end)?
 *   - câu cũ đã kết thúc chưa?
 *
 * Thuần logic, không đụng DOM/video/canvas → test được bằng node:test với
 * chuỗi quét giả lập, và dùng lại được cho ASR sau này.
 *
 * Ba hành vi thật đã đo được trên phim (chuỗi 92 khung, 32 giây) và phải xử lý:
 *   1. Cùng một câu: khoảng cách chữ ký ≤ 0,04. Hai câu khác nhau liền kề: ≥ 0,28.
 *      Ngưỡng 0,15 nằm giữa. (Lần đầu tôi đo bằng lưới thô và suýt chọn 0,18 — lưới
 *      đó có cặp câu khác nhau chỉ cách 0,14, nên sẽ coi nhầm hai câu là một.)
 *   2. Khung nhiễu làm CÙNG câu biến mất đúng 1 lần quét rồi hiện lại y nguyên →
 *      không được tách thành hai cue.
 *   3. NHƯNG chuyển cảnh cũng làm chữ biến mất 1 lần quét rồi hiện lại — với một câu
 *      KHÁC cùng độ dài, cùng vị trí. Hai trường hợp chỉ phân biệt được bằng độ giống:
 *      nhiễu cho ≈0, chuyển cảnh thì không → ngưỡng chặt hơn ngay sau chỗ đứt quãng.
 *   4. Câu đổi thẳng sang câu khác, KHÔNG có khe trống giữa hai câu.
 */

import { occDistance } from './preprocess.js';

export const TRACKER_DEFAULTS = {
  /** Nhịp quét dự kiến (giây) — dùng để ước lượng thời điểm câu thật sự xuất hiện. */
  interval: 0.28,
  /**
   * Chữ ký cách nhau quá ngưỡng này → câu mới. Đo thật (lưới 192×32): trôi trong cùng một
   * câu ≤ 0,04; hai câu khác nhau gần nhất 0,28–0,49. 0,15 cách xa cả hai phía.
   */
  sameMax: 0.15,
  /**
   * Ngưỡng chặt hơn áp dụng ngay sau một lần quét trống. Khung nhiễu làm CÙNG câu rớt
   * một lần sẽ hiện lại gần như y hệt (≈0), còn chuyển cảnh giữa hai câu thì không —
   * đã gặp: một câu → cắt cảnh → một câu KHÁC cùng
   * độ dài, cùng vị trí. Coi nhầm thì bỏ sót cả câu.
   */
  sameMaxAfterGap: 0.08,
  /** Số lần quét trống liên tiếp mới coi là kết thúc hẳn. */
  emptyToClose: 2,
  /** Quét lệch hơn chừng này giây so với lần trước → coi như vừa tua, không nội suy. */
  maxGap: 1.2,
};

/**
 * @typedef {Object} TrackedCue
 * @property {number} id
 * @property {number} start
 * @property {number} end        đầu cuối, cập nhật liên tục khi câu còn hiện
 * @property {number} lastSeen   lần quét cuối thấy câu
 * @property {Uint8Array} occ    chữ ký mới nhất
 * @property {any} meta          dữ liệu người gọi gắn kèm (vị trí dải chữ...)
 * @property {number} empties    số lần quét trống liên tiếp
 */

export class CueTracker {
  /**
   * @param {Partial<typeof TRACKER_DEFAULTS> & {
   *   onBegin?: (cue: TrackedCue) => void,
   *   onUpdate?: (cue: TrackedCue) => void,
   *   onEnd?: (cue: TrackedCue, reason: 'gap'|'replaced'|'reset') => void,
   * }} opts
   */
  constructor(opts = {}) {
    this.o = { ...TRACKER_DEFAULTS, ...opts };
    this.onBegin = opts.onBegin ?? (() => {});
    this.onUpdate = opts.onUpdate ?? (() => {});
    this.onEnd = opts.onEnd ?? (() => {});
    /** @type {TrackedCue|null} */
    this.current = null;
    this._nextId = 1;
    this._lastT = null;
  }

  /**
   * Nạp một kết quả quét.
   * @param {number} t thời điểm trong video (giây)
   * @param {{present: boolean, occ?: Uint8Array, meta?: any}} scan
   */
  observe(t, scan) {
    const cur = this.current;
    const jumped = this._lastT !== null && Math.abs(t - this._lastT) > this.o.maxGap;
    const prevT = this._lastT;
    this._lastT = t;

    // Vừa tua: câu đang theo dõi không còn liên quan tới khung hình mới.
    if (jumped && cur) this._finish('reset', cur.lastSeen + this.o.interval * 0.5);

    if (!scan.present) return this._observeEmpty(t);

    const c = this.current;
    const limit = c && c.empties > 0 ? this.o.sameMaxAfterGap : this.o.sameMax;
    if (c && occDistance(c.occ, scan.occ) <= limit) {
      // Vẫn là câu cũ. Nếu trước đó vừa "mờ" một lần quét thì đây là khung nhiễu.
      c.lastSeen = t;
      c.occ = scan.occ;
      c.meta = scan.meta ?? c.meta;
      c.empties = 0;
      // Lạc quan: giả định câu còn hiện tới lần quét kế. Không thì cue sẽ hết hạn
      // giữa hai lần quét và dòng dịch nhấp nháy dù chữ gốc vẫn còn trên hình.
      c.end = t + this.o.interval * 1.5;
      this.onUpdate(c);
      return c;
    }

    // Câu xuất hiện đâu đó giữa hai lần quét → lấy điểm giữa. Vừa tua hoặc lần
    // quét đầu tiên thì không biết gì về quá khứ, lấy đúng t.
    const known = prevT !== null && !jumped && t - prevT <= this.o.interval * 3;
    const start = known ? (prevT + t) / 2 : t;

    // Nếu đang có câu cũ thì nó kết thúc đúng lúc câu mới bắt đầu — không chồng lấn,
    // để nguồn phụ đề khỏi phải cắt tỉa.
    if (c) this._finish('replaced', start);

    const cue = {
      id: this._nextId++,
      start,
      end: t + this.o.interval * 1.5,
      lastSeen: t,
      occ: scan.occ,
      meta: scan.meta,
      empties: 0,
    };
    this.current = cue;
    this.onBegin(cue);
    return cue;
  }

  _observeEmpty(t) {
    const c = this.current;
    if (!c) return null;

    c.empties++;
    // Lần trống đầu: chữ có thể đã tắt thật, nên thu end về giữa hai lần quét để dòng
    // dịch tắt ngay. Nếu chỉ là khung nhiễu thì lần quét sau sẽ kéo end ra lại.
    c.end = Math.min(c.end, (c.lastSeen + t) / 2);
    this.onUpdate(c);

    if (c.empties >= this.o.emptyToClose) this._finish('gap', c.end);
    return c;
  }

  _finish(reason, endT) {
    const c = this.current;
    if (!c) return;
    c.end = Math.max(c.start + 0.05, Math.min(c.end, endT));
    this.current = null;
    this.onEnd(c, reason);
  }

  /** Người dùng tua hoặc video dừng hẳn: đóng câu đang theo dõi. */
  reset() {
    if (this.current) this._finish('reset', this.current.lastSeen + this.o.interval * 0.5);
    this._lastT = null;
  }
}
