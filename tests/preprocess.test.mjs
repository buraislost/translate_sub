import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  histogram,
  otsuThreshold,
  morph,
  whiteTopHat,
  textMask,
  findLines,
  components,
  occDistance,
  quickScan,
  resizeBilinear,
} from '../src/core/preprocess.js';
import { decodePng } from './helpers/png.mjs';

/** Dựng ảnh RGBA từ hàm fill(x,y) → [r,g,b]. */
function image(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/* ------------------------------------------------------------------ */
/* Otsu                                                                */
/* ------------------------------------------------------------------ */

test('Otsu đặt ngưỡng giữa hai cụm của histogram hai đỉnh', () => {
  const plane = new Uint8Array(1000);
  plane.fill(30, 0, 600); // nền tối
  plane.fill(210, 600, 1000); // chữ sáng
  const t = otsuThreshold(histogram(plane));
  assert.ok(t >= 30 && t < 210, `ngưỡng ${t} phải nằm giữa hai cụm`);
});

test('Otsu không cần ngưỡng cố định: dời cả hai cụm thì ngưỡng dời theo', () => {
  const make = (lo, hi) => {
    const p = new Uint8Array(1000);
    p.fill(lo, 0, 500);
    p.fill(hi, 500, 1000);
    return otsuThreshold(histogram(p));
  };
  const dark = make(10, 90);
  const bright = make(120, 250);
  assert.ok(bright > dark, `ngưỡng ${dark} → ${bright} phải tăng theo cụm`);
});

test('Otsu trên ảnh một màu không sập', () => {
  const p = new Uint8Array(100).fill(128);
  assert.doesNotThrow(() => otsuThreshold(histogram(p)));
});

/* ------------------------------------------------------------------ */
/* Hình thái học                                                       */
/* ------------------------------------------------------------------ */

test('erode co vùng sáng, dilate nở ra', () => {
  // ảnh 7x7, một khối sáng 3x3 ở giữa
  const p = new Uint8Array(49);
  for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) p[y * 7 + x] = 255;

  const eroded = morph(p, 7, 7, 1, false);
  assert.equal(eroded.filter((v) => v === 255).length, 1, 'khối 3x3 erode bán kính 1 chỉ còn 1 pixel');

  const dilated = morph(p, 7, 7, 1, true);
  assert.equal(dilated.filter((v) => v === 255).length, 25, 'khối 3x3 dilate bán kính 1 thành 5x5');
});

test('top-hat giữ nét sáng mảnh và xoá vùng sáng rộng', () => {
  // Nét mảnh rộng 3px bên trái, khối sáng rộng 30px bên phải, nền tối.
  const w = 60, h = 30;
  const plane = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 5; x < 8; x++) plane[y * w + x] = 250; // nét mảnh
    for (let x = 25; x < 55; x++) plane[y * w + x] = 250; // khối rộng
  }
  const hat = whiteTopHat(plane, w, h, 4);
  const thin = hat[15 * w + 6];
  const wide = hat[15 * w + 40];
  assert.ok(thin > 200, `nét mảnh phải giữ lại (được ${thin})`);
  assert.equal(wide, 0, 'giữa khối rộng phải bị xoá hoàn toàn');
});

/* ------------------------------------------------------------------ */
/* Mặt nạ chữ                                                          */
/* ------------------------------------------------------------------ */

/**
 * Mô phỏng đúng lỗi lớn nhất đã đo được trên phim thật: khe nền hẹp (bầu trời/tường,
 * L≈238) kẹp giữa hai nét chữ có viền đen. Bản đầu của bộ lọc coi khe đó là chữ và
 * tô kín lỗ của o, e, ơ. Nét chữ THẬT thì trắng tinh (255).
 */
function twoStrokes() {
  return image(60, 30, (x) => {
    const inStroke1 = x >= 10 && x <= 17;
    const inStroke2 = x >= 34 && x <= 41;
    if (inStroke1 || inStroke2) return [255, 255, 255]; // nét chữ
    const near1 = x >= 7 && x <= 20;
    const near2 = x >= 31 && x <= 44;
    if (near1 || near2) return [5, 5, 5]; // viền đen 3px hai bên
    return [238, 240, 236]; // nền tường, sáng nhưng KHÔNG trắng tinh
  });
}

test('mặt nạ lấy nét chữ trắng tinh và KHÔNG tô kín khe nền sáng kẹp giữa hai nét', () => {
  const img = twoStrokes();
  const { mask, width: w } = textMask(img, { open: 0 });
  const at = (x, y) => mask[y * w + x];

  assert.equal(at(13, 15), 1, 'giữa nét chữ trái phải có trong mặt nạ');
  assert.equal(at(37, 15), 1, 'giữa nét chữ phải phải có trong mặt nạ');
  // Khe nền rộng 10px (x=21..30) kẹp giữa hai viền đen. Sáng, mảnh, có viền tối kề bên
  // — mọi điều kiện cũ đều thoả — nhưng không trắng tinh nên phải bị loại.
  for (let x = 22; x <= 29; x++) assert.equal(at(x, 15), 0, `khe nền tại x=${x} bị lấp nhầm`);
});

