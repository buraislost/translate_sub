/**
 * store.js — lưu trữ.
 *
 * Tách riêng hai loại dữ liệu vì vòng đời khác nhau:
 *   - settings : nhỏ, đồng bộ giữa các máy → chrome.storage.sync
 *   - session  : cue đã nạp, có thể vài trăm KB → chrome.storage.local
 */

export const DEFAULT_SETTINGS = {
  enabled: true,
  fontSize: 26,
  bottom: 8, // phần trăm tính từ đáy video
  color: '#ffffff',
  bgAlpha: 0.55,
  offset1: 0,
  offset2: 0,
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ settings: next });
  return next;
}

/**
 * Lưu phiên làm việc theo hostname. Nhờ vậy khi người dùng F5 hoặc chuyển
 * sang tập tiếp theo trên cùng một site, phụ đề vẫn còn, không phải upload lại.
 */
export async function saveSession(host, payload) {
  await chrome.storage.local.set({ [`session:${host}`]: payload });
}

export async function loadSession(host) {
  const key = `session:${host}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

export async function clearSession(host) {
  await chrome.storage.local.remove(`session:${host}`);
}
