/**
 * ocr-selftest.js — kiểm chứng Tesseract đọc được tiếng Việt, không cần ảnh mẫu.
 *
 * Vấn đề của việc test OCR: muốn biết engine đọc đúng hay sai thì phải có ảnh
 * KÈM đáp án. Đi tìm ảnh phim rồi gõ tay đáp án là việc của Phase 5.
 *
 * Ở đây ta làm ngược lại: TỰ VẼ chữ ra canvas theo đúng kiểu hardsub (chữ
 * trắng viền đen), nên đáp án biết trước. Nhờ vậy có ngay một phép đo CER
 * khách quan để trả lời câu hỏi của Phase 1: "Tesseract có đọc nổi dấu tiếng
 * Việt không?" — trước khi bỏ công viết cả pipeline quanh nó.
 *
 * Lưu ý: đây là điều kiện LÝ TƯỞNG (chữ sắc nét, không nhiễu nén video).
 * CER đo ở đây là chặn dưới — thực tế trên phim sẽ tệ hơn.
 */

import { cer } from '../core/text-metrics.js';

/**
 * Câu thử tự soạn, chọn theo tiêu chí kỹ thuật chứ không phải ngẫu nhiên:
 * mỗi câu nhồi một loại dấu mà Tesseract hay sai.
 */
const CASES = [
  {
    label: 'dấu chồng (mũ + thanh)',
    text: 'Chiều nay trời đẹp, về nhà nghỉ một chút nhé.',
    bg: 'bright',
  },
  {
    label: 'dấu móc và dấu nặng',
    text: 'Ở đây người ta gọi thế là chuyện bình thường.',
    bg: 'dark',
  },
  {
    label: 'nền nhiễu, hai dòng',
    text: 'Tôi đã nghĩ kỹ rồi.\nChuyện này không thể để lâu hơn nữa.',
    bg: 'busy',
  },
  {
    label: 'chữ nhỏ (phim 480p)',
    text: 'Cậu ấy vừa mới rời khỏi đây được vài phút.',
    bg: 'bright',
    fontSize: 22,
  },
];

/**
 * Vẽ một khung hình giả lập hardsub.
 *
 * Kiểu vẽ bám theo cách đa số bản phụ đề cháy làm: chữ trắng đậm, viền đen
 * dày, căn giữa, nằm sát đáy. Đây chính là đặc điểm mà bước white-mask ở
 * Phase 3 sẽ khai thác.
 */
function renderFrame({ text, bg, fontSize = 38, width = 960, height = 220 }) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');

  paintBackground(ctx, bg, width, height);

  ctx.font = `700 ${fontSize}px Arial, "Helvetica Neue", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round'; // tránh gai nhọn ở góc chữ, giống bộ render phụ đề thật

  const lines = text.split('\n');
  const lineHeight = fontSize * 1.32;
  const startY = height - 24 - (lines.length - 1) * lineHeight - fontSize / 2;

  lines.forEach((line, i) => {
    const y = startY + i * lineHeight;
    // Viền vẽ TRƯỚC, thân chữ vẽ sau — ngược lại thì viền sẽ ăn mất nét chữ.
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(3, fontSize * 0.14);
    ctx.strokeText(line, width / 2, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(line, width / 2, y);
  });

  return canvas;
}

/** Ba kiểu nền tương ứng ba tình huống OCR khó dần. */
function paintBackground(ctx, kind, w, h) {
  if (kind === 'dark') {
    ctx.fillStyle = '#12171f';
    ctx.fillRect(0, 0, w, h);
    return;
  }

  if (kind === 'busy') {
    // Nền lốm đốm nhiều màu — trường hợp xấu nhất cho việc tách chữ, và là
    // lý do phải có white-mask thay vì chỉ dùng một ngưỡng Otsu toàn cục.
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = `hsl(${(i * 37) % 360} 65% ${35 + ((i * 13) % 45)}%)`;
      ctx.fillRect((i * 97) % w, (i * 53) % h, 46, 34);
    }
    return;
  }

  // 'bright' — nền sáng kiểu bầu trời, đúng tình huống Otsu dễ hỏng nhất
  // vì cả nền lẫn chữ đều sáng.
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#8fc7ee');
  g.addColorStop(1, '#dbeefb');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/**
 * Chạy toàn bộ ca thử.
 * @param {{recognize: Function}} engine đã init() sẵn
 */
export async function runOcrSelfTest(engine) {
  const results = [];

  for (const c of CASES) {
    const canvas = renderFrame(c);
    // Tesseract nhận Blob dễ hơn OffscreenCanvas ở một số bản — chuyển sang
    // PNG cho chắc, chi phí không đáng kể vì ảnh nhỏ.
    const blob = await canvas.convertToBlob({ type: 'image/png' });

    try {
      const out = await engine.recognize(blob);
      const expected = c.text.replace(/\n/g, ' ');
      results.push({
        label: c.label,
        expected,
        got: out.text.replace(/\s+/g, ' ').trim(),
        cer: +cer(out.text, expected).toFixed(3),
        confidence: Math.round(out.confidence),
        ms: out.ms,
      });
    } catch (err) {
      results.push({ label: c.label, error: `${err.name}: ${err.message}` });
    }
  }

  const scored = results.filter((r) => typeof r.cer === 'number');
  const meanCer = scored.length
    ? +(scored.reduce((s, r) => s + r.cer, 0) / scored.length).toFixed(3)
    : null;

  return { results, meanCer };
}
