/**
 * translate-service.js — dịch on-device bằng Chrome Translator API.
 *
 * Đã đo trong offscreen document thật: tạo translator 75 ms, mỗi câu dịch 6–22 ms,
 * không cần user gesture SAU KHI model đã tải. Việc tải model lần đầu thì Chrome
 * đòi user gesture, offscreen không bao giờ có — nên nút tải nằm ở popup.
 *
 * Hai ràng buộc của API này định hình file:
 *   - Không chạy được trong Web Worker  → phải ở một document (offscreen).
 *   - Xử lý tuần tự                     → có hàng đợi riêng, và cache để câu lặp
 *                                         (tên riêng, "Không sao!") trả về tức thì.
 */

import { splitUtterances, joinUtterances } from '../core/text-utils.js';

const CACHE_LIMIT = 3000;

export class TranslateService {
  constructor() {
    /** @type {Map<string, any>} translator theo cặp ngôn ngữ */
    this.translators = new Map();
    /** @type {Map<string, string>} */
    this.cache = new Map();
    this._chain = Promise.resolve();
    this.stats = { calls: 0, hits: 0 };
  }

  /** 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported' */
  async availability(from, to) {
    if (typeof globalThis.Translator?.availability !== 'function') return 'unsupported';
    try {
      return await globalThis.Translator.availability({ sourceLanguage: from, targetLanguage: to });
    } catch {
      return 'unsupported';
    }
  }

  /**
   * Tạo sẵn translator ngay lúc bật OCR, chạy song song với việc nạp Tesseract.
   * Không có bước này, câu phụ đề ĐẦU TIÊN phải chờ thêm lần tạo translator (đo được
   * ~75ms khi model đã có sẵn) sau khi đã chờ OCR xong.
   * Model chưa tải thì im lặng bỏ qua — lần translate() thật sẽ báo đúng mã lỗi.
   */
  async warm(from = 'vi', to = 'en') {
    try {
      await this._translatorFor(from, to);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err?.code ?? 'error', message: String(err?.message ?? err) };
    }
  }

  translate(text, from = 'vi', to = 'en') {
    const run = this._chain.then(() => this._run(text, from, to));
    this._chain = run.catch(() => {});
    return run;
  }

  async _translatorFor(from, to) {
    const key = `${from}>${to}`;
    const have = this.translators.get(key);
    if (have) return have;

    const state = await this.availability(from, to);
    if (state !== 'available') {
      const err = new Error(`Translator ${key}: ${state}`);
      err.code =
        state === 'downloadable' ? 'download-needed'
        : state === 'downloading' ? 'downloading'
        : state === 'unsupported' ? 'unsupported'
        : 'unavailable';
      throw err;
    }

    const translator = await globalThis.Translator.create({
      sourceLanguage: from,
      targetLanguage: to,
    });
    this.translators.set(key, translator);
    return translator;
  }

  async _run(text, from, to) {
    this.stats.calls++;
    const cacheKey = `${from}>${to}|${text}`;
    const hit = this.cache.get(cacheKey);
    if (hit !== undefined) {
      this.stats.hits++;
      // Đưa lên cuối Map để LRU giữ lại các câu vừa dùng.
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, hit);
      return { ok: true, text: hit, cached: true };
    }

    try {
      const translator = await this._translatorFor(from, to);
      const { parts, dialogue } = splitUtterances(text);
      if (!parts.length) return { ok: true, text: '', cached: false };

      // Tuần tự, không Promise.all: API tự xếp hàng, gọi song song chỉ làm khó đo thời gian.
      const out = [];
      for (const p of parts) out.push((await translator.translate(p)).trim());
      const result = joinUtterances(out, dialogue);

      this.cache.set(cacheKey, result);
      if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
      return { ok: true, text: result, cached: false };
    } catch (err) {
      // Translator hỏng giữa chừng (Chrome thu hồi model...) thì bỏ bản cache để lần sau tạo lại.
      if (!err?.code) this.translators.delete(`${from}>${to}`);
      return {
        ok: false,
        code: err?.code ?? 'error',
        message: String(err?.message ?? err),
      };
    }
  }
}
