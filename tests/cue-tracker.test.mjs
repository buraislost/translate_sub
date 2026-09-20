import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CueTracker } from '../src/core/cue-tracker.js';
import { quickScan, resizeBilinear, QUICK_OPTS } from '../src/core/preprocess.js';
import { decodePng } from './helpers/png.mjs';

const CELLS = QUICK_OPTS.gridCols * QUICK_OPTS.gridRows;

/** Chữ ký giả lập: bật một khoảng ô liên tiếp. Hai khoảng khác nhau → hai "câu" khác nhau. */
const occ = (from, to) => {
  const a = new Uint8Array(CELLS);
  for (let i = from; i < to; i++) a[i] = 1;
  return a;
};
const SENTENCE_A = occ(100, 200);
const SENTENCE_B = occ(400, 520);
const EMPTY = { present: false };
const seen = (o) => ({ present: true, occ: o });

/** Dựng tracker ghi lại mọi sự kiện. */
function make(opts) {
  const log = [];
  const tracker = new CueTracker({
    ...opts,
    onBegin: (c) => log.push(['begin', c.id, +c.start.toFixed(3)]),
    onEnd: (c, why) => log.push(['end', c.id, why, +c.end.toFixed(3)]),
  });
  return { tracker, log };
}

test('một câu hiện liên tục chỉ mở đúng một cue và kéo end theo', () => {
  const { tracker, log } = make({ interval: 0.3 });
  for (let i = 0; i < 6; i++) tracker.observe(10 + i * 0.3, seen(SENTENCE_A));

  assert.equal(log.filter((e) => e[0] === 'begin').length, 1);
  assert.equal(log.filter((e) => e[0] === 'end').length, 0);
  // end lạc quan: dài hơn lần quét cuối, để dòng dịch không nhấp nháy giữa hai lần quét.
  assert.ok(tracker.current.end > 10 + 5 * 0.3);
});

test('câu kết thúc sau hai lần quét trống liên tiếp, end nằm giữa lần thấy cuối và lần trống đầu', () => {
  const { tracker, log } = make({ interval: 0.3 });
  tracker.observe(10.0, seen(SENTENCE_A));
  tracker.observe(10.3, seen(SENTENCE_A));
  tracker.observe(10.6, EMPTY);
  assert.equal(log.filter((e) => e[0] === 'end').length, 0, 'mới trống 1 lần thì chưa kết thúc hẳn');
  tracker.observe(10.9, EMPTY);

  const end = log.find((e) => e[0] === 'end');
  assert.ok(end, 'phải kết thúc sau 2 lần trống');
  assert.equal(end[2], 'gap');
  assert.ok(end[3] > 10.3 && end[3] < 10.6, `end=${end[3]} phải nằm giữa 10.3 và 10.6`);
});

test('khung nhiễu làm câu rớt 1 lần rồi hiện lại y hệt thì KHÔNG tách thành hai cue', () => {
  const { tracker, log } = make({ interval: 0.3 });
  tracker.observe(10.0, seen(SENTENCE_A));
  tracker.observe(10.3, seen(SENTENCE_A));
  tracker.observe(10.6, EMPTY); // nhiễu nén video
  tracker.observe(10.9, seen(SENTENCE_A));
  tracker.observe(11.2, seen(SENTENCE_A));

  assert.equal(log.filter((e) => e[0] === 'begin').length, 1);
  assert.equal(log.filter((e) => e[0] === 'end').length, 0);
  assert.ok(tracker.current.end > 11.2, 'end phải được kéo ra lại sau khi câu hiện lại');
});

test('chuyển cảnh: rớt 1 lần rồi hiện câu KHÁC nhưng gần giống thì phải là cue mới', () => {
  // Đây chính là ca đã gặp: một câu → cắt cảnh → một câu KHÁC cùng độ dài.
  // Hai câu cùng độ dài, cùng vị trí nên chữ ký chỉ khác chút ít.
  const near = new Uint8Array(SENTENCE_A);
  for (let i = 100; i < 200; i += 4) near[i] = 0; // khác ~25% ô → d ≈ 0.25
  for (let i = 200; i < 225; i++) near[i] = 1;

  const { tracker, log } = make({ interval: 0.3 });
  tracker.observe(10.0, seen(SENTENCE_A));
  tracker.observe(10.3, seen(SENTENCE_A));
  tracker.observe(10.6, EMPTY);
  tracker.observe(10.9, seen(near));

  assert.equal(log.filter((e) => e[0] === 'begin').length, 2, 'ngưỡng sau chỗ đứt quãng phải chặt hơn');
});