test('mặt nạ vẫn lấy được chữ vàng (không phụ thuộc màu trắng cứng)', () => {
  const img = image(60, 30, (x) => {
    if (x >= 10 && x <= 17) return [255, 235, 40]; // chữ vàng
    if (x >= 7 && x <= 20) return [5, 5, 5];
    return [40, 60, 90];
  });
  const { mask, width: w } = textMask(img, { open: 0 });
  assert.equal(mask[15 * w + 13], 1, 'chữ vàng sáng có viền đen vẫn phải lọt vào mặt nạ');
});

test('mặt nạ trả về rỗng trên ảnh không có chữ', () => {
  const flat = image(80, 40, () => [120, 130, 140]);
  assert.equal(textMask(flat).count, 0);
});

/* ------------------------------------------------------------------ */
/* Dải hàng, thành phần liên thông                                     */
/* ------------------------------------------------------------------ */

test('findLines tách hai dòng và gộp khe hở nhỏ do dấu thanh', () => {
  const rows = new Uint32Array(100);
  for (let y = 10; y < 30; y++) rows[y] = 50; // dòng 1
  rows[20] = 3; // khe mờ giữa dòng — dấu thanh nằm cao hơn thân chữ
  for (let y = 60; y < 80; y++) rows[y] = 50; // dòng 2
  const lines = findLines(rows);
  assert.equal(lines.length, 2);
});

test('components đếm đúng số vùng rời nhau và bounding box', () => {
  const w = 12, h = 6;
  const mask = new Uint8Array(w * h);
  const set = (x, y) => (mask[y * w + x] = 1);
  for (let x = 1; x <= 3; x++) for (let y = 1; y <= 2; y++) set(x, y); // 3x2
  for (let x = 8; x <= 10; x++) set(x, 4); // 3x1
  const { comps } = components(mask, w, h, { minArea: 1 });
  assert.equal(comps.length, 2);
  const big = comps.find((c) => c.area === 6);
  assert.deepEqual([big.x0, big.x1, big.y0, big.y1], [1, 3, 1, 2]);
});

test('components nối chéo (8 láng giềng), không tách một nét chéo thành nhiều mảnh', () => {
  const w = 6, h = 6;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < 5; i++) mask[i * w + i] = 1; // đường chéo
  assert.equal(components(mask, w, h, { minArea: 1 }).comps.length, 1);
});

/* ------------------------------------------------------------------ */
/* Chữ ký và tầng quét nhẹ                                             */
/* ------------------------------------------------------------------ */

test('occDistance: giống hệt = 0, khác hẳn = 1, hai rỗng = 0', () => {
  const a = new Uint8Array([1, 1, 0, 0]);
  assert.equal(occDistance(a, a), 0);
  assert.equal(occDistance(a, new Uint8Array([0, 0, 1, 1])), 1);
  assert.equal(occDistance(new Uint8Array(4), new Uint8Array(4)), 0);
});

test('resizeBilinear thu nhỏ đúng kích thước và giữ độ sáng vùng phẳng', () => {
  const src = image(40, 20, () => [200, 100, 50]);
  const half = resizeBilinear(src, 0.5);
  assert.equal(half.width, 20);
  assert.equal(half.height, 10);
  assert.deepEqual([...half.data.slice(0, 3)], [200, 100, 50]);
});

/* ------------------------------------------------------------------ */
/* Dữ liệu thật                                                        */
/* ------------------------------------------------------------------ */

const FIX = (d) => fileURLToPath(new URL(`../benchmark/fixtures/${d}/`, import.meta.url));
const pos = FIX('hardsub-a');
const neg = FIX('hardsub-a-neg');
const hasReal = fs.existsSync(pos) && fs.existsSync(neg);

const scanFile = (path) =>
  quickScan(resizeBilinear(decodePng(fs.readFileSync(path)), 0.5), { scale: 0.5 });

test(
  'tầng quét nhẹ: 22/22 khung có phụ đề được phát hiện',
  { skip: hasReal ? false : 'không có benchmark/fixtures — bỏ qua' },
  () => {
    const files = fs.readdirSync(pos).filter((f) => f.endsWith('.png'));
    const missed = files.filter((f) => !scanFile(pos + f).present);
    assert.deepEqual(missed, [], `bỏ sót: ${missed.join(', ')}`);
  }
);

test(
  'tầng quét nhẹ: 0/14 khung KHÔNG có phụ đề bị báo nhầm',
  { skip: hasReal ? false : 'không có benchmark/fixtures — bỏ qua' },
  () => {
    const files = fs.readdirSync(neg).filter((f) => f.endsWith('.png'));
    const wrong = files.filter((f) => scanFile(neg + f).present);
    assert.deepEqual(wrong, [], `báo nhầm: ${wrong.join(', ')}`);
  }
);
