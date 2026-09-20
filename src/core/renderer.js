/**
 * renderer.js — vẽ overlay phụ đề.
 *
 * Hai quyết định thiết kế quan trọng:
 *
 * 1. Toàn bộ overlay nằm trong Shadow DOM. Mỗi website có CSS riêng và rất
 *    hay dùng selector rộng (`div { ... }`, `* { box-sizing }`). Shadow DOM
 *    cô lập style tuyệt đối — đây là cách duy nhất để một extension đa nền
 *    tảng hiển thị nhất quán trên hàng nghìn site khác nhau.
 *
 * 2. Host được gắn vào CONTAINER của video chứ không phải document.body.
 *    Khi người dùng bấm toàn màn hình, trình duyệt chỉ hiển thị cây con của
 *    element fullscreen — mọi thứ nằm ngoài cây đó sẽ biến mất.
 */

const STYLE = `
  :host { all: initial; }

  .layer {
    position: absolute;
    left: 0;
    right: 0;
    bottom: var(--ds-bottom, 8%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    pointer-events: none;
    z-index: 2147483000;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    text-align: center;
    padding: 0 6%;
    box-sizing: border-box;
  }

  .line {
    display: none;
    max-width: 100%;
    margin: 0;
    padding: 2px 10px;
    border-radius: 3px;
    background: rgba(0, 0, 0, var(--ds-bg-alpha, 0.55));
    color: var(--ds-color, #ffffff);
    line-height: 1.32;
    white-space: pre-wrap;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
  }

  .line.visible { display: block; }

  .primary   { font-size: var(--ds-size, 26px); font-weight: 500; }
  .secondary { font-size: calc(var(--ds-size, 26px) * 0.82); font-weight: 400; opacity: 0.92; }

  .toast {
    position: absolute;
    bottom: calc(var(--ds-bottom, 8%) + 90px);
    left: 50%;
    transform: translateX(-50%);
    padding: 6px 14px;
    border-radius: 4px;
    background: rgba(18, 16, 15, 0.92);
    color: #e6ddd2;
    font: 500 14px/1 system-ui, sans-serif;
    font-variant-numeric: tabular-nums;
    opacity: 0;
    transition: opacity 140ms ease-out;
  }
  .toast.show { opacity: 1; }

  @media (prefers-reduced-motion: reduce) {
    .toast { transition: none; }
  }
`;

export class Renderer {
  constructor() {
    this.host = document.createElement('div');
    this.host.dataset.subforge = 'overlay';

    // Host phải "miễn nhiễm" với CSS của trang → đặt inline kèm !important.
    const hostStyle = {
      position: 'absolute',
      inset: '0',
      margin: '0',
      padding: '0',
      border: 'none',
      display: 'block',
      'pointer-events': 'none',
      'z-index': '2147483000',
    };
    for (const [k, v] of Object.entries(hostStyle)) {
      this.host.style.setProperty(k, v, 'important');
    }

    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.shadow.innerHTML = `
      <style>${STYLE}</style>
      <div class="layer">
        <div class="line primary"></div>
        <div class="line secondary"></div>
      </div>
      <div class="toast"></div>
    `;

    this.layer = this.shadow.querySelector('.layer');
    this.els = {
      primary: this.shadow.querySelector('.primary'),
      secondary: this.shadow.querySelector('.secondary'),
      toast: this.shadow.querySelector('.toast'),
    };
    this._toastTimer = null;
    this._container = null;

    this._onFullscreen = this._onFullscreen.bind(this);
    document.addEventListener('fullscreenchange', this._onFullscreen, true);
    document.addEventListener('webkitfullscreenchange', this._onFullscreen, true);
  }

  /** Gắn overlay vào container của video. Gọi lại được nhiều lần. */
  attach(container) {
    if (!container || this._container === container) return;
    this._container = container;

    // Overlay dùng position:absolute nên container bắt buộc phải là
    // containing block. Nếu container đang static thì phải nâng lên relative.
    const pos = getComputedStyle(container).position;
    if (pos === 'static') container.style.position = 'relative';

    container.appendChild(this.host);
  }

  /** Khi vào/ra fullscreen, di chuyển overlay vào đúng cây DOM đang hiển thị. */
  _onFullscreen() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl && !fsEl.contains(this.host)) {
      const pos = getComputedStyle(fsEl).position;
      if (pos === 'static') fsEl.style.position = 'relative';
      fsEl.appendChild(this.host);
    } else if (!fsEl && this._container && !this._container.contains(this.host)) {
      this._container.appendChild(this.host);
    }
  }

  /** Cập nhật nội dung hai dòng. Truyền null/'' để ẩn dòng đó. */
  render(primaryText, secondaryText) {
    this._setLine(this.els.primary, primaryText);
    this._setLine(this.els.secondary, secondaryText);
  }

  _setLine(el, text) {
    const value = text || '';
    if (el.textContent !== value) el.textContent = value;
    el.classList.toggle('visible', value.length > 0);
  }

  /** Áp dụng cài đặt hiển thị (cỡ chữ, vị trí, màu, độ mờ nền). */
  applySettings({ fontSize, bottom, color, bgAlpha } = {}) {
    const s = this.layer.style;
    if (fontSize != null) s.setProperty('--ds-size', `${fontSize}px`);
    if (bottom != null) s.setProperty('--ds-bottom', `${bottom}%`);
    if (color != null) s.setProperty('--ds-color', color);
    if (bgAlpha != null) s.setProperty('--ds-bg-alpha', String(bgAlpha));
  }

  /** Thông báo ngắn trên video — dùng khi chỉnh offset bằng phím tắt. */
  toast(message, ms = 900) {
    const el = this.els.toast;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  setVisible(on) {
    this.host.style.setProperty('display', on ? 'block' : 'none', 'important');
  }

  destroy() {
    document.removeEventListener('fullscreenchange', this._onFullscreen, true);
    document.removeEventListener('webkitfullscreenchange', this._onFullscreen, true);
    this.host.remove();
  }
}
