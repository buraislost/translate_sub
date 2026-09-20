import { SubtitleSource } from '../core/SubtitleSource.js';
import { parseSubtitle } from '../core/parser.js';

/**
 * SrtFileSource — nguồn tĩnh, toàn bộ cue có sẵn ngay khi khởi tạo.
 *
 * Đây là nguồn đơn giản nhất, nhưng quan trọng: nó dùng để kiểm chứng
 * Renderer + SyncEngine chạy đúng TRƯỚC khi đụng vào OCR/ASR.
 * Khi sub hiển thị chuẩn từ file, mọi lỗi sau này chắc chắn nằm ở
 * khâu sinh cue chứ không phải khâu hiển thị.
 */
export class SrtFileSource extends SubtitleSource {
  /**
   * @param {string} content nội dung thô của file .srt / .vtt
   * @param {string} label tên hiển thị (thường là tên file)
   */
  constructor(content, label = 'file') {
    super(label);
    this.cues = parseSubtitle(content);
    this.ready = true;
  }

  static fromText(content, label) {
    return new SrtFileSource(content, label);
  }
}
