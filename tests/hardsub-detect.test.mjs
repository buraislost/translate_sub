import test from 'node:test';
import assert from 'node:assert/strict';

import {
  outlinedTextScore,
  detectSubtitleBand,
  summarizeScan,
  HARDSUB_RATIO_THRESHOLD,
} from '../src/core/hardsub-detect.js';

/** Dựng ảnh giả lập; fill(x,y) trả [r,g,b]. */
function makeImage(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/** Cảnh phim sáng — lõi sáng nhưng KHÔNG có viền tối. Đây là ca hay gây báo nhầm. */
const brightScene = (w, h) => makeImage(w, h, () => [220, 235, 250]);

/**
 * Dải chữ giả lập: các vệt sáng nằm ngang, mỗi vệt bọc viền tối.
 * Mô phỏng đúng cách phụ đề cháy được render.
 */
function subtitleBand(w, h, bandTop, bandHeight) {
  return makeImage(w, h, (x, y) => {
    const inBand = y >= bandTop && y < bandTop + bandHeight;
    if (!inBand) return [70, 110, 150];
    // Chu kỳ 16px: 8px lõi sáng, rồi viền tối hai bên.
    const phase = x % 16;
    if (phase < 8) return [255, 255, 255];
    return [10, 10, 10];
  });
}

test('cảnh sáng không có viền thì không bị tính là chữ', () => {
  const { ratio, count } = outlinedTextScore(brightScene(200, 80));
  // Toàn ảnh là lõi sáng, nhưng không đâu có viền tối -> phải ra 0.
  assert.equal(count, 0);
  assert.ok(ratio < HARDSUB_RATIO_THRESHOLD);
});

test('ảnh tối đều cũng không bị tính là chữ', () => {
  const dark = makeImage(200, 80, () => [20, 24, 30]);
  assert.equal(outlinedTextScore(dark).count, 0);
});

test('chữ sáng viền tối vượt xa ngưỡng', () => {
  const { ratio } = outlinedTextScore(subtitleBand(320, 120, 70, 30));
  assert.ok(
    ratio > HARDSUB_RATIO_THRESHOLD * 4,
    `ratio ${ratio} phải vượt xa ngưỡng ${HARDSUB_RATIO_THRESHOLD}`
  );
});

test('detectSubtitleBand khoanh đúng dải chứa chữ', () => {
  const img = subtitleBand(320, 200, 140, 40); // chữ nằm ở 70%-90% chiều cao
  const band = detectSubtitleBand(img);

  assert.ok(band, 'phải tìm thấy dải chữ');
  // Cho sai số rộng vì lấy mẫu thưa 2px.
  assert.ok(band.top >= 0.6 && band.top <= 0.75, `top=${band.top}`);
  assert.ok(band.bottom >= 0.85 && band.bottom <= 0.95, `bottom=${band.bottom}`);
});

test('detectSubtitleBand trả null khi không có chữ', () => {
  assert.equal(detectSubtitleBand(brightScene(200, 80)), null);
});

test('summarizeScan: một frame có chữ là đủ kết luận có hardsub', () => {
  // Phim nào cũng có đoạn không thoại — không được đòi mọi frame đều có chữ.
  const r = summarizeScan([0, 0, 0, 0.03, 0, 0, 0, 0, 0, 0]);
  assert.equal(r.hasHardsub, true);
});

test('summarizeScan: quét đủ nhiều mà không thấy gì thì kết luận không có', () => {
  // Đây chính là tình huống đo được trên web phim A.
  const r = summarizeScan(new Array(23).fill(0.0005));
  assert.equal(r.hasHardsub, false);
  assert.match(r.reason, /không thấy/);
});

test('summarizeScan: quét ít thì nói chưa chắc, không đoán bừa', () => {
  const r = summarizeScan([0, 0, 0]);
  assert.equal(r.hasHardsub, null);
  assert.match(r.reason, /chưa đủ/);
});
