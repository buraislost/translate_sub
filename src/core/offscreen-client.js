/**
 * offscreen-client.js — content script nói chuyện với offscreen document.
 *
 * Nói chuyện THẲNG với offscreen chứ không qua service worker: service worker MV3 bị
 * kill sau ~30s rảnh, mỗi lần bị kill là một lần đánh thức lại — vừa chậm vừa dễ
 * làm rơi message. Offscreen document thì sống ổn định.
 *
 * Chỉ service worker mới dựng được offscreen (chrome.offscreen.createDocument), nên
 * việc duy nhất phải nhờ nó là "hãy đảm bảo offscreen tồn tại".
 */

import { describeError } from './errors.js';

/** Gửi message; lỗi truyền tin trả về dạng object thay vì ném, để bên gọi xử lý gọn. */
async function send(msg) {
  try {
    const res = await chrome.runtime.sendMessage(msg);
    return res ?? { ok: false, transport: true, error: 'không phản hồi' };
  } catch (err) {
    return { ok: false, transport: true, error: describeError(err) };
  }
}

/** Extension vừa được nạp lại/gỡ: content script cũ mồ côi, mọi lời gọi sẽ lỗi vĩnh viễn. */
export function isContextInvalidated(errorText) {
  return /context invalidated|Extension context/i.test(String(errorText ?? ''));
}

export class OffscreenClient {
  async ensure() {
    const res = await send({ type: 'SF_ENSURE_OFFSCREEN', target: 'sw' });
    return res.ok === true;
  }

  /**
   * Gọi một handler của offscreen. Nếu không ai nhận (offscreen chưa dựng hoặc đã bị
   * Chrome đóng) thì nhờ service worker dựng lại rồi thử đúng một lần nữa.
   */
  async call(type, payload = {}) {
    const msg = { ...payload, type, target: 'offscreen' };
    let res = await send(msg);
    if (res.transport && !isContextInvalidated(res.error)) {
      if (await this.ensure()) res = await send(msg);
    }
    return res;
  }

  ocr({ dataUrl, frameH, lang }) {
    return this.call('SF_OCR', { dataUrl, frameH, lang });
  }

  warm(lang) {
    return this.call('SF_OCR_WARM', { lang });
  }

  translate({ text, from, to }) {
    return this.call('SF_TRANSLATE', { text, from, to });
  }

  async translatorAvailability(from, to) {
    const res = await this.call('SF_TRANSLATOR_STATUS', { from, to });
    return res.ok ? res.availability : 'unknown';
  }
}