test('đổi câu thẳng (không có khe trống): câu cũ kết thúc đúng lúc câu mới bắt đầu, không chồng lấn', () => {
  const { tracker, log } = make({ interval: 0.3 });
  tracker.observe(10.0, seen(SENTENCE_A));
  tracker.observe(10.3, seen(SENTENCE_A));
  tracker.observe(10.6, seen(SENTENCE_B));

  const begins = log.filter((e) => e[0] === 'begin');
  const end = log.find((e) => e[0] === 'end');
  assert.equal(begins.length, 2);
  assert.equal(end[2], 'replaced');
  assert.equal(end[3], begins[1][2], 'end câu cũ == start câu mới');
});

test('start của câu mới là điểm giữa hai lần quét, không phải lần quét đầu thấy nó', () => {
  const { tracker, log } = make({ interval: 0.3 });
  tracker.observe(10.0, EMPTY);
  tracker.observe(10.3, seen(SENTENCE_A));
  const begin = log.find((e) => e[0] === 'begin');
  assert.equal(begin[2], 10.15);
});

test('tua video: câu đang theo dõi bị đóng, câu ở vị trí mới là cue mới', () => {
  const { tracker, log } = make({ interval: 0.3 });
  tracker.observe(10.0, seen(SENTENCE_A));
  tracker.observe(10.3, seen(SENTENCE_A));
  tracker.observe(500.0, seen(SENTENCE_A)); // tua xa, chữ ký y hệt vẫn không được coi là cùng câu

  assert.equal(log.filter((e) => e[0] === 'begin').length, 2);
  assert.equal(log.find((e) => e[0] === 'end')[2], 'reset');
  assert.equal(log.filter((e) => e[0] === 'begin')[1][2], 500.0, 'sau khi tua không nội suy start');
});

test('reset() đóng câu đang theo dõi', () => {
  const { tracker, log } = make({ interval: 0.3 });
  tracker.observe(10.0, seen(SENTENCE_A));
  tracker.reset();
  assert.equal(tracker.current, null);
  assert.equal(log.find((e) => e[0] === 'end')[2], 'reset');
});

/* ------------------------------------------------------------------ */
/* Dữ liệu thật: chuỗi 92 khung liên tiếp của phim                     */
/* ------------------------------------------------------------------ */

const SEQ_DIR = fileURLToPath(new URL('../benchmark/fixtures/hardsub-a-seq/', import.meta.url));
const hasSeq = fs.existsSync(SEQ_DIR);

test(
  'chuỗi 92 khung thật cho ra đúng 10 câu, đúng thời điểm (±0,5s)',
  { skip: hasSeq ? false : 'không có benchmark/fixtures/hardsub-a-seq — bỏ qua' },
  () => {
    // Đáp án suy từ việc đọc bảng đo từng khung và xem trực tiếp các khung ở chỗ chuyển.
    const expected = [
      [2425.0, 2425.7], [2426.75, 2428.15], [2429.2, 2430.6], [2430.95, 2432.35],
      [2432.7, 2433.75], [2434.45, 2437.95], [2438.3, 2439.7], [2440.75, 2441.45],
      [2454.4, 2455.8], [2456.5, 2456.85],
    ];

    const cues = [];
    const tracker = new CueTracker({ interval: 0.35, onEnd: (c) => cues.push(c) });
    const files = fs.readdirSync(SEQ_DIR).filter((f) => f.endsWith('.png')).sort();
    for (const f of files) {
      const t = parseFloat(f.match(/_t([\d.]+)\.png$/)[1]);
      const q = quickScan(resizeBilinear(decodePng(fs.readFileSync(SEQ_DIR + f)), 0.5), { scale: 0.5 });
      tracker.observe(t, q.present ? { present: true, occ: q.occ } : { present: false });
    }
    tracker.reset();

    assert.equal(cues.length, expected.length, `tìm thấy ${cues.length} cue: ${cues.map((c) => c.start.toFixed(2)).join(', ')}`);
    cues.forEach((c, i) => {
      assert.ok(Math.abs(c.start - expected[i][0]) <= 0.5, `cue ${i}: start ${c.start.toFixed(2)} vs ${expected[i][0]}`);
      assert.ok(Math.abs(c.end - expected[i][1]) <= 0.6, `cue ${i}: end ${c.end.toFixed(2)} vs ${expected[i][1]}`);
    });
  }
);
