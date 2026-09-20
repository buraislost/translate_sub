/**
 * sync.js — vòng lặp đồng bộ.
 *
 * Vì sao dùng requestAnimationFrame thay vì event `timeupdate` của video:
 * `timeupdate` chỉ bắn khoảng 4 lần/giây, đủ cho thanh tiến trình nhưng gây
 * trễ thấy rõ với phụ đề (tối đa 250ms lệch). rAF chạy theo nhịp vẽ màn hình
 * và tự dừng khi tab ẩn — vừa mượt vừa không tốn pin.
 */
export class SyncEngine {
  constructor(videoEl, renderer) {
    this.video = videoEl;
    this.renderer = renderer;

    /** @type {{source: import('./SubtitleSource.js').SubtitleSource|null, offset: number}} */
    this.track1 = { source: null, offset: 0 };
    this.track2 = { source: null, offset: 0 };

    this._raf = null;
    this._last = { a: null, b: null };
    this._tick = this._tick.bind(this);
  }

  setTrack(index, source) {
    const track = index === 1 ? this.track1 : this.track2;
    track.source = source;
    this._last = { a: null, b: null }; // buộc vẽ lại ở frame kế tiếp
  }

  setOffset(index, seconds) {
    const track = index === 1 ? this.track1 : this.track2;
    track.offset = seconds;
    this._last = { a: null, b: null };
  }

  getOffset(index) {
    return (index === 1 ? this.track1 : this.track2).offset;
  }

  start() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.renderer.render('', '');
  }

  _tick() {
    this._raf = requestAnimationFrame(this._tick);

    const t = this.video.currentTime;
    // Offset dương = phụ đề hiện SỚM hơn. Người dùng nghĩ theo hướng
    // "kéo phụ đề tới trước", nên trừ vào thời gian tra cứu.
    const a = this.track1.source?.cueAt(t - this.track1.offset)?.text || '';
    const b = this.track2.source?.cueAt(t - this.track2.offset)?.text || '';

    // Chỉ chạm vào DOM khi nội dung thực sự đổi — tránh 60 lần ghi/giây.
    if (a !== this._last.a || b !== this._last.b) {
      this.renderer.render(a, b);
      this._last = { a, b };
    }
  }
}
