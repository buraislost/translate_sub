import { SubtitleSource } from '../core/SubtitleSource.js';
import { BandScanner } from '../core/scanner.js';
import { CueTracker } from '../core/cue-tracker.js';
import { describeError } from '../core/errors.js';
import { isContextInvalidated } from '../core/offscreen-client.js';

/**
 * OcrSource — đọc phụ đề CHÁY trên hình video thành cue văn bản.
 *
 * Đây là nguồn phụ đề realtime đầu tiên của dự án, và là lý do contract
 * SubtitleSource có `onCue`: cue đến dần theo lúc xem, không có sẵn từ đầu.
 *
 * Hai tầng để trang phim không giật:
 *   - Tầng nhẹ (ở đây, mỗi ~100ms): quét dải đáy ở nửa độ phân giải, ~1,3 ms
 *   - Tầng nặng (offscreen, chỉ khi có CÂU MỚI): mặt nạ đầy đủ + Tesseract, ~50–150 ms
 *
 * Kế thừa SubtitleSource nên Renderer và SyncEngine không biết (và không cần biết)
 * cue này đến từ OCR.
 */

/**
 * Nhịp quét tầng nhẹ. Đây là trần của độ trễ PHÁT HIỆN: câu mới có thể xuất hiện ngay
 * sau một lần quét và phải chờ trọn một nhịp mới được thấy (trung bình nửa nhịp).
 * Bản đầu dùng 280ms. Quét nhẹ chỉ ~1,3ms nên 100ms (≈10 lần/giây) tốn chưa tới 2% một
 * nhân CPU mà cắt trung bình ~90ms độ trễ.
 */
const DEFAULT_INTERVAL = 0.1;

/**
 * Chữ phải vắng mặt liên tục chừng này giây mới coi là câu đã hết. Tính theo GIÂY chứ
 * không theo số lần quét: quét dày hơn thì cần nhiều lần trống hơn mới đủ chắc — không
 * thì một khung nhiễu ~0,2s lúc chuyển cảnh cũng cắt câu làm đôi và tốn một lần OCR thừa.
 */
const CLOSE_AFTER_EMPTY_SEC = 0.3;

export class OcrSource extends SubtitleSource {
  /**
   * @param {{client: import('../core/offscreen-client.js').OffscreenClient,
   *          lang?: string, interval?: number, bandTop?: number}} opts
   */
  constructor({ client, lang = 'vie', interval = DEFAULT_INTERVAL, bandTop = 0.62 } = {}) {
    super('ocr');
    this.client = client;
    this.lang = lang;
    this.interval = interval;
    this.bandTop = bandTop;

    this.video = null;
    this.scanner = null;
    this.running = false;

    /** Trạng thái để popup hiển thị và để chẩn đoán. */
    this.info = {
      scans: 0,
      ocrRequests: 0,
      rejected: 0,
      errors: 0,
      lastError: null,
      lastText: '',
      unreadable: false, // canvas bị tainted: video DRM / cross-origin không CORS
      invalidated: false, // extension vừa được nạp lại, content script này đã mồ côi
    };

    /** id cue của tracker → cue công khai (nằm trong this.cues). */
    this._pub = new Map();
    this._tracker = new CueTracker({
      interval,
      emptyToClose: Math.max(2, Math.round(CLOSE_AFTER_EMPTY_SEC / interval)),
      onBegin: (tc) => this._onBegin(tc),
      onUpdate: (tc) => this._onUpdate(tc),
      onEnd: (tc) => this._onEnd(tc),
    });

    this._lastScanT = -Infinity;
    this._inflight = false;
    this._pendingCue = null;
    this._frameHandle = null;
    this._timer = null;
    this._consecutiveErrors = 0;

    this._onSeeking = () => this._tracker.reset();
    this._onSeeked = () => {
      this._lastScanT = -Infinity; // quét ngay khung hình vừa tua tới
    };
    this._onListeners = new Set();
  }

  async init(video) {
    this.video = video;
    this.scanner = new BandScanner(video, { bandTop: this.bandTop });
    this.ready = true;
  }

