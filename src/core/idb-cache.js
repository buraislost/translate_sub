/**
 * idb-cache.js — lưu cue đã OCR/dịch vào IndexedDB của chính trang web.
 *
 * Vì sao dùng IndexedDB của TRANG chứ không phải storage của extension: content
 * script đã có sẵn quyền truy cập nó, không cần bắc cầu message sang service worker.
 * Cái giá phải trả: dữ liệu nằm theo origin của trang, mất nếu người dùng xoá dữ liệu
 * site đó — chấp nhận được, đây là cache tăng tốc chứ không phải nơi lưu trữ chính.
 *
 * Mọi hàm ở đây KHÔNG BAO GIỜ ném lỗi ra ngoài — cache là tối ưu hoá, một trang có
 * CSP lạ hay đang ở chế độ ẩn danh chặn IndexedDB thì tính năng OCR vẫn phải chạy
 * bình thường, chỉ là không nhớ giữa hai lần xem.
 */

const DB_NAME = '__translate_sub_cache__';
const STORE = 'cues';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this context'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Khoá cache: băm từ URL + thời lượng video (làm tròn giây).
 *
 * Thời lượng là một phần khoá vì URL không đủ phân biệt — SPA phát nhiều tập trên
 * cùng một URL (chuyển tập không đổi địa chỉ), nhưng mỗi tập có thời lượng khác nhau.
 * Băm bằng djb2: đủ tốt cho việc phân bố key, không cần chống va chạm mật mã.
 */
export function cueCacheKey(href, duration) {
  const s = `${href}::${Math.round(duration || 0)}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `v1:${(h >>> 0).toString(36)}`;
}

/** @returns {Promise<{records: Array, savedAt: number}|null>} */
export async function loadCueCache(key) {
  try {
    const db = await openDb();
    const rec = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rec;
  } catch {
    return null;
  }
}

export async function saveCueCache(key, records) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ records, savedAt: Date.now() }, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // im lặng — xem lại phần đầu file
  }
}
