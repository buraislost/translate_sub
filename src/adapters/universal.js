import { BaseAdapter, deepQuerySelectorAll } from './base.js';

/**
 * UniversalAdapter — adapter mặc định, chạy trên MỌI website.
 *
 * Đây là adapter quan trọng nhất của project. Nó không biết gì về site cụ thể,
 * chỉ cần trang có thẻ <video> là hoạt động. Một mình nó phủ gần như toàn bộ
 * web phim, Vimeo, video nhúng, và file local mở bằng trình duyệt.
 *
 * Các adapter riêng (YouTube, Netflix...) chỉ cần thiết khi ta muốn ĐỌC phụ đề
 * gốc của site đó — việc của Sprint sau.
 */
export class UniversalAdapter extends BaseAdapter {
  static match() {
    return true; // luôn khớp — registry đặt nó ở cuối danh sách
  }

  static get id() {
    return 'universal';
  }

  /**
   * Chọn video LỚN NHẤT đang hiển thị trên trang.
   * Nhiều trang có video ẩn để preload hoặc quảng cáo nhỏ ở góc; video người
   * dùng đang xem gần như luôn là cái có diện tích lớn nhất.
   */
  getVideo() {
    const candidates = deepQuerySelectorAll('video').filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 200 && r.height > 120;
    });

    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });

    this.video = candidates[0];
    return this.video;
  }

  /**
   * Tìm container hợp lý để gắn overlay.
   *
   * Không dùng thẳng parentElement vì nhiều player bọc video trong một div
   * kích thước 0 hoặc div chỉ dùng để transform. Ta đi ngược lên tối đa 5 cấp
   * và chọn ancestor CUỐI CÙNG vẫn có kích thước xấp xỉ video — đó thường
   * chính là khung player, cũng là element được đưa vào fullscreen.
   */
  getContainer() {
    const v = this.video;
    if (!v) return null;

    const vr = v.getBoundingClientRect();
    let best = v.parentElement || document.body;
    let el = v.parentElement;
    let depth = 0;

    // Sai số tính THEO TỈ LỆ kích thước video, không phải số pixel cố định.
    // Đo thật trên một web phim: video 531x299, ancestor kế tiếp cao 404 —
    // chênh 105px, chỉ vừa đúng thoát ngưỡng cứng 100px cũ. Sát ranh giới
    // như vậy nghĩa là chỉ cần trang đổi padding vài pixel là overlay bị gắn
    // nhầm vào khối chứa cả phần dưới video, và phụ đề sẽ lệch hẳn ra ngoài.
    // Ngưỡng cố định còn hỏng theo chiều ngược lại: với video 480x270 thì
    // 100px là 37% chiều cao — lỏng tới mức vơ luôn cả container sai.
    const tolW = Math.max(24, vr.width * 0.08);
    const tolH = Math.max(24, vr.height * 0.08);

    while (el && depth < 5) {
      const r = el.getBoundingClientRect();
      if (Math.abs(r.width - vr.width) < tolW && Math.abs(r.height - vr.height) < tolH) {
        best = el;
      }
      el = el.parentElement;
      depth++;
    }

    return best;
  }
}