  /** Đăng ký nhận thông báo "có gì đó đổi" (cue mới, kết thúc) — để lưu cache. */
  onChange(fn) {
    this._onListeners.add(fn);
    return () => this._onListeners.delete(fn);
  }

  _changed() {
    for (const fn of this._onListeners) fn();
  }

  async start() {
    if (this.running || !this.video) return;
    this.running = true;
    // Nạp sẵn Tesseract ngay bây giờ để câu phụ đề đầu tiên không phải chờ giải nén WASM.
    this.client.warm(this.lang).catch(() => {});
    this.video.addEventListener('seeking', this._onSeeking);
    this.video.addEventListener('seeked', this._onSeeked);
    this._arm();
  }

  async stop() {
    this.running = false;
    this.video?.removeEventListener('seeking', this._onSeeking);
    this.video?.removeEventListener('seeked', this._onSeeked);
    if (this._frameHandle != null) this.video?.cancelVideoFrameCallback?.(this._frameHandle);
    clearTimeout(this._timer);
    this._frameHandle = null;
    this._timer = null;
    this._tracker.reset();
  }

  /* ---------------------------------------------------------------- */
  /* Vòng quét                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Dùng requestVideoFrameCallback khi có: nó bắn đúng lúc một khung hình MỚI được trình
   * chiếu và cho biết mediaTime chính xác của khung đó — tốt hơn setInterval (không đồng
   * bộ với video, quét lại cùng một khung khi video dừng).
   */
  _arm() {
    if (!this.running) return;
    const v = this.video;
    if (typeof v.requestVideoFrameCallback === 'function') {
      this._frameHandle = v.requestVideoFrameCallback((_now, meta) => {
        this._safeTick(meta?.mediaTime);
        this._arm();
      });
    } else {
      this._timer = setTimeout(() => {
        this._safeTick(v.currentTime);
        this._arm();
      }, this.interval * 1000);
    }
  }

  _safeTick(mediaTime) {
    try {
      this._tick(mediaTime);
      this._consecutiveErrors = 0;
    } catch (err) {
      this._fail(err);
    }
  }

  _tick(mediaTime) {
    const v = this.video;
    if (v.seeking) return;
    const t = mediaTime ?? v.currentTime;
    if (Math.abs(t - this._lastScanT) < this.interval) return;
    this._lastScanT = t;

    // Đường tắt khi xem lại: đã có cue ĐÃ ĐÓNG phủ thời điểm này thì không cần quét.
    // Cue đang mở (còn theo dõi) thì vẫn phải quét để kéo dài end theo chữ trên hình.
    const known = this.cueAt(t);
    if (known && !this._isLive(known)) return;

    const q = this.scanner.scan();
    if (!q) return;
    this.info.scans++;

    this._tracker.observe(
      t,
      q.present
        ? { present: true, occ: q.occ, meta: { rect: q.rect, frameH: q.frameH, topFrac: q.textTopFrac } }
        : { present: false }
    );
  }

  _isLive(pub) {
    for (const p of this._pub.values()) if (p === pub) return true;
    return false;
  }

  _fail(err) {
    if (err?.name === 'SecurityError') {
      // Canvas tainted: không có cách nào đọc pixel video này. Dừng hẳn thay vì thử lại mãi.
      this.info.unreadable = true;
      this.info.lastError = 'Video frames can’t be read (DRM, or cross-origin without CORS)';
      this.stop();
      this._changed();
      return;
    }
    this._noteError(err);
    if (++this._consecutiveErrors >= 8) this.stop();
  }

  _noteError(err) {
    const text = typeof err === 'string' ? err : describeError(err);
    if (isContextInvalidated(text)) {
      this.info.invalidated = true;
      this.stop();
    }
    this.info.errors++;
    this.info.lastError = text;
  }

  /* ---------------------------------------------------------------- */
  /* Tracker → OCR → cue                                               */
  /* ---------------------------------------------------------------- */

  _onBegin(tc) {
    this._requestOcr(tc);
  }

