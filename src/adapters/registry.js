import { UniversalAdapter } from './universal.js';
import { YouTubeAdapter } from './youtube.js';

/**
 * registry.js — bảng đăng ký adapter.
 *
 * Thứ tự QUAN TRỌNG: adapter chuyên biệt đứng trước, UniversalAdapter luôn
 * đứng cuối vì match() của nó luôn trả true.
 *
 * Thêm site mới: import class rồi chèn vào mảng, phía trên Universal.
 */
const ADAPTERS = [
  YouTubeAdapter,
  // ... thêm NetflixAdapter, PhimAdapter... ở đây
  UniversalAdapter,
];

export function pickAdapter(url = location.href) {
  for (const Adapter of ADAPTERS) {
    try {
      if (Adapter.match(url)) return new Adapter();
    } catch {
      // match() có thể ném lỗi với URL lạ (about:blank, blob:) → bỏ qua
    }
  }
  return new UniversalAdapter();
}
