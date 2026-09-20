/**
 * SubtitleSource.js — contract chung cho mọi nguồn phụ đề.
 *
 * Đây là trục chính của kiến trúc. Ba nguồn sẽ cùng implement interface này:
 *   - SrtFileSource   (Sprint 1) — người dùng upload file
 *   - WhisperSource   (Sprint 2) — nhận dạng tiếng nói từ audio
 *   - OcrSource       (Sprint 3) — đọc chữ cháy trên hình
 *
 * Nhờ contract chung, Renderer và SyncEngine không cần biết cue đến từ đâu.
 * Thêm nguồn mới = viết thêm một class, không sửa phần lõi.
 */
export class SubtitleSource {
  constructor(label = 'unknown') {
    this.label = label;
    /** @type {Array<{start:number,end:number,text:string,confidence?:number}>} */
    this.cues = [];
    this._listeners = new Set();
    this.ready = false;
  }

  /**
   * Chuẩn bị nguồn. Nhận video element vì OCR cần đọc pixel
   * và ASR cần lấy audio từ chính element đó.
   */
  async init(/* videoEl */) {
    this.ready = true;
  }

  /** Bắt đầu sinh cue. Với nguồn file thì cue đã có sẵn nên không làm gì. */
  async start() {}

  /** Dừng và giải phóng tài nguyên (worker, stream, canvas...). */
  async stop() {}

  /** Đăng ký nhận cue mới — nguồn realtime (OCR/ASR) sẽ bắn dần từng cue. */
  onCue(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Gọi từ lớp con khi có cue mới. */
  _emit(cue) {
    this.cues.push(cue);
    for (const fn of this._listeners) fn(cue);
  }

  /**
   * Tra cue tại thời điểm `time` bằng binary search — O(log n).
   * Hàm này chạy mỗi khung hình (~60 lần/giây) nên không được phép quét tuyến tính:
   * một phim 2 tiếng có khoảng 2000 cue, tuyến tính sẽ là 120.000 phép so sánh/giây.
   */
  cueAt(time) {
    const cues = this.cues;
    let lo = 0;
    let hi = cues.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cues[mid];
      if (time < c.start) hi = mid - 1;
      else if (time > c.end) lo = mid + 1;
      else return c;
    }
    return null;
  }
}
