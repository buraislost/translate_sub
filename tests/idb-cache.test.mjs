import test from 'node:test';
import assert from 'node:assert/strict';

import { cueCacheKey, loadCueCache, saveCueCache } from '../src/core/idb-cache.js';

test('cueCacheKey ổn định: cùng đầu vào luôn ra cùng khoá', () => {
  const a = cueCacheKey('https://example.com/watch/abc', 6541.4);
  const b = cueCacheKey('https://example.com/watch/abc', 6541.4);
  assert.equal(a, b);
});

test('cueCacheKey phân biệt hai tập trên cùng URL bằng thời lượng', () => {
  // SPA chuyển tập không đổi URL — thời lượng khác là cách duy nhất để không
  // nạp nhầm cue của tập 1 sang tập 2.
  const ep1 = cueCacheKey('https://x.app/xem/phim', 1320);
  const ep2 = cueCacheKey('https://x.app/xem/phim', 1500);
  assert.notEqual(ep1, ep2);
});

test('cueCacheKey làm tròn thời lượng theo giây', () => {
  assert.equal(cueCacheKey('https://x.app/a', 100.2), cueCacheKey('https://x.app/a', 100.4));
});

test('không có IndexedDB thì load/save không ném lỗi', async () => {
  // Node không có `indexedDB` toàn cục — đúng môi trường không hỗ trợ mà hàm phải chịu được.
  assert.equal(typeof indexedDB, 'undefined');
  await assert.doesNotReject(() => saveCueCache('k', [{ start: 0, end: 1, vi: 'x', en: 'y' }]));
  await assert.doesNotReject(async () => assert.equal(await loadCueCache('k'), null));
});
