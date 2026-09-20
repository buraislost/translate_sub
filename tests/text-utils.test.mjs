import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanOcrText, splitUtterances, joinUtterances } from '../src/core/text-utils.js';

/* ------------------------------------------------------------------ */
/* cleanOcrText — mỗi ca là một lỗi ĐÃ THẤY khi đo trên phim thật      */
/* ------------------------------------------------------------------ */

test('bỏ ký tự rác nhưng giữ nguyên chữ tiếng Việt có dấu', () => {
  const r = cleanOcrText('Hôm nay trời đẹp, đi dạo thôi.');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Hôm nay trời đẹp, đi dạo thôi.');
});

test('dấu câu rác kẹp giữa hai chữ (khe nền bị đọc nhầm) được đổi thành khoảng trắng', () => {
  // Thực tế Tesseract trả "Hôm:nay;.trời đẹp," khi mặt nạ còn lọt khe nền.
  assert.equal(cleanOcrText('Hôm:nay, trời đẹp,').text, 'Hôm nay, trời đẹp,');
  assert.equal(cleanOcrText('đừng"lo').text, 'đừng lo');
});

test('không phá dấu nháy đơn trong từ tiếng Anh', () => {
  assert.equal(cleanOcrText("don't stop").text, "don't stop");
});

test('số 0 lẫn trong từ chữ được sửa thành o, còn số đứng riêng thì giữ', () => {
  assert.equal(cleanOcrText('- A lô, ch0 hỏi').text, '- A lô, cho hỏi');
  assert.equal(cleanOcrText('Tr0ng nhà').text, 'Trong nhà');
  assert.equal(cleanOcrText('Có 3 con mèo.').text, 'Có 3 con mèo.');
  assert.equal(cleanOcrText('Đội 10 người').text, 'Đội 10 người');
});

test('gạch đầu dòng thoại bị nhiễu được chuẩn hoá về "- "', () => {
  assert.equal(cleanOcrText('_-Chị Mai ơi!').text, '- Chị Mai ơi!');
  assert.equal(cleanOcrText('¬-Đi nào.').text, '- Đi nào.');
  assert.equal(cleanOcrText('–Đi nào.').text, '- Đi nào.');
});

test('dòng chỉ toàn rác bị loại, các dòng còn lại giữ nguyên thứ tự', () => {
  const r = cleanOcrText('@@ ~~ ||\n- Chào cô ạ!\n_ ,\n- Hôm nay học gì');
  assert.equal(r.text, '- Chào cô ạ!\n- Hôm nay học gì');
});

test('chuẩn hoá NFC: dấu tổ hợp và dấu dựng sẵn thành một dạng', () => {
  const decomposed = 'chiều'; // e + mũ + huyền
  assert.equal(cleanOcrText(decomposed).text, 'chiều');
});

test('ít hơn 2 chữ hoặc độ tin cậy thấp thì không tin', () => {
  assert.equal(cleanOcrText('a').ok, false);
  assert.equal(cleanOcrText('|| ~').ok, false);
  const low = cleanOcrText('Lư, v.)N va', { confidence: 22 });
  assert.equal(low.ok, false);
  assert.match(low.reason, /tin cậy/);
});

/* ------------------------------------------------------------------ */
/* splitUtterances / joinUtterances                                    */
/* ------------------------------------------------------------------ */

test('hai người nói (có gạch đầu dòng) → hai phát ngôn độc lập', () => {
  const { parts, dialogue } = splitUtterances('- Chào cô ạ!\n- Hôm nay lớp mình học môn gì ạ?');
  assert.deepEqual(parts, ['Chào cô ạ!', 'Hôm nay lớp mình học môn gì ạ?']);
  assert.equal(dialogue, true);
});

test('một câu bị ngắt thành hai dòng (không gạch) → nối lại thành MỘT câu để dịch', () => {
  // Dịch từng dòng riêng lẻ sẽ ra hai mảnh câu vô nghĩa.
  const { parts, dialogue } = splitUtterances('Ngày mai nếu trời không mưa\nthì chúng ta sẽ đi dã ngoại.');
  assert.deepEqual(parts, ['Ngày mai nếu trời không mưa thì chúng ta sẽ đi dã ngoại.']);
  assert.equal(dialogue, false);
});

test('một dòng không gạch thì giữ nguyên', () => {
  assert.deepEqual(splitUtterances('Buồn ngủ quá đi.').parts, ['Buồn ngủ quá đi.']);
});

test('dòng thoại kèm dòng nối tiếp: dòng không gạch dính vào phát ngôn ngay trước nó', () => {
  const { parts } = splitUtterances('- A lô, cho hỏi có phải\nnhà bác Tư không-\n- Chị Mai ơi!');
  assert.deepEqual(parts, ['A lô, cho hỏi có phải nhà bác Tư không-', 'Chị Mai ơi!']);
});

test('joinUtterances: thoại thì mỗi người một dòng có gạch, ngược lại một dòng', () => {
  assert.equal(joinUtterances(['Hello, teacher!', 'What are we studying today?'], true), "- Hello, teacher!\n- What are we studying today?");
  assert.equal(joinUtterances(['One sentence.'], false), 'One sentence.');
  // một người nói nhưng có gạch: không thêm gạch thừa
  assert.equal(joinUtterances(['Only one.'], true), 'Only one.');
  assert.equal(joinUtterances([], true), '');
});

test('chuỗi rỗng hoặc null không làm sập', () => {
  assert.deepEqual(splitUtterances('').parts, []);
  assert.deepEqual(splitUtterances(null).parts, []);
  assert.equal(cleanOcrText(undefined).ok, false);
});
