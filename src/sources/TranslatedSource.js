import { SubtitleSource } from '../core/SubtitleSource.js';

/** Các mã lỗi nghĩa là "chưa dịch được lúc này, đừng thử dồn dập" — chờ người dùng xử lý. */
const BLOCKING = new Set(['download-needed', 'downloading', 'unavailable', 'unsupported']);

/**
 * TranslatedSource — bọc MỘT nguồn phụ đề khác và phát lại bản dịch của nó.
 *
 * Kiểu decorator: nó không biết nguồn bên trong là OCR, ASR hay file .srt — chỉ cần
 * `cues` và `onCue`. Nhờ vậy chính class này dùng lại nguyên si cho ASR sau này.
 *
 * Với sub cháy tiếng Việt: dòng tiếng Việt đã có sẵn trên hình nên chỉ dòng tiếng Anh
 * này được vẽ lên màn hình; nguồn OCR bên trong vẫn giữ cả hai để xuất .srt.
 */
export class TranslatedSource extends SubtitleSource {
  /**
   * @param {SubtitleSource} inner
   * @param {{client: {translate: Function}, from?: string, to?: string}} opts
   */
  constructor(inner, { client, from = 'vi', to = 'en' } = {}) {
    super(`translated:${inner.label}`);
    this.inner = inner;
    this.client = client;
    this.from = from;
    this.to = to;

    /** ok | download-needed | downloading | unavailable | unsupported | error */
    this.status = { state: 'ok', message: '' };
    this._queue = [];
    this._busy = false;
    this._blocked = false;
    this._failed = [];
    this._off = null;
    this._statusListeners = new Set();
    this.stats = { translated: 0, errors: 0 };
    this.ready = true;
  }

  onStatus(fn) {
    this._statusListeners.add(fn);
    return () => this._statusListeners.delete(fn);
  }

  _setStatus(state, message = '') {
    if (this.status.state === state && this.status.message === message) return;
    this.status = { state, message };
    for (const fn of this._statusListeners) fn(this.status);
  }

  async start() {
    if (this._off) return;
    // Tạo sẵn translator song song với lúc OCR đang nạp engine — không chờ, không chặn.
    this.client.translateWarm?.(this.from, this.to)?.catch?.(() => {});
    this._off = this.inner.onCue((cue) => this._enqueue(cue));
    // Cue đã có sẵn từ trước (nạp từ cache) mà chưa có bản dịch thì dịch bù.
    for (const cue of this.inner.cues) if (!this._hasTranslation(cue)) this._enqueue(cue);
  }

  async stop() {
    this._off?.();
    this._off = null;
    this._queue.length = 0;
  }

  _hasTranslation(cue) {
    return this.cues.some((t) => t.source === cue);
  }

  _enqueue(cue) {
    if (this._blocked) {
      this._failed.push(cue);
      return;
    }
    this._queue.push(cue);
    this._pump();
  }

  /**
   * Dịch tuần tự theo đúng thứ tự cue. Chrome Translator xử lý từng cái một nên gọi
   * song song không nhanh hơn, chỉ làm khó đoán bản dịch nào về trước.
   */
  async _pump() {
    if (this._busy) return;
    this._busy = true;
    try {
      while (this._queue.length) {
        const cue = this._queue.shift();
        const res = await this.client.translate({ text: cue.text, from: this.from, to: this.to });

        if (res?.ok) {
          this._setStatus('ok');
          this._insert(cue, res.text);
          this.stats.translated++;
          continue;
        }

        const code = res?.code ?? 'error';
        if (BLOCKING.has(code)) {
          // Model dịch chưa sẵn sàng: xếp cue này và MỌI cue đang chờ vào hàng lỗi, chờ
          // retry() khi người dùng đã tải model. Không thử lại dồn dập.
          this._blocked = true;
          this._failed.push(cue, ...this._queue.splice(0));
          this._setStatus(code, res?.message ?? '');
          break;
        }
        this.stats.errors++;
        this._setStatus('error', res?.message ?? res?.error ?? 'translation failed');
      }
    } finally {
      this._busy = false;
    }
  }

  /**
   * Cue dịch dùng getter cho start/end thay vì sao chép giá trị: cue OCR đang hiện thì
   * `end` liên tục được kéo dài, cue dịch phải đi theo mà không cần đồng bộ thủ công.
   */
  _insert(src, text) {
    let lo = 0;
    let hi = this.cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].start < src.start) lo = mid + 1;
      else hi = mid;
    }
    const tc = {
      text,
      source: src,
      get start() {
        return src.start;
      },
      get end() {
        return src.end;
      },
    };
    this.cues.splice(lo, 0, tc);
    for (const fn of this._listeners) fn(tc);
  }

  /** Gọi sau khi người dùng đã tải xong model dịch. */
  retry() {
    this._blocked = false;
    const again = this._failed.splice(0);
    this._setStatus('ok');
    for (const cue of again) if (!this._hasTranslation(cue)) this._queue.push(cue);
    this._pump();
  }

  /**
   * Nạp bản dịch đã lưu.
   * @param {Array<{start:number,end:number,vi:string,en:string|null}>} records
   */
  restore(records) {
    for (const r of records) {
      if (!r.en) continue;
      const src = this.inner.cues.find((c) => c.start === r.start && c.text === r.vi);
      if (src) this._insert(src, r.en);
    }
  }
}