  /**
   * Chỉ giữ MỘT yêu cầu chờ và luôn ưu tiên câu mới nhất: nếu máy quá tải thì thà bỏ
   * câu cũ (đã qua) còn hơn đọc lần lượt cả hàng và hiện chậm mãi.
   */
  async _requestOcr(tc) {
    if (!this.running) return;
    if (this._inflight) {
      this._pendingCue = tc;
      return;
    }
    this._inflight = true;
    try {
      // Câu đã kết thúc từ lâu thì khung hình hiện tại không còn chứa nó nữa.
      if (tc.done && this.video.currentTime - tc.end > 0.6) return;

      // Đồng bộ, ~2–4ms: cắt + đổi sang mặt phẳng xám base64 (xem BandScanner.cropLuma).
      const crop = this.scanner.cropLuma(tc.meta.rect);
      const res = await this.client.ocr({ ...crop, frameH: tc.meta.frameH, lang: this.lang });
      this.info.ocrRequests++;
      this._onOcr(tc, res);
    } catch (err) {
      this._noteError(err);
    } finally {
      this._inflight = false;
      const next = this._pendingCue;
      this._pendingCue = null;
      if (next && this.running) this._requestOcr(next);
    }
  }

  _onOcr(tc, res) {
    if (!res?.ok) {
      this._noteError(res?.error ?? 'OCR failed');
      return;
    }
    // Tầng nhẹ báo có chữ nhưng tầng nặng không dựng được mặt nạ, hoặc chuỗi đọc ra là
    // rác → thường là vệt trắng có viền đen của tranh vẽ. Bỏ qua; tracker vẫn giữ câu này
    // cho tới khi nó biến mất nên không bị OCR đi OCR lại.
    if (res.none || !res.valid) {
      this.info.rejected++;
      return;
    }
    this._commit(tc, res.text, res.confidence);
  }

  /* ---------------------------------------------------------------- */
  /* Kho cue: luôn sắp xếp theo start, không chồng lấn                  */
  /* ---------------------------------------------------------------- */

  _lowerBound(start) {
    let lo = 0;
    let hi = this.cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].start < start) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Chèn cue mới vào đúng vị trí. cueAt() dùng binary search nên mảng BẮT BUỘC sắp xếp:
   * khi người dùng tua lùi, cue đọc được ở thời điểm sớm hơn không được nối vào cuối mảng.
   */
  _commit(tc, text, confidence) {
    const idx = this._lowerBound(tc.start);
    const prev = this.cues[idx - 1];

    // Cùng nội dung và sát nhau → là cùng một câu bị tách (rớt khung, hoặc câu đã đọc rồi
    // được quét lại từ phần đuôi khi xem lại). Gộp thay vì tạo cue thứ hai.
    if (prev && prev.text === text && tc.start - prev.end < 0.8) {
      prev.end = Math.max(prev.end, tc.end);
      this._pub.set(tc.id, prev);
      this._changed();
      return;
    }

    const cue = {
      start: tc.start,
      end: tc.end,
      text,
      confidence,
      topFrac: tc.meta?.topFrac ?? null,
    };

    if (prev && prev.end > cue.start) prev.end = cue.start;
    const next = this.cues[idx];
    if (next && cue.end > next.start) cue.end = next.start;

    this.cues.splice(idx, 0, cue);
    this._pub.set(tc.id, cue);
    this.info.lastText = text;
    for (const fn of this._listeners) fn(cue);
    this._changed();
  }

  _onUpdate(tc) {
    const pub = this._pub.get(tc.id);
    if (!pub) return;
    const next = this.cues[this._lowerBound(pub.start) + 1];
    pub.end = next && tc.end > next.start ? next.start : tc.end;
  }

  _onEnd(tc) {
    tc.done = true;
    this._onUpdate(tc);
    this._pub.delete(tc.id);
    this._changed();
  }

  /**
   * Nạp cue đã lưu (từ cache) để xem lại không phải OCR lại.
   * @param {Array<{start:number,end:number,vi:string}>} records
   */
  restore(records) {
    for (const r of records) {
      const idx = this._lowerBound(r.start);
      this.cues.splice(idx, 0, { start: r.start, end: r.end, text: r.vi, confidence: 100, topFrac: r.top ?? null });
    }
  }
}
