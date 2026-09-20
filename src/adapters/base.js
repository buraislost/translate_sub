/**
 * base.js — contract cho adapter nền tảng.
 *
 * Mỗi website là một adapter. Adapter chỉ trả lời 4 câu hỏi:
 *   - Trang này có phải của tôi không?          → match()
 *   - Thẻ video nằm ở đâu?                      → getVideo()
 *   - Gắn overlay vào element nào?              → getContainer()
 *   - Có cần ẩn phụ đề gốc để tránh chồng chữ?  → hideNativeSubs()
 *
 * Thêm site mới = thêm một file ~30 dòng, không sửa phần lõi.
 */
export class BaseAdapter {
  /** @returns {boolean} adapter này có xử lý URL hiện tại không */
  static match(/* url */) {
    return false;
  }

  static get id() {
    return 'base';
  }

  constructor() {
    this.video = null;
  }

  /** Tìm thẻ video. Trả null nếu chưa có (trang chưa load xong). */
  getVideo() {
    return null;
  }

  /** Element bọc video — nơi overlay sẽ được gắn vào. */
  getContainer() {
    return this.video?.parentElement || null;
  }

  /** Ẩn phụ đề gốc của site. Mặc định không làm gì. */
  hideNativeSubs() {}

  /** Khôi phục phụ đề gốc khi tắt extension. */
  restoreNativeSubs() {}
}

/**
 * querySelectorAll xuyên qua Shadow DOM.
 *
 * Nhiều player hiện đại (đặc biệt là player tự viết bằng Web Component) bọc
 * thẻ video trong shadow root. `document.querySelector('video')` sẽ trả null
 * dù video đang chạy ngay trước mắt. Hàm này duyệt đệ quy qua mọi shadowRoot.
 */
export function deepQuerySelectorAll(selector, root = document) {
  const found = [...root.querySelectorAll(selector)];

  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) {
      found.push(...deepQuerySelectorAll(selector, el.shadowRoot));
    }
  }
  return found;
}
