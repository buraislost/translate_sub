/**
 * content.js — loader.
 *
 * Content script của MV3 không hỗ trợ `import` tĩnh, nên file này là một
 * classic script nhỏ, dùng dynamic import() để nạp main.js dưới dạng ES module.
 * Nhờ vậy toàn bộ phần còn lại của project viết được bằng module chuẩn,
 * không cần webpack / rollup / bước build nào.
 */
(async () => {
  // all_frames: true nên script có thể chạy nhiều lần trong cùng một frame
  // khi trang tự chèn iframe. Cờ này chặn việc khởi tạo trùng.
  if (window.__TRANSLATE_SUB_LOADED__) return;
  window.__TRANSLATE_SUB_LOADED__ = true;

  try {
    await import(chrome.runtime.getURL('src/main.js'));
  } catch (err) {
    console.error('[TranslateSub] Failed to load main.js:', err);
  }
})();
