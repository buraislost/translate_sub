import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { bytesToBase64, base64ToBytes, grayToRgba, rgbaToPgm } from '../src/core/bytes.js';
import { lumaPlane, prepareForOcr } from '../src/core/preprocess.js';
import { decodePng } from './helpers/png.mjs';

test('base64 khứ hồi giữ nguyên mọi byte, kể cả 0 và 255', () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});

test('base64 không tràn stack với mảng cỡ một dải phụ đề thật', () => {
  // 1200×200 = 240.000 byte. String.fromCharCode(...arr) một phát sẽ tràn stack.
  const big = new Uint8Array(1200 * 200);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
  const back = base64ToBytes(bytesToBase64(big));
  assert.equal(back.length, big.length);
  assert.deepEqual(back, big);
});

test('grayToRgba: luma của ảnh dựng lại đúng bằng mặt phẳng xám gốc', () => {
  // Đây là lý do gửi 1 byte/pixel là đủ: 77 + 150 + 29 = 256, nên luma(Y,Y,Y) = Y.
  const gray = new Uint8Array([0, 1, 127, 128, 200, 254, 255]);
  const rgba = grayToRgba(gray, gray.length, 1);
  assert.deepEqual(lumaPlane(rgba), gray);
});

test('rgbaToPgm: header P5 đúng chuẩn và đúng số byte pixel', () => {
  const img = grayToRgba(new Uint8Array([0, 255, 128, 64, 32, 16]), 3, 2);
  const pgm = rgbaToPgm(img);
  const head = 'P5\n3 2\n255\n';
  assert.equal(new TextDecoder().decode(pgm.subarray(0, head.length)), head);
  assert.deepEqual([...pgm.subarray(head.length)], [0, 255, 128, 64, 32, 16]);
});

/* ------------------------------------------------------------------ */
/* Dữ liệu thật: gửi 1 byte xám thay vì RGBA có làm đổi kết quả không  */
/* ------------------------------------------------------------------ */

const FIX = fileURLToPath(new URL('../benchmark/fixtures/hardsub-a/', import.meta.url));
const hasFix = fs.existsSync(FIX);

test(
  'trên 22 khung thật: mặt nạ dựng từ mặt phẳng xám GIỐNG HỆT mặt nạ dựng từ RGBA gốc',
  { skip: hasFix ? false : 'không có benchmark/fixtures/hardsub-a — bỏ qua' },
  () => {
    const files = fs.readdirSync(FIX).filter((f) => f.endsWith('.png'));
    for (const f of files) {
      const rgba = decodePng(fs.readFileSync(FIX + f));
      const viaGray = grayToRgba(lumaPlane(rgba), rgba.width, rgba.height);
      const a = prepareForOcr(rgba);
      const b = prepareForOcr(viaGray);
      assert.ok(a && b, `${f}: phải dựng được mặt nạ`);
      assert.deepEqual(b.box, a.box, `${f}: khung chữ lệch`);
      assert.deepEqual(b.image.data, a.image.data, `${f}: ảnh gửi Tesseract khác nhau`);
    }
  }
);
