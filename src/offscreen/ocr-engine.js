/**
 * ocr-engine.js — lớp bọc Tesseract.js.
 *
 * Vì sao có lớp bọc thay vì gọi thẳng Tesseract: Phase 5 sẽ so sánh Tesseract
 * với PaddleOCR trên cùng một test set. Nếu phần còn lại của pipeline gọi
 * thẳng API Tesseract thì việc thay engine sẽ lan ra khắp nơi. Ở đây mọi
 * engine đều trả về cùng một shape:
 *
 *   { text: string, confidence: number, words: [{ text, confidence }] }
 *
 * Chỉ chạy trong offscreen document — Tesseract nạp ~3,9MB WASM, đặt ở
 * content script sẽ làm video giật và chết theo mỗi lần điều hướng.
 */

// ESM build của tesseract.js CHỈ có default export, không có named export.
// Viết `import { createWorker }` sẽ ra undefined mà không báo lỗi rõ ràng.
import Tesseract from '../../vendor/tesseract/tesseract.esm.min.js';

const VENDOR = 'vendor/tesseract/';

/** OEM 1 = LSTM_ONLY. Bắt buộc khớp với core bản `-lstm` mà ta đóng gói. */
const OEM_LSTM_ONLY = 1;

/**
 * PSM 6 = SINGLE_BLOCK: một khối chữ có thể nhiều dòng.
 * Hardsub hay có 1–2 dòng nên SINGLE_BLOCK an toàn hơn SINGLE_LINE (PSM 7),
 * vốn sẽ nối hai dòng thành một chuỗi lộn xộn.
 */
const PSM_SINGLE_BLOCK = '6';

export class TesseractEngine {
  constructor() {
    this.worker = null;
    this.lang = null;
    this._initPromise = null;
  }

  get name() {
    return 'tesseract';
  }

  /**
   * Nạp engine. Tốn vài giây lần đầu vì phải giải nén WASM, nên gọi sớm
   * chứ đừng đợi tới lúc có frame cần đọc.
   *
   * Dùng chung một Promise để hai lời gọi đồng thời không tạo hai worker —
   * mỗi worker là một bản WASM ~3,9MB nằm trong RAM.
   */
  async init({ lang = 'vie', onProgress } = {}) {
    if (this.worker && this.lang === lang) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._create(lang, onProgress).finally(() => {
      this._initPromise = null;
    });
    return this._initPromise;
  }

  async _create(lang, onProgress) {
    // Terminate worker cũ nếu đổi ngôn ngữ — không thì rò rỉ RAM.
    if (this.worker) await this.terminate();

    this.worker = await Tesseract.createWorker(lang, OEM_LSTM_ONLY, {
      // Mọi đường dẫn phải trỏ vào extension: CSP của MV3 chặn tải script
      // và WASM từ CDN, nên không có cách nào dùng bản online.
      workerPath: chrome.runtime.getURL(`${VENDOR}worker.min.js`),
      // Trỏ vào THƯ MỤC (không phải file) để tesseract.js tự dò xem CPU có
      // relaxed SIMD hay chỉ SIMD thường — ta đóng gói sẵn cả hai biến thể.
      corePath: chrome.runtime.getURL(VENDOR),
      langPath: chrome.runtime.getURL(VENDOR),
      // Ta tải bản .traineddata chưa nén; mặc định thư viện tìm file .gz.
      gzip: false,
      logger: onProgress ? (m) => onProgress(m) : undefined,
    });

    await this.worker.setParameters({
      tessedit_pageseg_mode: PSM_SINGLE_BLOCK,
      // Không có tham số này, Tesseract hay nuốt khoảng trắng giữa các từ —
      // hỏng luôn khâu dịch vì cả câu dính thành một cục.
      preserve_interword_spaces: '1',
    });

    this.lang = lang;
  }

  /**
   * Đọc chữ từ một ảnh.
   * @param {ImageBitmap|HTMLCanvasElement|Blob|string} image
   * @returns {Promise<{text: string, confidence: number, words: Array, ms: number}>}
   */
  async recognize(image) {
    if (!this.worker) throw new Error('Engine chưa init()');

    const t0 = performance.now();
    // Tham số thứ ba chọn dữ liệu trả về. Phải xin `blocks` thì mới có
    // confidence theo từng từ — thứ bước hậu xử lý cần để lọc từ đọc sai.
    const { data } = await this.worker.recognize(image, {}, { text: true, blocks: true });
    const ms = Math.round(performance.now() - t0);

    return {
      text: (data.text || '').trim(),
      confidence: data.confidence ?? 0,
      words: extractWords(data),
      ms,
    };
  }

  async terminate() {
    await this.worker?.terminate();
    this.worker = null;
    this.lang = null;
  }
}

/**
 * Gom danh sách từ kèm confidence.
 *
 * Cấu trúc trả về của tesseract.js đổi giữa các bản major: bản cũ có
 * `data.words` phẳng, bản mới lồng blocks → paragraphs → lines → words.
 * Thử cả hai để không vỡ khi nâng cấp thư viện.
 */
function extractWords(data) {
  if (Array.isArray(data.words) && data.words.length) {
    return data.words.map((w) => ({ text: w.text, confidence: w.confidence }));
  }

  const out = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) {
          out.push({ text: w.text, confidence: w.confidence });
        }
      }
    }
  }
  return out;
}
