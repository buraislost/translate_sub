import test from 'node:test';
import assert from 'node:assert/strict';

import {
  levenshtein,
  similarity,
  normalizeText,
  cer,
  wer,
} from '../src/core/text-metrics.js';

test('levenshtein đếm đúng số phép biến đổi', () => {
  assert.equal(levenshtein('', ''), 0);
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  // Đối xứng — đổi chỗ hai tham số phải ra cùng kết quả.
  assert.equal(levenshtein('abc', 'yabd'), levenshtein('yabd', 'abc'));
});

test('levenshtein đếm theo ký tự, không theo byte', () => {
  // "à" và "ả" khác nhau đúng MỘT ký tự, dù mã hoá UTF-8 tốn nhiều byte.
  assert.equal(levenshtein('nhà', 'nhả'), 1);
  // Sai dấu chồng cũng chỉ là một ký tự — đây chính là loại lỗi Tesseract
  // hay mắc nhất với tiếng Việt.
  assert.equal(levenshtein('nghề', 'nghế'), 1);
});

test('normalizeText đưa hai cách mã hoá dấu về một', () => {
  const precomposed = 'chiều'; // ề dựng sẵn — U+1EC1
  const combining = 'chiều'; // e + dấu mũ + dấu huyền

  // Trước khi chuẩn hoá, hai chuỗi này khác nhau về độ dài...
  assert.notEqual(precomposed.length, combining.length);
  // ...nhưng sau NFC thì bằng nhau. Không có bước này, CER cao giả tạo.
  assert.equal(normalizeText(precomposed), normalizeText(combining));
});

test('normalizeText bỏ dấu câu nhưng giữ chữ có dấu', () => {
  assert.equal(normalizeText('Chào bạn, khoẻ không?'), 'chào bạn khoẻ không');
  // Chữ tiếng Việt có dấu phải sống sót — \p{L} bao gồm cả chúng.
  assert.equal(normalizeText('Ừ!!!'), 'ừ');
  assert.equal(normalizeText('  nhiều   khoảng   trắng  '), 'nhiều khoảng trắng');
});

test('cer tính đúng tỉ lệ lỗi ký tự', () => {
  assert.equal(cer('xin chào', 'xin chào'), 0);

  // Một ký tự sai trên bản đúng dài 8 ký tự ("xin chào") → 1/8.
  assert.equal(cer('xin chảo', 'xin chào'), 1 / 8);

  // Bản đúng rỗng mà đọc ra chữ → lỗi hoàn toàn.
  assert.equal(cer('thừa', ''), 1);
  assert.equal(cer('', ''), 0);
});

test('cer bỏ qua khác biệt về hoa thường và dấu câu', () => {
  // Ba thứ này không phải lỗi OCR đáng tính: overlay hiển thị lại được hết.
  assert.equal(cer('Xin chào!', 'xin chào'), 0);
});

test('cer vượt quá 1 khi OCR bịa thêm chữ', () => {
  // Cố tình KHÔNG kẹp về 1: kẹp lại sẽ giấu mất trường hợp OCR đọc nhiễu
  // thành cả đống ký tự rác, vốn là lỗi nặng cần thấy rõ trong báo cáo.
  assert.ok(cer('abc rất nhiều chữ rác thừa ra', 'abc') > 1);
});

test('wer đếm theo từ chứ không theo ký tự', () => {
  assert.equal(wer('tôi đi học', 'tôi đi học'), 0);
  // Sai một từ trên ba từ.
  assert.equal(wer('tôi đi chơi', 'tôi đi học'), 1 / 3);
});

test('similarity dùng được làm ngưỡng fuzzy merge', () => {
  assert.equal(similarity('abc', 'abc'), 1);

  // Hai lần OCR cùng một câu, lệch nhau đúng một dấu — ngưỡng 0.9 phải gộp
  // chúng lại thành một cue thay vì tạo hai cue trùng nhau.
  assert.ok(similarity('Xin chào anh', 'Xin chảo anh') >= 0.9);

  // Hai câu khác hẳn thì không được gộp.
  assert.ok(similarity('Xin chào anh', 'Tạm biệt nhé') < 0.5);
});
