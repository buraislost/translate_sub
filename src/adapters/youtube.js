import { BaseAdapter } from './base.js';

/**
 * YouTubeAdapter — ví dụ mẫu cho một adapter riêng.
 *
 * Sprint 1 mới dùng phần DOM. Sprint 3 sẽ bổ sung getNativeCues() để đọc
 * caption track gốc của YouTube rồi đem đi dịch.
 *
 * Lưu ý quan trọng: YouTube là SPA — chuyển video KHÔNG reload trang.
 * Việc phát hiện đổi video do main.js lo bằng MutationObserver, adapter
 * không cần quan tâm.
 */
export class YouTubeAdapter extends BaseAdapter {
  static match(url) {
    return /(^|\.)youtube\.com$/.test(new URL(url).hostname);
  }

  static get id() {
    return 'youtube';
  }

  getVideo() {
    this.video = document.querySelector('video.html5-main-video, #movie_player video');
    return this.video;
  }

  getContainer() {
    return document.querySelector('#movie_player') || this.video?.parentElement || null;
  }

  /**
   * Ẩn caption gốc. Nếu để cả hai cùng hiện, chữ sẽ đè lên nhau ở đáy màn hình.
   * Ta ẩn bằng CSS thay vì tắt caption qua UI của YouTube, để vẫn giữ được
   * dữ liệu caption cho bước dịch ở sprint sau.
   */
  hideNativeSubs() {
    if (this._styleEl) return;
    this._styleEl = document.createElement('style');
    this._styleEl.dataset.translateSub = 'hide-native';
    this._styleEl.textContent = `
      .ytp-caption-window-container { opacity: 0 !important; pointer-events: none !important; }
    `;
    document.documentElement.appendChild(this._styleEl);
  }

  restoreNativeSubs() {
    this._styleEl?.remove();
    this._styleEl = null;
  }
}
