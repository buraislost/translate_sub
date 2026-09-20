/**
 * Chạy: node tests/parser.test.mjs
 * Không dùng framework — Node có sẵn `node:test` và `node:assert`.
 *
 * Bộ test này sẽ lớn dần: Sprint 5 thêm phần đo CER/WER sẽ dùng chung
 * hạ tầng ở đây.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSubtitle, parseTimestamp, toSrt } from '../src/core/parser.js';
import { SubtitleSource } from '../src/core/SubtitleSource.js';

test('parseTimestamp đọc được cả dạng SRT và VTT', () => {
  assert.equal(parseTimestamp('00:00:01,042'), 1.042);
  assert.equal(parseTimestamp('01:02:03.500'), 3723.5);
  assert.equal(parseTimestamp('00:04.000'), 4); // VTT bỏ phần giờ
});

test('parseSubtitle bỏ BOM, thẻ HTML và tag ASS', () => {
  const cues = parseSubtitle(
    '\uFEFF1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>Xin chào</i>\n'
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Xin chào');
});

test('parseSubtitle sắp xếp lại cue sai thứ tự và cắt phần chồng lấn', () => {
  const cues = parseSubtitle(
    '2\n00:00:05,000 --> 00:00:07,000\nSau\n\n' +
      '1\n00:00:01,000 --> 00:00:06,000\nTrước\n'
  );
  assert.equal(cues[0].text, 'Trước');
  assert.equal(cues[0].end, 5, 'end phải bị cắt về đúng start của cue kế tiếp');
});

test('parseSubtitle sửa cue có end nhỏ hơn start', () => {
  const cues = parseSubtitle('1\n00:00:09,000 --> 00:00:08,000\nLỗi\n');
  assert.ok(cues[0].end > cues[0].start);
});

test('cueAt trả đúng cue bằng binary search', () => {
  const source = new SubtitleSource('test');
  source.cues = parseSubtitle(
    '1\n00:00:01,000 --> 00:00:02,000\nA\n\n' +
      '2\n00:00:05,000 --> 00:00:06,000\nB\n'
  );

  assert.equal(source.cueAt(0.5), null);
  assert.equal(source.cueAt(1.5).text, 'A');
  assert.equal(source.cueAt(3), null, 'khoảng trống giữa hai cue phải trả null');
  assert.equal(source.cueAt(5.5).text, 'B');
  assert.equal(source.cueAt(99), null);
});

test('toSrt xuất ra chuỗi parse ngược lại được', () => {
  const original = parseSubtitle('1\n00:00:01,250 --> 00:00:03,750\nVòng tròn\n');
  const round = parseSubtitle(toSrt(original));
  assert.deepEqual(round, original);
});
